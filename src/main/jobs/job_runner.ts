import { BrowserWindow, ipcMain } from 'electron'
import {
  AnalysisJob,
  AnalysisResult,
  Roi,
  StageName,
  StageState,
  StageStatus
} from '../../shared/contracts'
import { buildConfig } from '../config/loader'
import { runAnalysis } from '../pipeline/analyze'
import { loadSettings, saveSettings } from '../settings'
import {
  defaultConfigPath,
  defaultOutputRoot,
  pythonDir,
  pythonInterpreterPath,
  workerScriptPath
} from '../paths'

export interface ActiveJob {
  job: AnalysisJob
  controller: AbortController
  promise: Promise<void>
}

/**
 * Runs at most one analysis job at a time (v0.1) and forwards stage progress
 * to the renderer (PRD sections 9.4 and 29).
 */
export class JobManager {
  private active: ActiveJob | null = null

  constructor(private readonly win: BrowserWindow) {}

  private send(channel: string, payload: unknown): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }

  private stageList(): StageState[] {
    return [
      { name: 'prepare', status: 'pending' },
      { name: 'scoreboard_scan', status: 'pending' },
      { name: 'audio_analysis', status: 'pending' },
      { name: 'build_events', status: 'pending' },
      { name: 'generate_clips', status: 'pending' },
      { name: 'write_outputs', status: 'pending' }
    ]
  }

  get currentJob(): AnalysisJob | null {
    return this.active?.job ?? null
  }

  start(inputPath: string, roi: Roi, configOverrides?: Record<string, unknown>): AnalysisJob {
    if (this.active && (this.active.job.status === 'running' || this.active.job.status === 'queued')) {
      throw new Error('An analysis job is already running. Cancel it first.')
    }

    const settings = loadSettings()
    saveSettings({ ...settings, roi, ...(configOverrides ? { configOverrides } : {}) })

    const id = `job_${Date.now().toString(36)}`
    const job: AnalysisJob = {
      id,
      inputFile: inputPath,
      outputDir: '',
      status: 'running',
      stages: this.stageList(),
      startedAt: new Date().toISOString()
    }

    const controller = new AbortController()
    const config = buildConfig({
      defaultConfigPath: defaultConfigPath(),
      overrides: [settings.configOverrides, configOverrides]
    })

    const updateStage = (name: StageName, status: StageStatus, progress?: number, detail?: string) => {
      const stage = job.stages.find((s) => s.name === name)
      if (stage) {
        stage.status = status
        stage.progress = progress
        stage.detail = detail
      }
      this.send('job:event', { type: 'stage', jobId: id, stage: name, status, progress, detail })
    }

    const promise = (async () => {
      try {
        const result: AnalysisResult = await runAnalysis({
          inputPath,
          roi,
          config,
          outputRoot: defaultOutputRoot(),
          pythonPath: pythonInterpreterPath(),
          workerScriptPath: workerScriptPath(),
          pythonCwd: pythonDir(),
          signal: controller.signal,
          onStage: updateStage
        })
        job.status = 'completed'
        job.finishedAt = new Date().toISOString()
        job.outputDir = result.analysis.output_dir
        this.send('job:event', { type: 'completed', jobId: id, result })
      } catch (err) {
        const message = (err as Error).message || String(err)
        job.finishedAt = new Date().toISOString()
        if (controller.signal.aborted) {
          job.status = 'cancelled'
          this.send('job:event', { type: 'cancelled', jobId: id, error: message })
        } else {
          job.status = 'failed'
          job.error = message
          this.send('job:event', { type: 'failed', jobId: id, error: message })
        }
      } finally {
        if (this.active?.job.id === id) this.active = null
      }
    })()

    this.active = { job, controller, promise }
    this.send('job:event', { type: 'started', jobId: id, job })
    return job
  }

  async cancel(): Promise<boolean> {
    if (!this.active) return false
    this.active.controller.abort()
    this.send('job:event', { type: 'cancelling', jobId: this.active.job.id })
    await this.active.promise.catch(() => undefined)
    return true
  }
}

export function registerJobIpc(win: BrowserWindow): JobManager {
  const manager = new JobManager(win)

  ipcMain.handle(
    'job:start',
    (_e, params: { inputPath: string; roi: Roi; configOverrides?: Record<string, unknown> }) =>
      manager.start(params.inputPath, params.roi, params.configOverrides)
  )

  ipcMain.handle('job:cancel', async () => manager.cancel())
  ipcMain.handle('job:current', () => manager.currentJob)

  return manager
}
