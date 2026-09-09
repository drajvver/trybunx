import { mkdir } from 'fs/promises'
import { ClipInfo, DetectedEvent } from '../../shared/contracts'
import { AppConfig } from '../../shared/config'
import { resolveBinary, runProcess } from '../media/process'
import { probeMedia } from '../media/ffprobe'
import { PythonWorker } from '../workers/python_worker'
import { renderVerticalClip, verticalOutputPath } from '../vertical/renderer'

export interface ClipWindow {
  start: number
  end: number
}

/** Compute the [start, end) window for an event, with boundary clamping (PRD 23.1). */
export function computeClipWindow(
  eventTime: number,
  durationSeconds: number,
  cfg: AppConfig['clips']
): ClipWindow {
  const pre = cfg.goal_pre_roll_seconds
  const post = cfg.goal_post_roll_seconds
  const maxLen = cfg.max_clip_seconds

  let start = Math.max(0, eventTime - pre)
  let end = Math.min(durationSeconds, eventTime + post)

  if (end - start > maxLen) end = start + maxLen
  // Guarantee a usable clip even at hard boundaries.
  if (end - start < 0.5) {
    start = Math.max(0, Math.min(start, durationSeconds - 0.5))
    end = Math.min(durationSeconds, start + 0.5)
  }
  return { start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) }
}

/** goal_01_67m14s.mp4 (PRD section 7). */
export function clipFileName(event: DetectedEvent, index: number): string {
  const total = Math.max(0, Math.floor(event.event_time))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  const prefix = event.type.toLowerCase()
  return `${prefix}_${String(index).padStart(2, '0')}_${minutes}m${seconds}s.mp4`
}

/** Flat 9:16 twin next to the horizontal clip: goal_01_67m14s_vertical.mp4. */
export function verticalClipFileName(event: DetectedEvent, index: number): string {
  return clipFileName(event, index).replace(/\.mp4$/i, '_vertical.mp4')
}

export interface ClipGenerationOptions {
  inputPath: string
  events: DetectedEvent[]
  clipsDir: string
  durationSeconds: number
  cfg: AppConfig
  signal?: AbortSignal
  /** Source media geometry, needed for the 9:16 crop math. */
  sourceWidth?: number
  sourceHeight?: number
  sourceFps?: number
  /** Isolated Python worker for ball tracking; vertical falls back to center crop without it. */
  worker?: PythonWorker | null
  tempDir?: string
  onClipStart?: (event: DetectedEvent, index: number) => void
  onClipDone?: (event: DetectedEvent, index: number, info: ClipInfo) => void
  onClipFailed?: (event: DetectedEvent, index: number, error: string) => void
  onVerticalDone?: (event: DetectedEvent, index: number, info: ClipInfo) => void
  onVerticalFailed?: (event: DetectedEvent, index: number, error: string) => void
}

/** Cut one clip with ffmpeg. Re-encoding is the default for accurate cuts (PRD 23.2). */
async function cutClip(
  inputPath: string,
  outputPath: string,
  window: ClipWindow,
  cfg: AppConfig['clips'],
  signal?: AbortSignal
): Promise<boolean> {
  const duration = window.end - window.start
  const args =
    cfg.encoding === 'copy'
      ? [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-ss', window.start.toFixed(3),
          '-i', inputPath,
          '-t', duration.toFixed(3),
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero',
          '-y', outputPath
        ]
      : [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-ss', window.start.toFixed(3),
          '-i', inputPath,
          '-t', duration.toFixed(3),
          '-c:v', 'libx264',
          '-preset', cfg.video_preset,
          '-crf', String(cfg.video_crf),
          '-c:a', 'aac',
          '-b:a', '192k',
          '-movflags', '+faststart',
          '-avoid_negative_ts', 'make_zero',
          '-y', outputPath
        ]

  await runProcess(resolveBinary('ffmpeg'), args, { signal, timeoutSeconds: 1800 })
  return cfg.encoding === 'copy'
}

/** Generate all clips for the given events. Individual failures do not abort the rest. */
export async function generateClips(opts: ClipGenerationOptions): Promise<{
  clips: Map<string, ClipInfo>
  failures: Array<{ eventId: string; error: string }>
  verticalFailures: Array<{ eventId: string; error: string }>
}> {
  await mkdir(opts.clipsDir, { recursive: true })
  const clips = new Map<string, ClipInfo>()
  const failures: Array<{ eventId: string; error: string }> = []
  const verticalFailures: Array<{ eventId: string; error: string }> = []
  let index = 0

  for (const event of opts.events) {
    if (opts.signal?.aborted) throw new Error('cancelled')
    index++
    opts.onClipStart?.(event, index)

    const window = computeClipWindow(event.event_time, opts.durationSeconds, opts.cfg.clips)
    const outputPath = `${opts.clipsDir}/${clipFileName(event, index)}`

    try {
      const reencoded = await cutClip(opts.inputPath, outputPath, window, opts.cfg.clips, opts.signal)

      // Validate the produced clip (PRD 9.5 output validation).
      const probe = await probeMedia(outputPath, opts.signal)
      const duration = probe.durationSeconds
      if (duration <= 0.2) throw new Error(`produced clip is empty (${duration.toFixed(2)}s)`)
      const maxAllowed = opts.cfg.clips.max_clip_seconds + 1.0
      if (duration > maxAllowed) {
        throw new Error(`produced clip too long: ${duration.toFixed(2)}s > ${maxAllowed}s`)
      }

      const info: ClipInfo = {
        path: outputPath,
        startSeconds: window.start,
        endSeconds: window.end,
        durationSeconds: Number(duration.toFixed(3)),
        reencoded,
        variant: 'horizontal',
        width: probe.width,
        height: probe.height
      }
      clips.set(event.id, info)
      opts.onClipDone?.(event, index, info)
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'cancelled' || (err as Error).name === 'ProcessError' && msg.includes('cancelled')) {
        throw err
      }
      failures.push({ eventId: event.id, error: msg })
      opts.onClipFailed?.(event, index, msg)
      continue
    }

    // Action-following 9:16 twin: same window, same audio, flat layout.
    if (opts.cfg.vertical.enabled) {
      try {
        const verticalPath = `${opts.clipsDir}/${verticalClipFileName(event, index)}`
        if (verticalOutputPath(outputPath) !== verticalPath) {
          throw new Error('vertical naming diverged from horizontal clip')
        }
        const { info } = await renderVerticalClip({
          inputPath: opts.inputPath,
          outputPath: verticalPath,
          window,
          durationSeconds: opts.durationSeconds,
          sourceWidth: opts.sourceWidth ?? 0,
          sourceHeight: opts.sourceHeight ?? 0,
          sourceFps: opts.sourceFps ?? 25,
          cfg: opts.cfg,
          worker: opts.worker,
          tempDir: opts.tempDir ?? opts.clipsDir,
          signal: opts.signal
        })
        event.clip_vertical = info
        opts.onVerticalDone?.(event, index, info)
      } catch (err) {
        const msg = (err as Error).message
        if (msg === 'cancelled' || (err as Error).name === 'ProcessError' && msg.includes('cancelled')) {
          throw err
        }
        verticalFailures.push({ eventId: event.id, error: msg })
        opts.onVerticalFailed?.(event, index, msg)
      }
    }
  }

  return { clips, failures, verticalFailures }
}
