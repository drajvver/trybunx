import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, parseScore, resolveConfig, deepMerge, sanitizeRoi } from '../src/shared/config'

describe('config', () => {
  it('merges partial overrides over defaults', () => {
    const cfg = resolveConfig({ clips: { goal_pre_roll_seconds: 5 } })
    expect(cfg.clips.goal_pre_roll_seconds).toBe(5)
    expect(cfg.clips.goal_post_roll_seconds).toBe(DEFAULT_CONFIG.clips.goal_post_roll_seconds)
    expect(cfg.analysis.ocr_interval_ms).toBe(DEFAULT_CONFIG.analysis.ocr_interval_ms)
  })

  it('rejects nonsensical values', () => {
    expect(() => resolveConfig({ clips: { max_clip_seconds: 0 } })).toThrow()
    expect(() => resolveConfig({ clips: { max_clip_seconds: NaN } })).toThrow()
    expect(() => resolveConfig({ clips: { goal_pre_roll_seconds: -1 } })).toThrow()
    expect(() => resolveConfig({ audio: null })).toThrow()
    expect(() => resolveConfig({ vertical: { ball_trust: '0.5' } })).toThrow()
    expect(() => resolveConfig({ clips: { encoding: 'flac' } })).toThrow()
    expect(() => resolveConfig({ ocr: { engine: 'magic' } })).toThrow()
    expect(() => resolveConfig({ ocr: { provider: 'cuda' } })).toThrow()
    expect(() => resolveConfig({ analysis: { decode_acceleration: 'cuda' } })).toThrow()
  })
})

describe('score parsing', () => {
  it('parses common scoreboard formats', () => {
    expect(parseScore('1:0')).toEqual({ home: 1, away: 0 })
    expect(parseScore('2 - 1')).toEqual({ home: 2, away: 1 })
    expect(parseScore(' 0:0 ')).toEqual({ home: 0, away: 0 })
    expect(parseScore('12:30')).toEqual({ home: 12, away: 30 })
  })

  it('rejects garbage', () => {
    expect(parseScore('AB:CD')).toBeNull()
    expect(parseScore('')).toBeNull()
    expect(parseScore('123:45')).toBeNull()
  })
})

describe('roi sanitizing', () => {
  it('clamps out-of-bounds ROIs', () => {
    const roi = sanitizeRoi({ x: -0.1, y: 0.9, width: 0.5, height: 0.5 })
    expect(roi!.x).toBe(0)
    expect(roi!.y).toBeCloseTo(0.9, 6)
    expect(roi!.width).toBeCloseTo(0.5, 6)
    expect(roi!.height).toBeCloseTo(0.1, 6)
  })

  it('rejects degenerate ROIs', () => {
    expect(sanitizeRoi({ x: 0.5, y: 0.5, width: 0, height: 0.1 })).toBeNull()
  })
})

describe('deepMerge', () => {
  it('overrides nested keys without clobbering siblings', () => {
    const merged = deepMerge({ a: { b: 1, c: 2 }, d: 3 }, { a: { b: 9 } })
    expect(merged).toEqual({ a: { b: 9, c: 2 }, d: 3 })
  })
})
