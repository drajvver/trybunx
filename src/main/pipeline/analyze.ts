import { existsSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { basename, delimiter, dirname, join, resolve } from 'path'
import {
  AnalysisResult,
  AudioWindow,
  DetectionSignal,
  DetectedEvent,
  EventSignals,
  OCRSample,
  Roi,
  ScoreChange,
  StageName,
  StageStatus
} from '../../shared/contracts'
import { AppConfig, parseScore, sanitizeRoi, sameScore, scoreToString } from '../../shared/config'
import { probeMedia } from '../media/ffprobe'
import { resolveBinary } from '../media/process'
import { analyzePcm, extractAnalysisAudio, readWavPcm } from '../media/audio'
import { PythonWorker } from '../workers/python_worker'
import { detectScoreChanges } from '../detection/score_state'
import { collectSignals, classifyCluster, clusterSignals } from '../detection/event_aggregator'
import { estimateEventTime } from '../detection/goal_detector'
import { dedupeGoalEvents } from '../detection/dedup'
import { generateClips } from '../clips/generator'
import { AnalysisLogger } from './logger'

export interface AnalyzeOptions {
  inputPath: string
  roi?: Roi
  config?: AppConfig
  outputRoot?: string
  runName?: string
  pythonPath?: string
  workerScriptPath?: string
  /** Working directory for the python worker (defaults to the script's dir). */
  pythonCwd?: string
  /** Extra environment for the python worker (e.g. PYTHONPATH). */
  pythonEnv?: NodeJS.ProcessEnv
  keepTemp?: boolean
  signal?: AbortSignal
  onStage?: (stage: StageName, status: StageStatus, progress?: number, detail?: string) => void
}

export class AnalysisError extends Error {
  constructor(
    message: string,
    public readonly stage: StageName,
    public readonly fatal = true
  ) {
    super(message)
    this.name = 'AnalysisError'
  }
}

export const STAGE_ORDER: StageName[] = [
  'prepare',
  'scoreboard_scan',
  'audio_analysis',
  'build_events',
  'generate_clips',
  'write_outputs'
]

function defaultPythonPath(): string {
  if (process.env.TRYBUNX_PYTHON) return process.env.TRYBUNX_PYTHON
  const candidates = [
    resolve(process.cwd(), 'python', '.venv', 'bin', 'python'),
    resolve(process.cwd(), '.venv', 'bin', 'python')
  ]
  return candidates.find((c) => existsSync(c)) ?? 'python3'
}

function defaultWorkerScript(): string {
  return process.env.TRYBUNX_WORKER || resolve(process.cwd(), 'python/worker.py')
}

/** Build the worker environment; vendored deps (packaged apps) ride on PYTHONPATH. */
function workerEnvironment(vendorCandidates: string[], pythonEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...pythonEnv }
  const vendorDirs = vendorCandidates.filter((dir) => existsSync(dir))
  if (vendorDirs.length > 0) {
    const extra = vendorDirs.join(delimiter)
    env.PYTHONPATH = env.PYTHONPATH ? `${extra}${delimiter}${env.PYTHONPATH}` : extra
  }
  return env
}

