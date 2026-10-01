import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, resolve: null as null | ((value: unknown) => void) }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/settings', () => ({
  loadSettings: () => state.settings,
  saveSettings: vi.fn((next) => { state.settings = next })
}))
vi.mock('../src/main/paths', () => ({
  defaultConfigPath: () => '', defaultOutputRoot: () => '', pythonDir: () => '',
  pythonInterpreterPath: () => '', workerScriptPath: () => ''
}))
vi.mock('../src/main/pipeline/analyze', () => ({
  runAnalysis: vi.fn(() => new Promise((resolve) => { state.resolve = resolve }))
}))
import { JobManager } from '../src/main/jobs/job_runner'
import { saveSettings } from '../src/main/settings'
import type { BrowserWindow } from 'electron'
const roi = { x: 0, y: 0, width: 0.25, height: 0.1 }
const windowStub = () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } })
beforeEach(() => { state.settings = { roi, lastInputDir: '/video' }; vi.clearAllMocks() })
describe('job settings and reopened windows', () => {
  it('does not persist invalid configuration', () => {
    const manager = new JobManager(windowStub() as unknown as BrowserWindow)
    expect(() => manager.start('/video/test.mp4', roi, { clips: { max_clip_seconds: 0 } })).toThrow()
    expect(saveSettings).not.toHaveBeenCalled()
    expect(state.settings).toEqual({ roi, lastInputDir: '/video' })
    expect(manager.currentJob).toBeNull()
  })
  it('sends completion to the replacement window during an active job', async () => {
    const original = windowStub()
    const replacement = windowStub()
    const manager = new JobManager(original as unknown as BrowserWindow)
    manager.start('/video/test.mp4', roi)
    manager.attachWindow(replacement as unknown as BrowserWindow)
    state.resolve!({ events: [], analysis: { output_dir: '/results' } })
    await Promise.resolve()
    expect(replacement.webContents.send).toHaveBeenCalledWith('job:event', expect.objectContaining({ type: 'completed' }))
    expect(original.webContents.send).not.toHaveBeenCalledWith('job:event', expect.objectContaining({ type: 'completed' }))
  })
})
