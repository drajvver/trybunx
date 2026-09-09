import { CropTrajectory } from './smoothing'

/**
 * Build an FFmpeg sendcmd command file that drives the crop filter.
 * Verified against the bundled FFmpeg: `sendcmd=f=...,crop=w:h:x=0`
 * applies `crop x <value>` commands at the given (post-seek) timestamps.
 */
export function buildSendcmd(trajectory: CropTrajectory, commandFps = 5): string {
  const step = Math.max(1, Math.round(trajectory.fps / commandFps))
  const lines: string[] = []
  for (let f = 0; f < trajectory.xs.length; f += step) {
    const t = f / trajectory.fps
    lines.push(`${t.toFixed(3)} crop x ${trajectory.xs[f]};`)
  }
  const lastT = (trajectory.xs.length - 1) / trajectory.fps
  const lastLine = `${lastT.toFixed(3)} crop x ${trajectory.xs[trajectory.xs.length - 1]};`
  if (lines[lines.length - 1] !== lastLine) lines.push(lastLine)
  return lines.join('\n') + '\n'
}

/** Static center-crop filter (tracking unavailable or source narrower than 9:16 target). */
export function staticCropFilter(sourceWidth: number, sourceHeight: number): string {
  const cropW = Math.max(2, Math.min(sourceWidth, Math.floor((sourceHeight * 9) / 16)))
  return `crop=${cropW}:${sourceHeight}`
}
