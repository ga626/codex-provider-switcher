import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const port = Number(process.env.RUNTIME_BOUNDARY_SMOKE_PORT ?? 47841)
const baseUrl = `http://127.0.0.1:${port}/`
const outputDir = process.env.QA_OUTPUT_DIR ?? join(process.env.TEMP ?? process.cwd(), 'codex-switcher-runtime-boundary')

function stopProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  child.kill()
}

async function waitForStaticPreview() {
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < 15000) {
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`static preview did not become ready: ${lastError}`)
}

await mkdir(outputDir, { recursive: true })

const child = spawn(
  process.platform === 'win32' ? 'cmd.exe' : 'npm',
  process.platform === 'win32'
    ? ['/c', 'npm', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
    : ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }
)

child.stdout.on('data', () => undefined)
child.stderr.on('data', () => undefined)

const browser = await chromium.launch({ channel: 'chrome' })

try {
  await waitForStaticPreview()
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.getByText('真实本地后端不可用').waitFor()
  await page.screenshot({ path: join(outputDir, 'runtime-boundary.png'), fullPage: true })

  const providerCards = await page.locator('.provider-card').count()
  const appShells = await page.locator('.app-shell').count()
  if (providerCards > 0 || appShells > 0) {
    throw new Error('production static preview rendered the app shell instead of the backend error boundary.')
  }

  console.log(JSON.stringify({
    ok: true,
    url: baseUrl,
    outputDir,
    assertion: 'production build without local backend shows an explicit backend error and no mock data',
  }, null, 2))
} finally {
  await browser.close()
  stopProcessTree(child)
  setTimeout(() => {
    if (child.exitCode === null) stopProcessTree(child)
  }, 500)
}
