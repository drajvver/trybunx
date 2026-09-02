import { existsSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
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
import { extractFrames } from '../media/frames'
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
    const extra = vendorDirs.join(':')
    env.PYTHONPATH = env.PYTHONPATH ? `${extra}:${env.PYTHONPATH}` : extra
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

    const coarseDir = join(tempDir, 'frames_coarse')
    const intervalMs = cfg.analysis.ocr_interval_ms
    logger.log(`Extracting scoreboard frames every ${intervalMs}ms (ROI ${JSON.stringify(roi)})`)
    const coarse = await extractFrames({
      inputPath,
      outputDir: coarseDir,
      intervalMs,
      roi,
      videoWidth: media.width,
      videoHeight: media.height,
      upscale: cfg.ocr.upscale,
      signal
    })
    logger.log(`Extracted ${coarse.count} frames for OCR`)

    ocrSamples = await ocrFrames(worker, coarse, cfg, signal, (done, total) =>
      stage('scoreboard_scan', 'running', done / total)
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
        stage('audio_analysis', 'failed', undefined, (err as Error).message)
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
      const { failures } = await generateClips({
        inputPath,
        events: clipEvents,
        clipsDir,
        durationSeconds: media.durationSeconds,
        cfg,
        signal,
        onClipStart: () => undefined,
        onClipDone: (event, index, info) => {
          event.clip = info
          logger.log(
            `CLIP ${index}/${clipEvents.length} ${info.path} ` +
              `[${info.startSeconds.toFixed(2)}s -> ${info.endSeconds.toFixed(2)}s]`,
            event.event_time
          )
          stage('generate_clips', 'running', index / clipEvents.length)
        },
        onClipFailed: (event, _index, error) => {
          degraded.push(`clip_failed:${event.id}`)
          logger.error(`Clip failed for ${event.id}: ${error}`, event.event_time)
        }
      })
      if (failures.length === clipEvents.length && clipEvents.length > 0) {
        throw new AnalysisError(
          `All clip generations failed. First error: ${failures[0].error}`,
          'generate_clips'
        )
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
      fine_scan_windows: fineScanWindows,
      audio_spikes_detected: audioEvents.length,
      score_changes_detected: events.filter((e) => e.signals.score_change).length,
      goal_events_created: events.filter((e) => e.type === 'GOAL').length,
      clips_created: events.filter((e) => e.clip).length,
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

/** OCR a set of extracted frames through the Python worker, in batches. */
async function ocrFrames(
  worker: PythonWorker,
  frames: { count: number; framePath: (i: number) => string; startSeconds: number; intervalSeconds: number },
  cfg: AppConfig,
  signal: AbortSignal | undefined,
  onProgress: (done: number, total: number) => void
): Promise<OCRSample[]> {
  const samples: OCRSample[] = []
  const total = frames.count
  const batch = Math.max(1, cfg.ocr.worker_batch_size)

  for (let start = 0; start < total; start += batch) {
    signal?.throwIfAborted()
    const end = Math.min(total, start + batch)
    const framesPayload = []
    for (let i = start; i < end; i++) {
      framesPayload.push({
        path: frames.framePath(i),
        timestamp: frames.startSeconds + i * frames.intervalSeconds
      })
    }
    const result = (await worker.request(
      'ocr_batch',
      {
        frames: framesPayload,
        upscale: 1, // frames are already cropped+upscaled by ffmpeg
        min_confidence: cfg.ocr.min_confidence,
        max_score: cfg.ocr.max_reasonable_score,
        engine: cfg.ocr.engine,
        provider: cfg.ocr.provider,
        fallback_to_tesseract: cfg.ocr.fallback_to_tesseract
      },
      { timeoutMs: 10 * 60 * 1000 }
    )) as { samples: Array<Omit<OCRSample, 'score'> & { score?: string | null }> }
    // The worker speaks the wire format ("1:0"); convert to domain Scores.
    for (const s of result.samples) {
      const score = typeof s.score === 'string' ? parseScore(s.score) : (s.score ?? null)
      samples.push({ ...s, ok: s.ok && !!score, score: score ?? undefined })
    }
    onProgress(end, total)
  }
  return samples
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
      const fineDir = `${ctx.tempDir}/frames_fine_${Math.round(change.changeTime * 1000)}`
      const fine = await extractFrames({
        inputPath: ctx.inputPath,
        outputDir: fineDir,
        start: fineStart,
        end: fineEnd,
        intervalMs: cfg.analysis.fine_ocr_interval_ms,
        roi: ctx.roi,
        videoWidth: ctx.mediaSize.width,
        videoHeight: ctx.mediaSize.height,
        upscale: ocrCfg.upscale,
        signal: ctx.signal
      })
      ctx.countFineScan()
      fineSamples = await ocrFrames(ctx.worker, fine, cfg, ctx.signal, () => undefined)
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
