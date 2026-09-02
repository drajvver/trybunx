import { mkdir } from 'fs/promises'
import { resolveBinary, runProcess } from './process'
import { Roi } from '../../shared/contracts'

export interface ExtractFramesRequest {
  inputPath: string
  outputDir: string
  /** Seconds to start extraction from (default 0). */
  start?: number
  /** Seconds to stop extraction at (default: end of file). */
  end?: number
  /** Sampling interval in milliseconds. */
  intervalMs: number
  /** Normalized ROI to crop before saving (optional). */
  roi?: Roi
  /** Video dimensions, required to convert a normalized ROI into pixels. */
  videoWidth?: number
  videoHeight?: number
  /** Upscale factor applied after cropping (OCR readability). */
  upscale?: number
  signal?: AbortSignal
}

export interface ExtractFramesResult {
  dir: string
  count: number
  /** Timestamp (seconds) of the first extracted frame. */
  startSeconds: number
  intervalSeconds: number
  /** Frame file path for an index (0-based). */
  framePath: (index: number) => string
}

/**
 * Extract evenly spaced frames with ffmpeg and save them as PNGs.
 * Node owns all frame extraction; the Python worker only reads image files.
 */
export async function extractFrames(req: ExtractFramesRequest): Promise<ExtractFramesResult> {
  const {
    inputPath,
    outputDir,
    start = 0,
    end,
    intervalMs,
    roi,
    videoWidth,
    videoHeight,
    upscale = 1,
    signal
  } = req

  await mkdir(outputDir, { recursive: true })

  const fps = 1000 / intervalMs
  const filters: string[] = [`fps=${fps}`]

  if (roi && videoWidth && videoHeight) {
    const x = Math.max(0, Math.round(roi.x * videoWidth))
    const y = Math.max(0, Math.round(roi.y * videoHeight))
    const w = Math.min(videoWidth - x, Math.max(2, Math.round(roi.width * videoWidth)))
    const h = Math.min(videoHeight - y, Math.max(2, Math.round(roi.height * videoHeight)))
    filters.push(`crop=${w}:${h}:${x}:${y}`)
    if (upscale > 1) {
      filters.push(`scale=${w * upscale}:${h * upscale}:flags=lanczos`)
    }
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-ss', start.toFixed(3)
  ]
  if (end !== undefined) {
    args.push('-t', Math.max(0, end - start).toFixed(3))
  }
  args.push(
    '-i', inputPath,
    '-vf', filters.join(','),
    '-fps_mode', 'cfr',
    '-start_number', '0',
    `${outputDir}/%08d.png`
  )

  await runProcess(resolveBinary('ffmpeg'), args, { signal, timeoutSeconds: 24 * 3600 })

  const { readdir } = await import('fs/promises')
  const files = (await readdir(outputDir)).filter((f) => f.endsWith('.png')).sort()
  return {
    dir: outputDir,
    count: files.length,
    startSeconds: start,
    intervalSeconds: intervalMs / 1000,
    framePath: (index: number) => `${outputDir}/${String(index).padStart(8, '0')}.png`
  }
}

/** Extract a single frame as PNG (for the ROI editor). */
export async function extractSingleFrame(
  inputPath: string,
  timestampSeconds: number,
  outputPath: string,
  signal?: AbortSignal
): Promise<string> {
  await runProcess(
    resolveBinary('ffmpeg'),
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-ss', timestampSeconds.toFixed(3),
      '-i', inputPath,
      '-frames:v', '1',
      '-y', outputPath
    ],
    { signal, timeoutSeconds: 120 }
  )
  return outputPath
}
