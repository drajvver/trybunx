import { describe, expect, it } from 'vitest'
import { computeTrajectory, cropWidthFor } from '../src/main/vertical/smoothing'
import { buildSendcmd, staticCropFilter } from '../src/main/vertical/crop_command'
import { verticalClipFileName } from '../src/main/clips/generator'
import { DEFAULT_CONFIG } from '../src/shared/config'
import type { BallSample } from '../src/main/vertical/tracker'
import type { DetectedEvent } from '../src/shared/contracts'

function sample(t: number, x: number): BallSample {
  return { timestamp: t, x, y: 360, width: 20, height: 20, confidence: 0.8, lost: false, kind: 'ball' }
}

function lost(t: number): BallSample {
  return { timestamp: t, x: 0, y: 0, width: 0, height: 0, confidence: 0, lost: true }
}

const CFG = DEFAULT_CONFIG.vertical
const W = 1280
const H = 720

describe('vertical crop geometry', () => {
  it('computes a full-height 9:16 crop width', () => {
    expect(cropWidthFor(1280, 720)).toBe(405) // floor(720*9/16)
    expect(cropWidthFor(1920, 1080)).toBe(607)
  })

  it('names the vertical twin flat next to the horizontal clip', () => {
    const event = { type: 'GOAL', event_time: 434 } as DetectedEvent
    expect(verticalClipFileName(event, 1)).toBe('goal_01_7m14s_vertical.mp4')
  })
})

describe('computeTrajectory', () => {
  it('follows the ball center, clamped to frame bounds', () => {
    const track = [sample(0, 100), sample(5, 640), sample(10, 1200)]
    const traj = computeTrajectory(track, 0, 10, W, H, 10, CFG)
    expect(traj.xs).toHaveLength(100)
    expect(traj.fallback).toBe(false)
    expect(Math.min(...traj.xs)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...traj.xs)).toBeLessThanOrEqual(W - traj.cropWidth)
    // Ball at x=100 -> crop near the left edge; ball at 1200 -> near right.
    expect(traj.xs[0]).toBeLessThan(traj.xs[50])
    expect(traj.xs[99]).toBeGreaterThan(traj.xs[50])
  })

  it('falls back to a static center crop when the ball is never seen', () => {
    const traj = computeTrajectory([lost(0), lost(1), lost(2)], 0, 3, W, H, 10, CFG)
    expect(traj.fallback).toBe(true)
    const center = Math.round((W - traj.cropWidth) / 2)
    expect(new Set(traj.xs).size).toBe(1)
    expect(traj.xs[0]).toBe(center)
  })

  it('holds the last position, then eases back to center', () => {
    const track = [sample(0, 200), sample(0.5, 220), lost(1), lost(2), lost(3), lost(4), lost(5)]
    const traj = computeTrajectory(track, 0, 6, W, H, 10, {
      ...CFG,
      lost_hold_seconds: 1.0,
      recenter_seconds: 1.0,
      smoothing_window_seconds: 0
    })
    const center = (W - traj.cropWidth) / 2
    // Still holding shortly after loss.
    expect(Math.abs(traj.xs[12] - (220 - traj.cropWidth / 2))).toBeLessThan(60)
    // Eased back to center by the end.
    expect(Math.abs(traj.xs[traj.xs.length - 1] - center)).toBeLessThan(5)
  })

  it('limits pan speed so the window never whips', () => {
    const track = [sample(0, 100), sample(0.4, 1200)]
    const traj = computeTrajectory(track, 0, 2, W, H, 10, { ...CFG, max_pan_speed: 0.1 })
    const maxStep = (0.1 * W) / 10 + 1 // +1 for rounding
    for (let i = 1; i < traj.xs.length; i++) {
      expect(Math.abs(traj.xs[i] - traj.xs[i - 1])).toBeLessThanOrEqual(maxStep)
    }
  })
})

describe('buildSendcmd', () => {
  it('emits valid sendcmd lines within the clip duration', () => {
    const traj = computeTrajectory([sample(0, 640), sample(4, 640)], 0, 5, W, H, 25, CFG)
    const cmd = buildSendcmd(traj, 5)
    const lines = cmd.trim().split('\n')
    expect(lines.length).toBeGreaterThan(3)
    for (const line of lines) {
      expect(line).toMatch(/^\d+\.\d{3} crop x \d+;$/)
      const t = parseFloat(line.split(' ')[0])
      expect(t).toBeLessThanOrEqual(5)
    }
    const xs = lines.map((l) => parseInt(l.split('crop x ')[1], 10))
    expect(new Set(xs).size).toBe(1) // static ball -> one x value
  })
})

describe('staticCropFilter', () => {
  it('covers the full height', () => {
    expect(staticCropFilter(1280, 720)).toBe('crop=405:720')
  })
})
