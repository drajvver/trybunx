import type { AnalysisJob, AnalysisResult, MediaInfo, Roi } from '../../shared/contracts'

export interface JobEventMessage {
  type: 'started' | 'stage' | 'completed' | 'failed' | 'cancelled' | 'cancelling'
  jobId: string
  job?: AnalysisJob
  stage?: string
  status?: string
  progress?: number
  detail?: string
  result?: AnalysisResult
  error?: string
}

export interface FrameImage {
  dataUrl: string
  width: number
  height: number
}

export interface ClipHunterApi {
  appInfo: () => Promise<{ version: string; platform: string; userDataPath: string }>
  getSettings: () => Promise<{ roi?: Roi; configOverrides?: Record<string, unknown> }>
  saveSettings: (settings: unknown) => Promise<boolean>
  getConfig: () => Promise<Record<string, unknown>>
  selectVideo: () => Promise<string | null>
  probeMedia: (path: string) => Promise<MediaInfo>
  getFrameImage: (path: string, timestamp: number) => Promise<FrameImage | null>
  startJob: (params: {
    inputPath: string
    roi: Roi
    configOverrides?: Record<string, unknown>
  }) => Promise<AnalysisJob>
  cancelJob: () => Promise<boolean>
  getCurrentJob: () => Promise<AnalysisJob | null>
  onJobEvent: (listener: (msg: JobEventMessage) => void) => () => void
  openPath: (path: string) => Promise<boolean>
  showItemInFolder: (path: string) => Promise<boolean>
}

declare global {
  interface Window {
    clipHunter: ClipHunterApi
  }
}

export {}
