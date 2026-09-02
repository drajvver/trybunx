/**
 * Benchmark runner (PRD section 32 Milestone 5 / section 34).
 *
 * Measures goal recall, precision, duplicate rate, timestamp error and clip
 * coverage against a manually annotated dataset:
 *
 *   dataset/
 *     match1.mp4
 *     match1.truth.json   { "events": [{ "type": "GOAL", "timestamp": 4034.5 }] }
 *     match2.mp4 ...
 *
 * Usage: npm run benchmark -- --dir dataset [--roi "x,y,w,h"]
 *        (or place a per-video "roi" field into each truth.json)
 */
import { parseArgs } from 'util'
import { readdirSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { runAnalysis } from '../src/main/pipeline/analyze'
import { buildConfig } from '../src/main/config/loader'
import type { DetectedEvent, Roi } from '../src/shared/contracts'

interface Truth {
  events: Array<{ type: string; timestamp: number; roi?: Roi }>
  roi?: Roi
}

interface VideoReport {
  video: string
  truthCount: number
  detectedCount: number
  truePositives: number
  duplicates: number
  timestampErrors: number[]
  clipCovered: number
  correctDetections: number
}

function matchEvent(event: DetectedEvent, truthEvents: Truth['events'], tolerance = 10) {
  return truthEvents.find(
    (t) => t.type === 'GOAL' && Math.abs(t.timestamp - event.event_time) <= tolerance
  )
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      roi: { type: 'string' },
      output: { type: 'string' }
    },
    strict: true
  })
  if (!values.dir) {
    console.error('Usage: npm run benchmark -- --dir <dataset> [--roi "x,y,w,h"]')
    return 2
  }
  const datasetDir = resolve(values.dir)
  const globalRoi = values.roi
    ? (() => {
        const [x, y, width, height] = values.roi.split(',').map(Number)
        return { x, y, width, height }
      })()
    : undefined

  const cfg = buildConfig({ defaultConfigPath: resolve(process.cwd(), 'config/default.yaml') })
  const outDir = resolve(values.output ?? join(datasetDir, 'benchmark_output'))
  mkdirSync(outDir, { recursive: true })

  const videos = readdirSync(datasetDir).filter((f) => /\.(mp4|mkv|mov)$/i.test(f))
  if (videos.length === 0) {
    console.error(`No videos found in ${datasetDir}`)
    return 2
  }

  const reports: VideoReport[] = []
  let processingSeconds = 0

  for (const video of videos) {
    const truthPath = join(datasetDir, video.replace(/\.[^.]+$/, '') + '.truth.json')
    if (!existsSync(truthPath)) {
      console.warn(`Skipping ${video}: no truth file`)
      continue
    }
    const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Truth
    const roi = truth.roi ?? globalRoi
    if (!roi) {
      console.error(`No ROI for ${video}: provide --roi or "roi" in the truth file`)
      return 2
    }

    const truthGoals = truth.events.filter((e) => e.type === 'GOAL')
    console.log(`\n=== ${video} (${truthGoals.length} ground-truth goals) ===`)

    const started = Date.now()
    const result = await runAnalysis({
      inputPath: join(datasetDir, video),
      roi,
      config: cfg,
      outputRoot: outDir,
      onStage: (stage, status, progress) => {
        if (status === 'running' && progress !== undefined) {
          process.stdout.write(`\r${stage} ${Math.round(progress * 100)}%   `)
        } else if (status !== 'running') {
          process.stdout.write(`\r${stage} ${status}   \n`)
        }
      }
    })
    processingSeconds += (Date.now() - started) / 1000

    const goals = result.events.filter((e) => e.type === 'GOAL')

    // Duplicate rate: same transition matched to multiple ground-truth slots is impossible;
    // duplicates = detected events sharing a transition key beyond the first.
    const seen = new Map<string, number>()
    let duplicates = 0
    for (const g of goals) {
      const key = `${g.score_before}|${g.score_after}`
      const n = seen.get(key) ?? 0
      if (n > 0) duplicates++
      seen.set(key, n + 1)
    }

    const matchedTruth = new Set<number>()
    const timestampErrors: number[] = []
    let clipCovered = 0
    let truePositives = 0
    for (const g of goals) {
      const t = matchEvent(g, truth.events)
      if (t && !matchedTruth.has(truth.events.indexOf(t))) {
        matchedTruth.add(truth.events.indexOf(t))
        truePositives++
        timestampErrors.push(Math.abs(g.event_time - t.timestamp))
        if (g.clip && g.clip.startSeconds <= g.event_time && g.clip.endSeconds >= g.event_time) {
          clipCovered++
        }
      }
    }

    reports.push({
      video,
      truthCount: truthGoals.length,
      detectedCount: goals.length,
      truePositives,
      duplicates,
      timestampErrors,
      clipCovered,
      correctDetections: truePositives
    })

    console.log(
      `detected=${goals.length} matched=${truePositives}/${truthGoals.length} duplicates=${duplicates}`
    )
  }

  // Aggregate PRD 34 metrics.
  const totalTruth = reports.reduce((n, r) => n + r.truthCount, 0)
  const totalDetected = reports.reduce((n, r) => n + r.detectedCount, 0)
  const totalTp = reports.reduce((n, r) => n + r.truePositives, 0)
  const totalDuplicates = reports.reduce((n, r) => n + r.duplicates, 0)
  const errors = reports.flatMap((r) => r.timestampErrors).sort((a, b) => a - b)
  const median = errors.length ? errors[Math.floor(errors.length / 2)] : 0
  const correctDetections = reports.reduce((n, r) => n + r.correctDetections, 0)
  const clipCovered = reports.reduce((n, r) => n + r.clipCovered, 0)

  const summary = {
    videos: reports.length,
    goal_recall: totalTruth ? totalTp / totalTruth : 0,
    goal_precision: totalDetected ? totalTp / totalDetected : 0,
    duplicate_rate: totalDetected ? totalDuplicates / totalDetected : 0,
    median_timestamp_error_seconds: median,
    clip_coverage: correctDetections ? clipCovered / correctDetections : 0,
    targets: {
      goal_recall: '>= 0.90',
      goal_precision: '>= 0.95',
      duplicate_rate: 0,
      median_timestamp_error_seconds: '<= 3',
      clip_coverage: '>= 0.95'
    },
    processing_seconds: Math.round(processingSeconds),
    reports
  }

  const summaryPath = join(outDir, 'benchmark_summary.json')
  const { writeFile } = await import('fs/promises')
  await writeFile(summaryPath, JSON.stringify(summary, null, 2))

  console.log('\n=== Benchmark summary ===')
  console.log(`Goal recall:            ${(summary.goal_recall * 100).toFixed(1)}%  (target >= 90%)`)
  console.log(`Goal precision:         ${(summary.goal_precision * 100).toFixed(1)}%  (target >= 95%)`)
  console.log(`Duplicate rate:         ${summary.duplicate_rate.toFixed(3)}  (target 0)`)
  console.log(`Median timestamp error: ${median.toFixed(2)}s  (target <= 3s)`)
  console.log(`Clip coverage:          ${(summary.clip_coverage * 100).toFixed(1)}%  (target >= 95%)`)
  console.log(`\nDetails: ${summaryPath}`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Benchmark failed: ${err.message}`)
    process.exit(1)
  })
