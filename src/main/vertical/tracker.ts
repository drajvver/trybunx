import { existsSync } from 'fs'
import { resolve } from 'path'
import { resourceRoot } from '../paths'
import { PythonWorker } from '../workers/python_worker'
import { resolveBinary } from '../media/process'
import { AppConfig, clamp } from '../../shared/config'

/** One action position sample. Coordinates are source-video pixels. */
export interface BallSample {
  /** Seconds from media start. */
  timestamp: number
  x: number
  y: number
  width: number
  height: number
  confidence: number
  lost: boolean
  /** 'ball' = opportunistic ball sighting, 'cluster' = player-cluster follow. */
  interpolated?: boolean
  kind?: 'ball' | 'cluster'
}

export interface BallTrack {
  samples: BallSample[]
  sourceWidth: number
  sourceHeight: number
  inferenceSeconds: number
}

interface WorkerTrackResult {
  samples: Array<{
    timestamp: number
    x?: number
    y?: number
    width?: number
    height?: number
    confidence?: number
    interpolated?: boolean
    kind?: 'ball' | 'cluster'
    lost?: boolean
  }>
  width: number
  height: number
  sample_count: number
  tracked_count: number
  mean_confidence: number
  inference_seconds: number
}

export interface TrackBallOptions {
  worker: PythonWorker
  inputPath: string
  start: number
  end: number
  sourceWidth: number
  sourceHeight: number
  cfg: AppConfig
  signal?: AbortSignal
  onProgress?: (done: number) => void
}

/**
 * Track the action over a clip window via the isolated Python worker.
 * The worker follows the player cluster with the same nano-YOLO pass and
 * uses the ball opportunistically when the model actually sees it.
 * Raises when the model is missing so the caller can use a static
 * center crop instead. Analysis-only: no clip cutting happens here.
 */
export async function trackBall(opts: TrackBallOptions): Promise<BallTrack> {
  opts.signal?.throwIfAborted()
  const modelPath = opts.cfg.vertical.model_path
  // The Python worker has its own cwd; always pass absolute resource paths.
  const root = resourceRoot()
  const resolvedModel = resolve(root, modelPath)
  if (!existsSync(resolvedModel)) {
    throw new Error(
      `Ball model not found at ${modelPath} (resolved ${resolvedModel}). ` +
        'Run: python/track/download_model.py'
    )
  }
  const result = await opts.worker.request<WorkerTrackResult>(
    'track_ball_video',
    {
      input_path: opts.inputPath,
      ffmpeg_path: resolveBinary('ffmpeg'),
      start: opts.start,
      end: opts.end,
      sample_fps: opts.cfg.vertical.track_sample_fps,
      model_path: resolvedModel,
      ball_model_path: opts.cfg.vertical.ball_model_path ? resolve(root, opts.cfg.vertical.ball_model_path) : '',
      ball_input_size: opts.cfg.vertical.ball_input_size,
      min_confidence: opts.cfg.vertical.min_confidence,
      ball_trust: opts.cfg.vertical.ball_trust,
      person_confidence: opts.cfg.vertical.person_confidence,
      person_iou: opts.cfg.vertical.person_iou,
      cluster_top_k: opts.cfg.vertical.cluster_top_k,
      cluster_padding: opts.cfg.vertical.cluster_padding,
      cluster_trust: opts.cfg.vertical.cluster_trust,
      resync_after_lost: opts.cfg.vertical.resync_after_lost_seconds,
      source_width: opts.sourceWidth,
      source_height: opts.sourceHeight
    },
    {
      timeoutMs: 30 * 60 * 1000,
      onProgress: (done) => opts.onProgress?.(done)
    }
  )

  const samples: BallSample[] = result.samples.map((s) => ({
    timestamp: s.timestamp,
    x: clamp(s.x ?? opts.sourceWidth / 2, 0, opts.sourceWidth),
    y: clamp(s.y ?? opts.sourceHeight / 2, 0, opts.sourceHeight),
    width: s.width ?? 0,
    height: s.height ?? 0,
    confidence: s.confidence ?? 0,
    kind: s.kind,
    interpolated: s.interpolated,
    lost: Boolean(s.lost) || s.confidence === undefined
  }))

  return {
    samples,
    sourceWidth: opts.sourceWidth,
    sourceHeight: opts.sourceHeight,
    inferenceSeconds: result.inference_seconds ?? 0
  }
}
