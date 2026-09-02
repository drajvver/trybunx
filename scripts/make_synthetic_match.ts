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

export async function makeSyntheticMatch(outPath: string, force = false): Promise<void> {
  if (existsSync(outPath) && !force) return
  await mkdir(resolve(outPath, '..'), { recursive: true })

  const vf = ['drawbox=x=16:y=16:w=300:h=64:color=black@0.9:t=fill', ...scoreTexts()].join(',')

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
      outPath
    ],
    { timeoutSeconds: 600 }
  )

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
