import { DetectedEvent } from '../../shared/contracts'

/**
 * Semantic deduplication (PRD section 22): at most one goal event per logical
 * score transition within a time window. Different transitions (1:0 -> 2:0
 * followed by 2:0 -> 2:1) are always separate events.
 */
export function dedupeGoalEvents(events: DetectedEvent[], dedupSeconds: number): DetectedEvent[] {
  const kept: DetectedEvent[] = []
  const lastOfKey = new Map<string, number>()

  for (const event of events) {
    if (event.type !== 'GOAL') {
      kept.push(event)
      continue
    }
    const key = `${event.score_before}|${event.score_after}`
    const last = lastOfKey.get(key)
    if (last !== undefined && event.event_time - last < dedupSeconds) {
      continue
    }
    lastOfKey.set(key, event.event_time)
    kept.push(event)
  }
  return kept
}
