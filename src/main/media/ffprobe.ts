import { MediaInfo } from '../../shared/contracts'
import { ProcessError, resolveBinary, runProcess } from './process'

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  sample_rate?: string
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { duration?: string; format_name?: string; bit_rate?: string }
}

function parseFps(rate?: string): number {
  if (!rate) return 0
  const [num, den] = rate.split('/').map(Number)
  if (!num || den === undefined || isNaN(den)) return 0
  return den === 0 ? 0 : num / den
}

export async function probeMedia(inputPath: string, signal?: AbortSignal): Promise<MediaInfo> {
  const { stdout } = await runProcess(
    resolveBinary('ffprobe'),
    [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath
    ],
    { signal, timeoutSeconds: 60 }
  )

  let parsed: FfprobeOutput
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput
  } catch {
    throw new ProcessError('Could not parse ffprobe output', 0, stdout, false)
  }

  const video = parsed.streams?.find((s) => s.codec_type === 'video')
  const audio = parsed.streams?.find((s) => s.codec_type === 'audio')

  if (!video) {
    throw new Error(`No video track found in "${inputPath}". The input cannot be analyzed.`)
  }

  const duration = parseFloat(parsed.format?.duration ?? '0')
  if (!duration || duration <= 0) {
    throw new Error(`Could not determine media duration of "${inputPath}".`)
  }

  return {
    path: inputPath,
    container: parsed.format?.format_name,
    durationSeconds: duration,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: parseFps(video.avg_frame_rate),
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name,
    hasVideo: true,
    hasAudio: Boolean(audio)
  }
}
