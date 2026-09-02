import { contextBridge, ipcRenderer } from 'electron'
import { AnalysisJob, MediaInfo, Roi } from '../shared/contracts'

export interface JobEventMessage {
  type: 'started' | 'stage' | 'completed' | 'failed' | 'cancelled' | 'cancelling'
  jobId: string
  job?: AnalysisJob
  stage?: string
  status?: string
  progress?: number
  detail?: string
  result?: unknown
  error?: string
}

export interface FrameImage {
  dataUrl: string
  width: number
  height: number
}

const api = {
  appInfo: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:set', settings),
  getConfig: () => ipcRenderer.invoke('config:get'),

  selectVideo: () => ipcRenderer.invoke('dialog:selectVideo'),
  probeMedia: (path: string): Promise<MediaInfo> => ipcRenderer.invoke('media:probe', path),
  getFrameImage: (path: string, timestamp: number): Promise<FrameImage | null> =>
    ipcRenderer.invoke('media:frame', path, timestamp),

  startJob: (params: { inputPath: string; roi: Roi; configOverrides?: Record<string, unknown> }) =>
    ipcRenderer.invoke('job:start', params),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  getCurrentJob: () => ipcRenderer.invoke('job:current'),
  onJobEvent: (listener: (msg: JobEventMessage) => void) => {
    const wrapped = (_e: unknown, msg: JobEventMessage) => listener(msg)
    ipcRenderer.on('job:event', wrapped)
    return () => ipcRenderer.removeListener('job:event', wrapped)
  },

  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
  showItemInFolder: (path: string) => ipcRenderer.invoke('shell:showItemInFolder', path)
}

contextBridge.exposeInMainWorld('clipHunter', api)

export type ClipHunterApi = typeof api
