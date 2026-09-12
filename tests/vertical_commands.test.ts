import { it, expect } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildSendcmd } from '../src/main/vertical/crop_command'
import { resolveBinary, runProcess } from '../src/main/media/process'

it.each([60, 30000 / 1001])('FFmpeg applies every crop command at %s fps', async (fps) => {
  const dir = await mkdtemp(join(tmpdir(), 'trybunx pan spaces-'))
  try {
    const width = 512, height = 288, cropWidth = 160
    const pixels = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        pixels.fill(Math.floor(x / 2), (y * width + x) * 3, (y * width + x) * 3 + 3)
      }
    }
    const source = join(dir, 'gradient.ppm'), commands = join(dir, 'pan.cmd'), output = join(dir, 'frames.rgb')
    await writeFile(source, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]))
    await writeFile(commands, buildSendcmd({ xs: Array.from({length:60}, (_,i)=>i*2),
      fps,cropWidth,cropHeight:height,fallback:false }))
    await runProcess(resolveBinary('ffmpeg'), ['-hide_banner','-loglevel','error','-nostdin',
      '-loop','1','-framerate',String(fps),'-i',source,'-frames:v','60',
      '-vf',`fps=${fps},sendcmd=f=pan.cmd,crop=${cropWidth}:${height}:x=0:y=0`,
      '-pix_fmt','rgb24','-f','rawvideo','-y',output], { timeoutSeconds: 30, cwd: dir })
    const frames = await readFile(output)
    expect(frames.length).toBe(60 * cropWidth * height * 3)
    for (let i=0; i<60; i++) {
      // The grayscale ramp encodes the x coordinate. A held or late command
      // repeats the previous frame's value and fails this assertion.
      expect(frames[i * cropWidth * height * 3]).toBe(i)
    }
  } finally { await rm(dir, {recursive:true,force:true}) }
}, 30000)
