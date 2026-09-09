/**
 * Generates a synthetic football broadcast VOD for end-to-end testing:
 * a scoreboard graphic that changes at known times, and crowd-noise audio
 * that spikes exactly when each "goal" happens.
 *
 * Ground truth is written next to the video as <name>.truth.json.
 */
import { mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { runProcess } from '../src/main/media/process'

export const DURATION_S = 330
export const WIDTH = 1280
export const HEIGHT = 720
export const FPS = 25

/** goalTime = crowd roar start = true goal moment; updateAt = scoreboard change. */
export const GOALS = [
  { goalTime: 80, updateAt: 83, score: '1 - 0' },
  { goalTime: 200, updateAt: 203, score: '1 - 1' },
  { goalTime: 300, updateAt: 304, score: '2 - 1' }
]

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

function scoreTexts(): string[] {
  const bounds = [0, ...GOALS.map((g) => g.updateAt), DURATION_S + 1]
  const texts = ['0 - 0', ...GOALS.map((g) => g.score)]
  const filters: string[] = []
  for (let i = 0; i < texts.length; i++) {
    const from = bounds[i]
    const to = bounds[i + 1]
    const enable =
      i === 0
        ? `lt(t,${to})`
        : i === texts.length - 1
          ? `gte(t,${from})`
          : `between(t,${from},${to})`
    filters.push(
      `drawtext=fontfile=${FONT}:text='${texts[i]}':fontcolor=white:fontsize=44:` +
        `x=28:y=30:box=1:boxcolor=black:boxborderw=14:enable='${enable}'`
    )
  }
  return filters
}

function audioFilter(): string {
  const boosts = GOALS.map(
    (g) => `+ 0.55*between(t,${g.goalTime},${g.goalTime + 4.5})`
  ).join(' ')
  return `volume='0.06 ${boosts}':eval=frame`
}

/**
 * A trackable ball for the vertical-crop E2E: a white disc with dark patches
 * (the texture nano-YOLO keys on) sweeping across the pitch. It crosses the
 * frame center exactly at each goal moment so the 9:16 window must pan to
 * keep it in frame.
 *
 * NOTE: drawbox x/y expressions with `t` are evaluated once per filtergraph
 * config in this FFmpeg version, so the sweep is rendered as discrete
 * per-second steps instead of smooth motion. Tracking only needs ~3 samples
 * per second, so steps are fine. Circles are approximated with stacked boxes
 * (drawbox cannot draw circles); r=20 reads at conf ~0.6 after H.264.
 */
export function ballOverlay(): string {
  return ballOverlayChunk(0, DURATION_S)
}

/** Ball overlay filters active inside [from, to), for chunked encoding. */
export function ballOverlayChunk(from: number, to: number): string {
  const overlays: string[] = []
  // Disc rows: [dy, dx, w] relative to a 44x44 box (r=20 disc).
  const rows: Array<[number, number, number]> = [
    [2, 13, 18],
    [5, 8, 28],
    [8, 5, 34],
    [11, 3, 38],
    [14, 2, 40],
    [17, 2, 40],
    [20, 2, 40],
    [23, 2, 40],
    [26, 3, 38],
    [29, 5, 34],
    [32, 8, 28],
    [35, 13, 18]
  ]
  for (const g of GOALS) {
    const t0 = Math.max(0, Math.floor(g.goalTime - 8))
    const t1 = Math.ceil(g.goalTime + 8)
    for (let t = t0; t < t1; t++) {
      if (t + 1 <= from || t >= to) continue
      const x = Math.round(((t - t0 + 0.5) / (t1 - t0)) * (WIDTH - 60))
      const y = 330 + Math.round(60 * Math.sin((t / 4) * Math.PI))
      const en = `enable='between(t,${t},${t + 1})'`
      for (const [dy, dx, w] of rows) {
        overlays.push(`drawbox=x=${x + dx}:y=${y + dy}:w=${w}:h=3:color=white:t=fill:${en}`)
      }
      overlays.push(`drawbox=x=${x + 15}:y=${y + 14}:w=10:h=10:color=black:t=fill:${en}`)
      overlays.push(`drawbox=x=${x + 28}:y=${y + 26}:w=8:h=8:color=black:t=fill:${en}`)
    }
  }
  return overlays.join(',')
}

export async function makeSyntheticMatch(outPath: string, force = false): Promise<void> {
  if (existsSync(outPath) && !force) return
  await mkdir(resolve(outPath, '..'), { recursive: true })

  const vf = [
    'drawbox=x=16:y=16:w=300:h=64:color=black@0.9:t=fill',
    ...scoreTexts()
  ].join(',')

  await runProcess(
    'ffmpeg',
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=0x1e6b34:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${DURATION_S}`,
      '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.5:duration=${DURATION_S}:seed=42`,
      '-vf', vf,
      '-af', audioFilter(),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k',
      '-shortest',
      `${outPath}.noball.mp4`
    ],
    { timeoutSeconds: 600 }
  )

  // Second pass overlays the trackable ball. (One pass with ~700 drawbox
  // filters trips an FFmpeg filtergraph limit on some builds, and the ball
  // must be overlaid after encoding anyway; two passes stay reliable.)
  // Chunk the overlay into segments so no single filtergraph is oversized.
  const CHUNK_S = 60
  let chained = `${outPath}.noball.mp4`
  for (let c = 0; c * CHUNK_S < DURATION_S; c++) {
    const from = c * CHUNK_S
    const to = Math.min(DURATION_S, from + CHUNK_S)
    const chunkFilters = ballOverlayChunk(from, to)
    const next = c * CHUNK_S + CHUNK_S >= DURATION_S ? outPath : `${outPath}.ball${c}.mp4`
    if (chunkFilters) {
      await runProcess(
        'ffmpeg',
        [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-i', chained,
          '-vf', chunkFilters,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
          '-c:a', 'copy',
          next
        ],
        { timeoutSeconds: 600 }
      )
    } else if (next !== chained) {
      await import('fs/promises').then((m) => m.copyFile(chained, next))
    }
    if (chained !== `${outPath}.noball.mp4`) {
      await import('fs/promises').then((m) => m.rm(chained, { force: true }))
    }
    chained = next
  }
  await import('fs/promises').then((m) => m.rm(`${outPath}.noball.mp4`, { force: true }))

  const truth = {
    video: resolve(outPath),
    duration_seconds: DURATION_S,
    events: GOALS.map((g, i) => ({
      type: 'GOAL',
      timestamp: g.goalTime,
      scoreboard_update: g.updateAt,
      score_after: g.score.replace(/ /g, ''),
      index: i + 1
    }))
  }
  await writeFile(outPath.replace(/\.mp4$/, '.truth.json'), JSON.stringify(truth, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const out = process.argv[2] || 'tests/fixtures/synthetic_match.mp4'
  makeSyntheticMatch(resolve(out), process.argv.includes('--force'))
    .then(() => console.log(`Synthetic match written to ${resolve(out)}`))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
