import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join, resolve } from 'path'
import { readFileSync } from 'fs'
import { probeMedia } from './media/ffprobe'
import { extractSingleFrame } from './media/frames'
import { registerJobIpc } from './jobs/job_runner'
import { defaultConfigPath } from './paths'
import { buildConfig } from './config/loader'
import { loadSettings, saveSettings } from './settings'
import { MediaInfo, Roi } from '../shared/contracts'

// Running as root (e.g. CI containers) requires disabling the Chromium sandbox.
if (process.platform === 'linux' && process.getuid && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox')
}

export interface AppSettings {
  roi?: Roi
  configOverrides?: Record<string, unknown>
  lastInputDir?: string
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: 'TrybunaTV AI Clip Hunter',
    backgroundColor: '#101418',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  const win = createMainWindow()
  registerAppIpc(win)
  registerJobIpc(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

export function registerAppIpc(win: BrowserWindow): void {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userDataPath: app.getPath('userData')
  }))

  ipcMain.handle('settings:get', () => loadSettings())

  ipcMain.handle('settings:set', (_e, settings: AppSettings) => {
    saveSettings(settings)
    return true
  })

  ipcMain.handle('config:get', () => {
    const settings = loadSettings()
    return buildConfig({
      defaultConfigPath: defaultConfigPath(),
      overrides: [settings.configOverrides]
    })
  })

  ipcMain.handle('dialog:selectVideo', async () => {
    const settings = loadSettings()
    const result = await dialog.showOpenDialog(win, {
      title: 'Select a VOD recording',
      properties: ['openFile'],
      defaultPath: settings.lastInputDir,
      filters: [
        { name: 'Video files', extensions: ['mp4', 'mkv', 'mov', 'avi', 'ts', 'webm'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const selected = result.filePaths[0]
    saveSettings({ ...settings, lastInputDir: resolve(selected, '..') })
    return selected
  })

  ipcMain.handle('media:probe', async (_e, inputPath: string): Promise<MediaInfo> => {
    return probeMedia(inputPath)
  })

  ipcMain.handle(
    'media:frame',
    async (_e, inputPath: string, timestamp: number): Promise<{ dataUrl: string; width: number; height: number } | null> => {
      const tmp = join(app.getPath('temp'), `clip_hunter_frame_${Date.now()}.png`)
      await extractSingleFrame(inputPath, timestamp, tmp)
      const data = readFileSync(tmp)
      const meta = await probeMedia(inputPath)
      return {
        dataUrl: `data:image/png;base64,${data.toString('base64')}`,
        width: meta.width,
        height: meta.height
      }
    }
  )

  ipcMain.handle('shell:openPath', async (_e, path: string) => {
    await shell.openPath(path)
    return true
  })

  ipcMain.handle('shell:showItemInFolder', (_e, path: string) => {
    shell.showItemInFolder(path)
    return true
  })
}
