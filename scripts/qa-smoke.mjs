import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const url = process.env.QA_URL ?? process.env.QA_BASE_URL ?? 'http://127.0.0.1:47832/'
const outputDir = process.env.QA_OUTPUT_DIR ?? join(process.env.TEMP ?? process.cwd(), 'codex-switcher-qa')
const chromePath = process.env.QA_CHROME_PATH

await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch(chromePath ? { executablePath: chromePath } : { channel: 'chrome' })
const consoleEvents = []

async function newPage(viewport) {
  const page = await browser.newPage({ viewport })
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) consoleEvents.push(`${message.type()}: ${message.text()}`)
  })
  page.on('pageerror', (error) => consoleEvents.push(`pageerror: ${error.message}`))
  return page
}

async function assertShell(page, label) {
  await page.locator('.app-shell').waitFor()
  await page.getByRole('heading', { name: 'Signalman AI' }).waitFor()
  await page.locator('.top-navigation').waitFor()
  await page.locator('.statusbar').waitFor()
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollHeight: document.body.scrollHeight,
    bodyClientHeight: document.body.clientHeight,
    bodyOverflowY: getComputedStyle(document.body).overflowY,
  }))
  if (metrics.scrollWidth > metrics.clientWidth + 1) throw new Error(`${label}: unexpected horizontal overflow: ${JSON.stringify(metrics)}`)
  if (metrics.bodyOverflowY !== 'hidden' || metrics.bodyScrollHeight > metrics.bodyClientHeight + 1) {
    throw new Error(`${label}: desktop shell must not page-scroll: ${JSON.stringify(metrics)}`)
  }
  return metrics
}

