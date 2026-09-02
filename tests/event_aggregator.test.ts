import { describe, expect, it } from 'vitest'
import { DetectionSignal } from '../src/shared/contracts'
import { collectSignals, classifyCluster, clusterSignals } from '../src/main/detection/event_aggregator'
import { DEFAULT_CONFIG } from '../src/shared/config'

describe('signal clustering (PRD 19)', () => {
  it('groups signals within the event window', () => {
    const signals: DetectionSignal[] = [
      { type: 'audio_spike', timestamp: 4032.1, payload: { delta_db: 12 } },
      { type: 'score_change', timestamp: 4038, payload: { score_before: '1:0', score_after: '2:0', validation: 'valid' } },
      { type: 'audio_spike', timestamp: 4100, payload: { delta_db: 10 } }
    ]
    const clusters = clusterSignals(signals, 8)
    expect(clusters).toHaveLength(2)
    expect(clusters[0].signals).toHaveLength(2)
    expect(clusters[1].signals).toHaveLength(1)
  })

  it('classifies a cluster with a score change as GOAL', () => {
    const signals: DetectionSignal[] = [
      { type: 'audio_spike', timestamp: 4032.1, payload: { delta_db: 13.8 } },
      { type: 'score_change', timestamp: 4038, payload: { score_before: '1:0', score_after: '2:0', validation: 'valid' } }
    ]
    const [cluster] = clusterSignals(signals, 8)
    const event = classifyCluster(cluster, DEFAULT_CONFIG)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('GOAL')
    expect(event!.scoreBefore).toBe('1:0')
    expect(event!.scoreAfter).toBe('2:0')
    // 0.70 + 0.15 + 0.05 (agreeing signals)
    expect(event!.confidence).toBeCloseTo(0.9, 3)
  })

  it('classifies audio-only clusters as UNKNOWN_INTERESTING', () => {
    const signals: DetectionSignal[] = [{ type: 'audio_spike', timestamp: 100, payload: { delta_db: 12 } }]
    const [cluster] = clusterSignals(signals, 8)
    const event = classifyCluster(cluster, DEFAULT_CONFIG)
    expect(event!.type).toBe('UNKNOWN_INTERESTING')
    expect(event!.signals.score_change).toBe(false)
  })

  it('collectSignals flattens score changes and audio events', () => {
    const signals = collectSignals({
      scoreChanges: [{ from: { home: 1, away: 0 }, to: { home: 2, away: 0 }, changeTime: 4038, validation: 'valid' }],
      audioEvents: [{ timestamp: 4032.1, deltaDb: 12 }]
    })
    expect(signals.map((s) => s.type)).toEqual(['audio_spike', 'score_change'])
  })
})
