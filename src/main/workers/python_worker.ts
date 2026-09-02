import { ChildProcess, spawn } from 'child_process'
import { WorkerRequest, WorkerResponse } from '../../shared/contracts'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  onProgress?: (done: number, total: number) => void
  bytes: number
}

export interface PythonWorkerOptions {
  pythonPath: string
  scriptPath: string
  /** Working directory for the worker process (should be the python/ dir). */
  cwd?: string
  /** Extra environment variables (e.g. PYTHONPATH for vendored deps). */
  env?: NodeJS.ProcessEnv
}

export class WorkerDeadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkerDeadError'
  }
}

/**
 * Manages one Python worker child process speaking JSON Lines over
 * stdin/stdout (PRD 9.3). A worker failure never crashes the host: pending
 * requests are rejected and the worker can be restarted (PRD 9.4).
 */
export class PythonWorker {
  private child?: ChildProcess
  private pending = new Map<string, PendingRequest>()
  private nextId = 0
  private dead = false
  private starting: Promise<void> | null = null
  private abortHandler?: () => void

  constructor(private readonly opts: PythonWorkerOptions) {}

  get isRunning(): boolean {
    return !!this.child && !this.child.killed && this.child.exitCode === null
  }

  /** Spawn the worker and wait until it answers a ping. */
  async start(signal?: AbortSignal, startTimeoutMs = 30000): Promise<void> {
    if (this.isRunning) return
    if (this.starting) return this.starting

    this.starting = (async () => {
      this.dead = false
      const child = spawn(this.opts.pythonPath, [this.opts.scriptPath], {
        cwd: this.opts.cwd,
        env: this.opts.env ? { ...process.env, ...this.opts.env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.child = child

      let stderrTail = ''
      child.stderr?.on('data', (d: Buffer) => {
        stderrTail = (stderrTail + d.toString()).slice(-8192)
      })

      child.on('error', (err) => this.handleDeath(new WorkerDeadError(`worker spawn failed: ${err.message}`)))
      child.on('close', (code) => {
        if (!this.dead) {
          this.handleDeath(new WorkerDeadError(`worker exited unexpectedly (code=${code}). ${stderrTail.slice(-500)}`))
        }
      })

      if (signal) {
        this.abortHandler = () => child.kill('SIGTERM')
        if (signal.aborted) this.abortHandler()
        else signal.addEventListener('abort', this.abortHandler, { once: true })
      }

      child.stdout?.setEncoding('utf8')
      let buffer = ''
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (line) this.handleLine(line)
        }
      })

      try {
        await this.request('ping', {}, { timeoutMs: startTimeoutMs })
      } catch (err) {
        child.kill('SIGTERM')
        throw new Error(
          `OCR worker failed to initialize: ${(err as Error).message}. ` +
            'Ensure the Python venv exists (npm run python:setup) and tesseract is installed.'
        )
      }
    })()

    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private handleDeath(err: Error): void {
    this.dead = true
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
  }

  private handleLine(line: string): void {
    let msg: WorkerResponse
    try {
      msg = JSON.parse(line) as WorkerResponse
    } catch {
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) return
    if (msg.progress) {
      p.onProgress?.(msg.progress.done, msg.progress.total)
      return
    }
    clearTimeout(p.timer)
    this.pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error || 'worker request failed'))
  }

  request<T = unknown>(
    op: string,
    params: Record<string, unknown>,
    opts: { timeoutMs?: number; onProgress?: (done: number, total: number) => void } = {}
  ): Promise<T> {
    if (!this.isRunning || this.dead) {
      return Promise.reject(new WorkerDeadError('worker is not running'))
    }
    const id = `r${++this.nextId}`
    const req: WorkerRequest = { id, op, params }
    const payload = JSON.stringify(req) + '\n'

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`worker request "${op}" timed out after ${opts.timeoutMs}ms`))
      }, opts.timeoutMs ?? 120000)
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        onProgress: opts.onProgress,
        bytes: payload.length
      })
      this.child!.stdin!.write(payload, (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new WorkerDeadError(`failed to write to worker: ${err.message}`))
        }
      })
    })
  }

  async stop(): Promise<void> {
    if (this.abortHandler) {
      this.abortHandler = undefined
    }
    if (this.child && this.child.exitCode === null) {
      const child = this.child
      await new Promise<void>((resolve) => {
        child.once('close', () => resolve())
        child.kill('SIGTERM')
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL')
          resolve()
        }, 2000)
      })
    }
    this.child = undefined
  }
}
