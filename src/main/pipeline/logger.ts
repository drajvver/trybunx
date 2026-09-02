/**
 * Analysis logger (PRD section 27): every meaningful intermediate detection
 * is logged with a media-time prefix and persisted to logs/analysis.log.
 */
export class AnalysisLogger {
  private lines: string[] = []
  private startedAt = Date.now()

  constructor(private readonly sink?: (line: string) => void) {}

  static formatMediaTime(seconds: number): string {
    const safe = Math.max(0, seconds)
    const m = Math.floor(safe / 60)
    const s = Math.floor(safe % 60)
    const ms = Math.round((safe - Math.floor(safe)) * 1000)
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
  }

  log(message: string, mediaTime?: number): void {
    const prefix =
      mediaTime !== undefined
        ? `[${AnalysisLogger.formatMediaTime(mediaTime)}]`
        : `[t+${((Date.now() - this.startedAt) / 1000).toFixed(1)}s]`
    const line = `${prefix} ${message}`
    this.lines.push(line)
    this.sink?.(line)
  }

  warn(message: string, mediaTime?: number): void {
    this.log(`WARN ${message}`, mediaTime)
  }

  error(message: string, mediaTime?: number): void {
    this.log(`ERROR ${message}`, mediaTime)
  }

  getLines(): string[] {
    return [...this.lines]
  }
}
