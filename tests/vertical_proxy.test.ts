import { describe, expect, it, beforeAll } from 'vitest'
import { existsSync, statSync } from 'fs'
import { resolve } from 'path'
import { spawnSync } from 'child_process'
import { PythonWorker } from '../src/main/workers/python_worker'
import { probeMedia } from '../src/main/media/ffprobe'
import { computeClipWindow } from '../src/main/clips/generator'
import { renderVerticalClip } from '../src/main/vertical/renderer'
import { buildConfig } from '../src/main/config/loader'
import { mkdir, rm } from 'fs/promises'

const ROOT = resolve(__dirname, '..')
const MODEL = resolve(ROOT, 'python/track/models/ball.onnx')
const OUT = resolve(ROOT, 'tests/fixtures/vertical_proxy')

interface ProxyCase {
  name: string
  input: string
  start: number
  end: number
  sourceWidth: number
  sourceHeight: number
  /** Minimum tracked share; real broadcast footage tracks nearly fully. */
  minTrackedShare: number
}

/** Real TrybunaTV broadcast footage (not committed; local verification). */
const REAL_CASES: ProxyCase[] = [
  {
    name: 'short-goal',
    input: '/Users/kpaliga/Movies/short.webm',
    start: 135,
    end: 160,
    sourceWidth: 1920,
    sourceHeight: 1080,
    minTrackedShare: 0.6
  },
  {
    name: 'goal2',
    input: '/Users/kpaliga/Movies/goal2.webm',
    start: 10,
    end: 35,
    sourceWidth: 1920,
    sourceHeight: 1080,
    minTrackedShare: 0.6
  }
]

const availableCases = REAL_CASES.filter((c) => existsSync(c.input) && existsSync(MODEL))

describe('vertical render proxy (no OCR)', () => {
  let worker: PythonWorker
  const verticals: Array<{ name: string; path: string; start: number; end: number }> = []

  beforeAll(async () => {
    if (availableCases.length === 0 || !existsSync(MODEL)) return
    await rm(OUT, { recursive: true, force: true })
    await mkdir(OUT, { recursive: true })
    worker = new PythonWorker({
      pythonPath: resolve(ROOT, 'python/.venv/bin/python'),
      scriptPath: resolve(ROOT, 'python/worker.py'),
      cwd: resolve(ROOT, 'python')
    })
    await worker.start()

    const cfg = buildConfig({ defaultConfigPath: resolve(ROOT, 'config/default.yaml') })
    for (const c of availableCases) {
      const media = await probeMedia(c.input)
      const window = { start: c.start, end: c.end }
      const outPath = resolve(OUT, `proxy_${c.name}_vertical.mp4`)
      const { info } = await renderVerticalClip({
        inputPath: c.input,
        outputPath: outPath,
        window,
        durationSeconds: media.durationSeconds,
        sourceWidth: media.width,
        sourceHeight: media.height,
        sourceFps: media.fps,
        cfg,
        worker,
        tempDir: OUT
      })
      verticals.push({ name: c.name, path: outPath, start: c.start, end: c.end })
      ;(globalThis as Record<string, unknown>)[`proxy_${c.name}`] = info
    }
    await worker.stop().catch(() => undefined)
  }, 600000)

  it('renders tracked 1080x1920 vertical clips on real footage', () => {
    if (availableCases.length === 0 || !existsSync(MODEL)) {
      console.warn('skipping: real footage or ball model missing')
      return
    }
    expect(verticals).toHaveLength(availableCases.length)
    for (const v of verticals) {
      const expected = availableCases.find((c) => c.name === v.name)!
      const info = (globalThis as Record<string, unknown>)[`proxy_${v.name}`] as {
        width: number
        height: number
        tracking: { samples: number; tracked: number; fallback: boolean }
        durationSeconds: number
      }
      expect(existsSync(v.path)).toBe(true)
      expect(statSync(v.path).size).toBeGreaterThan(10 * 1024)
      expect(info.width).toBe(1080)
      expect(info.height).toBe(1920)
      expect(info.durationSeconds).toBeCloseTo(v.end - v.start, 0)
      expect(info.tracking.samples).toBeGreaterThan(10)
      expect(info.tracking.fallback).toBe(false)
      expect(info.tracking.tracked / info.tracking.samples).toBeGreaterThanOrEqual(
        expected.minTrackedShare
      )
    }
  })

  it('pans the crop instead of sitting static', async () => {
    if (availableCases.length === 0 || !existsSync(MODEL)) return
    const c = availableCases[0]
    // Re-run tracking directly and assert the trajectory moves.
    const worker2 = new PythonWorker({
      pythonPath: resolve(ROOT, 'python/.venv/bin/python'),
      scriptPath: resolve(ROOT, 'python/worker.py'),
      cwd: resolve(ROOT, 'python')
    })
    await worker2.start()
    try {
      const cfg = buildConfig({ defaultConfigPath: resolve(ROOT, 'config/default.yaml') })
      const { trackBall } = await import('../src/main/vertical/tracker')
      const { computeTrajectory } = await import('../src/main/vertical/smoothing')
      const track = await trackBall({
        worker: worker2,
        inputPath: c.input,
        start: c.start,
        end: c.end,
        sourceWidth: c.sourceWidth,
        sourceHeight: c.sourceHeight,
        cfg
      })
      const traj = computeTrajectory(
        track.samples, c.start, c.end, c.sourceWidth, c.sourceHeight, 25, cfg.vertical
      )
      const travel = Math.max(...traj.xs) - Math.min(...traj.xs)
      expect(travel).toBeGreaterThan(200) // action crosses the frame; crop must follow
    } finally {
      await worker2.stop().catch(() => undefined)
    }
  }, 300000)
})

describe('vertical proxy clip windows', () => {
  it('shares the horizontal window math', () => {
    const cfg = buildConfig({ defaultConfigPath: resolve(ROOT, 'config/default.yaml') })
    const w = computeClipWindow(80, 100, cfg.clips)
    expect(w.end - w.start).toBeLessThanOrEqual(cfg.clips.max_clip_seconds)
  })
})

export { spawnSync }
