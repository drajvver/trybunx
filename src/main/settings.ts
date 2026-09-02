import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { Roi } from '../shared/contracts'

export interface AppSettings {
  roi?: Roi
  configOverrides?: Record<string, unknown>
  lastInputDir?: string
}

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

export function loadSettings(): AppSettings {
  try {
    const p = settingsPath()
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as AppSettings
  } catch {
    // fall through
  }
  return {}
}

export function saveSettings(settings: AppSettings): void {
  const p = settingsPath()
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(p, JSON.stringify(settings, null, 2))
}
