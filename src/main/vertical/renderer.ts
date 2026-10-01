import { writeFile } from 'fs/promises'
import { basename } from 'path'
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

/**
 * A person cluster that spans most of a wide pitch is not a useful crop
 * anchor: it tends to select a foreground player while the decisive action
 * (and goal) sits on the opposite side. If there is no sustained ball track,
 * preserve the whole source frame instead of making a confidently bad crop.
 */
export function shouldUseWideFallback(
  samples: Array<{ lost: boolean; kind?: 'ball' | 'cluster'; width: number }>,
  sourceWidth: number
): boolean {
  const tracked = samples.filter((sample) => !sample.lost)
  if (tracked.length === 0) return false
  const balls = tracked.filter((sample) => sample.kind === 'ball').length
  const clusters = tracked
    .filter((sample) => sample.kind === 'cluster' && sample.width > 0)
    .map((sample) => sample.width)
    .sort((a, b) => a - b)
  if (clusters.length === 0) return false
  const medianWidth = clusters[Math.floor(clusters.length / 2)]
  const minimumReliableBalls = Math.max(2, Math.ceil(tracked.length * 0.1))
  return balls < minimumReliableBalls && medianWidth >= sourceWidth * 0.5
}

function wideFrameFilter(width: number, height: number): string {
  return [
    '[0:v]split=2[background][foreground]',
    `[background]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=20:10[blurred]`,
    `[foreground]scale=${width}:${height}:force_original_aspect_ratio=decrease[fit]`,
    '[blurred][fit]overlay=(W-w)/2:(H-h)/2'
  ].join(';')
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

  let xs: number[] | null = null
  let useWideFallback = false
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
        samples: track.samples.length,
        tracked: tracked.length,
        fallback: tracked.length === 0,
        mean_confidence: confs.length
          ? Number((confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(4))
          : 0
      }
      if (tracked.length > 0) {
        useWideFallback = v.wide_fallback_enabled && shouldUseWideFallback(track.samples, opts.sourceWidth)
        if (useWideFallback) {
          tracking.wide_fallback = true
        } else {
          const traj = computeTrajectory(
            track.samples,
            opts.window.start,
            opts.window.end,
            opts.sourceWidth,
            opts.sourceHeight,
            Math.max(1, Math.round(opts.sourceFps)) || 25,
            v
          )
          xs = traj.xs
          tracking.fallback = traj.fallback
        }
      }
    } catch (err) {
      if ((err as Error).message === 'cancelled' || opts.signal?.aborted) throw err
      tracking = { samples: 0, tracked: 0, fallback: true }
    }
  }
  opts.onTracked?.(tracking)

  const cropW = Math.max(2, Math.min(opts.sourceWidth, Math.floor((opts.sourceHeight * 9) / 16)))
  let videoFilter: string
  let cmdPath: string | null = null
  if (useWideFallback) {
    videoFilter = wideFrameFilter(v.width, v.height)
  } else if (xs && !tracking.fallback) {
    const fps = Math.max(1, Math.round(opts.sourceFps)) || 25
    cmdPath = `${opts.tempDir}/vertical_${Date.now()}_${Math.floor(Math.random() * 1e6)}.cmd`
    await writeFile(cmdPath, buildSendcmd({ xs, fps, cropWidth: cropW, cropHeight: opts.sourceHeight, fallback: false }))
    videoFilter = `sendcmd=f=${basename(cmdPath)},crop=${cropW}:${opts.sourceHeight}:x=0:y=0,scale=${v.width}:${v.height}:flags=lanczos`
  } else {
    videoFilter = `crop=${cropW}:${opts.sourceHeight},scale=${v.width}:${v.height}:flags=lanczos`
  }

  try {
    await runProcess(
      resolveBinary('ffmpeg'),
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', opts.window.start.toFixed(3),
        '-i', opts.inputPath,
        '-t', duration.toFixed(3),
        '-vf', videoFilter,
        '-c:v', 'libx264',
        '-preset', v.video_preset,
        '-crf', String(v.video_crf),
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-avoid_negative_ts', 'make_zero',
        '-y', opts.outputPath
      ],
      { cwd: opts.tempDir, signal: opts.signal, timeoutSeconds: 1800 }
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
