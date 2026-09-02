import { open } from 'fs/promises'
import { AudioEvent, AudioWindow } from '../../shared/contracts'
import { AppConfig } from '../../shared/config'
import { resolveBinary, runProcess } from './process'

/**
 * Extract mono 16 kHz PCM analysis audio to a WAV file.
 * Does not need broadcast quality; see PRD section 15.
 */
export async function extractAnalysisAudio(
  inputPath: string,
  outputWavPath: string,
  sampleRate: number,
  signal?: AbortSignal
): Promise<string> {
  await runProcess(
    resolveBinary('ffmpeg'),
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-c:a', 'pcm_s16le',
      '-y', outputWavPath
    ],
    { signal, timeoutSeconds: 24 * 3600 }
  )
  return outputWavPath
}

const DB_FLOOR = 1e-7 // ~ -140 dBFS guard

function rmsDb(samples: Int16Array | Float64Array, from: number, to: number): number {
  let sum = 0
  for (let i = from; i < to; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / Math.max(1, to - from))
  return 20 * Math.log10(Math.max(rms, DB_FLOOR))
}

export interface AudioAnalysis {
  windows: AudioWindow[]
  events: AudioEvent[]
}

/**
 * Analyze 16-bit mono PCM data in RMS windows with a rolling baseline.
 * Pure function over the PCM buffer so it can be unit-tested directly.
 */
export function analyzePcm(
  pcm: Int16Array,
  cfg: AppConfig['audio'],
  signal?: AbortSignal
): AudioAnalysis {
  const windowSamples = Math.max(1, Math.round((cfg.sample_rate * cfg.rms_window_ms) / 1000))
  const totalWindows = Math.floor(pcm.length / windowSamples)
  const baselineWindows = Math.max(1, Math.round((cfg.baseline_seconds * 1000) / cfg.rms_window_ms))
  const cooldownWindows = Math.max(0, Math.round((cfg.spike_cooldown_seconds * 1000) / cfg.rms_window_ms))

  const windows: AudioWindow[] = []
  const events: AudioEvent[] = []
  let lastSpikeWindow = -Infinity

  for (let w = 0; w < totalWindows; w++) {
    if (signal?.aborted) throw new Error('cancelled')
    if (w % 500 === 0 && signal) signal.throwIfAborted()

    const from = w * windowSamples
    const to = from + windowSamples
    const db = rmsDb(pcm, from, to)
    const timestamp = (from / cfg.sample_rate)

    const baselineFrom = Math.max(0, w - baselineWindows)
    let baselineDb: number
    if (baselineFrom >= w) {
      baselineDb = db
    } else {
      // Baseline = average RMS (in linear domain) over the previous N windows.
      let sum = 0
      let count = 0
      for (let b = baselineFrom; b < w; b++) {
        const bDb = windows[b].rmsDb
        sum += Math.pow(10, bDb / 20)
        count++
      }
      baselineDb = 20 * Math.log10(Math.max(sum / Math.max(1, count), DB_FLOOR))
    }

    const deltaDb = db - baselineDb
    windows.push({ timestamp, rms: Math.pow(10, db / 20), rmsDb: db, baselineDb, deltaDb })

    const enoughBaseline = w >= Math.max(2, Math.ceil(baselineWindows / 5))
    if (
      enoughBaseline &&
      deltaDb >= cfg.spike_threshold_db &&
      db >= cfg.silence_floor_db &&
      w - lastSpikeWindow > cooldownWindows
    ) {
      lastSpikeWindow = w
      events.push({ type: 'audio_spike', timestamp, deltaDb, rmsDb: db })
    }
  }

  return { windows, events }
}

/** Parse a RIFF/WAVE file and return the 16-bit PCM samples. */
export async function readWavPcm(wavPath: string, signal?: AbortSignal): Promise<Int16Array> {
  signal?.throwIfAborted()
  const fh = await open(wavPath, 'r')
  try {
    const header = Buffer.alloc(12)
    await fh.read(header, 0, 12, 0)
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`Not a WAV file: ${wavPath}`)
    }

    // Walk chunks to find fmt and data.
    let offset = 12
    let dataOffset = -1
    let dataLength = 0
    while (offset + 8 <= (await fh.stat()).size) {
      const chunkHeader = Buffer.alloc(8)
      await fh.read(chunkHeader, 0, 8, offset)
      const id = chunkHeader.toString('ascii', 0, 4)
      const size = chunkHeader.readUInt32LE(4)
      if (id === 'data') {
        dataOffset = offset + 8
        dataLength = size
        break
      }
      offset += 8 + size + (size % 2)
    }
    if (dataOffset < 0) throw new Error(`WAV file has no data chunk: ${wavPath}`)

    const buffer = Buffer.alloc(dataLength)
    await fh.read(buffer, 0, dataLength, dataOffset)
    const pcm = new Int16Array(buffer.length / 2)
    for (let i = 0; i < pcm.length; i++) pcm[i] = buffer.readInt16LE(i * 2)
    return pcm
  } finally {
    await fh.close()
  }
}
