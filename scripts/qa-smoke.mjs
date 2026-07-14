import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const url = process.env.QA_URL ?? 'http://127.0.0.1:5173/'
const outputDir = process.env.QA_OUTPUT_DIR ?? join(process.env.TEMP ?? process.cwd(), 'codex-switcher-qa')
const chromePath = process.env.QA_CHROME_PATH

await mkdir(outputDir, { recursive: true })

const launchOptions = chromePath
  ? { executablePath: chromePath }
  : { channel: 'chrome' }

const browser = await chromium.launch(launchOptions)
const consoleEvents = []

async function newPage(viewport) {
  const page = await browser.newPage({ viewport })
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      consoleEvents.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => {
    consoleEvents.push(`pageerror: ${error.message}`)
  })
  return page
}

try {
  const desktop = await newPage({ width: 1440, height: 1000 })
  await desktop.goto(url, { waitUntil: 'networkidle' })
  await desktop.locator('.app-shell').waitFor()
  await desktop.screenshot({ path: join(outputDir, 'desktop.png'), fullPage: true })

  await desktop.getByRole('button', { name: '刷新' }).click()
  await desktop.getByRole('button', { name: '刷新' }).waitFor({ state: 'visible' })
  await desktop.getByRole('button', { name: '刷新' }).waitFor({ state: 'attached' })
  await desktop.waitForFunction(() => {
    const buttons = [...document.querySelectorAll('button')]
    return buttons.some((button) => button.textContent?.includes('刷新') && !button.disabled)
  })

  await desktop.getByRole('button', { name: '新增服务商' }).click()
  await desktop.getByLabel('服务商名称').fill('Smoke Test API')
  await desktop.getByLabel('接口地址').fill('https://smoke.example.com/v1')
  await desktop.getByLabel('模型').fill('gpt-smoke')
  await desktop.getByLabel('API 密钥').fill('sk-smoke-test')
  await desktop.getByLabel('备注').fill('由 qa:smoke 自动生成。')
  await desktop.getByRole('button', { name: '保存配置' }).click()
  await desktop.getByText('Smoke Test API 已保存').first().waitFor()
  await desktop.getByRole('button', { name: 'Smoke Test API' }).waitFor()

  await desktop.getByRole('button', { name: '验证配置' }).click()
  await desktop.getByText('验证完成').first().waitFor()

  await desktop.getByRole('button', { name: '切换到此服务商' }).click()
  await desktop.getByText('已切换到 Smoke Test API').first().waitFor()

  await desktop.locator('.provider-card').filter({ hasText: 'OWL' }).click()
  await desktop.getByRole('button', { name: '复制' }).click()
  await desktop.getByLabel('服务商名称').fill('OWL Smoke Copy')
  await desktop.getByRole('button', { name: '保存配置' }).click()
  await desktop.getByText('OWL Smoke Copy 已保存').first().waitFor()
  await desktop.getByRole('button', { name: '删除' }).click()
  await desktop.getByText('OWL Smoke Copy 已删除').first().waitFor()

  await desktop.locator('.provider-card').filter({ hasText: 'DasuAPI' }).click()
  await desktop.getByRole('button', { name: '设为默认' }).click()
  await desktop.getByText('DasuAPI 已设为默认').first().waitFor()

  await desktop.locator('.provider-card').filter({ hasText: 'Smoke Test API' }).click()
  await desktop.getByText('高级恢复与启动选项').click()
  await desktop.getByRole('button', { name: '恢复最近备份' }).click()
  await desktop.getByText('已恢复最近备份').first().waitFor()
  await desktop.screenshot({ path: join(outputDir, 'desktop-after-save.png'), fullPage: true })

  const compactDesktop = await newPage({ width: 980, height: 760 })
  await compactDesktop.goto(url, { waitUntil: 'networkidle' })
  await compactDesktop.locator('.app-shell').waitFor()
  await compactDesktop.screenshot({ path: join(outputDir, 'compact-desktop.png'), fullPage: true })

  const seriousConsoleEvents = consoleEvents.filter((event) => !event.includes('Download the React DevTools'))
  if (seriousConsoleEvents.length > 0) {
    throw new Error(`Console had relevant warnings/errors:\n${seriousConsoleEvents.join('\n')}`)
  }

  console.log(JSON.stringify({
    ok: true,
    url,
    outputDir,
    screenshots: ['desktop.png', 'desktop-after-save.png', 'compact-desktop.png'],
    interaction: '刷新 -> 新增服务商 -> 保存 -> 验证 -> 切换 -> 复制 -> 删除 -> 设为默认 -> 恢复最近备份',
  }, null, 2))
} finally {
  await browser.close()
}
