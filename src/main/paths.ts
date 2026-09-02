import { existsSync } from 'fs'
import { join, resolve } from 'path'

declare global {
  // Electron main-process extension of Node's process object. Must match
  // Electron's own declaration exactly (readonly resourcesPath: string).
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Process {
      readonly resourcesPath: string
    }
  }
}

/**
 * Path resolution for runtime resources.
 *
 * Dev mode (electron-vite / tsx): everything lives relative to the project
 * root (= process.cwd()).
 *
 * Packaged app (electron-builder, e.g. the macOS .app): the working directory
 * of a GUI-launched app is "/", so bundled resources must be resolved against
 * process.resourcesPath and user data against app.getPath(). The electron
 * module is imported lazily so the CLI (plain Node) can share this module.
 */

type ElectronApp = {
  isPackaged: boolean
  getAppPath: () => string
  getPath: (name: 'userData' | 'documents' | 'temp' | 'home') => string
}

function electronApp(): ElectronApp | null {
  try {
    const electron = require('electron') as { app?: ElectronApp }
    return electron.app ?? null
  } catch {
    return null
  }
}

/** True when running inside a packaged Electron app. */
export function isPackaged(): boolean {
  return electronApp()?.isPackaged ?? false
}

/** Project root in dev, the .app/Contents/Resources equivalent when packaged. */
export function resourceRoot(): string {
  const app = electronApp()
  if (app?.isPackaged) {
    if (process.resourcesPath) return process.resourcesPath
    // Fallback: app bundle layout <bundle>/Contents/Resources
    return join(app.getAppPath(), '..', 'Resources')
  }
  return process.cwd()
}/** Bundled config/default.yaml. */
export function defaultConfigPath(): string {
  return join(resourceRoot(), 'config', 'default.yaml')
}

/** Directory containing the python worker bundle. */
export function pythonDir(): string {
  return join(resourceRoot(), 'python')
}

/** The worker entry script. */
export function workerScriptPath(): string {
  return join(pythonDir(), 'worker.py')
}

/**
 * Python interpreter selection:
 *  1. TRYBUNX_PYTHON env override
 *  2. project .venv (dev setup via python/setup.sh)
 *  3. plain python3 (system interpreter; needs python/vendor with deps)
 */
export function pythonInterpreterPath(): string {
  if (process.env.TRYBUNX_PYTHON) return process.env.TRYBUNX_PYTHON

  const devVenv = resolve(process.cwd(), '.venv/bin/python')
  if (existsSync(devVenv)) return devVenv

  return 'python3'
}

/** Directory with vendored python deps (pip install --target), if present. */
export function pythonVendorDir(): string | null {
  const vendor = join(pythonDir(), 'vendor')
  return existsSync(vendor) ? vendor : null
}

/**
 * Default location for analysis output. In dev: <project>/output.
 * Packaged: ~/Documents/TrybunaTV so Finder users can find it.
 */
export function defaultOutputRoot(): string {
  const app = electronApp()
  if (app?.isPackaged) {
    try {
      return join(app.getPath('documents'), 'TrybunaTV')
    } catch {
      // fall through
    }
  }
  return resolve(process.cwd(), 'output')
}