/** Analyze one VOD end-to-end (PRD sections 8 and 10). */
export async function runAnalysis(opts: AnalyzeOptions): Promise<AnalysisResult> {
  const signal = opts.signal
  const cfg = opts.config
  if (!cfg) throw new Error('runAnalysis requires a resolved config')

  const stage = (name: StageName, status: StageStatus, progress?: number, detail?: string) =>
    opts.onStage?.(name, status, progress, detail)
  const check = () => signal?.throwIfAborted()

  const startedAt = new Date()
  const startedMs = Date.now()
  const degraded: string[] = []
  const inputPath = resolve(opts.inputPath)
  if (!existsSync(inputPath)) {
    throw new AnalysisError(`Input file does not exist: ${inputPath}`, 'prepare')
  }

  const roi = opts.roi ? sanitizeRoi(opts.roi) : undefined
  if (!roi) {
    throw new AnalysisError(
      'No valid scoreboard ROI configured. Define the scoreboard region before analyzing.',
      'prepare'
    )
  }

  // ---- output layout (PRD section 7) ------------------------------------
  const base = basename(inputPath).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_')
  const stamp = startedAt.toISOString().replace(/[:T]/g, '_').slice(0, 19)
  const runName = opts.runName || `${base}_${stamp}`
  const outputRoot = resolve(opts.outputRoot || cfg.output.dir)
  const runDir = join(outputRoot, runName)
  const clipsDir = join(runDir, 'clips')
  const logsDir = join(runDir, 'logs')
  const tempDir = join(runDir, '.tmp')

  const logger = new AnalysisLogger()
  await mkdir(logsDir, { recursive: true })
  // Re-running into an existing run directory must produce deterministic
  // results (PRD 3.3: repeated testing on the same VOD), so clear stale clips.
  await rm(clipsDir, { recursive: true, force: true }).catch(() => undefined)

  let worker: PythonWorker | null = null
  let media
  let ocrSamples: OCRSample[] = []
  let audioWindows: AudioWindow[] = []
  let audioEvents: Array<{ timestamp: number; deltaDb: number }> = []
  let events: DetectedEvent[] = []
  let fineScanWindows = 0
  let videoDecoder = 'software'
  let hardwareDecodeFallback = false

  try {
    // ---- stage: prepare --------------------------------------------------
    stage('prepare', 'running')
    check()
    logger.log(`Analyzing "${inputPath}"`)
    media = await probeMedia(inputPath, signal)
    if (!media.hasAudio) {
      degraded.push('audio_analysis_unavailable')
      logger.warn('No audio track found; continuing in OCR-only mode')
    }
    logger.log(
      `Media: ${media.width}x${media.height} @ ${media.fps.toFixed(2)}fps, ` +
        `${media.durationSeconds.toFixed(1)}s, video=${media.videoCodec}, audio=${media.audioCodec ?? 'none'}`
    )
    await mkdir(tempDir, { recursive: true })
    stage('prepare', 'complete')

    // ---- stage: scoreboard scan (OCR) ------------------------------------
    stage('scoreboard_scan', 'running')
    check()
    const workerScript = opts.workerScriptPath || defaultWorkerScript()
    const workerScriptDir = dirname(workerScript)
    worker = new PythonWorker({
      pythonPath: opts.pythonPath || defaultPythonPath(),
      scriptPath: workerScript,
      cwd: opts.pythonCwd || workerScriptDir,
      env: workerEnvironment([join(workerScriptDir, 'vendor')], opts.pythonEnv)
    })
    try {
      await worker.start(signal)
    } catch (err) {
      throw new AnalysisError(`OCR cannot initialize: ${(err as Error).message}`, 'scoreboard_scan')
    }

    const intervalMs = cfg.analysis.ocr_interval_ms
    logger.log(`Streaming scoreboard frames every ${intervalMs}ms (ROI ${JSON.stringify(roi)})`)
    const coarse = await ocrVideoFrames({
      worker,
      inputPath,
      start: 0,
      end: media.durationSeconds,
      intervalMs,
      roi,
      videoWidth: media.width,
      videoHeight: media.height,
      cfg,
      signal,
      onProgress: (done, total) => stage('scoreboard_scan', 'running', done / total)
    })
    ocrSamples = coarse.samples
    videoDecoder = coarse.decoder
    hardwareDecodeFallback = coarse.hardwareDecodeFallback
    logger.log(
      `Streamed ${ocrSamples.length} frames: neural=${coarse.inferredFrames}, ` +
        `reused=${coarse.reusedFrames}, decoder=${videoDecoder}` +
        (hardwareDecodeFallback ? ' (hardware fallback)' : '')
    )
    logger.log(`OCR complete: ${ocrSamples.filter((s) => s.ok).length}/${ocrSamples.length} readable samples`)
    const ocrProviders = countValues(ocrSamples.map((s) => s.provider ?? 'unknown'))
    const ocrEngines = countValues(ocrSamples.map((s) => s.engine ?? 'unknown'))
    const ocrInferenceSeconds = ocrSamples.reduce((sum, s) => sum + (s.inference_seconds ?? 0), 0)
    logger.log(
      `OCR backend: engines=${JSON.stringify(ocrEngines)}, providers=${JSON.stringify(ocrProviders)}, ` +
        `inference=${ocrInferenceSeconds.toFixed(2)}s`
    )
    for (const s of ocrSamples) {
      if (s.ok) logger.log(`OCR ${scoreToString(s.score!)} (conf=${s.confidence.toFixed(2)})`, s.timestamp)
    }
    stage('scoreboard_scan', 'complete', 1)

    // ---- stage: audio analysis -------------------------------------------
    stage('audio_analysis', 'running')
    check()
    if (cfg.audio.enabled && media.hasAudio) {
      try {
        const wavPath = join(tempDir, 'analysis_audio.wav')
        await extractAnalysisAudio(inputPath, wavPath, cfg.audio.sample_rate, signal)
        const pcm = await readWavPcm(wavPath, signal)
        const analysis = analyzePcm(pcm, cfg.audio, signal)
        audioWindows = analysis.windows
        audioEvents = analysis.events
        logger.log(`Audio: ${audioWindows.length} windows, ${audioEvents.length} spikes`)
        for (const e of audioEvents) {
          logger.log(`AUDIO_SPIKE +${e.deltaDb.toFixed(1)} dB`, e.timestamp)
        }
        stage('audio_analysis', 'complete')
      } catch (err) {
        if (signal?.aborted) throw err
        degraded.push('audio_analysis_failed')
        logger.error(`Audio analysis failed: ${(err as Error).message}; continuing OCR-only`)
        stage('audio_analysis', 'failed', undefined, 'Nie udało się przeanalizować dźwięku. Analiza jest oparta na wyniku.')
      }
    } else {
      degraded.push('audio_analysis_skipped')
      logger.warn('Audio analysis disabled or unavailable; continuing OCR-only')
      stage('audio_analysis', 'skipped')
    }

    // ---- stage: build events ---------------------------------------------
    stage('build_events', 'running')
    check()
    events = await buildEvents({
      cfg,
      ocrSamples,
      audioWindows,
      audioEvents,
      duration: media.durationSeconds,
      logger,
      worker,
      roi,
      mediaSize: { width: media.width, height: media.height },
      tempDir,
      inputPath,
      signal,
      videoDecoder,
      countFineScan: () => fineScanWindows++
    })
    logger.log(`Built ${events.filter((e) => e.type === 'GOAL').length} goal events`)
    stage('build_events', 'complete')

    // ---- stage: generate clips -------------------------------------------
    stage('generate_clips', 'running')
    check()
    const clipEvents = events.filter(
      (e) => e.type === 'GOAL' || cfg.clips.create_clips_for_unknown
    )
    if (clipEvents.length === 0) {
      logger.log('No events eligible for clips')
      stage('generate_clips', 'complete')
    } else {
      const { failures, verticalFailures } = await generateClips({
        inputPath,
        events: clipEvents,
        clipsDir,
        durationSeconds: media.durationSeconds,
        cfg,
        signal,
        sourceWidth: media.width,
        sourceHeight: media.height,
        sourceFps: media.fps,
        worker,
        tempDir,
        onClipStart: () => undefined,
        onClipDone: (event, index, info) => {
          event.clip = info
          logger.log(
            `CLIP ${index}/${clipEvents.length} ${info.path} ` +
              `[${info.startSeconds.toFixed(2)}s -> ${info.endSeconds.toFixed(2)}s]`,
            event.event_time
          )
          stage('generate_clips', 'running', index / clipEvents.length, `Klip ${index}/${clipEvents.length}`)
        },
        onClipFailed: (event, _index, error) => {
          degraded.push(`clip_failed:${event.id}`)
          logger.error(`Clip failed for ${event.id}: ${error}`, event.event_time)
        },
        onVerticalDone: (event, index, info) => {
          logger.log(
            `VERTICAL ${index}/${clipEvents.length} ${info.path} ` +
              `[${info.startSeconds.toFixed(2)}s -> ${info.endSeconds.toFixed(2)}s] ` +
              `tracked=${info.tracking?.tracked ?? 0}/${info.tracking?.samples ?? 0}` +
              (info.tracking?.wide_fallback
                ? ' (wide framing)'
                : info.tracking?.fallback ? ' (center fallback)' : ''),
            event.event_time
          )
          if (info.tracking?.fallback) degraded.push(`vertical_center_fallback:${event.id}`)
          stage('generate_clips', 'running', index / clipEvents.length, `Klip pionowy ${index}/${clipEvents.length}`)
        },
        onVerticalFailed: (event, _index, error) => {
          degraded.push(`vertical_failed:${event.id}`)
          logger.error(`Vertical clip failed for ${event.id}: ${error}`, event.event_time)
        }
      })
      if (failures.length === clipEvents.length && clipEvents.length > 0) {
        throw new AnalysisError(
          `All clip generations failed. First error: ${failures[0].error}`,
          'generate_clips'
        )
      }
      if (verticalFailures.length > 0) {
        logger.warn(`${verticalFailures.length}/${clipEvents.length} vertical clips failed (horizontal clips unaffected)`)
      }
      stage('generate_clips', 'complete', 1)
    }

    // ---- stage: write outputs --------------------------------------------
    stage('write_outputs', 'running')
    check()
    const analysis = {
      input_file: inputPath,
      output_dir: runDir,
      duration_seconds: Number(media.durationSeconds.toFixed(3)),
      video_resolution: `${media.width}x${media.height}`,
      video_decoder: videoDecoder,
      hardware_decode_fallback: hardwareDecodeFallback,
      scoreboard_roi: roi,
      analysis_started_at: startedAt.toISOString(),
      analysis_finished_at: new Date().toISOString(),
      ocr_samples: ocrSamples.length,
      ocr_ok_samples: ocrSamples.filter((s) => s.ok).length,
      ocr_engines: countValues(ocrSamples.map((s) => s.engine ?? 'unknown')),
      ocr_providers: countValues(ocrSamples.map((s) => s.provider ?? 'unknown')),
      ocr_inference_seconds: Number(
        ocrSamples.reduce((sum, s) => sum + (s.inference_seconds ?? 0), 0).toFixed(3)
      ),
      ocr_inferred_samples: ocrSamples.filter((s) => !s.reused).length,
      ocr_reused_samples: ocrSamples.filter((s) => s.reused).length,
      fine_scan_windows: fineScanWindows,
      audio_spikes_detected: audioEvents.length,
      score_changes_detected: events.filter((e) => e.signals.score_change).length,
      goal_events_created: events.filter((e) => e.type === 'GOAL').length,
      clips_created: events.filter((e) => e.clip).length,
      vertical_clips_created: events.filter((e) => e.clip_vertical).length,
      vertical_center_fallbacks: events.filter((e) => e.clip_vertical?.tracking?.fallback).length,
      processing_seconds: Number(((Date.now() - startedMs) / 1000).toFixed(1)),
      degraded: [...new Set(degraded)],
      config_used: cfg
    }

    await writeFile(join(runDir, 'events.json'), JSON.stringify({ events }, null, 2))
    await writeFile(join(runDir, 'analysis.json'), JSON.stringify(analysis, null, 2))
    await writeFile(join(logsDir, 'analysis.log'), logger.getLines().join('\n') + '\n')
    stage('write_outputs', 'complete')

    logger.log('Analysis complete')

    if (!opts.keepTemp) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }

    return { events, analysis }
  } catch (err) {
    // Persist whatever we logged, then rethrow.
    await writeFile(join(logsDir, 'analysis.log'), logger.getLines().join('\n') + '\n').catch(
      () => undefined
    )
    throw err
  } finally {
    await worker?.stop().catch(() => undefined)
  }
}

