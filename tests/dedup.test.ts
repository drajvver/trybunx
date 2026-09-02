import { describe, expect, it } from 'vitest'
import { DetectedEvent } from '../src/shared/contracts'
import { dedupeGoalEvents } from '../src/main/detection/dedup'

function goal(id: string, eventTime: number, before: string, after: string): DetectedEvent {
  return {
    id,
    type: 'GOAL',
    event_time: eventTime,
    confidence: 0.9,
    score_before: before,
    score_after: after,
    signals: { score_change: true, audio_spike: false }
  }
}

describe('goal deduplication (PRD 22)', () => {
  it('drops duplicate detections of the same transition', () => {
    const events = [
      goal('a', 100, '1:0', '2:0'),
      goal('b', 108, '1:0', '2:0'),
      goal('c', 130, '1:0', '2:0')
    ]
    const deduped = dedupeGoalEvents(events, 20)
    expect(deduped.map((e) => e.id)).toEqual(['a', 'c'])
  })

  it('never merges different transitions (PRD 22 example)', () => {
    const events = [
      goal('a', 100, '1:0', '2:0'),
      goal('b', 105, '2:0', '2:1')
    ]
    const deduped = dedupeGoalEvents(events, 20)
    expect(deduped).toHaveLength(2)
  })

  it('keeps the same transition when it happens after the window', () => {
    const events = [
      goal('a', 100, '1:0', '2:0'),
      goal('b', 121, '1:0', '2:0')
    ]
    expect(dedupeGoalEvents(events, 20)).toHaveLength(2)
  })
})
