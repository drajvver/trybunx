import { useCallback, useEffect, useRef, useState } from 'react'
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

  const loadFrame = useCallback(async () => {
    if (!inputPath) return
    setLoading(true)
    setError(null)
    try {
      const img = await window.clipHunter.getFrameImage(inputPath, frameTime)
      setFrame(img)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [inputPath, frameTime])

  useEffect(() => {
    void loadFrame()
  }, [loadFrame])

  const toNormalized = (e: React.MouseEvent): { x: number; y: number } => {
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
          {loading ? 'Loading frame…' : 'Reload frame'}
        </button>
        <span className="hint">
          Draw a rectangle over the scoreboard (top-left of the frame usually)
        </span>
        {roi && (
          <button className="secondary" onClick={() => onRoiChange(null)}>
            Clear ROI
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div
        ref={containerRef}
        className="frame-container"
        onMouseDown={(e) => {
          if (!frame) return
          const p = toNormalized(e)
          dragging.current = true
          setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
        }}
        onMouseMove={(e) => {
          if (!dragging.current || !drag) return
          const p = toNormalized(e)
          setDrag({ ...drag, x1: p.x, y1: p.y })
        }}
        onMouseUp={() => {
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
        {frame ? (
          <img src={frame.dataUrl} alt="Video frame" draggable={false} />
        ) : (
          <div className="frame-placeholder">Select a VOD to load a frame</div>
        )}
        {rect && <div className="roi-rect" style={rect} />}
      </div>

      {roi && (
        <div className="roi-values">
          ROI (normalized): x={roi.x.toFixed(3)} y={roi.y.toFixed(3)} w={roi.width.toFixed(3)} h=
          {roi.height.toFixed(3)}
          {frame && (
            <span>
              {' '}
              ({Math.round(roi.x * frame.width)},{Math.round(roi.y * frame.height)}{' '}
              {Math.round(roi.width * frame.width)}x{Math.round(roi.height * frame.height)} px)
            </span>
          )}
        </div>
      )}
    </div>
  )
}
