import { afterEach, expect, it, vi } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'
import { pythonInterpreterPath } from '../src/main/paths'
import { resolveBinary } from '../src/main/media/process'

vi.mock('fs', () => ({ existsSync: vi.fn() }))
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(existsSync).mockReset() })

it('uses the bundled interpreter without requiring a system Python', () => {
  vi.stubEnv('TRYBUNX_PYTHON', '')
  const expected = join(process.cwd(), 'runtime', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  vi.mocked(existsSync).mockImplementation(path => path === expected)
  expect(pythonInterpreterPath()).toBe(expected)
})

it('uses bundled video tools before searching developer machine locations', () => {
  vi.stubEnv('TRYBUNX_FFMPEG_PATH', '')
  const expected = join(process.cwd(), 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  vi.mocked(existsSync).mockReturnValue(true)
  expect(resolveBinary('ffmpeg')).toBe(expected)
})

it('preserves explicit runtime and video tool overrides', () => {
  vi.stubEnv('TRYBUNX_PYTHON', '/custom/python')
  vi.stubEnv('TRYBUNX_FFMPEG_PATH', '/custom/ffmpeg')
  expect(pythonInterpreterPath()).toBe('/custom/python')
  expect(resolveBinary('ffmpeg')).toBe('/custom/ffmpeg')
})
