import { DetectionSignal, EventType, EventSignals } from '../../shared/contracts'
import { AppConfig, scoreToString } from '../../shared/config'

export interface SignalInput {
  scoreChanges: Array<{ from: { home: number; away: number }; to: { home: number; away: number }; changeTime: number; validation: string }>
  audioEvents: Array<{ timestamp: number; deltaDb: number }>
  speechSegments?: Array<{ start: number; text: string }>
}

/** Flatten all raw detections into typed signals (PRD section 19). */
export function collectSignals(input: SignalInput): DetectionSignal[] {
  const signals: DetectionSignal[] = []
  for (const c of input.scoreChanges) {
    signals.push({
      type: 'score_change',
      timestamp: c.changeTime,
      payload: {
        score_before: scoreToString(c.from),
        score_after: scoreToString(c.to),
        validation: c.validation
      }
    })
  }
  for (const a of input.audioEvents) {
    signals.push({
      type: 'audio_spike',
      timestamp: a.timestamp,
      payload: { delta_db: a.deltaDb }
    })
  }
  if (input.speechSegments) {
    for (const s of input.speechSegments) {
      signals.push({ type: 'keyword', timestamp: s.start, payload: { text: s.text } })
    }
  }
  return signals.sort((a, b) => a.timestamp - b.timestamp)
}

export interface SignalCluster {
  start: number
  end: number
  signals: DetectionSignal[]
}

/** Cluster signals by timestamp with a maximum gap (PRD section 19). */
export function clusterSignals(signals: DetectionSignal[], windowSeconds: number): SignalCluster[] {
  const clusters: SignalCluster[] = []
  let current: SignalCluster | null = null
  for (const s of signals) {
    if (!current || s.timestamp - current.end > windowSeconds) {
      current = { start: s.timestamp, end: s.timestamp, signals: [s] }
      clusters.push(current)
    } else {
      current.end = s.timestamp
      current.signals.push(s)
    }
  }
  return clusters
}

export interface AggregationEvent {
  type: EventType
  confidence: number
  signals: EventSignals
  scoreBefore?: string
  scoreAfter?: string
  detectedFromScoreChange?: number
  changeValidation?: string
}

/** Classify one cluster of signals (PRD section 20). */
export function classifyCluster(cluster: SignalCluster, cfg: AppConfig): AggregationEvent | null {
  const scoreSignal = cluster.signals.find((s) => s.type === 'score_change')
  const audioSignals = cluster.signals.filter((s) => s.type === 'audio_spike')
  const keywordSignals = cluster.signals.filter((s) => s.type === 'keyword')

  if (scoreSignal) {
    const bestDelta = audioSignals.length
      ? Math.max(...audioSignals.map((s) => s.payload.delta_db as number))
      : undefined
    const w = cfg.goal_detection.confidence_weights
    let confidence = w.score_change
    if (audioSignals.length > 0) confidence += w.audio_spike
    if (audioSignals.length > 0 && w.agreeing_signals) confidence += w.agreeing_signals
    if (keywordSignals.length > 0) confidence += w.keyword
    const validation = scoreSignal.payload.validation as string
    if (validation !== 'valid') confidence -= 0.1

    return {
      type: 'GOAL',
      confidence: Number(Math.max(0.01, Math.min(0.99, confidence)).toFixed(3)),
      signals: {
        score_change: true,
        audio_spike: audioSignals.length > 0,
        audio_delta_db: bestDelta !== undefined ? Number(bestDelta.toFixed(2)) : undefined,
        keyword_goal: keywordSignals.length > 0
      },
      scoreBefore: scoreSignal.payload.score_before as string,
      scoreAfter: scoreSignal.payload.score_after as string,
      detectedFromScoreChange: scoreSignal.timestamp,
      changeValidation: validation
    }
  }

  // Audio-only clusters are interesting but not goals in v0.1.
  // They are recorded for tuning but do not produce clips by default.
  const bestDelta = audioSignals.length
    ? Math.max(...audioSignals.map((s) => s.payload.delta_db as number))
    : 0
  return {
    type: 'UNKNOWN_INTERESTING',
    confidence: Number(Math.min(0.4, 0.15 + bestDelta / 100).toFixed(3)),
    signals: {
      score_change: false,
      audio_spike: audioSignals.length > 0,
      audio_delta_db: Number(bestDelta.toFixed(2)),
      keyword_goal: keywordSignals.length > 0
    }
  }
}
