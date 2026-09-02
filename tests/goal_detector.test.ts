import { describe, expect, it } from 'vitest'
import { AudioWindow } from '../src/shared/contracts'
import { estimateEventTime } from '../src/main/detection/goal_detector'
import { computeClipWindow } from '../src/main/clips/generator'

const GD = {
  audio_lookback_seconds: 12,
  fallback_offset_seconds: 4,
  dedup_seconds: 20,
  peak_metric: 'rms' as const,
  strong_spike_threshold_db: 8,
  confidence_weights: {
    score_change: 0.7,
    audio_spike: 0.15,
    keyword: 0.1,
    agreeing_signals: 0.05
  }
}

function win(t: number, rmsDb: number, deltaDb = 0): AudioWindow {
  return { timestamp: t, rms: Math.pow(10, rmsDb / 20), rmsDb, baselineDb: rmsDb - deltaDb, deltaDb }
}

describe('event timestamp estimation (PRD 17)', () => {
  it('uses the audio onset within the lookback window (goal roar start)', () => {
    const windows = [
      win(4010, -30),
      win(4032.2, -18, 12), // goal roar onset
      win(4034, -17.5, 13), // marginally louder later
      win(4036, -25, 3),
      win(4038, -28) // score change time
    ]
    const result = estimateEventTime(4038, windows, GD, 5524)
    expect(result.usedFallback).toBe(false)
    expect(result.eventTime).toBeCloseTo(4032.2, 5)
  })

  it('respects the lookback window (ignores older peaks)', () => {
    const windows = [
      win(4000, -5), // loud but too old
      win(4030, -20, 9),
      win(4038, -28)
    ]
    const result = estimateEventTime(4038, windows, GD, 5524)
    expect(result.eventTime).toBeCloseTo(4030, 5)
  })

  it('falls back to change time minus offset when audio is flat', () => {
    const windows = [win(4030, -40, 1), win(4036, -40, 0.5)]
    const result = estimateEventTime(4038, windows, GD, 5524)
    expect(result.usedFallback).toBe(true)
    expect(result.eventTime).toBeCloseTo(4034, 5)
  })

  it('falls back when there is no audio at all', () => {
    const result = estimateEventTime(4038, [], GD, 5524)
    expect(result.usedFallback).toBe(true)
    expect(result.eventTime).toBeCloseTo(4034, 5)
  })
})

describe('clip window computation (PRD 23)', () => {
  const clips = {
    goal_pre_roll_seconds: 14,
    goal_post_roll_seconds: 12,
    max_clip_seconds: 30,
    create_clips_for_unknown: false,
    encoding: 'reencode' as const,
    video_crf: 23,
    video_preset: 'veryfast'
  }

  it('produces pre/post roll windows', () => {
    const w = computeClipWindow(4034.2, 5524, clips)
    expect(w.start).toBeCloseTo(4020.2, 3)
    expect(w.end).toBeCloseTo(4046.2, 3)
  })

  it('clamps at the start of the file (PRD 23.1 example)', () => {
    const w = computeClipWindow(5, 5524, clips)
    expect(w.start).toBe(0)
    expect(w.end).toBeCloseTo(17, 3)
  })

  it('clamps at the end of the file', () => {
    const w = computeClipWindow(5520, 5524, clips)
    expect(w.end).toBe(5524)
    expect(w.end - w.start).toBeLessThanOrEqual(clips.max_clip_seconds)
  })

  it('never exceeds max_clip_seconds', () => {
    const w = computeClipWindow(100, 5524, {
      ...clips,
      goal_pre_roll_seconds: 20,
      goal_post_roll_seconds: 20
    })
    expect(w.end - w.start).toBeLessThanOrEqual(30)
  })
})
