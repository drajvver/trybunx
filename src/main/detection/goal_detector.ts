import { AppConfig } from '../../shared/config'

/**
 * Estimate the real event time for a score change (PRD section 17):
 * the scoreboard usually updates after the actual goal, so we look back into
 * the audio and use the strongest excitement peak as the event time.
 */
export interface EventTiming {
  eventTime: number
  peak: { timestamp: number; deltaDb: number; rmsDb: number } | null
  usedFallback: boolean
}

export interface AudioWindowLike {
  timestamp: number
  rmsDb: number
  deltaDb: number
}

export function estimateEventTime(
  changeTime: number,
  windows: AudioWindowLike[],
  cfg: AppConfig['goal_detection'],
  durationSeconds: number,
  silenceFloorDb = -55
): EventTiming {
  const lookbackStart = Math.max(0, changeTime - cfg.audio_lookback_seconds)
  const inWindow = windows.filter((w) => w.timestamp >= lookbackStart && w.timestamp <= changeTime)

  const fallbackTime = Math.max(0, Math.min(changeTime - cfg.fallback_offset_seconds, durationSeconds))

  if (inWindow.length === 0) {
    return { eventTime: fallbackTime, peak: null, usedFallback: true }
  }

  const metric = (w: AudioWindowLike) => (cfg.peak_metric === 'delta' ? w.deltaDb : w.rmsDb)

  let best = inWindow[0]
  for (const w of inWindow) {
    if (metric(w) > metric(best)) best = w
  }

  // Prefer the onset of the excitement (the goal moment) over a marginally
  // louder window deeper into the roar: take the earliest window within 1 dB
  // of the strongest one.
  const onsetThreshold = metric(best) - 1.0
  const onset = inWindow.find((w) => metric(w) >= onsetThreshold) ?? best
  const isStrong = onset.deltaDb >= cfg.strong_spike_threshold_db && onset.rmsDb >= silenceFloorDb
  const peak = { timestamp: onset.timestamp, deltaDb: onset.deltaDb, rmsDb: onset.rmsDb }

  if (!isStrong) {
    return { eventTime: fallbackTime, peak, usedFallback: true }
  }
  return { eventTime: onset.timestamp, peak, usedFallback: false }
}