interface OcrVideoRequest {
  worker: PythonWorker
  inputPath: string
  start: number
  end: number
  intervalMs: number
  roi: Roi
  videoWidth: number
  videoHeight: number
  cfg: AppConfig
  decodeAcceleration?: 'auto' | 'videotoolbox' | 'software'
  signal?: AbortSignal
  onProgress: (done: number, total: number) => void
}

interface OcrVideoResult {
  samples: OCRSample[]
  inferredFrames: number
  reusedFrames: number
  decoder: string
  hardwareDecodeFallback: boolean
}

/** Stream ROI frames directly from FFmpeg inside the worker; no PNG intermediates. */
async function ocrVideoFrames(req: OcrVideoRequest): Promise<OcrVideoResult> {
  req.signal?.throwIfAborted()
  const x = Math.max(0, Math.round(req.roi.x * req.videoWidth))
  const y = Math.max(0, Math.round(req.roi.y * req.videoHeight))
  const width = Math.min(
    req.videoWidth - x,
    Math.max(2, Math.round(req.roi.width * req.videoWidth))
  )
  const height = Math.min(
    req.videoHeight - y,
    Math.max(2, Math.round(req.roi.height * req.videoHeight))
  )
  const outputWidth = Math.max(2, Math.round(width * req.cfg.ocr.upscale))
  const outputHeight = Math.max(2, Math.round(height * req.cfg.ocr.upscale))
  const total = Math.max(1, Math.ceil(((req.end - req.start) * 1000) / req.intervalMs))

  const result = await req.worker.request<{
    samples: Array<Omit<OCRSample, 'score'> & { score?: string | null }>
    frame_count: number
    inferred_frames: number
    reused_frames: number
    decoder: string
    hardware_decode_fallback: boolean
  }>(
    'ocr_video',
    {
      input_path: req.inputPath,
      ffmpeg_path: resolveBinary('ffmpeg'),
      start: req.start,
      end: req.end,
      interval_ms: req.intervalMs,
      crop: { x, y, width, height },
      output_width: outputWidth,
      output_height: outputHeight,
      min_confidence: req.cfg.ocr.min_confidence,
      max_score: req.cfg.ocr.max_reasonable_score,
      engine: req.cfg.ocr.engine,
      provider: req.cfg.ocr.provider,
      fallback_to_tesseract: req.cfg.ocr.fallback_to_tesseract,
      change_detection_enabled: req.cfg.ocr.change_detection_enabled,
      change_threshold: req.cfg.ocr.change_threshold,
      refresh_interval_seconds: req.cfg.ocr.refresh_interval_seconds,
      confirmation_reads: req.cfg.ocr.confirmation_reads,
      decode_acceleration: req.decodeAcceleration ?? req.cfg.analysis.decode_acceleration
    },
    {
      timeoutMs: 24 * 60 * 60 * 1000,
      onProgress: (done) => req.onProgress(Math.min(done, total), total)
    }
  )

  const samples = result.samples.map((sample) => {
    const score = typeof sample.score === 'string' ? parseScore(sample.score) : (sample.score ?? null)
    return { ...sample, ok: sample.ok && !!score, score: score ?? undefined }
  })
  req.onProgress(total, total)
  return {
    samples,
    inferredFrames: result.inferred_frames,
    reusedFrames: result.reused_frames,
    decoder: result.decoder,
    hardwareDecodeFallback: result.hardware_decode_fallback
  }
}

