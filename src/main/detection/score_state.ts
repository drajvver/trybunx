import { OCRSample, Score, ScoreChange, ScoreChangeValidation } from '../../shared/contracts'
import { sameScore } from '../../shared/config'

export interface ScoreStateConfig {
  confirmation_reads: number
  confirmation_window_seconds: number
}

export interface RejectedTransition {
  from: Score
  to: Score
  around: number
  reason: string
}

export interface ScoreDetectionResult {
  /** First stable score in the VOD. Never produces an event (PRD 14.1). */
  baseline: Score | null
  baselineTime: number | null
  changes: ScoreChange[]
  rejected: RejectedTransition[]
}

/**
 * Validate a score transition (PRD 14.3):
 *  - exactly one team +1                -> valid
 *  - one team +2..+3                    -> suspicious (fine scan may resolve)
 *  - one team +4 or more (e.g. 1:0->8:0) -> invalid OCR anomaly
 *  - any decrease or both teams changing -> invalid
 */
export function validateTransition(from: Score, to: Score): ScoreChangeValidation {
  const dHome = to.home - from.home
  const dAway = to.away - from.away
  if (dHome === 0 && dAway === 0) return 'invalid' // not a change at all
  if (dHome < 0 || dAway < 0) return 'invalid'
  if (dHome > 0 && dAway > 0) return 'invalid'
  const increase = Math.max(dHome, dAway)
  if (increase === 1) return 'valid'
  if (increase <= 3) return 'suspicious'
  return 'invalid'
}

interface RecentRead {
  timestamp: number
  score: Score
}

/**
 * Deterministic score state machine over an ordered list of OCR samples
 * (PRD section 14). A score is accepted only after `confirmation_reads`
 * occurrences within `confirmation_window_seconds` (repeated confirmation,
 * not necessarily consecutive). Pure function of the sample list.
 */
export function detectScoreChanges(
  samples: OCRSample[],
  cfg: ScoreStateConfig,
  options: { initialBaseline?: Score | null } = {}
): ScoreDetectionResult {
  const sorted = samples.filter((s) => s.ok && s.score).sort((a, b) => a.timestamp - b.timestamp)
  const changes: ScoreChange[] = []
  const rejected: RejectedTransition[] = []

  let baseline = options.initialBaseline ?? null
  let baselineTime: number | null = options.initialBaseline ? (sorted[0]?.timestamp ?? null) : null
  let current: Score | null = baseline
  let recent: RecentRead[] = []

  const countInWindow = (score: Score): number =>
    recent.reduce((n, r) => (sameScore(r.score, score) ? n + 1 : n), 0)

  for (const sample of sorted) {
    const score = sample.score!
    const t = sample.timestamp

    // Keep only reads inside the confirmation window.
    recent = recent.filter((r) => t - r.timestamp <= cfg.confirmation_window_seconds)
    recent.push({ timestamp: t, score })

    if (!baseline) {
      // Establish the initial stable score; never emits an event (PRD 14.1).
      if (countInWindow(score) >= cfg.confirmation_reads) {
        baseline = score
        baselineTime = recent.find((r) => sameScore(r.score, score))!.timestamp
        current = baseline
        recent = []
      }
      continue
    }

    if (sameScore(score, current)) {
      // No change; reset the candidate window.
      recent = []
      continue
    }

    if (countInWindow(score) >= cfg.confirmation_reads) {
      const firstSeen = recent.find((r) => sameScore(r.score, score))!.timestamp
      if (!current) continue
      const validation = validateTransition(current, score)
      if (validation === 'valid' || validation === 'suspicious') {
        changes.push({
          from: current,
          to: score,
          changeTime: firstSeen,
          confirmedAt: t,
          validation,
          refined: false
        })
        current = score
      } else {
        rejected.push({
          from: current,
          to: score,
          around: firstSeen,
          reason: `invalid transition ${current.home}:${current.away} -> ${score.home}:${score.away}`
        })
        // Do not adopt an invalid score; the previous score remains current.
      }
      recent = []
    }
  }

  return { baseline, baselineTime, changes, rejected }
}
