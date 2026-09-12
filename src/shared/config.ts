import { Roi, Score } from './contracts'

export interface ConfidenceWeights {
  score_change: number
  audio_spike: number
  keyword: number
  agreeing_signals: number
}

export interface AppConfig {
  analysis: {
    ocr_interval_ms: number
    fine_ocr_interval_ms: number
    fine_scan_margin_seconds: number
    event_window_seconds: number
    refine_change_times: boolean
    decode_acceleration: 'auto' | 'videotoolbox' | 'software'
  }
  ocr: {
    engine: 'neural' | 'tesseract'
    provider: 'auto' | 'coreml' | 'cpu'
    fallback_to_tesseract: boolean
    change_detection_enabled: boolean
    change_threshold: number
    refresh_interval_seconds: number
    confirmation_reads: number
    confirmation_window_seconds: number
    upscale: number
    min_confidence: number
    max_reasonable_score: number
    worker_batch_size: number
  }
  audio: {
    enabled: boolean
    sample_rate: number
    rms_window_ms: number
    baseline_seconds: number
    spike_threshold_db: number
    spike_cooldown_seconds: number
    silence_floor_db: number
  }
  goal_detection: {
    audio_lookback_seconds: number
    fallback_offset_seconds: number
    dedup_seconds: number
    peak_metric: 'rms' | 'delta'
    strong_spike_threshold_db: number
    confidence_weights: ConfidenceWeights
  }
  clips: {
    goal_pre_roll_seconds: number
    goal_post_roll_seconds: number
    max_clip_seconds: number
    create_clips_for_unknown: boolean
    encoding: 'reencode' | 'copy'
    video_crf: number
    video_preset: string
  }
  vertical: VerticalClipConfig
  output: {
    dir: string
  }
}

export interface VerticalClipConfig {
  enabled: boolean
  width: number
  height: number
  /** Action position samples per second for the tracking pass. */
  track_sample_fps: number
  model_path: string
  /** Optional football-specific PyTorch detector; requires the tracking Python extra. */
  ball_model_path: string
  ball_input_size: number
  /** Ball sightings below this are ignored (the player cluster still applies). */
  min_confidence: number
  /** Ball must reach this confidence to override the cluster. */
  ball_trust: number
  /** Person boxes below this are ignored by the cluster. */
  person_confidence: number
  /** NMS IoU threshold for the person pass. */
  person_iou: number
  /** Tallest of the top-k person boxes is the action. */
  cluster_top_k: number
  /** Padding around the player span, in source pixels. */
  cluster_padding: number
  /** Min cluster confidence to link (0 = accept all). */
  cluster_trust: number
  /** Re-seed the track after this long lost (seconds). */
  resync_after_lost_seconds: number
  /** Moving-average smoothing window for the crop center (seconds). */
  smoothing_window_seconds: number
  /** Tracker sample rate the smoothing math was built for (gap detection). */
  sample_fps: number
  /** Maximum horizontal pan speed as a fraction of frame width per second. */
  max_pan_speed: number
  /** Hold the last known position this long after the action is lost. */
  lost_hold_seconds: number
  /** Ease back to center over this long when the action stays lost. */
  recenter_seconds: number
  video_preset: string
  video_crf: number
}

export const DEFAULT_CONFIG: AppConfig = {
  analysis: {
    ocr_interval_ms: 1000,
    fine_ocr_interval_ms: 200,
    fine_scan_margin_seconds: 2,
    event_window_seconds: 8,
    refine_change_times: true,
    decode_acceleration: 'auto'
  },
  ocr: {
    engine: 'neural',
    provider: 'auto',
    fallback_to_tesseract: false,
    change_detection_enabled: true,
    change_threshold: 2,
    refresh_interval_seconds: 30,
    confirmation_reads: 3,
    confirmation_window_seconds: 3,
    upscale: 3,
    min_confidence: 0.35,
    max_reasonable_score: 30,
    worker_batch_size: 64
  },
  audio: {
    enabled: true,
    sample_rate: 16000,
    rms_window_ms: 200,
    baseline_seconds: 10,
    spike_threshold_db: 8,
    spike_cooldown_seconds: 1.5,
    silence_floor_db: -55
  },
  goal_detection: {
    audio_lookback_seconds: 12,
    fallback_offset_seconds: 4,
    dedup_seconds: 20,
    peak_metric: 'rms',
    strong_spike_threshold_db: 8,
    confidence_weights: {
      score_change: 0.7,
      audio_spike: 0.15,
      keyword: 0.1,
      agreeing_signals: 0.05
    }
  },
  clips: {
    goal_pre_roll_seconds: 14,
    goal_post_roll_seconds: 12,
    max_clip_seconds: 30,
    create_clips_for_unknown: false,
    encoding: 'reencode',
    video_crf: 23,
    video_preset: 'veryfast'
  },
  vertical: {
    enabled: true,
    width: 1080,
    height: 1920,
    track_sample_fps: 3,
    model_path: 'python/track/models/ball.onnx',
    ball_model_path: '',
    ball_input_size: 2560,
    min_confidence: 0.05,
    ball_trust: 0.3,
    person_confidence: 0.25,
    person_iou: 0.5,
    cluster_top_k: 6,
    cluster_padding: 60,
    cluster_trust: 0,
    resync_after_lost_seconds: 3,
    smoothing_window_seconds: 1.0,
    sample_fps: 3,
    max_pan_speed: 0.6,
    lost_hold_seconds: 1.5,
    recenter_seconds: 1.0,
    video_preset: 'veryfast',
    video_crf: 23
  },
  output: {
    dir: 'output'
  }
}