function countValues(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1
    return counts
  }, {})
}

interface BuildEventsContext {
  cfg: AppConfig
  ocrSamples: OCRSample[]
  audioWindows: AudioWindow[]
  audioEvents: Array<{ timestamp: number; deltaDb: number }>
  duration: number
  logger: AnalysisLogger
  worker: PythonWorker
  roi: Roi
  mediaSize: { width: number; height: number }
  tempDir: string
  inputPath: string
  signal?: AbortSignal
  videoDecoder: string
  countFineScan: () => void
}

/** Score state machine + fine scans + aggregation + dedup (PRD 14-22). */
async function buildEvents(ctx: BuildEventsContext): Promise<DetectedEvent[]> {
  const { cfg, logger } = ctx
  const ocrCfg = cfg.ocr

  const coarse = detectScoreChanges(ctx.ocrSamples, ocrCfg)
  if (coarse.baseline) {
    logger.log(
      `BASELINE ${scoreToString(coarse.baseline)} at ${coarse.baselineTime?.toFixed(2)}s (no event)`
    )
  } else {
    logger.warn('No stable baseline score could be established from OCR')
  }
  for (const r of coarse.rejected) {
    logger.warn(
      `REJECTED ${scoreToString(r.from)} -> ${scoreToString(r.to)} (${r.reason})`,
      r.around
    )
  }

  // Fine scans: refine timing of valid changes, resolve suspicious ones (PRD 11.2).
  const finalChanges: ScoreChange[] = []
  for (const change of coarse.changes) {
    ctx.signal?.throwIfAborted()
    if (change.validation === 'invalid') continue

    const margin = cfg.analysis.fine_scan_margin_seconds
    const fineStart = Math.max(0, change.changeTime - margin)
    const fineEnd = Math.min(ctx.duration, change.confirmedAt + margin)

    let fineSamples: OCRSample[] = []
    try {
      const fine = await ocrVideoFrames({
        worker: ctx.worker,
        inputPath: ctx.inputPath,
        start: fineStart,
        end: fineEnd,
        intervalMs: cfg.analysis.fine_ocr_interval_ms,
        roi: ctx.roi,
        videoWidth: ctx.mediaSize.width,
        videoHeight: ctx.mediaSize.height,
        cfg,
        decodeAcceleration: ctx.videoDecoder === 'videotoolbox' ? 'videotoolbox' : 'software',
        signal: ctx.signal,
        onProgress: () => undefined
      })
      ctx.countFineScan()
      fineSamples = fine.samples
      logger.log(
        `FINE_SCAN ${fineStart.toFixed(2)}-${fineEnd.toFixed(2)}s: ` +
          `${fineSamples.filter((s) => s.ok).length}/${fineSamples.length} readable`
      )
    } catch (err) {
      if (ctx.signal?.aborted) throw err
      logger.warn(`Fine scan failed: ${(err as Error).message}`)
    }

    if (change.validation === 'suspicious') {
      const resolved = resolveSuspiciousChange(change, fineSamples, ocrCfg, logger)
      finalChanges.push(...resolved)
      continue
    }

    // Valid change: refine the change time using the fine samples.
    if (cfg.analysis.refine_change_times && fineSamples.length > 0) {
      const refinedTime = refineChangeTime(change, fineSamples, ocrCfg)
      if (refinedTime !== null) {
        logger.log(
          `SCORE_CHANGE ${scoreToString(change.from)} -> ${scoreToString(change.to)} ` +
            `refined ${change.changeTime.toFixed(2)} -> ${refinedTime.toFixed(2)}`
        )
        finalChanges.push({ ...change, changeTime: refinedTime, refined: true })
        continue
      }
    }
    logger.log(
      `SCORE_CHANGE ${scoreToString(change.from)} -> ${scoreToString(change.to)} ` +
        `at ${change.changeTime.toFixed(2)}s`
    )
    finalChanges.push(change)
  }

  // Merge fine-scan OCR samples into the signal stream so audio-only clusters
  // near changes are already covered by the audio analysis instead.

  const signals: DetectionSignal[] = collectSignals({
    scoreChanges: finalChanges.map((c) => ({
      from: c.from,
      to: c.to,
      changeTime: c.changeTime,
      validation: c.validation
    })),
    audioEvents: ctx.audioEvents
  })

  const clusters = clusterSignals(signals, cfg.analysis.event_window_seconds)
  logger.log(`Aggregated ${signals.length} signals into ${clusters.length} clusters`)

  const events: DetectedEvent[] = []
  let index = 1
  for (const cluster of clusters) {
    const agg = classifyCluster(cluster, cfg)
    if (!agg) continue

    if (agg.type !== 'GOAL') {
      logger.log(
        `EVENT UNKNOWN_INTERESTING at ${cluster.start.toFixed(2)}s ` +
          `(no score change; not clipping)`
      )
      continue
    }

    const timing = estimateEventTime(
      agg.detectedFromScoreChange ?? cluster.start,
      ctx.audioWindows,
      cfg.goal_detection,
      ctx.duration,
      cfg.audio.silence_floor_db
    )

    const signalsOut: EventSignals = { ...agg.signals }
    if (timing.peak) signalsOut.audio_delta_db = Number(timing.peak.deltaDb.toFixed(2))

    const event: DetectedEvent = {
      id: `event_${String(index).padStart(4, '0')}`,
      type: 'GOAL',
      event_time: Number(timing.eventTime.toFixed(3)),
      detected_from_score_change: Number((agg.detectedFromScoreChange ?? cluster.start).toFixed(3)),
      confidence: agg.confidence,
      score_before: agg.scoreBefore,
      score_after: agg.scoreAfter,
      signals: signalsOut
    }
    events.push(event)
    logger.log(
      `EVENT GOAL confidence=${event.confidence} ` +
        `event_time=${AnalysisLogger.formatMediaTime(event.event_time)} ` +
        `score ${event.score_before} -> ${event.score_after}`,
      event.event_time
    )
    index++
  }

  // Re-number after dedup to keep ids contiguous.
  const deduped = dedupeGoalEvents(events, cfg.goal_detection.dedup_seconds)
  return deduped.map((e, i) => ({ ...e, id: `event_${String(i + 1).padStart(4, '0')}` }))
}

