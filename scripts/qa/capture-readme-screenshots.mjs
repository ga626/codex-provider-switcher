import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const root = process.cwd()
const output = join(root, 'docs', 'assets', 'readme')
const backend = join(root, 'src-tauri', 'target', 'debug', 'local_backend.exe')
const fixture = join(root, 'scripts', 'qa', 'fixtures', 'dev-desktop')
const version = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'package.json'), 'utf8')).version
const workspace = await mkdtemp(join(tmpdir(), 'signalman-readme-'))

async function wait(url) {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${url}api/health`)).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`backend did not start: ${url}`)
}

async function start(port, name, ready) {
  const base = join(workspace, name)
  const home = join(base, 'codex-home')
  const appData = join(base, 'app-data')
  await mkdir(home, { recursive: true })
  await mkdir(appData, { recursive: true })
  if (ready) {
    await copyFile(join(fixture, 'profiles.json'), join(appData, 'profiles.json'))
    await copyFile(join(fixture, 'activity.json'), join(appData, 'activity.json'))
    await writeFile(join(home, 'config.toml'), 'model = "gpt-5.6-terra"\nmodel_provider = "custom"\ndisable_response_storage = true\n\n[model_providers.custom]\nname = "服务商 A"\nbase_url = "https://provider-a.example/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n\n[projects]\n[features]\n[desktop]\n[memories]\n[mcp_servers]\n[plugins]\n[hooks]\n[hooks.state]\n[marketplaces]\n', 'utf8')
    await writeFile(join(home, 'auth.json'), '{}', 'utf8')
    await writeFile(join(appData, 'connection-environment.json'), '{"selected_layer_id":"user-config","setup_completed":true}', 'utf8')
  }
  const child = spawn(backend, ['--host', '127.0.0.1', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, CODEX_PROVIDER_SWITCHER_CODEX_HOME: home, CODEX_PROVIDER_SWITCHER_APP_DATA_DIR: appData, CODEX_PROVIDER_SWITCHER_DIST_DIR: join(root, 'dist') },
    stdio: 'ignore', windowsHide: true,
  })
  const url = `http://127.0.0.1:${port}/`
  await wait(url)
  return { child, url }
}

await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome' })
const consoleErrors = []
try {
  const initial = await start(47851, 'initial', false)
  const first = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  first.on('console', (message) => { if (['error', 'warning'].includes(message.type())) consoleErrors.push(message.text()) })
  await first.goto(initial.url, { waitUntil: 'networkidle' })
  await first.getByRole('heading', { name: '先把连接环境准备好' }).waitFor()
  await first.screenshot({ path: join(output, `first-run-v${version.replace('-alpha', '')}.png`), fullPage: true })
  initial.child.kill()

  const daily = await start(47852, 'daily', true)
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) consoleErrors.push(message.text()) })
  await page.goto(daily.url, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '基础配置' }).waitFor()
  await page.screenshot({ path: join(output, `provider-workspace-v${version.replace('-alpha', '')}.png`), fullPage: true })
  await page.getByRole('button', { name: '使用说明', exact: true }).click()
  await page.getByRole('dialog', { name: '选择要了解的功能' }).waitFor()
  await page.screenshot({ path: join(output, `guide-hub-v${version.replace('-alpha', '')}.png`), fullPage: true })
  await page.getByRole('button', { name: '关闭使用说明' }).click()
  await page.getByRole('button', { name: '安全与恢复', exact: true }).click()
  await page.getByRole('heading', { name: '首次启动基线备份已就绪' }).waitFor()
  await page.screenshot({ path: join(output, `configuration-protection-v${version.replace('-alpha', '')}.png`), fullPage: true })
  await page.getByRole('button', { name: '活动记录', exact: true }).click()
  await page.locator('.activity-list').waitFor()
  await page.screenshot({ path: join(output, `activity-v${version.replace('-alpha', '')}.png`), fullPage: true })
  await page.getByRole('button', { name: '实验室', exact: true }).click()
  await page.getByRole('heading', { name: '性价比中心' }).waitFor()
  await page.screenshot({ path: join(output, `cost-center-v${version.replace('-alpha', '')}.png`), fullPage: true })
  await page.getByRole('button', { name: '应用设置' }).click()
  await page.getByRole('dialog', { name: '应用偏好' }).waitFor()
  await page.screenshot({ path: join(output, `application-settings-v${version.replace('-alpha', '')}.png`), fullPage: true })
  daily.child.kill()
  if (consoleErrors.length) throw new Error(`capture console warning/error: ${consoleErrors.join('; ')}`)
  console.log(JSON.stringify({ ok: true, output, version }, null, 2))
} finally {
  await browser.close()
  await rm(workspace, { recursive: true, force: true })
}
