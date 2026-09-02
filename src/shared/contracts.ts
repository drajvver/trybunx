/**
 * Shared, language-neutral data contracts between the Electron/TypeScript app
 * and any Python analysis workers. Serialized forms use plain JSON types.
 */

/** Normalized rectangle in frame coordinates, all values 0..1. */
export interface Roi {
  x: number
  y: number
  width: number
  height: number
}

export interface MediaInfo {
  path: string
  container?: string
  durationSeconds: number
  width: number
  height: number
  fps: number
  videoCodec?: string
  audioCodec?: string
  hasVideo: boolean
  hasAudio: boolean
}

export interface Score {
  home: number
  away: number
}

/** One OCR reading of the scoreboard ROI. Timestamps are seconds from media start. */
export interface OCRSample {
  timestamp: number
  ok: boolean
  score?: Score
  confidence: number
  raw?: string
}

export type ScoreChangeValidation = 'valid' | 'suspicious' | 'invalid'

export interface ScoreChange {
  from: Score
  to: Score
  /** Earliest appearance time of the new score (seconds). */
  changeTime: number
  /** Time at which the new score was confirmed stable. */
  confirmedAt: number
  validation: ScoreChangeValidation
  refined: boolean
}

export interface AudioEvent {
  type: 'audio_spike'
  timestamp: number
  deltaDb: number
  rmsDb: number
}

export interface AudioWindow {
  timestamp: number
  rms: number
  rmsDb: number
  baselineDb: number
  deltaDb: number
}

/** Optional future component (v0.2+). */
export interface SpeechSegment {
  start: number
  end: number
  text: string
}

export type SignalType = 'score_change' | 'audio_spike' | 'keyword'

export interface DetectionSignal {
  type: SignalType
  timestamp: number
  payload: Record<string, unknown>
}

export type EventType = 'GOAL' | 'UNKNOWN_INTERESTING'

export interface EventSignals {
  score_change: boolean
  audio_spike: boolean
  audio_delta_db?: number
  keyword_goal?: boolean
}

export interface ClipInfo {
  path: string
  startSeconds: number
  endSeconds: number
  durationSeconds: number
  reencoded: boolean
}

export interface DetectedEvent {
  id: string
  type: EventType
  /** Estimated real-world event time (seconds from media start). */
  event_time: number
  /** Time of the scoreboard change that produced this event, if any. */
  detected_from_score_change?: number
  confidence: number
  score_before?: string
  score_after?: string
  signals: EventSignals
  clip?: ClipInfo
}

export interface ClipRequest {
  id: string
  eventId: string
  start: number
  end: number
  outputPath: string
}

export type StageName =
  | 'prepare'
  | 'scoreboard_scan'
  | 'audio_analysis'
  | 'build_events'
  | 'generate_clips'
  | 'write_outputs'

export type StageStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped' | 'cancelled'

export interface StageState {
  name: StageName
  status: StageStatus
  progress?: number
  detail?: string
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface AnalysisJob {
  id: string
  inputFile: string
  outputDir: string
  status: JobStatus
  stages: StageState[]
  startedAt?: string
  finishedAt?: string
  error?: string
}

export interface AnalysisMetadata {
  input_file: string
  output_dir: string
  duration_seconds: number
  video_resolution: string
  analysis_started_at: string
  analysis_finished_at?: string
  ocr_samples: number
  ocr_ok_samples: number
  fine_scan_windows: number
  audio_spikes_detected: number
  score_changes_detected: number
  goal_events_created: number
  clips_created: number
  processing_seconds: number
  degraded: string[]
  config_used: unknown
}

export interface AnalysisResult {
  events: DetectedEvent[]
  analysis: AnalysisMetadata
}

/** Structured request/result frames for the Python worker (JSON Lines). */
export interface WorkerRequest {
  id: string
  op: string
  params: Record<string, unknown>
}

export interface WorkerResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
  progress?: { done: number; total: number }
}