/**
 * Refine a confirmed change time with fine-scan samples: the new score must
 * appear stably (confirmation_reads reads within the confirmation window).
 */
function refineChangeTime(
  change: ScoreChange,
  fineSamples: OCRSample[],
  ocrCfg: AppConfig['ocr']
): number | null {
  const sorted = fineSamples.filter((s) => s.ok && s.score).sort((a, b) => a.timestamp - b.timestamp)
  for (let i = 0; i < sorted.length; i++) {
    if (!sameScore(sorted[i].score, change.to)) continue
    // Require the new score to be stable here.
    const window = sorted.slice(i, i + ocrCfg.confirmation_reads)
    const allNew =
      window.length >= ocrCfg.confirmation_reads &&
      window.every((s) => sameScore(s.score, change.to))
    if (allNew && window[window.length - 1].timestamp - window[0].timestamp <= ocrCfg.confirmation_window_seconds) {
      return window[0].timestamp
    }
  }
  return null
}

/**
 * Resolve a suspicious (multi-step) transition using fine-scan samples,
 * seeded with the change's starting score. Returns the resolved chain, or
 * the original change when the fine scan cannot improve it.
 */
function resolveSuspiciousChange(
  change: ScoreChange,
  fineSamples: OCRSample[],
  ocrCfg: AppConfig['ocr'],
  logger: AnalysisLogger
): ScoreChange[] {
  if (fineSamples.length === 0) {
    logger.warn(
      `SUSPICIOUS transition ${scoreToString(change.from)} -> ${scoreToString(change.to)} ` +
        `kept as single change (fine scan unavailable)`
    )
    return [change]
  }
  const result = detectScoreChanges(fineSamples, ocrCfg, { initialBaseline: change.from })
  const chain = result.changes.filter((c) => c.validation === 'valid' || c.validation === 'suspicious')
  if (chain.length === 0) {
    logger.warn(
      `SUSPICIOUS transition ${scoreToString(change.from)} -> ${scoreToString(change.to)} ` +
        `kept as single change (fine scan found no valid chain)`
    )
    return [change]
  }
  for (const c of chain) {
    logger.log(
      `RESOLVED suspicious transition step: ${scoreToString(c.from)} -> ${scoreToString(c.to)} ` +
        `at ${c.changeTime.toFixed(2)}s (${c.validation})`
    )
  }
  return chain
}
