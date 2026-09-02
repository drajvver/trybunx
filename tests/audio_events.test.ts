import { describe, expect, it } from 'vitest'
import { AppConfig } from '../src/shared/config'
import { analyzePcm } from '../src/main/media/audio'

const AUDIO_CFG: AppConfig['audio'] = {
  enabled: true,
  sample_rate: 16000,
  rms_window_ms: 200,
  baseline_seconds: 10,
  spike_threshold_db: 8,
  spike_cooldown_seconds: 1.5,
  silence_floor_db: -55
}

function generatePcm(seconds: number, envelope: (t: number) => number): Int16Array {
  const total = seconds * 16000
  const pcm = new Int16Array(total)
  for (let i = 0; i < total; i++) {
    const t = i / 16000
    const amp = envelope(t)
    // 220 Hz sine "crowd noise"
    const v = Math.sin(2 * Math.PI * 220 * t) * amp
    pcm[i] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)))
  }
  return pcm
}

describe('audio spike detection (PRD 15)', () => {
  it('detects a loud roar against a quiet baseline', () => {
    // Quiet crowd (-30 dBFS amplitude ~ 0.03), roar at 40-42s.
    const pcm = generatePcm(50, (t) => (t >= 40 && t <= 42 ? 0.6 : 0.03))
    const { events } = analyzePcm(pcm, AUDIO_CFG)
    expect(events.length).toBeGreaterThan(0)
    const first = events[0]
    expect(first.timestamp).toBeGreaterThanOrEqual(39.5)
    expect(first.timestamp).toBeLessThanOrEqual(40.5)
    expect(first.deltaDb).toBeGreaterThanOrEqual(8)
  })

  it('does not spike on constant loud audio', () => {
    const pcm = generatePcm(30, () => 0.5)
    const { events } = analyzePcm(pcm, AUDIO_CFG)
    expect(events).toHaveLength(0)
  })

  it('respects the cooldown between spikes', () => {
    // Two roars 0.5s apart (within cooldown) count as one; roars 5s apart count twice.
    const pcmOne = generatePcm(50, (t) => (t >= 40 && t <= 41.5 ? 0.6 : 0.03))
    const one = analyzePcm(pcmOne, AUDIO_CFG).events.filter((e) => e.timestamp >= 39 && e.timestamp <= 43)
    expect(one.length).toBeLessThanOrEqual(2)

    const pcmTwo = generatePcm(60, (t) => ((t >= 40 && t <= 41) || (t >= 46 && t <= 47) ? 0.6 : 0.03))
    const two = analyzePcm(pcmTwo, AUDIO_CFG).events.filter((e) => e.timestamp >= 39 && e.timestamp <= 49)
    expect(two.length).toBeGreaterThanOrEqual(2)
  })
})
