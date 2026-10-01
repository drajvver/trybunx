import { useState } from 'react'
import { userError } from '../errors'
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
      <h2>1. Wybierz nagranie meczu</h2>
      <div className="row">
        <button onClick={props.onSelect}>Wybierz nagranie…</button>
        <span className="file-path">{props.inputPath ?? 'Nie wybrano nagrania'}</span>
      </div>
      {props.probing && <div className="hint">Odczytywanie informacji o nagraniu…</div>}
      {props.error && <div className="error-banner">{props.error}</div>}
      {props.media && (
        <div className="meta-grid">
          <span>Długość nagrania</span>
          <span>{formatTime(props.media.durationSeconds)}</span>
          <span>Wymiary obrazu</span>
          <span>
            {props.media.width}x{props.media.height} punktów obrazu
          </span>
          <span>Płynność nagrania</span>
          <span>{props.media.fps.toLocaleString('pl-PL', { maximumFractionDigits: 2 })} obrazów na sekundę</span>
          <span>Dźwięk</span>
          <span>{props.media.hasAudio ? 'Nagranie zawiera dźwięk' : 'Nagranie bez dźwięku'}</span>
        </div>
      )}
      {props.media && !props.media.hasAudio && (
        <div className="warn-banner">To nagranie nie ma dźwięku. Aplikacja poszuka bramek po zmianie wyniku na ekranie. Nie znajdzie momentów na podstawie dopingu ani komentarza.</div>
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
    build_events: 'Wybieranie bramek i ciekawych momentów',
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
  const [error, setError] = useState<string | null>(null)
  if (!props.result) return <></>
  const { events, analysis } = props.result
  return (
    <section className="card">
      <div className="row">
        <h2>Wyniki</h2>
        <button onClick={() => void window.clipHunter.openPath(analysis.output_dir).catch((err) => setError(userError(err, 'Nie udało się otworzyć folderu wyników.')))}>
          Otwórz folder wyników
        </button>
        <button className="secondary" onClick={() => setOpen(!open)}>
          {open ? 'Ukryj podsumowanie' : 'Pokaż podsumowanie analizy'}
        </button>
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {analysis.degraded.length > 0 && (
        <div className="warn-banner" role="status">
          Gotowe. Zwróć uwagę na poniższe informacje.
          {analysis.degraded.some((item) => item.startsWith('vertical_failed:')) && ' Nie udało się utworzyć części klipów pionowych.'}
          {analysis.degraded.some((item) => item.startsWith('clip_failed:')) && ' Nie udało się utworzyć części klipów poziomych.'}
          {analysis.degraded.some((item) => item.startsWith('audio_analysis')) && ' Dźwięk nie został wykorzystany. Bramki wyszukano po zmianach wyniku na ekranie.'}
          {analysis.degraded.some((item) => item.startsWith('vertical_center_fallback:')) && ' W części klipów pionowych pokazano środek obrazu, ponieważ nie udało się śledzić piłki ani zawodników.'}
        </div>
      )}
      {open && (
        <dl className="analysis-summary">
          <dt>Długość sprawdzonego nagrania</dt><dd>{formatTime(analysis.duration_seconds)} (minuty:sekundy)</dd>
          <dt>Czas pracy aplikacji</dt><dd>{analysis.processing_seconds.toLocaleString('pl-PL')} sekund</dd>
          <dt>Sprawdzone obrazy z wynikiem</dt><dd>{analysis.ocr_samples}</dd>
          <dt>Obrazy, na których odczytano wynik</dt><dd>{analysis.ocr_ok_samples}</dd>
          <dt>Wykryte bramki</dt><dd>{analysis.goal_events_created}</dd>
          <dt>Gotowe klipy poziome</dt><dd>{analysis.clips_created}</dd>
          <dt>Gotowe klipy pionowe</dt><dd>{analysis.vertical_clips_created ?? 0}</dd>
        </dl>
      )}

      {events.length === 0 ? (
        <div className="hint">Nie znaleziono bramek ani ciekawych momentów. Sprawdź, czy zaznaczony obszar obejmuje cały wynik i czy wynik jest czytelny w nagraniu.</div>
      ) : (
        <>
        <p className="hint">Czas oznacza moment od początku nagrania (minuty:sekundy). Kliknij „Poziomy” lub „Pionowy”, aby znaleźć plik w folderze. Pionowy klip jest przeznaczony do oglądania na telefonie.</p>
        <p className="hint">Ocena aplikacji pokazuje siłę wskazówek, na podstawie których wybrano moment. Wyższy procent oznacza mocniejsze wskazówki; to nie jest gwarancja, że padła bramka.</p>
        <table className="events-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Co znaleziono</th>
              <th>Moment nagrania</th>
              <th>Zmiana wyniku</th>
              <th>Ocena aplikacji</th>
              <th>Dlaczego wybrano</th>
              <th>Gotowe klipy</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, index) => (
              <tr key={e.id}>
                <td>{index + 1}</td>
                <td>{e.type === 'GOAL' ? 'BRAMKA' : 'CIEKAWY MOMENT'}</td>
                <td>{formatTime(e.event_time)}</td>
                <td>
                  {e.score_before && e.score_after ? `${e.score_before} → ${e.score_after}` : 'Bez zmiany wyniku'}
                </td>
                <td>{(e.confidence * 100).toFixed(0)}%</td>
                <td className="signals">
                  {e.signals.score_change && <span className="tag">zmiana wyniku</span>}
                  {e.signals.audio_spike && (
                    <span className="tag">głośna reakcja</span>
                  )}
                  {e.signals.keyword_goal && <span className="tag">komentator mówi o bramce</span>}
                </td>
                <td>
                  {e.clip ? (
                    <button
                      className="link"
                      onClick={() => void window.clipHunter.showItemInFolder(e.clip!.path).catch((err) => setError(userError(err, 'Nie udało się odnaleźć klipu.')))}
                    >
                      Poziomy
                    </button>
                  ) : (
                    'Nie utworzono'
                  )}
                  {e.clip_vertical && (
                    <>
                      <br />
                      <button
                        className="link"
                        onClick={() => void window.clipHunter.showItemInFolder(e.clip_vertical!.path).catch((err) => setError(userError(err, 'Nie udało się odnaleźć klipu pionowego.')))}
                      >
                        Pionowy
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </>
      )}
    </section>
  )
}
