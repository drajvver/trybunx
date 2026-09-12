import { _electron as electron } from 'playwright'
import { resolve } from 'path'

async function main(): Promise<void> {
  const app = await electron.launch({
    executablePath: resolve(process.argv[2] || 'dist/win-unpacked/TrybunaTV AI Clip Hunter.exe'),
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    timeout: 60000
  })
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.locator('#root').waitFor()
    const text = await window.locator('body').innerText()
    if (text.trim().length < 20) throw new Error('Packaged renderer is empty')
    console.log('Packaged Windows application opens successfully.')
  } finally { await app.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
