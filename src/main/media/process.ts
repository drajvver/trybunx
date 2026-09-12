import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { resourceRoot } from '../paths'

export interface RunOptions {
  /** AbortSignal to cancel the process (SIGTERM, then SIGKILL). */
  signal?: AbortSignal
  /** Seconds after which the process is killed and the run fails. */
  timeoutSeconds?: number
  /** Called for each chunk of stderr/stdout output (for progress parsing). */
  onOutput?: (chunk: string) => void
  cwd?: string
}

export class ProcessError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderrTail: string,
    public readonly cancelled: boolean
  ) {
    super(message)
    this.name = 'ProcessError'
  }
}

/**
 * Directories searched when a binary is not on PATH. GUI-launched apps on
 * macOS get a minimal PATH that misses Homebrew installs, so we probe the
 * usual locations explicitly.
 */
const BINARY_FALLBACK_DIRS = [
  '/opt/homebrew/bin', // Homebrew on Apple Silicon
  '/usr/local/bin', // Homebrew on Intel macOS, common on Linux
  '/usr/bin',
  '/bin',
  '/usr/games'
]

/**
 * Resolve an external binary: env override (TRYBUNX_<NAME>_PATH) wins, then
 * PATH (default spawn behavior), then platform fallback directories.
 */
export function resolveBinary(name: string): string {
  const envKey = `TRYBUNX_${name.toUpperCase()}_PATH`
  const fromEnv = process.env[envKey]
  if (fromEnv) return fromEnv

  const bundled = join(resourceRoot(), 'bin', process.platform === 'win32' ? `${name}.exe` : name)
  if (existsSync(bundled)) return bundled

  const fallback = BINARY_FALLBACK_DIRS.map((dir) => join(dir, name)).find((p) => existsSync(p))
  return fallback ?? name
}

/** Run a process to completion, collecting stderr. Rejects on non-zero exit or cancellation. */
export function runProcess(
  cmd: string,
  args: string[],
  opts: RunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let cancelled = false
    let settled = false

    const kill = () => {
      cancelled = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 2000)
    }

    if (opts.signal) {
      if (opts.signal.aborted) kill()
      else opts.signal.addEventListener('abort', kill, { once: true })
    }

    let timer: NodeJS.Timeout | undefined
    if (opts.timeoutSeconds) {
      timer = setTimeout(kill, opts.timeoutSeconds * 1000)
    }

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      stderr += text
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024)
      opts.onOutput?.(text)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(new ProcessError(`Failed to start ${cmd}: ${err.message}`, null, stderr, cancelled))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (opts.signal?.aborted || cancelled) {
        reject(new ProcessError(`${cmd} cancelled`, code, stderr, true))
      } else if (code !== 0) {
        const tail = stderr.split('\n').slice(-12).join('\n')
        reject(new ProcessError(`${cmd} exited with code ${code}`, code, tail, false))
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

/**
 * Spawn a long-running process whose stdout is consumed line-by-line.
 * The caller owns cancellation via opts.signal.
 */
export function spawnProcess(
  cmd: string,
  args: string[],
  handlers: { onStdoutLine?: (line: string) => void; onStderr?: (chunk: string) => void },
  opts: RunOptions = {}
): { child: ReturnType<typeof spawn>; done: Promise<void> } {
  const child = spawn(cmd, args, { windowsHide: true, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  child.stdout.on('data', (d: Buffer) => {
    buffer += d.toString()
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line) handlers.onStdoutLine?.(line)
    }
  })
  child.stderr.on('data', (d: Buffer) => handlers.onStderr?.(d.toString()))
  const done = new Promise<void>((resolve, reject) => {
    let settled = false
    const kill = () => {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 2000)
    }
    if (opts.signal) {
      if (opts.signal.aborted) kill()
      else opts.signal.addEventListener('abort', kill, { once: true })
    }
    child.on('error', (err) => {
      if (settled) return
      settled = true
      reject(new ProcessError(`Failed to start ${cmd}: ${err.message}`, null, '', false))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (opts.signal?.aborted) reject(new ProcessError(`${cmd} cancelled`, code, '', true))
      else if (code !== 0) reject(new ProcessError(`${cmd} exited with code ${code}`, code, '', false))
      else resolve()
    })
  })
  return { child, done }
}
