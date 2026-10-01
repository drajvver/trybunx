import { useCallback, useEffect, useRef, useState } from 'react'
import { userError } from '../errors'
import type { Roi } from '../../../shared/contracts'

interface Props {
  inputPath: string
  frameTime: number
  roi: Roi | null
  onRoiChange: (roi: Roi | null) => void
}

/**
 * Scoreboard ROI editor (PRD 29.2): shows a representative frame and lets the
 * user draw the scoreboard rectangle. Coordinates are stored normalized.
 */
export function RoiEditor({ inputPath, frameTime, roi, onRoiChange }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [frame, setFrame] = useState<{ dataUrl: string; width: number; height: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const dragging = useRef(false)
  const requestId = useRef(0)
  const [loadedSource, setLoadedSource] = useState('')
  const source = `${inputPath}:${frameTime}`
  const ready = !!frame && !loading && loadedSource === source

  const loadFrame = useCallback(async () => {
    const request = ++requestId.current
    setFrame(null)
    setDrag(null)
    dragging.current = false
    if (!inputPath) { setLoading(false); return }
    setLoading(true)
    setError(null)
    try {
      const img = await window.clipHunter.getFrameImage(inputPath, frameTime)
      if (request !== requestId.current) return
      if (!img) throw new Error('Nie udało się pokazać tego momentu nagrania. Wybierz inny czas i spróbuj ponownie.')
      setFrame(img)
      setLoadedSource(`${inputPath}:${frameTime}`)
    } catch (err) {
      if (request === requestId.current) setError(userError(err, 'Nie udało się pokazać tego momentu nagrania. Wybierz inny czas i spróbuj ponownie.'))
    } finally {
      if (request === requestId.current) setLoading(false)
    }
  }, [inputPath, frameTime])

  useEffect(() => {
    void loadFrame()
    return () => { requestId.current++ }
  }, [loadFrame])

  const toNormalized = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = containerRef.current!.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    }
  }

  const displayRect = (): { left: string; top: string; width: string; height: string } | null => {
    let x0: number, y0: number, x1: number, y1: number
    if (drag) {
      x0 = Math.min(drag.x0, drag.x1)
      y0 = Math.min(drag.y0, drag.y1)
      x1 = Math.max(drag.x0, drag.x1)
      y1 = Math.max(drag.y0, drag.y1)
    } else if (roi) {
      x0 = roi.x
      y0 = roi.y
      x1 = roi.x + roi.width
      y1 = roi.y + roi.height
    } else {
      return null
    }
    return {
      left: `${x0 * 100}%`,
      top: `${y0 * 100}%`,
      width: `${(x1 - x0) * 100}%`,
      height: `${(y1 - y0) * 100}%`
    }
  }

  const rect = displayRect()

  return (
    <div className="roi-editor">
      <div className="roi-toolbar">
        <button onClick={() => void loadFrame()} disabled={!inputPath || loading}>
          {loading ? 'Wczytywanie podglądu…' : 'Odśwież podgląd'}
        </button>
        <span className="hint">
          Przeciągnij myszą wokół liczb z wynikiem obu drużyn. Pomiń zegar meczu i logo stacji.
        </span>
        {roi && (
          <button className="secondary" onClick={() => onRoiChange(null)}>
            Usuń zaznaczenie
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div
        ref={containerRef}
        className="frame-container"
        style={{ touchAction: 'none' }}
        aria-busy={loading}
        onPointerCancel={() => { dragging.current = false; setDrag(null) }}
        onPointerDown={(e) => {
          if (!ready || e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          const p = toNormalized(e)
          dragging.current = true
          setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
        }}
        onPointerMove={(e) => {
          if (!dragging.current || !drag) return
          const p = toNormalized(e)
          setDrag({ ...drag, x1: p.x, y1: p.y })
        }}
        onPointerUp={() => {
          if (!dragging.current || !drag) return
          dragging.current = false
          const x = Math.min(drag.x0, drag.x1)
          const y = Math.min(drag.y0, drag.y1)
          const width = Math.abs(drag.x1 - drag.x0)
          const height = Math.abs(drag.y1 - drag.y0)
          setDrag(null)
          if (width > 0.005 && height > 0.005) {
            onRoiChange({ x, y, width, height })
          }
        }}
      >
        {ready ? (
          <img src={frame!.dataUrl} alt="Podgląd wybranego momentu nagrania" draggable={false} />
        ) : (
          <div className="frame-placeholder">{loading ? 'Wczytywanie podglądu…' : 'Najpierw wybierz nagranie meczu. Tutaj pojawi się jego podgląd.'}</div>
        )}
        {rect && <div className="roi-rect" style={rect} />}
      </div>

      <fieldset disabled={!ready} className="roi-numeric">
        <legend>Możesz też ustawić zaznaczenie, wpisując liczby</legend>
        <p className="hint">Wartości są podane jako procent szerokości lub wysokości obrazu. Na przykład szerokość 25% obejmuje jedną czwartą obrazu. Obszar nie może wyjść poza obraz.</p>
        <div className="row">
          {(['x', 'y', 'width', 'height'] as const).map((field) => (
            <div className="roi-field" key={field}>
              <label htmlFor={`roi-${field}`}>
                {{ x: 'Odległość od lewej krawędzi (%)', y: 'Odległość od góry obrazu (%)', width: 'Szerokość zaznaczenia (%)', height: 'Wysokość zaznaczenia (%)' }[field]}
              </label>
              <input id={`roi-${field}`} aria-describedby={`roi-${field}-help`} type="number" min={field === 'width' || field === 'height' ? 1 : 0} max={100} step={0.1}
                value={Math.round((roi ?? { x: 0, y: 0, width: 0.25, height: 0.1 })[field] * 1000) / 10}
                onChange={(event) => {
                  const next = { ...(roi ?? { x: 0, y: 0, width: 0.25, height: 0.1 }), [field]: Number(event.target.value) / 100 }
                  next.x = Math.max(0, Math.min(0.99, next.x))
                  next.y = Math.max(0, Math.min(0.99, next.y))
                  next.width = Math.max(0.01, Math.min(1 - next.x, next.width))
                  next.height = Math.max(0.01, Math.min(1 - next.y, next.height))
                  onRoiChange(next)
                }} />
              <small id={`roi-${field}-help`}>
                {{
                  x: 'Zwiększ: przesuń zaznaczenie w prawo. Zmniejsz: przesuń je w lewo.',
                  y: 'Zwiększ: przesuń zaznaczenie w dół. Zmniejsz: przesuń je w górę.',
                  width: 'Zwiększ: obejmij szerszy fragment. Zmniejsz: zawęź zaznaczenie do liczb wyniku.',
                  height: 'Zwiększ: obejmij wyższy fragment. Zmniejsz: ogranicz zaznaczenie do liczb wyniku.'
                }[field]}
              </small>
            </div>
          ))}
          {!roi && <button onClick={() => onRoiChange({ x: 0, y: 0, width: 0.25, height: 0.1 })}>Dodaj zaznaczenie</button>}
        </div>
      </fieldset>
      {roi && (
        <div className="roi-values">
          Zaznaczenie obejmuje {(roi.width * 100).toLocaleString('pl-PL', { maximumFractionDigits: 1 })}% szerokości i {(roi.height * 100).toLocaleString('pl-PL', { maximumFractionDigits: 1 })}% wysokości obrazu.
          {frame && (
            <span> Rozmiar zaznaczenia: {Math.round(roi.width * frame.width)}x{Math.round(roi.height * frame.height)} punktów obrazu.</span>
          )}
        </div>
      )}
    </div>
  )
}
