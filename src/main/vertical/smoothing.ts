import { VerticalClipConfig, clamp } from '../../shared/config'
import { BallSample } from './tracker'

/**
 * Smoothed horizontal crop-center trajectory for a 9:16 window.
 *
 * Full-height crop (no vertical pan): the crop keeps source height and only
 * follows the ball horizontally. When the ball is lost the center holds the
 * last known position, then eases back to frame center.
 */
export interface CropTrajectory {
  /** Per-frame crop x offsets (source pixels), 0..(sourceWidth - cropWidth). */
  xs: number[]
  fps: number
  cropWidth: number
  cropHeight: number
  /** True when no tracked sample contributed (static center crop). */
  fallback: boolean
}

export function cropWidthFor(sourceWidth: number, sourceHeight: number): number {
  return Math.max(2, Math.min(sourceWidth, Math.floor((sourceWidth * 0 + sourceHeight * 9) / 16)))
}

export function computeTrajectory(
  track: BallSample[],
  windowStart: number,
  windowEnd: number,
  sourceWidth: number,
  sourceHeight: number,
  outputFps: number,
  cfg: VerticalClipConfig
): CropTrajectory {
  const cropWidth = cropWidthFor(sourceWidth, sourceHeight)
  const cropHeight = sourceHeight
  const maxX = Math.max(0, sourceWidth - cropWidth)
  const center = maxX / 2
  const duration = Math.max(0.1, windowEnd - windowStart)
  const frames = Math.max(1, Math.round(duration * outputFps))

  const known = track.filter((s) => !s.lost)
  if (known.length === 0 || maxX === 0) {
    return { xs: new Array(frames).fill(Math.round(center)), fps: outputFps, cropWidth, cropHeight, fallback: true }
  }

  // Raw target center per output frame: nearest tracked sample, but only if
  // it is close in time; otherwise this frame counts as lost (hold/recenter).
  const maxSampleGap = 1 / Math.max(0.5, cfg.sample_fps) / 2 + 0.05
  const raw: Array<number | null> = []
  for (let f = 0; f < frames; f++) {
    const t = windowStart + (f + 0.5) / outputFps
    let best: BallSample | null = null
    let bestDt = Infinity
    for (const s of known) {
      const dt = Math.abs(s.timestamp - t)
      if (dt < bestDt) {
        bestDt = dt
        best = s
      }
    }
    raw.push(best && bestDt <= Math.max(0.6, maxSampleGap * 4) ? clamp(best.x - cropWidth / 2, 0, maxX) : null)
  }

  // Hold last position after losing the ball, then ease to center.
  const holdFrames = Math.round(cfg.lost_hold_seconds * outputFps)
  const recenterFrames = Math.max(1, Math.round(cfg.recenter_seconds * outputFps))
  const held: number[] = new Array(frames)
  let lastKnown: number | null = null
  let lostFor = 0
  for (let f = 0; f < frames; f++) {
    if (raw[f] !== null) {
      lastKnown = raw[f] as number
      lostFor = 0
      held[f] = lastKnown
    } else if (lastKnown === null) {
      held[f] = center
    } else if (lostFor < holdFrames) {
      lostFor++
      held[f] = lastKnown
    } else {
      const k = Math.min(1, (lostFor - holdFrames + 1) / recenterFrames)
      const ease = k * k * (3 - 2 * k) // smoothstep
      held[f] = lastKnown + (center - lastKnown) * ease
      lostFor++
      if (k >= 1) lastKnown = center
    }
  }

  // Centered moving average over the smoothing window.
  const smoothRadius = Math.max(0, Math.floor((cfg.smoothing_window_seconds * outputFps) / 2))
  const smoothed = held.map((_, f) => {
    let sum = 0
    let n = 0
    for (let k = f - smoothRadius; k <= f + smoothRadius; k++) {
      if (k < 0 || k >= frames) continue
      sum += held[k]
      n++
    }
    return sum / Math.max(1, n)
  })

  // Clamp pan speed so the window never whips across the frame.
  const maxStep = (cfg.max_pan_speed * sourceWidth) / outputFps
  const limited = [...smoothed]
  for (let f = 1; f < frames; f++) {
    const delta = limited[f] - limited[f - 1]
    if (Math.abs(delta) > maxStep) {
      limited[f] = limited[f - 1] + Math.sign(delta) * maxStep
    }
  }

  return {
    xs: limited.map((x) => Math.round(clamp(x, 0, maxX))),
    fps: outputFps,
    cropWidth,
    cropHeight,
    fallback: false
  }
}
