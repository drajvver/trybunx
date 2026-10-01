import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { PythonWorker } from '../src/main/workers/python_worker'
import { computeClipWindow } from '../src/main/clips/generator'
import { resolveConfig } from '../src/shared/config'
import { runProcess, spawnProcess } from '../src/main/media/process'

describe('clip windows', () => {
  it('keeps the goal inside a short clip, including at video boundaries', () => {
    const cfg = resolveConfig({ clips: { max_clip_seconds: 5 } }).clips
    for (const event of [0, 1, 80, 99, 100]) {
      const { start, end } = computeClipWindow(event, 100, cfg)
      expect(start).toBeLessThanOrEqual(event)
      expect(end).toBeGreaterThanOrEqual(event)
      expect(end - start).toBeLessThanOrEqual(5)
      expect(end - start).toBeGreaterThan(0)
    }
  })
})

describe('process cancellation', () => {
  const script = "process.on('SIGTERM', () => {}); console.error('ready'); setInterval(() => {}, 1000)"
  it('forces exit after SIGTERM is ignored', async () => {
    const controller = new AbortController()
    const start = Date.now()
    const result = runProcess(process.execPath, ['-e', script], {
      signal: controller.signal,
      onOutput: () => controller.abort()
    })
    await expect(result).rejects.toMatchObject({ cancelled: true })
    expect(Date.now() - start).toBeLessThan(5000)
  }, 7000)
  it('also forces exit for streaming processes', async () => {
    const controller = new AbortController()
    const { done } = spawnProcess(process.execPath, ['-e', script], {
      onStderr: () => controller.abort()
    }, { signal: controller.signal })
    await expect(done).rejects.toMatchObject({ cancelled: true })
  }, 7000)
  it('applies timeouts to streaming processes', async () => {
    const { done } = spawnProcess(process.execPath, ['-e', script], {}, { timeoutSeconds: 0.2 })
    await expect(done).rejects.toMatchObject({ cancelled: true })
  }, 7000)
})


describe('worker cancellation', () => {
  it('kills an unresponsive worker and rejects its pending request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trybunx-worker-test-'))
    const script = join(directory, 'worker.cjs')
    await writeFile(script, `
      process.on('SIGTERM', () => {});
      require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const request = JSON.parse(line);
        if (request.op === 'ping') console.log(JSON.stringify({ id: request.id, ok: true, result: {} }));
      });
      setInterval(() => {}, 1000);
    `)
    const controller = new AbortController()
    const worker = new PythonWorker({ pythonPath: process.execPath, scriptPath: script })
    try {
      await worker.start(controller.signal)
      const assertion = expect(worker.request('hang', {})).rejects.toThrow('worker exited')
      controller.abort()
      await assertion
    } finally {
      await worker.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 7000)
})