export function scoreToString(s: Score): string {
  return `${s.home}:${s.away}`
}

export function parseScore(text: string): Score | null {
  const m = text.match(/^\s*(\d{1,2})\s*[:\-–—]\s*(\d{1,2})\s*$/)
  if (!m) return null
  return { home: parseInt(m[1], 10), away: parseInt(m[2], 10) }
}

export function sameScore(a?: Score | null, b?: Score | null): boolean {
  if (!a || !b) return false
  return a.home === b.home && a.away === b.away
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Clamp a normalized ROI to valid bounds and drop degenerate sizes. */
export function sanitizeRoi(roi: Roi): Roi | null {
  const x = clamp(roi.x, 0, 1)
  const y = clamp(roi.y, 0, 1)
  const w = clamp(roi.width, 0, 1 - x)
  const h = clamp(roi.height, 0, 1 - y)
  if (w <= 0.001 || h <= 0.001) return null
  return { x, y, width: w, height: h }
}

type PlainObject = Record<string, unknown>

function isPlainObject(v: unknown): v is PlainObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override) || !isPlainObject(base)) {
    return (override === undefined ? base : (override as T))
  }
  const out: PlainObject = { ...(base as PlainObject) }
  for (const [key, value] of Object.entries(override)) {
    const current = out[key]
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value
  }
  return out as T
}

/** Merge user-supplied partial config (from YAML or UI) over defaults. */
export function resolveConfig(...overrides: Array<unknown>): AppConfig {
  let cfg: AppConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  for (const o of overrides) {
    if (o === undefined || o === null) continue
    cfg = deepMerge(cfg, o)
  }
  validateConfig(cfg)
  return cfg
}

function validateConfig(cfg: AppConfig): void {
  if (cfg.analysis.ocr_interval_ms < 50) throw new Error('analysis.ocr_interval_ms must be >= 50')
  if (cfg.analysis.fine_ocr_interval_ms < 20) throw new Error('analysis.fine_ocr_interval_ms must be >= 20')
  if (!['auto', 'videotoolbox', 'software'].includes(cfg.analysis.decode_acceleration)) {
    throw new Error('analysis.decode_acceleration must be "auto", "videotoolbox", or "software"')
  }
  if (cfg.ocr.confirmation_reads < 2) throw new Error('ocr.confirmation_reads must be >= 2')
  if (cfg.ocr.engine !== 'neural' && cfg.ocr.engine !== 'tesseract') {
    throw new Error('ocr.engine must be "neural" or "tesseract"')
  }
  if (!['auto', 'coreml', 'cpu'].includes(cfg.ocr.provider)) {
    throw new Error('ocr.provider must be "auto", "coreml", or "cpu"')
  }
  if (cfg.ocr.change_threshold < 0) throw new Error('ocr.change_threshold must be >= 0')
  if (cfg.ocr.refresh_interval_seconds <= 0) {
    throw new Error('ocr.refresh_interval_seconds must be > 0')
  }
  if (cfg.audio.rms_window_ms < 10) throw new Error('audio.rms_window_ms must be >= 10')
  if (cfg.clips.max_clip_seconds <= 0) throw new Error('clips.max_clip_seconds must be > 0')
  if (cfg.clips.encoding !== 'reencode' && cfg.clips.encoding !== 'copy') {
    throw new Error('clips.encoding must be "reencode" or "copy"')
  }
  const v = (cfg as AppConfig).vertical
  if (v) {
    if (v.width <= 0 || v.height <= 0) throw new Error('vertical.width/height must be > 0')
    if (v.track_sample_fps <= 0 || v.track_sample_fps > 30) {
      throw new Error('vertical.track_sample_fps must be in (0, 30]')
    }
    if (v.min_confidence < 0 || v.min_confidence > 1) {
      throw new Error('vertical.min_confidence must be in [0, 1]')
    }
    if (v.person_confidence < 0 || v.person_confidence > 1) {
      throw new Error('vertical.person_confidence must be in [0, 1]')
    }
    if (v.person_iou < 0 || v.person_iou > 1) {
      throw new Error('vertical.person_iou must be in [0, 1]')
    }
    if (v.cluster_top_k < 1) throw new Error('vertical.cluster_top_k must be >= 1')
    if (v.cluster_padding < 0) throw new Error('vertical.cluster_padding must be >= 0')
    if (v.ball_trust < 0 || v.ball_trust > 1) {
      throw new Error('vertical.ball_trust must be in [0, 1]')
    }
    if (v.cluster_trust < 0 || v.cluster_trust > 1) {
      throw new Error('vertical.cluster_trust must be in [0, 1]')
    }
    if (v.resync_after_lost_seconds < 0) {
      throw new Error('vertical.resync_after_lost_seconds must be >= 0')
    }
    if (v.smoothing_window_seconds < 0) throw new Error('vertical.smoothing_window_seconds must be >= 0')
    if (v.max_pan_speed <= 0) throw new Error('vertical.max_pan_speed must be > 0')
    if (v.lost_hold_seconds < 0) throw new Error('vertical.lost_hold_seconds must be >= 0')
    if (v.recenter_seconds < 0) throw new Error('vertical.recenter_seconds must be >= 0')
    if (v.video_crf < 0 || v.video_crf > 51) throw new Error('vertical.video_crf must be in [0, 51]')
  }
}
