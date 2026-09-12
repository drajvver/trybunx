/** Render a vertical preview through the production worker, without rerunning OCR. */
import { resolve, dirname } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { buildConfig } from '../src/main/config/loader'
import { probeMedia } from '../src/main/media/ffprobe'
import { PythonWorker } from '../src/main/workers/python_worker'
import { renderVerticalClip } from '../src/main/vertical/renderer'

async function main(): Promise<void> {
  const [input, startArg, endArg, output] = process.argv.slice(2)
  const start = Number(startArg), end = Number(endArg)
  if (!input || !output || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error('Usage: npx tsx scripts/render_vertical_preview.ts INPUT START END OUTPUT.mp4')
  }
  const media = await probeMedia(resolve(input))
  if (end > media.durationSeconds) throw new Error('End exceeds source duration')
  const outputPath = resolve(output)
  await mkdir(dirname(outputPath), { recursive: true })
  const cfg = buildConfig({ defaultConfigPath: resolve('config/default.yaml') })
  const worker = new PythonWorker({
    pythonPath: process.env.TRYBUNX_PYTHON || resolve('python/.venv/bin/python'),
    scriptPath: resolve('python/worker.py'), cwd: resolve('python')
  })
  await worker.start()
  try {
    const result = await renderVerticalClip({ inputPath: resolve(input), outputPath,
      window: { start, end }, durationSeconds: media.durationSeconds,
      sourceWidth: media.width, sourceHeight: media.height, sourceFps: media.fps,
      cfg, worker, tempDir: dirname(outputPath) })
    await writeFile(`${outputPath}.json`, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
  } finally { await worker.stop() }
}
main().catch(err => { console.error(err); process.exitCode = 1 })
