#!/usr/bin/env node
/**
 * Headless analysis runner. Uses exactly the same pipeline core as the
 * Electron app, which makes the detection engine testable without a display
 * (PRD 3.3: easy offline testing) and enables benchmark runs (PRD 32/M5).
 */
import { parseArgs } from 'util'
import { resolve } from 'path'
import { runAnalysis } from './pipeline/analyze'
import { buildConfig } from './config/loader'
import { StageName } from '../shared/contracts'
import { Roi } from '../shared/contracts'

function parseRoi(spec: string): Roi {
  const parts = spec.split(',').map(Number)
  if (parts.length !== 4 || parts.some((n) => isNaN(n))) {
    throw new Error('--roi must be "x,y,width,height" in normalized 0..1 coordinates')
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      roi: { type: 'string' },
      config: { type: 'string' },
      'user-config': { type: 'string' },
      output: { type: 'string' },
      name: { type: 'string' },
      'keep-temp': { type: 'boolean' },
      help: { type: 'boolean' }
    },
    strict: true
  })

  if (values.help || !values.input || !values.roi) {
    console.log(`TrybunaTV AI Clip Hunter - headless analysis runner

Usage:
  npm run analyze -- --input match.mp4 --roi "0.04,0.03,0.18,0.08" [options]

Options:
  --input         path to the VOD file (required)
  --roi           scoreboard ROI, normalized "x,y,width,height" (required)
  --config        path to config YAML (default: config/default.yaml)
  --user-config   additional user config YAML merged on top
  --output        output root directory (default: config output.dir)
  --name          explicit run directory name
  --keep-temp     keep temporary frame/audio artifacts for debugging
  --help          show this help
`)
    return values.help ? 0 : 2
  }

  const cfg = buildConfig({
    defaultConfigPath: values.config
      ? resolve(values.config)
      : resolve(process.cwd(), 'config/default.yaml'),
    userConfigPath: values['user-config'] ? resolve(values['user-config']) : undefined
  })

  const stageProgress = new Map<StageName, number>()
  let currentStage: StageName | null = null

  const result = await runAnalysis({
    inputPath: resolve(values.input),
    roi: parseRoi(values.roi),
    config: cfg,
    outputRoot: values.output ? resolve(values.output) : undefined,
    runName: values.name,
    keepTemp: values['keep-temp'],
    onStage: (stage, status, progress) => {
      if (progress !== undefined) stageProgress.set(stage, progress)
      if (status === 'running') {
        if (currentStage !== stage) {
          currentStage = stage
          console.log(`\n=== ${stage} ===`)
        }
        const pct = Math.floor((stageProgress.get(stage) ?? 0) * 100)
        process.stdout.write(`\r${stage}: ${pct}%   `)
      } else if (status === 'complete') {
        process.stdout.write(`\r${stage}: done      \n`)
      } else if (status === 'failed') {
        process.stdout.write(`\r${stage}: FAILED    \n`)
      } else if (status === 'skipped') {
        process.stdout.write(`\r${stage}: skipped   \n`)
      }
    }
  })

  console.log(`\nDetected events: ${result.events.length}`)
  for (const e of result.events) {
    console.log(
      `  ${e.id} ${e.type} t=${e.event_time.toFixed(2)}s ` +
        `score ${e.score_before} -> ${e.score_after} conf=${e.confidence}` +
        (e.clip ? ` clip=${e.clip.path}` : ' (no clip)')
    )
  }
  console.log(`Output: ${result.analysis.output_dir}`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\nAnalysis failed: ${err.message}`)
    process.exit(1)
  })
