import { useEffect, useState } from 'react'
import type { AnalysisResult, MediaInfo, Roi } from '../../shared/contracts'
import type { JobEventMessage } from './api'
import { RoiEditor } from './components/RoiEditor'
import { FileSection, ProgressPanel, ResultsPanel } from './components/panels'

interface SettingsView {
  audio: {
    enabled: boolean
    spike_threshold_db: number
    baseline_seconds: number
    spike_cooldown_seconds: number
    silence_floor_db: number
  }
  goal_detection: {
    audio_lookback_seconds: number
    fallback_offset_seconds: number
    dedup_seconds: number
  }
  clips: {
    goal_pre_roll_seconds: number
    goal_post_roll_seconds: number
    max_clip_seconds: number
    create_clips_for_unknown: boolean
  }
  vertical: {
    ball_trust: number
    ball_confirmation_frames: number
    ball_lead_fraction: number
    wide_fallback_enabled: boolean
    track_sample_fps: number
  }
}

type ConfigOverrides = Record<string, unknown>

function asSettingsView(value: unknown): SettingsView {
  return value as SettingsView
}

function mergeOverrides(base: ConfigOverrides, patch: ConfigOverrides): ConfigOverrides {
  const result: ConfigOverrides = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key]
    result[key] =
      existing && typeof existing === 'object' && !Array.isArray(existing) &&
      value && typeof value === 'object' && !Array.isArray(value)
        ? mergeOverrides(existing as ConfigOverrides, value as ConfigOverrides)
        : value
  }
  return result
}

function overridesFor(settings: SettingsView): ConfigOverrides {
  return {
    audio: settings.audio,
    goal_detection: settings.goal_detection,
    clips: settings.clips,
    vertical: settings.vertical
  }
}

