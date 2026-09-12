import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative, resolve } from 'path'
import { resourceRoot } from '../src/main/paths'
import { trackBall } from '../src/main/vertical/tracker'
import { DEFAULT_CONFIG } from '../src/shared/config'
import type { PythonWorker } from '../src/main/workers/python_worker'

vi.mock('../src/main/paths', () => ({ resourceRoot: vi.fn() }))
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

function fixture(root: string, model = 'python/track/models/ball.onnx') {
  const path = resolve(root, model)
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, '')
  const request = vi.fn().mockResolvedValue({ samples: [], inference_seconds: 0 })
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.vertical.model_path = model
  cfg.vertical.ball_model_path = 'python/track/models/football.pt'
  return { request, opts: { worker: { request } as unknown as PythonWorker,
    inputPath: '/video.webm', start: 0, end: 1, sourceWidth: 1920, sourceHeight: 1080, cfg } }
}

describe('tracking model resource paths', () => {
  it('makes an existing relative model absolute before sending it to a worker with another cwd', async () => {
    const root = mkdtempSync(join(process.cwd(), '.tracking-path-test-')); roots.push(root)
    vi.mocked(resourceRoot).mockReturnValue(process.cwd())
    const model = relative(process.cwd(), join(root, 'ball.onnx'))
    const { request, opts } = fixture(process.cwd(), model)
    await trackBall(opts)
    const params = request.mock.calls[0][1]
    expect(params.model_path).toBe(resolve(model))
    expect(resolve(process.cwd(), 'python', params.model_path)).toBe(resolve(model))
    expect(params.ball_model_path).toBe(resolve('python/track/models/football.pt'))
  })

  it('resolves bundled models from the resource root independently of cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tracking-resources-')); roots.push(root)
    vi.mocked(resourceRoot).mockReturnValue(root)
    const { request, opts } = fixture(root)
    await trackBall(opts)
    expect(request.mock.calls[0][1]).toMatchObject({
      model_path: join(root, 'python/track/models/ball.onnx'),
      ball_model_path: join(root, 'python/track/models/football.pt')
    })
  })

  it('preserves absolute user model paths and a disabled optional detector', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tracking-custom-')); roots.push(root)
    vi.mocked(resourceRoot).mockReturnValue('/unrelated/resources')
    const { request, opts } = fixture(root, join(root, 'custom.onnx'))
    opts.cfg.vertical.ball_model_path = ''
    await trackBall(opts)
    expect(request.mock.calls[0][1]).toMatchObject({ model_path: join(root, 'custom.onnx'), ball_model_path: '' })
  })
})
