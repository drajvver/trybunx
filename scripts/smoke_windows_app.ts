import { _electron as electron } from 'playwright'
import { resolve, dirname, join } from 'path'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { makeSyntheticMatch } from './make_synthetic_match'

async function main(): Promise<void> {
  const executablePath = resolve(process.argv[2] || 'dist/win-unpacked/TrybunaTV AI Clip Hunter.exe')
  const resources = join(dirname(executablePath), 'resources')
  const temp = await mkdtemp(join(tmpdir(), 'Trybunx installed test '))
  const video = join(temp, 'mecz testowy.mp4')
  process.env.TRYBUNX_PYTHON = join(resources, 'runtime/python.exe')
  process.env.TRYBUNX_FFMPEG_PATH = join(resources, 'bin/ffmpeg.exe')
  process.env.TRYBUNX_FFPROBE_PATH = join(resources, 'bin/ffprobe.exe')
  process.env.PYTHONPATH = join(resources, 'python/vendor')
  await makeSyntheticMatch(video)
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  env.ELECTRON_RENDERER_URL = ''
  env.PATH = `${process.env.SystemRoot}\\System32`
  for (const key of ['ELECTRON_RUN_AS_NODE', 'TRYBUNX_PYTHON', 'TRYBUNX_FFMPEG_PATH', 'TRYBUNX_FFPROBE_PATH', 'PYTHONPATH']) delete env[key]
  const app = await electron.launch({ executablePath, args: [`--user-data-dir=${join(temp, 'profile')}`], env, timeout: 60000 })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('h1')
    if (!(await page.locator('html').getAttribute('lang'))?.startsWith('pl')) throw new Error('UI language must be Polish')
    const probe = await page.evaluate(path => window.clipHunter.probeMedia(path), video)
    if (probe.width !== 1280) throw new Error('Packaged media probe failed')
    const frame = await page.evaluate(path => window.clipHunter.getFrameImage(path, 60), video)
    if (!frame?.dataUrl.startsWith('data:image/png')) throw new Error('Packaged frame extraction failed')
    const result = await page.evaluate(path => new Promise<{ clips: number; vertical: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Packaged analysis timed out')), 300000)
      const unsubscribe = window.clipHunter.onJobEvent(message => {
        if (message.type === 'failed') { clearTimeout(timer); unsubscribe(); reject(new Error(message.error)) }
        if (message.type === 'completed') {
          clearTimeout(timer); unsubscribe()
          const result = message.result!
          resolve({ clips: result.analysis.clips_created + (result.analysis.vertical_clips_created ?? 0), vertical: result.analysis.vertical_clips_created ?? 0 })
        }
      })
      window.clipHunter.startJob({ inputPath: path, roi: { x: 0.005, y: 0.01, width: 0.18, height: 0.13 }, configOverrides: {
        clips: { pre_goal_seconds: 4, post_goal_seconds: 2, max_clip_seconds: 10 },
        vertical: { width: 360, height: 640, video_preset: 'ultrafast' }
      } }).catch(reject)
    }), video)
    if (result.clips !== 6 || result.vertical !== 3) throw new Error(`Unexpected packaged analysis: ${JSON.stringify(result)}`)
    console.log('Installed Windows application: Polish UI, media preview, OCR and six horizontal/vertical clips passed without system Python or FFmpeg.')
  } finally { await app.close(); await rm(temp, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