function NumberSetting(props: {
  id: string
  label: string
  hint: string
  value: number
  min: number
  step?: number
  disabled?: boolean
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <label className="setting-field" htmlFor={props.id}>
      <span>{props.label}</span>
      <input
        id={props.id}
        type="number"
        min={props.min}
        step={props.step ?? 1}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
      <small>{props.hint}</small>
    </label>
  )
}

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
  const [savedSettings, setSavedSettings] = useState<{ roi?: Roi; configOverrides?: ConfigOverrides } | null>(null)
  const [settingsStatus, setSettingsStatus] = useState<string | null>(null)

  // Load persisted settings (ROI survives restarts; PRD 29.2).
  useEffect(() => {
    void (async () => {
      const settings = await window.clipHunter.getSettings()
      if (settings.roi) setRoi(settings.roi)
      setSavedSettings(settings)
      setConfig(asSettingsView(await window.clipHunter.getConfig()))
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
        setJobError(msg.error ?? 'Analiza nie powiodła się')
      } else if (msg.type === 'cancelled') {
        setRunning(false)
        setJobError('Analiza została anulowana.')
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
      const configOverrides = config
        ? mergeOverrides(savedSettings?.configOverrides ?? {}, overridesFor(config))
        : undefined
      await window.clipHunter.startJob({ inputPath, roi, configOverrides })
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

  const updateConfig = (section: keyof SettingsView, field: string, value: number | boolean) => {
    setConfig((current) => current && {
      ...current,
      [section]: { ...current[section], [field]: value }
    })
    setSettingsStatus('Niezapisane zmiany')
  }

  const saveConfig = async () => {
    if (!config) return
    const next = {
      ...(savedSettings ?? {}),
      configOverrides: mergeOverrides(savedSettings?.configOverrides ?? {}, overridesFor(config))
    }
    await window.clipHunter.saveSettings(next)
    setSavedSettings(next)
    setSettingsStatus('Zapisano — ustawienia będą używane w kolejnych analizach')
  }

  const resetConfig = async () => {
    const next = { ...(savedSettings ?? {}) }
    delete next.configOverrides
    await window.clipHunter.saveSettings(next)
    setSavedSettings(next)
    setConfig(asSettingsView(await window.clipHunter.getConfig()))
    setSettingsStatus('Przywrócono ustawienia domyślne z pliku konfiguracji')
  }

  return (
    <div className="app">
      <header>
        <h1>TrybunaTV AI Clip Hunter</h1>
        <span className="subtitle">Znajdź najważniejsze momenty meczu w kilku prostych krokach</span>
      </header>

      <FileSection
        inputPath={inputPath}
        media={media}
        onSelect={() => void selectVideo()}
        probing={probing}
        error={fileError}
      />

      <section className="card">
        <h2>2. Obszar wyniku</h2>
        <div className="row">
          <label className="frame-time">
            Czas klatki (s):
            <input
              type="number"
              min={0}
              max={media?.durationSeconds ?? 999999}
              value={frameTime}
              onChange={(e) => setFrameTime(Number(e.target.value) || 0)}
            />
          </label>
          <span className="hint">
            Wybierz moment, w którym wynik jest dobrze widoczny, a następnie zaznacz prostokąt.
          </span>
        </div>
        <RoiEditor inputPath={inputPath ?? ''} frameTime={frameTime} roi={roi} onRoiChange={(r) => void onRoiChange(r)} />
      </section>

      <section className="card">
        <h2>3. Rozpocznij analizę</h2>
        <details className="optional-settings">
          <summary>Dostosuj działanie aplikacji</summary>
          <p className="hint">Domyślne ustawienia sprawdzają się w większości nagrań. Zmieniaj je tylko wtedy, gdy chcesz uzyskać inny efekt.</p>
          {config && (
            <div className="settings-editor">
            <fieldset>
              <legend>Interesujące momenty</legend>
              <label className="toggle-setting">
                <input type="checkbox" checked={config.audio.enabled} onChange={(event) => updateConfig('audio', 'enabled', event.target.checked)} />
                Analizuj dźwięk trybun i komentarza
              </label>
              <label className="toggle-setting">
                <input type="checkbox" checked={config.clips.create_clips_for_unknown} onChange={(event) => updateConfig('clips', 'create_clips_for_unknown', event.target.checked)} disabled={!config.audio.enabled} />
                Twórz klipy dla interesujących momentów wykrytych wyłącznie przez dźwięk
              </label>
              <div className="settings-fields">
                <NumberSetting id="audio-threshold" label="Próg emocji (dB)" hint="Głośność powyżej ruchomego poziomu bazowego" value={config.audio.spike_threshold_db} min={0} step={0.5} disabled={!config.audio.enabled} onChange={(value) => updateConfig('audio', 'spike_threshold_db', value)} />
                <NumberSetting id="audio-baseline" label="Okno poziomu bazowego (s)" hint="Zwykły poziom trybun używany do porównania" value={config.audio.baseline_seconds} min={1} disabled={!config.audio.enabled} onChange={(value) => updateConfig('audio', 'baseline_seconds', value)} />
                <NumberSetting id="audio-cooldown" label="Odstęp między pikami (s)" hint="Zapobiega powtarzaniu jednego momentu podczas dopingu" value={config.audio.spike_cooldown_seconds} min={0} step={0.1} disabled={!config.audio.enabled} onChange={(value) => updateConfig('audio', 'spike_cooldown_seconds', value)} />
                <NumberSetting id="silence-floor" label="Próg ciszy (dB)" hint="Pomija niewielkie zmiany w tle" value={config.audio.silence_floor_db} min={-100} step={1} disabled={!config.audio.enabled} onChange={(value) => updateConfig('audio', 'silence_floor_db', value)} />
              </div>
            </fieldset>
            <fieldset>
              <legend>Czas trwania klipu</legend>
              <div className="settings-fields">
                <NumberSetting id="pre-roll" label="Przed zdarzeniem (s)" hint="Kontekst przed momentem" value={config.clips.goal_pre_roll_seconds} min={0} onChange={(value) => updateConfig('clips', 'goal_pre_roll_seconds', value)} />
                <NumberSetting id="post-roll" label="Po zdarzeniu (s)" hint="Reakcja po momencie" value={config.clips.goal_post_roll_seconds} min={0} onChange={(value) => updateConfig('clips', 'goal_post_roll_seconds', value)} />
                <NumberSetting id="max-length" label="Maksymalna długość (s)" hint="Ogranicza długość każdego klipu" value={config.clips.max_clip_seconds} min={1} onChange={(value) => updateConfig('clips', 'max_clip_seconds', value)} />
              </div>
            </fieldset>
            <details>
              <summary>Zaawansowane: czas bramki i śledzenie piłki</summary>
              <div className="settings-fields advanced-fields">
                <NumberSetting id="goal-lookback" label="Analiza dźwięku przed bramką (s)" hint="Wyszukuje pik przed zmianą wyniku" value={config.goal_detection.audio_lookback_seconds} min={0} onChange={(value) => updateConfig('goal_detection', 'audio_lookback_seconds', value)} />
                <NumberSetting id="goal-fallback" label="Zapasowe przesunięcie bramki (s)" hint="Używane, gdy nie wykryto silnego piku trybun" value={config.goal_detection.fallback_offset_seconds} min={0} onChange={(value) => updateConfig('goal_detection', 'fallback_offset_seconds', value)} />
                <NumberSetting id="dedup" label="Usuwanie duplikatów bramki (s)" hint="Łączy powtórzone zdarzenia z taką samą zmianą wyniku" value={config.goal_detection.dedup_seconds} min={0} onChange={(value) => updateConfig('goal_detection', 'dedup_seconds', value)} />
                <NumberSetting id="ball-trust" label="Pewność wykrycia piłki" hint="Wyższa wartość odrzuca niepewne wykrycia" value={config.vertical.ball_trust} min={0} step={0.05} onChange={(value) => updateConfig('vertical', 'ball_trust', value)} />
                <NumberSetting id="ball-confirmation" label="Potwierdzenia piłki" hint="Powiązane odczyty przed rozpoczęciem śledzenia" value={config.vertical.ball_confirmation_frames} min={1} onChange={(value) => updateConfig('vertical', 'ball_confirmation_frames', Math.round(value))} />
                <NumberSetting id="goal-side-room" label="Miejsce w stronę bramki" hint="Część kadru zachowana za piłką przy linii bocznej" value={config.vertical.ball_lead_fraction} min={0} step={0.05} onChange={(value) => updateConfig('vertical', 'ball_lead_fraction', value)} />
                <label className="toggle-setting"><input type="checkbox" checked={config.vertical.wide_fallback_enabled} onChange={(event) => updateConfig('vertical', 'wide_fallback_enabled', event.target.checked)} /> Zachowaj szerokie ujęcie po utracie piłki</label>
                <NumberSetting id="tracking-rate" label="Próbki śledzenia / sekundę" hint="Wyższa wartość lepiej śledzi ruch, ale wydłuża analizę" value={config.vertical.track_sample_fps} min={1} step={1} onChange={(value) => updateConfig('vertical', 'track_sample_fps', value)} />
              </div>
            </details>
            </div>
          )}
          <div className="row settings-actions">
            <button onClick={() => void saveConfig()} disabled={!config}>Zapisz moje ustawienia</button>
            <button className="secondary" onClick={() => void resetConfig()} disabled={!config}>Przywróć ustawienia domyślne</button>
            {settingsStatus && <span className="hint" role="status">{settingsStatus}</span>}
          </div>
        </details>
        <div className="row">
          <button className="primary" onClick={() => void startAnalysis()} disabled={!canStart}>
            {running ? 'Trwa analiza…' : 'Rozpocznij analizę'}
          </button>
          {cancelling && <span className="hint">Anulowanie…</span>}
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
