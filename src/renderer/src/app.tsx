import { useEffect, useRef, useState } from 'react'
import type { AnalysisResult, MediaInfo, Roi } from '../../shared/contracts'
import type { JobEventMessage } from './api'
import { RoiEditor } from './components/RoiEditor'
import { userError } from './errors'
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
  increaseHint: string
  decreaseHint: string
  value: number
  min: number
  step?: number
  disabled?: boolean
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <div className="setting-field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type="number"
        min={props.min}
        step={props.step ?? 1}
        value={props.value}
        disabled={props.disabled}
        aria-describedby={`${props.id}-help`}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
      <div id={`${props.id}-help`} className="setting-help">
        <small>{props.hint}</small>
        <small><strong>Zwiększ:</strong> {props.increaseHint}</small>
        <small><strong>Zmniejsz:</strong> {props.decreaseHint}</small>
      </div>
    </div>
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
  const probeRequest = useRef(0)
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
      try {
        const settings = await window.clipHunter.getSettings()
        if (settings.roi) setRoi(settings.roi)
        setSavedSettings(settings)
        setConfig(asSettingsView(await window.clipHunter.getConfig()))
      } catch (err) {
        setSettingsStatus(userError(err, 'Nie udało się wczytać ustawień. Otwórz ustawienia i wybierz „Przywróć zalecane ustawienia”.'))
      }
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
    void window.clipHunter.getCurrentJob().then((job) => {
      if (job) {
        setRunning(job.status === 'running' || job.status === 'queued')
        setStages(job.stages)
      }
    }).catch(() => setJobError('Nie udało się odczytać stanu analizy.'))
    return unsub
  }, [])

  const selectVideo = async () => {
    setFileError(null)
    try {
      const path = await window.clipHunter.selectVideo()
      if (!path) return
      const request = ++probeRequest.current
      setInputPath(path)
      setMedia(null)
      setProbing(true)
      try {
        const info = await window.clipHunter.probeMedia(path)
        if (request !== probeRequest.current) return
        setMedia(info)
        setFrameTime(Math.min(DEFAULT_FRAME_TIME, Math.max(0, info.durationSeconds - 0.1)))
      } catch (err) {
        if (request === probeRequest.current) setFileError(userError(err, 'Nie udało się odczytać nagrania. Wybierz poprawny plik wideo.'))
      } finally {
        if (request === probeRequest.current) setProbing(false)
      }
    } catch (err) {
      setFileError(userError(err, 'Nie udało się otworzyć wyboru nagrania.'))
    }
  }

  const onRoiChange = async (next: Roi | null) => {
    setRoi(next)
    try {
      await window.clipHunter.saveSettings({ roi: next })
    } catch (err) {
      setSettingsStatus(userError(err, 'Nie udało się zapisać obszaru wyniku.'))
    }
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
      setJobError(userError(err, 'Nie udało się rozpocząć analizy.'))
      setRunning(false)
    }
  }

  const cancelAnalysis = async () => {
    setCancelling(true)
    try {
      await window.clipHunter.cancelJob()
    } catch (err) {
      setJobError(userError(err, 'Nie udało się anulować analizy.'))
    } finally {
      setCancelling(false)
    }
  }

  const canStart = !!inputPath && !!roi && !!media && !!config && !probing && !running

  const updateConfig = (section: keyof SettingsView, field: string, value: number | boolean) => {
    setConfig((current) => current && {
      ...current,
      [section]: { ...current[section], [field]: value }
    })
    setSettingsStatus('Zmiany nie są zapisane. Będą użyte w najbliższej analizie; zapisz je, aby zachować je na później.')
  }

  const saveConfig = async () => {
    if (!config) return
    try {
      const current = await window.clipHunter.getSettings()
      const configOverrides = mergeOverrides(current.configOverrides ?? {}, overridesFor(config))
      await window.clipHunter.saveSettings({ configOverrides })
      setSavedSettings({ ...current, configOverrides })
      setSettingsStatus('Zapisano ustawienia. Aplikacja użyje ich także przy kolejnych nagraniach.')
    } catch (err) {
      setSettingsStatus(userError(err, 'Nie udało się zapisać ustawień.'))
    }
  }

  const resetConfig = async () => {
    try {
      await window.clipHunter.saveSettings({ configOverrides: null })
      setSavedSettings(await window.clipHunter.getSettings())
      setConfig(asSettingsView(await window.clipHunter.getConfig()))
      setSettingsStatus('Przywrócono zalecane ustawienia. Obszar wyniku został zachowany.')
    } catch (err) {
      setSettingsStatus(userError(err, 'Nie udało się przywrócić ustawień.'))
    }
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
        <h2>2. Pokaż, gdzie na ekranie jest wynik</h2>
        <div className="row">
          <label className="frame-time">
            Moment nagrania do podglądu (sekundy):
            <input
              type="number"
              min={0}
              max={media?.durationSeconds ?? 999999}
              value={frameTime}
              onChange={(e) => setFrameTime(Number(e.target.value) || 0)}
            />
          </label>
          <span className="hint">
            Zwiększ czas, aby zobaczyć późniejszy fragment; zmniejsz, aby zobaczyć wcześniejszy. Wybierz moment z dobrze widocznym wynikiem. Ten czas nie ogranicza analizy — aplikacja sprawdzi całe nagranie.
          </span>
        </div>
        <RoiEditor inputPath={inputPath ?? ''} frameTime={frameTime} roi={roi} onRoiChange={(r) => void onRoiChange(r)} />
      </section>

      <section className="card">
        <h2>3. Znajdź bramki i przygotuj klipy</h2>
        <details className="optional-settings">
          <summary>Ustawienia klipów i wyszukiwania momentów</summary>
          <p className="hint">Możesz zacząć bez zmian. Przy każdym ustawieniu znajdziesz opis jego działania oraz efekt zwiększenia i zmniejszenia wartości.</p>
          {config && (
            <div className="settings-editor">
            <fieldset>
              <legend>Szukanie emocjonujących momentów po dźwięku</legend>
              <label className="toggle-setting">
                <input type="checkbox" checked={config.audio.enabled} onChange={(event) => updateConfig('audio', 'enabled', event.target.checked)} />
                Wykorzystaj reakcje trybun i komentatora do szukania momentów
              </label>
              <p className="hint">Po wyłączeniu aplikacja będzie szukać bramek tylko po zmianie wyniku na ekranie.</p>
              <label className="toggle-setting">
                <input type="checkbox" checked={config.clips.create_clips_for_unknown} onChange={(event) => updateConfig('clips', 'create_clips_for_unknown', event.target.checked)} disabled={!config.audio.enabled} />
                Twórz także klipy z głośnych reakcji, nawet bez zmiany wyniku
              </label>
              <p className="hint">Po włączeniu powstaną też klipy z dopingu i głośnego komentarza. Te momenty nie muszą być bramkami. Po wyłączeniu klipy powstaną tylko dla wykrytych bramek.</p>
              <div className="settings-fields">
                <NumberSetting id="audio-threshold" label="Jak duży wzrost głośności uznać za emocje (dB)" hint="Aplikacja porównuje głośność z wcześniejszym fragmentem. dB to jednostka różnicy głośności." increaseHint="wybierze tylko wyraźniejsze reakcje; może pominąć cichszy doping." decreaseHint="wyłapie słabsze reakcje, ale może też wybrać zwykły hałas." value={config.audio.spike_threshold_db} min={0} step={0.5} disabled={!config.audio.enabled} onChange={(value) => updateConfig('audio', 'spike_threshold_db', value)} />
                <NumberSetting id="audio-baseline" label="Z ilu sekund porównywać głośność" hint="Tyle wcześniejszych sekund służy do ustalenia zwykłej głośności nagrania." increaseHint="wolniej przyzwyczai się do dłuższego dopingu i zmian głośności." decreaseHint="szybciej przyzwyczai się do dopingu, więc jego dalszy ciąg może już nie wyróżniać się głośnością." value={config.audio.baseline_seconds} min={1} disabled={!config.audio.enabled} onChange={(value) => updateConfig('audio', 'baseline_seconds', value)} />
                <NumberSetting id="audio-cooldown" label="Przerwa między wykrytymi reakcjami (sekundy)" hint="Po wykryciu głośnej reakcji aplikacja przez ten czas nie wybiera następnej." increaseHint="ograniczy powtórzenia tej samej reakcji, ale może pominąć kolejną, bliską w czasie." decreaseHint="wyłapie reakcje bliżej siebie; długi doping może zostać wykryty kilka razy." value={config.audio.spike_cooldown_seconds} min={0} step={0.1} disabled={!config.audio.enabled} onChange={(value) => updateConfig('audio', 'spike_cooldown_seconds', value)} />
                <NumberSetting id="silence-floor" label="Pomijaj dźwięki cichsze niż (dB)" hint="Pomaga pomijać ciche tło. W tej skali liczby są ujemne: −40 jest wyższą wartością niż −60." increaseHint="np. z −60 do −40: odrzuci więcej cichych fragmentów." decreaseHint="np. z −40 do −60: dopuści cichsze fragmenty, także szum tła." value={config.audio.silence_floor_db} min={-100} step={1} disabled={!config.audio.enabled} onChange={(value) => updateConfig('audio', 'silence_floor_db', value)} />
              </div>
            </fieldset>
            <fieldset>
              <legend>Ile akcji zachować w klipie</legend>
              <div className="settings-fields">
                <NumberSetting id="pre-roll" label="Ile sekund przed bramką zostawić" hint="Dotyczy także innych wybranych momentów, jeśli tworzysz dla nich klipy." increaseHint="pokaże więcej akcji prowadzącej do bramki, o ile pozwala na to limit długości klipu." decreaseHint="klip zacznie się bliżej bramki i pokaże mniej wcześniejszej akcji." value={config.clips.goal_pre_roll_seconds} min={0} onChange={(value) => updateConfig('clips', 'goal_pre_roll_seconds', value)} />
                <NumberSetting id="post-roll" label="Ile sekund po bramce zostawić" hint="Pozwala zachować celebrację, reakcję trybun lub powtórkę." increaseHint="pokaże więcej po bramce, o ile pozwala na to limit długości klipu." decreaseHint="klip skończy się wcześniej i pokaże mniej reakcji po bramce." value={config.clips.goal_post_roll_seconds} min={0} onChange={(value) => updateConfig('clips', 'goal_post_roll_seconds', value)} />
                <NumberSetting id="max-length" label="Najdłuższy klip (sekundy)" hint="Jeśli czas przed i po bramce przekracza ten limit, aplikacja skróci klip, zachowując moment bramki." increaseHint="pozwoli zachować dłuższe klipy; nie wydłuży ich ponad wybrane czasy przed i po bramce." decreaseHint="skróci zbyt długie klipy i ograniczy pokazywaną akcję oraz reakcje." value={config.clips.max_clip_seconds} min={1} onChange={(value) => updateConfig('clips', 'max_clip_seconds', value)} />
              </div>
            </fieldset>
            <details>
              <summary>Dodatkowe ustawienia: czas bramki i pionowe klipy</summary>
              <div className="settings-fields advanced-fields">
                <NumberSetting id="goal-lookback" label="Jak daleko przed zmianą wyniku szukać reakcji (sekundy)" hint="Wynik na ekranie zwykle zmienia się po bramce. Reakcja trybun pomaga ustalić, kiedy piłka wpadła do siatki." increaseHint="uwzględni wcześniejsze reakcje; przy dużym opóźnieniu grafiki może pomóc, ale może też wybrać inną reakcję." decreaseHint="szuka tylko bliżej zmiany wyniku; może pominąć reakcję, jeśli grafika wyniku zmienia się późno." value={config.goal_detection.audio_lookback_seconds} min={0} onChange={(value) => updateConfig('goal_detection', 'audio_lookback_seconds', value)} />
                <NumberSetting id="goal-fallback" label="O ile sekund cofnąć czas bramki bez reakcji trybun" hint="Jeśli nie ma wyraźnej reakcji, aplikacja odejmuje tyle sekund od chwili zmiany wyniku." increaseHint="uzna, że bramka padła wcześniej, i przesunie klip wstecz." decreaseHint="uzna, że bramka padła bliżej zmiany wyniku, i przesunie klip później." value={config.goal_detection.fallback_offset_seconds} min={0} onChange={(value) => updateConfig('goal_detection', 'fallback_offset_seconds', value)} />
                <NumberSetting id="dedup" label="Przez ile sekund pomijać powtórne wykrycie bramki" hint="Dotyczy wyłącznie tej samej zmiany wyniku. Różne bramki pozostają osobnymi momentami." increaseHint="przez dłuższy czas będzie pomijać kolejne wykrycia tej samej bramki." decreaseHint="szybciej pozwoli na kolejne wykrycie tej samej bramki; może pojawić się więcej powtórzeń." value={config.goal_detection.dedup_seconds} min={0} onChange={(value) => updateConfig('goal_detection', 'dedup_seconds', value)} />
                <NumberSetting id="ball-trust" label="Wymagana pewność rozpoznania piłki (0–1)" hint="Określa, jak pewne musi być rozpoznanie, by pionowy klip podążał za piłką. 0 oznacza brak dodatkowych wymagań, 1 — najwyższą pewność." increaseHint="rzadziej pomyli inny obiekt z piłką, ale może częściej kierować obraz na zawodników." decreaseHint="łatwiej zacznie podążać za piłką, ale może pomylić ją z innym obiektem." value={config.vertical.ball_trust} min={0} step={0.05} onChange={(value) => updateConfig('vertical', 'ball_trust', value)} />
                <NumberSetting id="ball-confirmation" label="Ile razy rozpoznać piłkę przed podążaniem za nią" hint="Aplikacja musi rozpoznać piłkę tyle razy z rzędu w pobliskich miejscach obrazu." increaseHint="poczeka na więcej potwierdzeń; zmniejszy pomyłki, ale później zacznie podążać za piłką." decreaseHint="szybciej zacznie podążać za piłką, także przy krótkim pojawieniu się; łatwiej o pomyłkę." value={config.vertical.ball_confirmation_frames} min={1} onChange={(value) => updateConfig('vertical', 'ball_confirmation_frames', Math.round(value))} />
                <NumberSetting id="goal-side-room" label="Położenie piłki w pionowym obrazie (0–0,5)" hint="0,5 umieszcza piłkę na środku. Mniejsza wartość zostawia więcej miejsca w stronę najbliższej bramki." increaseHint="piłka znajdzie się bliżej środka, a w stronę bramki będzie mniej miejsca." decreaseHint="piłka znajdzie się bliżej bocznej krawędzi, a w stronę bramki będzie więcej miejsca." value={config.vertical.ball_lead_fraction} min={0} step={0.05} onChange={(value) => updateConfig('vertical', 'ball_lead_fraction', value)} />
                <label className="toggle-setting"><input type="checkbox" checked={config.vertical.wide_fallback_enabled} onChange={(event) => updateConfig('vertical', 'wide_fallback_enabled', event.target.checked)} /> Pokaż całe boisko w pionowym klipie, gdy trudno śledzić piłkę</label>
                <p className="hint">Po włączeniu aplikacja może zachować szeroki obraz boiska na rozmytym tle, gdy nie ma pewnego śledzenia piłki i zawodnicy zajmują dużą część obrazu. Po wyłączeniu pionowy klip pozostaje wycinkiem obrazu.</p>
                <NumberSetting id="tracking-rate" label="Ile razy na sekundę sprawdzać położenie piłki" hint="To liczba sprawdzeń położenia piłki i zawodników, a nie liczba klatek w gotowym klipie." increaseHint="lepiej wychwyci szybki ruch, ale przygotowanie pionowych klipów może potrwać dłużej." decreaseHint="zmniejszy liczbę sprawdzeń i może przyspieszyć pracę, ale łatwiej przeoczyć szybki ruch." value={config.vertical.track_sample_fps} min={1} step={1} onChange={(value) => updateConfig('vertical', 'track_sample_fps', value)} />
              </div>
            </details>
            </div>
          )}
          <div className="row settings-actions">
            <button onClick={() => void saveConfig()} disabled={!config}>Zapisz ustawienia na przyszłość</button>
            <button className="secondary" onClick={() => void resetConfig()}>Przywróć zalecane ustawienia</button>
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
