import { describe, expect, it } from 'vitest'
import { OCRSample, Score } from '../src/shared/contracts'
import { detectScoreChanges, validateTransition } from '../src/main/detection/score_state'

const CFG = { confirmation_reads: 3, confirmation_window_seconds: 3 }

function ok(timestamp: number, home: number, away: number, confidence = 0.95): OCRSample {
  return { timestamp, ok: true, score: { home, away }, confidence }
}

function bad(timestamp: number): OCRSample {
  return { timestamp, ok: false, confidence: 0.1 }
}

describe('validateTransition (PRD 14.3)', () => {
  const s = (h: number, a: number): Score => ({ home: h, away: a })
  it('accepts +1 transitions', () => {
    expect(validateTransition(s(1, 0), s(2, 0))).toBe('valid')
    expect(validateTransition(s(1, 0), s(1, 1))).toBe('valid')
  })
  it('marks small multi-step increases suspicious', () => {
    expect(validateTransition(s(1, 0), s(3, 0))).toBe('suspicious')
  })
  it('rejects impossible jumps and decreases', () => {
    expect(validateTransition(s(1, 0), s(8, 0))).toBe('invalid')
    expect(validateTransition(s(2, 1), s(1, 1))).toBe('invalid')
    expect(validateTransition(s(1, 0), s(0, 1))).toBe('invalid')
  })
})

describe('score state machine (PRD 14)', () => {
  it('establishes the baseline without creating an event', () => {
    const result = detectScoreChanges(
      [ok(1, 1, 0), ok(2, 1, 0), ok(3, 1, 0), ok(4, 1, 0)],
      CFG
    )
    expect(result.baseline).toEqual({ home: 1, away: 0 })
    expect(result.changes).toHaveLength(0)
  })

  it('rejects a one-off OCR anomaly (8:0)', () => {
    const result = detectScoreChanges(
      [ok(1, 1, 0), ok(2, 1, 0), ok(3, 1, 0), ok(10, 8, 0), ok(11, 1, 0), ok(12, 1, 0)],
      CFG
    )
    expect(result.baseline).toEqual({ home: 1, away: 0 })
    expect(result.changes).toHaveLength(0)
    expect(result.rejected).toHaveLength(0) // 8:0 never stabilized
  })

  it('confirms a valid score change after repeated reads', () => {
    const result = detectScoreChanges(
      [ok(1, 1, 0), ok(2, 1, 0), ok(3, 1, 0), ok(10, 2, 0), ok(11, 2, 0), ok(12, 2, 0), ok(13, 2, 0)],
      CFG
    )
    expect(result.changes).toHaveLength(1)
    const change = result.changes[0]
    expect(change.from).toEqual({ home: 1, away: 0 })
    expect(change.to).toEqual({ home: 2, away: 0 })
    expect(change.validation).toBe('valid')
    expect(change.changeTime).toBe(10)
    expect(change.confirmedAt).toBe(12)
  })

  it('requires confirmation within the confirmation window', () => {
    // Reads spaced 5s apart: window (3s) expires, change must not confirm.
    const result = detectScoreChanges(
      [ok(1, 1, 0), ok(2, 1, 0), ok(3, 1, 0), ok(10, 2, 0), ok(15, 2, 0), ok(20, 2, 0)],
      CFG
    )
    expect(result.changes).toHaveLength(0)
  })

  it('rejects invalid decreases explicitly', () => {
    const result = detectScoreChanges(
      [ok(1, 2, 1), ok(2, 2, 1), ok(3, 2, 1), ok(10, 1, 1), ok(11, 1, 1), ok(12, 1, 1)],
      CFG
    )
    expect(result.changes).toHaveLength(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].reason).toContain('invalid transition')
  })

  it('flags multi-step increases as suspicious', () => {
    const result = detectScoreChanges(
      [ok(1, 1, 0), ok(2, 1, 0), ok(3, 1, 0), ok(10, 3, 0), ok(10.5, 3, 0), ok(11, 3, 0)],
      CFG
    )
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].validation).toBe('suspicious')
  })

  it('ignores unreadable samples', () => {
    const result = detectScoreChanges(
      [bad(1), bad(2), ok(3, 0, 0), bad(4), ok(5, 0, 0), ok(6, 0, 0)],
      CFG
    )
    expect(result.baseline).toEqual({ home: 0, away: 0 })
  })

  it('does not emit a change for alternating noise', () => {
    const result = detectScoreChanges(
      [
        ok(1, 1, 0), ok(2, 1, 0), ok(3, 1, 0),
        ok(4, 2, 0), ok(5, 1, 0), ok(6, 2, 0), ok(7, 1, 0), ok(8, 1, 0)
      ],
      CFG
    )
    expect(result.changes).toHaveLength(0)
  })

  it('supports an initial baseline for fine-scan windows', () => {
    const result = detectScoreChanges(
      [ok(10, 2, 0), ok(10.2, 2, 0), ok(10.4, 2, 0)],
      { confirmation_reads: 2, confirmation_window_seconds: 2 },
      { initialBaseline: { home: 1, away: 0 } }
    )
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].from).toEqual({ home: 1, away: 0 })
    expect(result.changes[0].to).toEqual({ home: 2, away: 0 })
  })

  it('handles a score correction back to an earlier value', () => {
    // 2:1 shown, then corrected to 1:1 (disallowed goal). Both are stable reads.
    const result = detectScoreChanges(
      [
        ok(1, 1, 1), ok(2, 1, 1), ok(3, 1, 1),
        ok(20, 2, 1), ok(21, 2, 1), ok(22, 2, 1),
        ok(60, 1, 1), ok(61, 1, 1), ok(62, 1, 1)
      ],
      CFG
    )
    expect(result.changes).toHaveLength(1) // 1:1 -> 2:1 valid
    expect(result.rejected).toHaveLength(1) // 2:1 -> 1:1 decrease rejected
    expect(result.changes[0].to).toEqual({ home: 2, away: 1 })
  })
})
