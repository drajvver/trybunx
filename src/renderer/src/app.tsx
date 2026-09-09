import { useEffect, useState } from 'react'
import type { AnalysisResult, MediaInfo, Roi } from '../../shared/contracts'
import type { JobEventMessage } from './api'
import { RoiEditor } from './components/RoiEditor'
import { FileSection, ProgressPanel, ResultsPanel } from './components/panels'

interface StageUi {
  name: string
  status: string
  progress?: number
  detail?: string
}

const INITIAL_STAGES: StageUi[] = [
  { name: 'prepare', status: 'pending' },
  { name: 'scoreboard_scan', status: 'pending' },
  { name: 'audio_analysis', status: 'pending' },
  { name: 'build_events', status: 'pending' },
  { name: 'generate_clips', status: 'pending' },
  { name: 'write_outputs', status: 'pending' }
]

const DEFAULT_FRAME_TIME = 60

export function App(): JSX.Element {
  const [inputPath, setInputPath] = useState<string | null>(null)
  const [media, setMedia] = useState<MediaInfo | null>(null)
  const [probing, setProbing] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)

  const [roi, setRoi] = useState<Roi | null>(null)
  const [frameTime, setFrameTime] = useState(DEFAULT_FRAME_TIME)

  const [stages, setStages] = useState<StageUi[]>(INITIAL_STAGES)
  const [running, setRunning] = useState(false)
  const [jobError, setJobError] = useState<string | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [config, setConfig] = useState<SettingsView | null>(null)

  interface SettingsView {
    analysis: { ocr_interval_ms: number }
    ocr: { confirmation_reads: number; confirmation_window_seconds: number }
    audio: { spike_threshold_db: number; baseline_seconds: number }
    goal_detection: {
      audio_lookback_seconds: number
      fallback_offset_seconds: number
      dedup_seconds: number
    }
    clips: {
      goal_pre_roll_seconds: number
      goal_post_roll_seconds: number
      max_clip_seconds: number
      encoding: string
    }
    vertical: {
      width: number
      height: number
    }
  }

  // Load persisted settings (ROI survives restarts; PRD 29.2).
  useEffect(() => {
    void (async () => {
      const settings = await window.clipHunter.getSettings()
      if (settings.roi) setRoi(settings.roi)
      setConfig((await window.clipHunter.getConfig()) as unknown as SettingsView)
    })()
  }, [])

  useEffect(() => {
    const unsub = window.clipHunter.onJobEvent((msg: JobEventMessage) => {
      if (msg.type === 'started') {
        setStages(INITIAL_STAGES)
        setJobError(null)
        setResult(null)
        setRunning(true)
      } else if (msg.type === 'stage') {
        setStages((prev) =>
          prev.map((s) =>
            s.name === msg.stage
              ? { ...s, status: msg.status ?? s.status, progress: msg.progress, detail: msg.detail }
              : s
          )
        )
      } else if (msg.type === 'completed') {
        setRunning(false)
        setResult(msg.result ?? null)
      } else if (msg.type === 'failed') {
        setRunning(false)
        setJobError(msg.error ?? 'Analysis failed')
      } else if (msg.type === 'cancelled') {
        setRunning(false)
        setJobError('Analysis cancelled.')
      }
    })
    return unsub
  }, [])

  const selectVideo = async () => {
    setFileError(null)
    const path = await window.clipHunter.selectVideo()
    if (!path) return
    setInputPath(path)
    setProbing(true)
    try {
      const info = await window.clipHunter.probeMedia(path)
      setMedia(info)
    } catch (err) {
      setMedia(null)
      setFileError((err as Error).message)
    } finally {
      setProbing(false)
    }
  }

  const onRoiChange = async (next: Roi | null) => {
    setRoi(next)
    const settings = await window.clipHunter.getSettings()
    await window.clipHunter.saveSettings({ ...settings, roi: next })
  }

  const startAnalysis = async () => {
    if (!inputPath || !roi || !media) return
    setJobError(null)
    try {
      await window.clipHunter.startJob({ inputPath, roi })
    } catch (err) {
      setJobError((err as Error).message)
      setRunning(false)
    }
  }

  const cancelAnalysis = async () => {
    setCancelling(true)
    await window.clipHunter.cancelJob()
    setCancelling(false)
  }

  const canStart = !!inputPath && !!roi && !!media && !running

  return (
    <div className="app">
      <header>
        <h1>TrybunaTV AI Clip Hunter</h1>
        <span className="subtitle">VOD goal detection MVP</span>
      </header>

      <FileSection
        inputPath={inputPath}
        media={media}
        onSelect={() => void selectVideo()}
        probing={probing}
        error={fileError}
      />

      <section className="card">
        <h2>2. Scoreboard ROI</h2>
        <div className="row">
          <label className="frame-time">
            Frame time (s):
            <input
              type="number"
              min={0}
              max={media?.durationSeconds ?? 999999}
              value={frameTime}
              onChange={(e) => setFrameTime(Number(e.target.value) || 0)}
            />
          </label>
          <span className="hint">
            Pick a timestamp where the scoreboard is clearly visible, then draw the rectangle.
          </span>
        </div>
        <RoiEditor inputPath={inputPath ?? ''} frameTime={frameTime} roi={roi} onRoiChange={(r) => void onRoiChange(r)} />
      </section>

      <section className="card">
        <h2>3. Settings</h2>
        <div className="hint">
          Detection thresholds and clip timing are configured in{' '}
          <code>config/default.yaml</code> and applied on the next analysis run.
        </div>
        {config && (
          <div className="meta-grid settings-grid">
            <span>OCR interval</span>
            <span>{config.analysis.ocr_interval_ms} ms</span>
            <span>OCR confirmation</span>
            <span>
              {config.ocr.confirmation_reads} reads / {config.ocr.confirmation_window_seconds}s
            </span>
            <span>Audio spike</span>
            <span>&ge; {config.audio.spike_threshold_db} dB over {config.audio.baseline_seconds}s baseline</span>
            <span>Goal lookback</span>
            <span>{config.goal_detection.audio_lookback_seconds}s (fallback offset {config.goal_detection.fallback_offset_seconds}s)</span>
            <span>Clips</span>
            <span>
              {config.clips.goal_pre_roll_seconds}s pre + {config.clips.goal_post_roll_seconds}s post,
              max {config.clips.max_clip_seconds}s, {config.clips.encoding}
            </span>
            <span>Dedup</span>
            <span>{config.goal_detection.dedup_seconds}s per score transition</span>
            <span>Vertical</span>
            <span>
              {config.vertical.width}x{config.vertical.height} ball-following twin per goal
            </span>
          </div>
        )}
        <div className="row">
          <button className="primary" onClick={() => void startAnalysis()} disabled={!canStart}>
            {running ? 'Analysis running…' : 'Start analysis'}
          </button>
          {cancelling && <span className="hint">Cancelling…</span>}
        </div>
      </section>

      <ProgressPanel
        stages={stages}
        running={running}
        error={jobError}
        onCancel={() => void cancelAnalysis()}
      />

      <ResultsPanel result={result} />
    </div>
  )
}