try {
  const desktop = await newPage({ width: 1280, height: 860 })
  await desktop.goto(url, { waitUntil: 'networkidle' })
  const desktopMetrics = await assertShell(desktop, 'Desktop')

  await desktop.getByRole('button', { name: '应用设置' }).click()
  const settings = desktop.getByRole('dialog', { name: '应用偏好' })
  await settings.waitFor()
  await settings.getByRole('heading', { name: '更新' }).waitFor()
  if (!await settings.getByRole('button', { name: '检查更新' }).isDisabled()) {
    throw new Error('Browser preview must not expose a public update action')
  }
  await settings.getByRole('button', { name: '关闭设置' }).click()

  await desktop.getByRole('button', { name: '服务商', exact: true }).click()
  await desktop.getByRole('heading', { name: '基础配置' }).waitFor()
  await desktop.getByRole('complementary', { name: '连接与切换' }).waitFor()
  const connectionDock = desktop.getByRole('complementary', { name: '连接与切换' })
  await connectionDock.locator('.dock-status-list dt').filter({ hasText: '连接环境' }).waitFor()
  await connectionDock.getByRole('heading', { name: '服务商可用性' }).waitFor()
  await connectionDock.getByRole('button', { name: '运行可用性测试' }).waitFor()
  await connectionDock.getByRole('button', { name: '当前正在使用' }).waitFor()
  await desktop.getByRole('button', { name: '显示访问密钥' }).click()
  await desktop.getByRole('button', { name: '隐藏访问密钥' }).waitFor()
  const apiKey = desktop.getByRole('textbox', { name: '已保存访问密钥，输入新密钥即可替换' })
  if (await apiKey.getAttribute('type') !== 'text') throw new Error('The access-key eye must reveal the locally saved value')
  await desktop.getByRole('button', { name: '隐藏访问密钥' }).click()

  const modelInput = desktop.getByPlaceholder('输入 5.6 搜索模型')
  await modelInput.click()
  await modelInput.fill('5.6')
  for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    await desktop.locator('#model-options').getByRole('option', { name: new RegExp(model) }).waitFor()
  }
  await desktop.keyboard.press('Escape')
  if (await desktop.getByRole('button', { name: '报告兼容问题' }).count()) {
    throw new Error('A verified provider must not show the compatibility feedback action')
  }
  await desktop.locator('.provider-row').filter({ hasText: '服务商 C' }).click()
  await desktop.getByRole('button', { name: '报告兼容问题' }).click()
  await desktop.getByRole('heading', { name: '把这次问题告诉维护者' }).waitFor()
  await desktop.getByText(/不包含访问密钥、配置正文、文件路径、响应原文/).waitFor()
  await desktop.getByText('在线反馈尚未配置').waitFor()
  await desktop.getByRole('button', { name: '关闭反馈' }).click()
  await desktop.getByRole('button', { name: '查看使用说明' }).click()
  await desktop.getByRole('heading', { name: '添加服务商' }).waitFor()
  if (await desktop.locator('.getting-started-progress').getAttribute('aria-label') !== '第 1 步，共 8 步') {
    throw new Error('The ready-state guide did not begin at the first actionable provider step')
  }
  await desktop.getByRole('button', { name: '稍后再说' }).click()
  const leftSplitter = desktop.getByRole('separator', { name: '调整服务商列表宽度' })
  const beforeLeftWidth = Number(await leftSplitter.getAttribute('aria-valuenow'))
  await leftSplitter.focus()
  await desktop.keyboard.press('Shift+ArrowRight')
  const afterLeftWidth = Number(await leftSplitter.getAttribute('aria-valuenow'))
  if (afterLeftWidth <= beforeLeftWidth) throw new Error('Keyboard splitter did not update the accessible width value')
  await desktop.screenshot({ path: join(outputDir, 'provider-workbench.png'), fullPage: true })

  await desktop.locator('.provider-row').filter({ hasText: '服务商 D' }).click()
  const dockSwitch = desktop.getByRole('button', { name: '检查并切换' })
  await dockSwitch.waitFor()
  if (process.env.QA_EXPECT_MOCK === 'true' && !await dockSwitch.isDisabled()) throw new Error('Browser preview must keep provider switching disabled')

  await desktop.getByRole('button', { name: '实验室' }).click()
  await desktop.getByRole('heading', { name: '性价比中心' }).waitFor()
  await desktop.getByRole('heading', { name: '服务商对比' }).waitFor()
  await desktop.getByRole('table', { name: '性价比排名' }).waitFor()
  await desktop.getByRole('button', { name: '运行固定测试' }).click()
  await desktop.getByText('已读取测试额度').waitFor()
  if (await desktop.getByLabel('测试额度').inputValue() !== '0.000398') {
    throw new Error('The fixed demo test must prefill the returned provider cost')
  }
  await desktop.getByLabel('充值金额').fill('10')
  await desktop.getByLabel('平台实际额度').fill('1000')
  await desktop.getByRole('button', { name: '计算并保存' }).click()
  const demoRankingRow = desktop.locator('.lab-ranking-row').filter({ hasText: '服务商 D' })
  await demoRankingRow.waitFor()
  if (!/\d+ 次/.test(await demoRankingRow.innerText())) throw new Error('Saved calibration did not render a sample count in the ranking row')
  await desktop.screenshot({ path: join(outputDir, 'cost-center.png'), fullPage: true })

  const compact = await newPage({ width: 980, height: 700 })
  await compact.goto(url, { waitUntil: 'networkidle' })
  const compactMetrics = await assertShell(compact, 'Compact desktop')
  await compact.getByRole('button', { name: '实验室' }).click()
  await compact.getByRole('heading', { name: '性价比中心' }).waitFor()
  await compact.getByRole('table', { name: '性价比排名' }).waitFor()
  await compact.screenshot({ path: join(outputDir, 'compact-cost-center.png'), fullPage: true })

  const seriousConsoleEvents = consoleEvents.filter((event) => !event.includes('Download the React DevTools'))
  if (seriousConsoleEvents.length > 0) throw new Error(`Console had relevant warnings/errors:\n${seriousConsoleEvents.join('\n')}`)
  console.log(JSON.stringify({
    ok: true,
    url,
    outputDir,
    screenshots: ['provider-workbench.png', 'cost-center.png', 'compact-cost-center.png'],
    metrics: { desktop: desktopMetrics, compact: compactMetrics },
    interaction: '服务商单页 -> 已保存访问密钥显示 -> 模型筛选 -> Dock 切换状态 -> 固定测试自动读费 -> 保存样本 -> 性价比排名',
  }, null, 2))
} finally {
  await browser.close()
}
