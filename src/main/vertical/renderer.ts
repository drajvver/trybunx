import { basename, resolve } from 'path'
import { writeFile } from 'fs/promises'
import { AppConfig } from '../../shared/config'
import { resolveBinary, runProcess } from '../media/process'
import { probeMedia } from '../media/ffprobe'
import { computeClipWindow, ClipWindow } from '../clips/generator'
import { trackBall } from './tracker'
import { computeTrajectory } from './smoothing'
import { buildSendcmd } from './crop_command'
import { PythonWorker } from '../workers/python_worker'
import { ClipInfo, VerticalTrackingSummary } from '../../shared/contracts'

export interface VerticalRenderOptions {
  inputPath: string
  outputPath: string
  window: ClipWindow
  durationSeconds: number
  sourceWidth: number
  sourceHeight: number
  sourceFps: number
  cfg: AppConfig
  worker?: PythonWorker | null
  /** Directory for the transient sendcmd file (removed after render). */
  tempDir: string
  signal?: AbortSignal
  onTracked?: (summary: VerticalTrackingSummary) => void
}

export interface VerticalRenderResult {
  info: ClipInfo
  tracking: VerticalTrackingSummary
  fallback: boolean
}

function verticalFileName(horizontalPath: string): string {
  return horizontalPath.replace(/\.mp4$/i, '_vertical.mp4')
}

export function verticalOutputPath(horizontalPath: string): string {
  return verticalFileName(horizontalPath)
}

/**
 * Render the 9:16 action-following twin of one clip window. Same time window
 * and same audio as the horizontal clip. Tracking failure degrades to a
 * static center crop; only an FFmpeg encode failure rejects.
 */
export async function renderVerticalClip(opts: VerticalRenderOptions): Promise<VerticalRenderResult> {
  const v = opts.cfg.vertical
  const duration = opts.window.end - opts.window.start
  const fps = Number.isFinite(opts.sourceFps) && opts.sourceFps >= 1 ? opts.sourceFps : 25

  let xs: number[] | null = null
  let tracking: VerticalTrackingSummary = {
    samples: 0,
    tracked: 0,
    fallback: true
  }

  if (opts.worker) {
    try {
      const track = await trackBall({
        worker: opts.worker,
        inputPath: opts.inputPath,
        start: opts.window.start,
        end: opts.window.end,
        sourceWidth: opts.sourceWidth,
        sourceHeight: opts.sourceHeight,
        cfg: opts.cfg,
        signal: opts.signal
      })
      const tracked = track.samples.filter((s) => !s.lost)
      const confs = tracked.map((s) => s.confidence)
      tracking = {
        ball_observations: tracked.filter(s => s.kind === 'ball' && !s.interpolated).length,
        ball_interpolated: tracked.filter(s => s.kind === 'ball' && s.interpolated).length,
        samples: track.samples.length,
        tracked: tracked.length,
        fallback: tracked.length === 0,
        mean_confidence: confs.length
          ? Number((confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(4))
          : 0
      }
      if (tracked.length > 0) {
        const traj = computeTrajectory(
          track.samples,
          opts.window.start,
          opts.window.end,
          opts.sourceWidth,
          opts.sourceHeight,
          fps,
          v
        )
        xs = traj.xs
        tracking.fallback = traj.fallback
      }
    } catch (err) {
      if ((err as Error).message === 'cancelled' || opts.signal?.aborted) throw err
      tracking = { samples: 0, tracked: 0, fallback: true, fallback_reason: 'tracking_failed', error: (err as Error).message }
    }
  }
  opts.onTracked?.(tracking)

  const cropW = Math.max(2, Math.min(opts.sourceWidth, Math.floor((opts.sourceHeight * 9) / 16)))
  let videoFilter: string
  let cmdPath: string | null = null
  if (xs && !tracking.fallback) {
    cmdPath = `${opts.tempDir}/vertical_${Date.now()}_${Math.floor(Math.random() * 1e6)}.cmd`
    await writeFile(cmdPath, buildSendcmd({ xs, fps, cropWidth: cropW, cropHeight: opts.sourceHeight, fallback: false }))
    videoFilter = `fps=${fps},sendcmd=f=${basename(cmdPath)},crop=${cropW}:${opts.sourceHeight}:x=0:y=0,scale=${v.width}:${v.height}:flags=lanczos`
  } else {
    videoFilter = `crop=${cropW}:${opts.sourceHeight},scale=${v.width}:${v.height}:flags=lanczos`
  }

  try {
    await runProcess(
      resolveBinary('ffmpeg'),
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', opts.window.start.toFixed(3),
        '-i', resolve(opts.inputPath),
        '-t', duration.toFixed(3),
        '-vf', videoFilter,
        '-c:v', 'libx264',
        '-preset', v.video_preset,
        '-crf', String(v.video_crf),
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-avoid_negative_ts', 'make_zero',
        '-y', resolve(opts.outputPath)
      ],
      { signal: opts.signal, timeoutSeconds: 1800, cwd: resolve(opts.tempDir) }
    )
  } finally {
    if (cmdPath) {
      const { rm } = await import('fs/promises')
      await rm(cmdPath, { force: true }).catch(() => undefined)
    }
  }

  const probe = await probeMedia(opts.outputPath, opts.signal)
  if (probe.durationSeconds <= 0.2) {
    throw new Error(`produced vertical clip is empty (${probe.durationSeconds.toFixed(2)}s)`)
  }

  const info: ClipInfo = {
    path: opts.outputPath,
    startSeconds: opts.window.start,
    endSeconds: opts.window.end,
    durationSeconds: Number(probe.durationSeconds.toFixed(3)),
    reencoded: true,
    variant: 'vertical',
    width: probe.width,
    height: probe.height,
    tracking
  }
  return { info, tracking, fallback: tracking.fallback }
}

export { computeClipWindow }
