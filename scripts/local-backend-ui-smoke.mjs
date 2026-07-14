import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'

const port = Number(process.env.BACKEND_UI_SMOKE_PORT ?? 47840)
const baseUrl = `http://127.0.0.1:${port}/`
const outputDir = process.env.QA_OUTPUT_DIR ?? join(process.env.TEMP ?? process.cwd(), 'codex-switcher-backend-ui-smoke')
const exePath = join(process.cwd(), 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'local_backend.exe' : 'local_backend')

async function waitForBackend() {
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < 15000) {
    try {
      const response = await fetch(`${baseUrl}api/health`)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`local backend did not become ready: ${lastError}`)
}

await mkdir(outputDir, { recursive: true })
await access(exePath).catch(() => {
  throw new Error(`local backend binary not found: ${exePath}. Run npm run backend:build first.`)
})

const child = spawn(exePath, ['--port', String(port)], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

const browser = await chromium.launch({ channel: 'chrome' })
const consoleEvents = []

try {
  await waitForBackend()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      consoleEvents.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => {
    consoleEvents.push(`pageerror: ${error.message}`)
  })

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.locator('.app-shell').waitFor()
  await page.getByText('本机 Web 后端').waitFor()
  await page.screenshot({ path: join(outputDir, 'local-web-backend.png'), fullPage: true })

  const seriousConsoleEvents = consoleEvents.filter((event) => !event.includes('Download the React DevTools'))
  if (seriousConsoleEvents.length > 0) {
    throw new Error(`Console had relevant warnings/errors:\n${seriousConsoleEvents.join('\n')}`)
  }

  console.log(JSON.stringify({
    ok: true,
    url: baseUrl,
    outputDir,
    screenshot: 'local-web-backend.png',
    assertion: 'frontend rendered through the local Web backend, not browser preview mock',
  }, null, 2))
} finally {
  await browser.close()
  child.kill()
  setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL')
  }, 500)
}
