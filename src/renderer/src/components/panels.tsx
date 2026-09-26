import { useState } from 'react'
import type { AnalysisResult } from '../../../shared/contracts'

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function FileSection(props: {
  inputPath: string | null
  media: Awaited<ReturnType<typeof window.clipHunter.probeMedia>> | null
  onSelect: () => void
  probing: boolean
  error: string | null
}): JSX.Element {
  return (
    <section className="card">
      <h2>1. Plik VOD</h2>
      <div className="row">
        <button onClick={props.onSelect}>Wybierz nagranie…</button>
        <span className="file-path">{props.inputPath ?? 'Nie wybrano pliku'}</span>
      </div>
      {props.probing && <div className="hint">Odczytywanie informacji o nagraniu…</div>}
      {props.error && <div className="error-banner">{props.error}</div>}
      {props.media && (
        <div className="meta-grid">
          <span>Czas trwania</span>
          <span>{formatTime(props.media.durationSeconds)}</span>
          <span>Rozdzielczość</span>
          <span>
            {props.media.width}x{props.media.height} @ {props.media.fps.toFixed(2)} fps
          </span>
          <span>Kodeki</span>
          <span>
            {props.media.videoCodec ?? '?'} / {props.media.audioCodec ?? 'brak dźwięku'}
          </span>
        </div>
      )}
      {props.media && !props.media.hasAudio && (
        <div className="warn-banner">Brak ścieżki dźwiękowej: analiza będzie oparta wyłącznie na odczycie wyniku.</div>
      )}
    </section>
  )
}

export function ProgressPanel(props: {
  stages: Array<{ name: string; status: string; progress?: number; detail?: string }>
  running: boolean
  error: string | null
  onCancel: () => void
}): JSX.Element {
  return (
    <section className="card">
      <div className="row">
        <h2>Postęp analizy</h2>
        {props.running && (
          <button className="danger" onClick={props.onCancel}>
            Anuluj
          </button>
        )}
      </div>
      {props.error && <div className="error-banner">{props.error}</div>}
      <ul className="stages">
        {props.stages.map((s) => (
          <li key={s.name} className={`stage stage-${s.status}`}>
            <span className="stage-name">{stageLabel(s.name)}</span>
            <span className="stage-status">
              {s.status === 'running' ? `${Math.round((s.progress ?? 0) * 100)}%` : stageStatus(s.status)}
            </span>
            {s.status === 'running' && (
              <div className="bar">
                <div
                  className="bar-fill"
                  style={{ width: `${Math.round((s.progress ?? 0) * 100)}%` }}
                />
              </div>
            )}
            {s.detail && <span className="stage-detail">{s.detail}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

function stageLabel(name: string): string {
  const labels: Record<string, string> = {
    prepare: 'Przygotowanie nagrania',
    scoreboard_scan: 'Odczytywanie wyniku',
    audio_analysis: 'Analiza dźwięku',
    build_events: 'Tworzenie zdarzeń',
    generate_clips: 'Tworzenie klipów',
    write_outputs: 'Zapisywanie wyników'
  }
  return labels[name] ?? name
}

function stageStatus(status: string): string {
  const labels: Record<string, string> = {
    pending: 'oczekuje',
    complete: 'gotowe',
    failed: 'błąd',
    skipped: 'pominięto',
    cancelled: 'anulowano',
    cancelling: 'anulowanie'
  }
  return labels[status] ?? status
}

export function ResultsPanel(props: { result: AnalysisResult | null }): JSX.Element {
  const [open, setOpen] = useState(false)
  if (!props.result) return <></>
  const { events, analysis } = props.result
  return (
    <section className="card">
      <div className="row">
        <h2>Wyniki</h2>
        <button onClick={() => void window.clipHunter.openPath(analysis.output_dir)}>
          Otwórz folder wyników
        </button>
        <button className="secondary" onClick={() => setOpen(!open)}>
          {open ? 'Ukryj metadane' : 'Pokaż metadane'}
        </button>
      </div>

      {open && (
        <pre className="meta-json">{JSON.stringify(analysis, null, 2)}</pre>
      )}

      {events.length === 0 ? (
        <div className="hint">Nie wykryto żadnych zdarzeń.</div>
      ) : (
        <table className="events-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Typ</th>
              <th>Czas zdarzenia</th>
              <th>Wynik</th>
              <th>Pewność</th>
              <th>Sygnały</th>
              <th>Klip</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{e.id}</td>
                <td>{e.type === 'GOAL' ? 'BRAMKA' : 'CIEKAWY MOMENT'}</td>
                <td>{formatTime(e.event_time)}</td>
                <td>
                  {e.score_before} → {e.score_after}
                </td>
                <td>{(e.confidence * 100).toFixed(0)}%</td>
                <td className="signals">
                  {e.signals.score_change && <span className="tag">wynik</span>}
                  {e.signals.audio_spike && (
                    <span className="tag">dźwięk +{(e.signals.audio_delta_db ?? 0).toFixed(1)}dB</span>
                  )}
                  {e.signals.keyword_goal && <span className="tag">słowo kluczowe</span>}
                </td>
                <td>
                  {e.clip ? (
                    <button
                      className="link"
                      onClick={() => void window.clipHunter.showItemInFolder(e.clip!.path)}
                    >
                      {e.clip.path.split('/').pop()}
                    </button>
                  ) : (
                    '—'
                  )}
                  {e.clip_vertical && (
                    <>
                      <br />
                      <button
                        className="link"
                        onClick={() => void window.clipHunter.showItemInFolder(e.clip_vertical!.path)}
                      >
                        {e.clip_vertical.path.split('/').pop()}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
