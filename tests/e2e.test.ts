/**
 * End-to-end test: generates a synthetic VOD, runs the exact production
 * pipeline through the headless CLI, and validates events, timestamps,
 * dedup and clips against ground truth (PRD section 35 targets).
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { resolve } from 'path'
import { makeSyntheticMatch } from '../scripts/make_synthetic_match'

const ROOT = resolve(__dirname, '..')
const FIXTURES = resolve(ROOT, 'tests', 'fixtures')
const VIDEO = resolve(FIXTURES, 'synthetic_match.mp4')
const TRUTH = resolve(FIXTURES, 'synthetic_match.truth.json')
const OUTPUT = resolve(FIXTURES, 'e2e_output')

// Scoreboard box spans roughly (16,16)-(316,80); ROI with margin, normalized.
const ROI = '0.005,0.01,0.30,0.13'

interface TruthFile {
  events: Array<{ type: string; timestamp: number; scoreboard_update: number; score_after: string }>
}

interface E2EEvent {
  id: string
  type: string
  event_time: number
  detected_from_score_change?: number
  confidence: number
  score_before?: string
  score_after?: string
  clip?: { path: string; durationSeconds: number; startSeconds: number; endSeconds: number }
}

beforeAll(async () => {
  await makeSyntheticMatch(VIDEO)
})

function runCli(): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(
    process.execPath,
    [
      '--import', 'tsx',
      resolve(ROOT, 'src', 'main', 'cli.ts'),
      '--input', VIDEO,
      '--roi', ROI,
      '--output', OUTPUT,
      '--name', 'e2e_run'
    ],
    { encoding: 'utf8', cwd: ROOT, timeout: 600000 }
  )
}

describe('end-to-end pipeline on synthetic VOD', () => {
  let cliResult: { status: number | null; stdout: string; stderr: string }
  let events: E2EEvent[]

  beforeAll(() => {
    cliResult = runCli()
    if (existsSync(resolve(OUTPUT, 'e2e_run', 'events.json'))) {
      const parsed = JSON.parse(
        readFileSync(resolve(OUTPUT, 'e2e_run', 'events.json'), 'utf8')
      ) as { events: E2EEvent[] }
      events = parsed.events
    }
  })

  it('completes analysis and produces the output contract', () => {
    if (cliResult.status !== 0) {
      console.error('CLI stdout:', cliResult.stdout)
      console.error('CLI stderr:', cliResult.stderr)
    }
    expect(cliResult.status).toBe(0)

    expect(existsSync(resolve(OUTPUT, 'e2e_run', 'events.json'))).toBe(true)
    expect(existsSync(resolve(OUTPUT, 'e2e_run', 'analysis.json'))).toBe(true)
    expect(existsSync(resolve(OUTPUT, 'e2e_run', 'logs', 'analysis.log'))).toBe(true)
    expect(existsSync(resolve(OUTPUT, 'e2e_run', 'clips'))).toBe(true)
  })

  it('detects every goal exactly once with correct transitions', () => {
    const truth = JSON.parse(readFileSync(TRUTH, 'utf8')) as TruthFile
    const goals = events.filter((e) => e.type === 'GOAL')
    expect(goals).toHaveLength(truth.events.length)

    // No event for the initial 0:0 baseline.
    expect(goals.every((e) => e.score_before !== e.score_after)).toBe(true)

    // Transitions match the script exactly: 0:0->1:0, 1:0->1:1, 1:1->2:1.
    const transitions = goals.map((e) => `${e.score_before}->${e.score_after}`)
    expect(transitions).toEqual(['0:0->1:0', '1:0->1:1', '1:1->2:1'])

    // Timestamp accuracy target: median error <= 3s (PRD 34.4).
    const errors = goals.map((e, i) => Math.abs(e.event_time - truth.events[i].timestamp))
    const median = [...errors].sort((a, b) => a - b)[Math.floor(errors.length / 2)]
    expect(median).toBeLessThanOrEqual(3)
    for (const err of errors) expect(err).toBeLessThanOrEqual(4)

    // The score change should be located near the scripted scoreboard update.
    for (let i = 0; i < goals.length; i++) {
      const delta = Math.abs(
        (goals[i].detected_from_score_change ?? -1) - truth.events[i].scoreboard_update
      )
      expect(delta).toBeLessThanOrEqual(1.5)
    }
  })

  it('generates one valid clip per goal, each <= 30s and covering the goal moment', () => {
    const truth = JSON.parse(readFileSync(TRUTH, 'utf8')) as TruthFile

    const goals = events.filter((e) => e.type === 'GOAL')
    expect(goals).toHaveLength(truth.events.length)

    const clipsDir = resolve(OUTPUT, 'e2e_run', 'clips')
    const files = readdirSync(clipsDir).filter((f) => f.endsWith('.mp4'))
    expect(files).toHaveLength(truth.events.length)

    for (const goal of goals) {
      expect(goal.clip).toBeDefined()
      const onDisk = statSync(goal.clip!.path)
      expect(onDisk.size).toBeGreaterThan(10 * 1024)
      // PRD 35.8: every clip <= 30 seconds.
      expect(goal.clip!.durationSeconds).toBeLessThanOrEqual(31)
      expect(goal.clip!.durationSeconds).toBeGreaterThan(15)
      // PRD 35.9: the clip must include the goal moment.
      expect(goal.clip!.startSeconds).toBeLessThanOrEqual(goal.event_time + 0.5)
      expect(goal.clip!.endSeconds).toBeGreaterThanOrEqual(goal.event_time - 0.5)
    }

    // Clip naming: goal_01_1m20s.mp4 style (PRD section 7).
    expect(files[0]).toMatch(/^goal_01_\d+m\d+s\.mp4$/)
  })
})
