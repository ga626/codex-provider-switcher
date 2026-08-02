import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, access, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.env.BACKEND_UI_SMOKE_PORT ?? 47840)
const baseUrl = `http://127.0.0.1:${port}/`
const outputDir = process.env.QA_OUTPUT_DIR ?? join(process.env.TEMP ?? process.cwd(), 'codex-switcher-backend-ui-smoke')
const exePath = join(process.cwd(), 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'local_backend.exe' : 'local_backend')
const fixtureRoot = await mkdtemp(join(tmpdir(), 'codex-switcher-backend-ui-'))
const userHome = join(fixtureRoot, 'user')
const localAppData = join(fixtureRoot, 'local-app-data')
const codexDir = join(userHome, '.codex')

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

async function apiPost(path, body) {
  const response = await fetch(`${baseUrl.slice(0, -1)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`fixture API ${path} failed: HTTP ${response.status}`)
  }
  return response.json()
}

await mkdir(outputDir, { recursive: true })
await mkdir(codexDir, { recursive: true })
await mkdir(localAppData, { recursive: true })
await writeFile(join(codexDir, 'config.toml'), [
  'model = "baseline-model"',
  'model_provider = "custom"',
  'disable_response_storage = true',
  '',
  '[model_providers.custom]',
  'name = "Baseline"',
  'wire_api = "responses"',
  'base_url = "https://baseline.example/v1"',
].join('\r\n'), 'utf8')
await writeFile(join(codexDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'baseline-key' }), 'utf8')
await access(exePath).catch(() => {
  throw new Error(`local backend binary not found: ${exePath}. Run npm run backend:build first.`)
})

const providerServer = createServer((request, response) => {
  if (request.url !== '/v1/responses') {
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
    return
  }
  request.resume()
  request.on('end', () => {
    if (request.headers.authorization !== 'Bearer ui-fixture-key') {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'unauthorized' } }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ id: 'resp_ui_fixture', object: 'response' }))
  })
})
await new Promise((resolve, reject) => {
  providerServer.once('error', reject)
  providerServer.listen(0, '127.0.0.1', resolve)
})
const providerAddress = providerServer.address()
if (!providerAddress || typeof providerAddress === 'string') {
  throw new Error('fixture provider did not expose a TCP address')
}

const child = spawn(exePath, ['--port', String(port)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    LOCALAPPDATA: localAppData,
    CODEX_PROVIDER_SWITCHER_CODEX_HOME: codexDir,
    CODEX_PROVIDER_SWITCHER_APP_DATA_DIR: join(localAppData, 'CodeX Provider Switcher'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

const browser = await chromium.launch({ channel: 'chrome' })
const consoleEvents = []

try {
  await waitForBackend()
  const saved = await apiPost('/api/profiles/save', {
    profile: {
      id: '',
      name: 'UI Fixture Provider',
      baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
      model: 'ui-fixture-model',
      note: '本地 UI smoke fixture。',
      apiKey: 'ui-fixture-key',
    },
  })
  const profileId = saved.profiles.find((profile) => profile.name === 'UI Fixture Provider')?.id
  if (!profileId) {
    throw new Error('fixture provider was not saved')
  }
  const verified = await apiPost('/api/profiles/verify', { profileId })
  if (!verified.profiles.find((profile) => profile.id === profileId)?.verified) {
    throw new Error('fixture provider was not verified')
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
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
  await page.getByRole('heading', { name: 'Signalman AI' }).waitFor()
  await page.getByText('1 个配置').waitFor()
  await page.getByRole('heading', { name: '编辑 UI Fixture Provider' }).waitFor()
  await page.getByRole('button', { name: /切换前检查/ }).click()
  await page.getByRole('heading', { name: '完成以下检查后即可切换' }).waitFor()
  await page.getByRole('heading', { name: '这些设置会在切换后继续生效' }).waitFor()
  await page.getByText('Responses 线路协议').waitFor()
  await page.getByRole('button', { name: '切换到 UI Fixture Provider' }).click()
  await page.getByRole('dialog', { name: '确认切换到 UI Fixture Provider？' }).waitFor()
  await page.getByText('切换影响确认').waitFor()
  await page.getByText('保护检查').first().waitFor()
  await page.getByRole('button', { name: '取消' }).click()
  await page.getByText('不保证', { exact: true }).count().then((count) => {
    if (count !== 0) throw new Error('switch check must not expose duplicate disclaimer cards')
  })
  await page.locator('.inspector-panel').count().then((count) => {
    if (count !== 0) throw new Error('workspace must not render a duplicate right-side inspector')
  })
  await page.locator('.compact-check-list').count().then((count) => {
    if (count !== 0) throw new Error('workspace must not render nested scrollable check lists')
  })
  await page.screenshot({ path: join(outputDir, 'switch-check.png'), fullPage: true })
  await page.getByRole('button', { name: /配置保护/ }).click()
  await page.getByRole('heading', { name: '首次启动基线备份已就绪' }).waitFor()
  await page.getByRole('button', { name: '切换到 UI Fixture Provider' }).count().then((count) => {
    if (count !== 0) throw new Error('configuration protection must not repeat the switch action')
  })
  await page.getByRole('heading', { name: '切换时会保留这些设置' }).waitFor()
  await page.getByText('MCP 服务').waitFor()
  await page.getByRole('heading', { name: '已保护的恢复点' }).waitFor()
  await page.getByText('首次基线', { exact: true }).waitFor()
  await page.getByText('自动保护', { exact: true }).waitFor()
  await page.getByText('手动保存', { exact: true }).waitFor()
  await page.getByRole('button', { name: '立即备份当前状态' }).click()
  const manualRecoveryRow = page.locator('.recovery-row').filter({ hasText: '手动备份' })
  await manualRecoveryRow.waitFor()
  await manualRecoveryRow.getByRole('button', { name: '安全恢复' }).click()
  const restoreDialog = page.getByRole('dialog', { name: '确认回到这个恢复点？' })
  await restoreDialog.waitFor()
  const restoreButton = restoreDialog.getByRole('button', { name: '确认恢复' })
  if (!await restoreButton.isDisabled()) throw new Error('restore confirmation must require the confirmation phrase')
  await restoreDialog.getByPlaceholder('恢复').fill('恢复')
  await restoreButton.click()
  await restoreDialog.waitFor({ state: 'detached' })
  await page.getByRole('status').getByText('已恢复配置备份').waitFor()
  await page.getByRole('button', { name: /活动记录/ }).click()
  await page.getByText('已恢复配置备份').first().waitFor()
  await page.getByRole('button', { name: /配置保护/ }).click()
  await page.getByText('这些内容仍然在不在', { exact: true }).count().then((count) => {
    if (count !== 0) throw new Error('configuration protection must use product language')
  })
  await page.screenshot({ path: join(outputDir, 'configuration-protection.png'), fullPage: true })
  const applicationSettingsButton = page.getByRole('button', { name: /应用设置/ })
  const applicationSettingsBounds = await applicationSettingsButton.boundingBox()
  if (!applicationSettingsBounds || applicationSettingsBounds.y < 0 || applicationSettingsBounds.y + applicationSettingsBounds.height > 800) {
    throw new Error('application settings must be directly reachable in the compact desktop viewport')
  }
  await applicationSettingsButton.click()
  await page.getByRole('heading', { name: '使用方式与恢复点' }).waitFor()
  const autoStartToggle = page.getByRole('checkbox', { name: '开启开机启动' })
  if (!await autoStartToggle.isDisabled()) throw new Error('Web diagnostic mode must not write Windows autostart state')
  await page.getByText('开发预览和 Web 诊断模式不会修改 Windows 启动项。').waitFor()
  await page.getByText('恢复点保留数量').waitFor()
  await page.locator('.application-settings-dialog select').count().then((count) => {
    if (count !== 2) throw new Error('settings must expose automatic and manual recovery-point limits')
  })

  const seriousConsoleEvents = consoleEvents.filter((event) => !event.includes('Download the React DevTools'))
  if (seriousConsoleEvents.length > 0) {
    throw new Error(`Console had relevant warnings/errors:\n${seriousConsoleEvents.join('\n')}`)
  }

  console.log(JSON.stringify({
    ok: true,
    url: baseUrl,
    outputDir,
    screenshots: ['switch-check.png', 'configuration-protection.png'],
    assertion: 'frontend rendered through the local Web backend with a verified fixture provider, kept switching conditions in one workspace, separated baseline/automatic/manual recovery points, exposed application settings from the title bar, and kept Windows autostart unavailable in Web diagnostic mode',
  }, null, 2))
} finally {
  await browser.close()
  child.kill()
  setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL')
  }, 500)
  await rm(fixtureRoot, { recursive: true, force: true })
  await new Promise((resolve) => providerServer.close(resolve))
}
