import { _electron } from 'playwright'
import { mkdtemp, rm } from 'fs/promises'
import { resolve, join } from 'path'
import { tmpdir } from 'os'
import { makeSyntheticMatch } from '../scripts/make_synthetic_match'

const ROOT = resolve(__dirname, '..')
const VIDEO = resolve(ROOT, 'tests/fixtures/synthetic_match.mp4')

async function main(): Promise<void> {
  await makeSyntheticMatch(VIDEO)
  const profile = await mkdtemp(join(tmpdir(), 'trybunx-ui-'))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  env.ELECTRON_DISABLE_SANDBOX = '1'
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({
    args: [resolve(ROOT, 'out/main/index.js'), `--user-data-dir=${profile}`],
    env
  })
  try {
    let page = await app.firstWindow()
    await page.waitForSelector('h1')
    if (!await page.locator('button.primary').isDisabled()) throw new Error('Analiza dostępna bez nagrania')
    // Stub only the native dialog; drive the actual selection and React state.
    await app.evaluate(({ dialog }, video) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [video] })
    }, VIDEO)
    await page.getByRole('button', { name: 'Wybierz nagranie…' }).click()
    await page.waitForSelector('.meta-grid')
    await page.waitForFunction(() => {
      const image = document.querySelector('.frame-container img') as HTMLImageElement | null
      return !!image && image.complete && image.naturalWidth > 0
    })
    console.log('ok: wybór nagrania, metadane i rzeczywista klatka')
    // Keyboard-only ROI editing, then verify saving/resetting config preserves it.
    await page.getByRole('button', { name: 'Dodaj zaznaczenie', exact: true }).focus()
    await page.keyboard.press('Enter')
    const width = page.getByLabel('Szerokość zaznaczenia (%)')
    await width.fill('18')
    await width.press('Tab')
    await page.getByLabel('Odległość od lewej krawędzi (%)').fill('0.5')
    await page.getByLabel('Odległość od góry obrazu (%)').fill('1')
    await page.getByLabel('Wysokość zaznaczenia (%)').fill('13')
    await page.getByText('Ustawienia klipów i wyszukiwania momentów', { exact: true }).click()
    await page.getByRole('button', { name: 'Zapisz ustawienia na przyszłość' }).click()
    await page.getByText('Zapisano ustawienia. Aplikacja użyje ich także przy kolejnych nagraniach.').waitFor()
    let settings = await page.evaluate(() => window.clipHunter.getSettings())
    if (settings.roi?.width !== 0.18) throw new Error('Zapis ustawień nadpisał ROI')
    await page.getByRole('button', { name: 'Przywróć zalecane ustawienia' }).click()
    await page.getByText('Przywrócono zalecane ustawienia. Obszar wyniku został zachowany.').waitFor()
    settings = await page.evaluate(() => window.clipHunter.getSettings())
    if (settings.roi?.width !== 0.18) throw new Error('Reset ustawień nadpisał ROI')
    await page.evaluate(async () => {
      const before = await window.clipHunter.getSettings()
      let rejected = false
      try { await window.clipHunter.saveSettings({ configOverrides: { clips: { max_clip_seconds: 0 } } }) }
      catch { rejected = true }
      if (!rejected) throw new Error('Nieprawidłowa konfiguracja została przyjęta')
      const after = await window.clipHunter.getSettings()
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Nieprawidłowa konfiguracja została zapisana')
    })
    console.log('ok: ROI klawiaturą, zapis i reset oraz odrzucenie błędnych ustawień')
    const frame = await page.evaluate(() => window.clipHunter.getFrameImage(
      document.querySelector('.file-path')!.textContent!, 60
    ))
    await app.evaluate(({ ipcMain }, frame) => {
      ipcMain.removeHandler('media:frame')
      ipcMain.handle('media:frame', async (_event, _path, time: number) => {
        await new Promise((resolve) => setTimeout(resolve, time === 61 ? 700 : 50))
        return { ...frame, width: time === 61 ? 1000 : 2000 }
      })
    }, frame)
    await page.getByLabel('Moment nagrania do podglądu (sekundy):').fill('61')
    await page.getByLabel('Moment nagrania do podglądu (sekundy):').fill('62')
    await page.waitForFunction(() => document.querySelector('.roi-values')?.textContent?.includes('360x'))
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 800)))
    if (!(await page.locator('.roi-values').textContent())?.includes('360x')) throw new Error('Starsza klatka zastąpiła nową')
    await page.getByText('Dodatkowe ustawienia: czas bramki i pionowe klipy', { exact: true }).click()
    // Each configurable number must explain both directions; screen readers get the same help.
    const fields = page.locator('.setting-field')
    for (let i = 0; i < await fields.count(); i++) {
      const field = fields.nth(i)
      if (!await field.getByText('Zwiększ:', { exact: true }).isVisible()) throw new Error('Brak opisu zwiększenia wartości')
      if (!await field.getByText('Zmniejsz:', { exact: true }).isVisible()) throw new Error('Brak opisu zmniejszenia wartości')
    }
    await page.screenshot({ path: '/tmp/trybunx-ui.png', fullPage: true })
    console.log('ok: starsze żądanie klatki nie nadpisuje nowego')
    await page.getByRole('button', { name: 'Rozpocznij analizę', exact: true }).click()
    await page.getByRole('button', { name: 'Anuluj', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Anuluj', exact: true }).click()
    await page.getByText('Analiza została anulowana.', { exact: true }).waitFor({ timeout: 15000 })
    console.log('ok: anulowanie analizy')
    if (process.platform === 'darwin') {
      const nextWindow = app.waitForEvent('window')
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].close()
      })
      await app.evaluate(({ app }) => { app.emit('activate') })
      page = await nextWindow
      await page.waitForSelector('h1')
      await page.getByRole('button', { name: 'Wybierz nagranie…' }).click()
      await page.waitForSelector('.meta-grid')
      console.log('ok: ponowne otwarcie okna na macOS')
    }
    await page.getByRole('button', { name: 'Rozpocznij analizę', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.events-table') || document.querySelector('.error-banner') || [...document.querySelectorAll('.hint')].some((el) => el.textContent === 'Nie znaleziono bramek ani ciekawych momentów. Sprawdź, czy zaznaczony obszar obejmuje cały wynik i czy wynik jest czytelny w nagraniu.'), undefined, { timeout: 600000 })
    const rows = await page.locator('.events-table tbody tr').count()
    if (rows !== 3) throw new Error(`Oczekiwano 3 zdarzeń, otrzymano ${rows}`)
    const clips = await page.locator('.events-table button.link').count()
    if (clips !== 6) throw new Error(`Oczekiwano 6 klipów, otrzymano ${clips}`)
    console.log('ok: pełna analiza i klipy poziome oraz pionowe')
    await page.getByRole('button', { name: 'Pokaż podsumowanie analizy' }).click()
    await page.locator('.analysis-summary').waitFor()
    await page.screenshot({ path: '/tmp/trybunx-results.png', fullPage: true })
  } catch (error) {
    const page = app.windows()[0]
    if (page) await page.screenshot({ path: '/tmp/trybunx-ui-failure.png', fullPage: true }).catch(() => undefined)
    throw error
  } finally {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
