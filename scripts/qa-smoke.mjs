import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const url = process.env.QA_URL ?? process.env.QA_BASE_URL ?? 'http://127.0.0.1:47832/'
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

async function sidebarMetrics(page) {
  return page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect()
    const providerList = document.querySelector('.provider-list')
    const providerRow = document.querySelector('.provider-row')
    const title = document.querySelector('.sidebar-section-title')
    const pane = rect('.provider-object-pane')
    const workspaces = rect('.top-navigation')
    const connections = rect('.provider-object-pane .sidebar-connections')
    const list = providerList?.getBoundingClientRect()
    const firstRow = providerRow?.getBoundingClientRect()

    return {
      sectionGap: workspaces && connections ? connections.top - workspaces.bottom : null,
      titleToFirstRow: title && firstRow ? firstRow.top - title.getBoundingClientRect().bottom : null,
      listToPaneBottom: list && pane ? pane.bottom - list.bottom : null,
      providerOverflowY: providerList ? getComputedStyle(providerList).overflowY : null,
      providerClientHeight: providerList?.clientHeight ?? 0,
      providerScrollHeight: providerList?.scrollHeight ?? 0,
    }
  })
}

function assertSidebarLayout(metrics, label) {
  if (metrics.titleToFirstRow === null || metrics.titleToFirstRow < 8 || metrics.titleToFirstRow > 28) {
    throw new Error(`${label}: saved connections have an unexpected title-to-list gap: ${JSON.stringify(metrics)}`)
  }
  if (metrics.listToPaneBottom === null || metrics.listToPaneBottom < 10 || metrics.listToPaneBottom > 32) {
    throw new Error(`${label}: provider list does not own the remaining sidebar height: ${JSON.stringify(metrics)}`)
  }
  if (metrics.providerOverflowY !== 'auto') {
    throw new Error(`${label}: provider list must own its vertical scrolling: ${JSON.stringify(metrics)}`)
  }
}

try {
  const desktop = await newPage({ width: 1280, height: 860 })
  await desktop.goto(url, { waitUntil: 'networkidle' })
  await desktop.locator('.app-shell').waitFor()
  await desktop.locator('.top-navigation').waitFor()
  await desktop.locator('.workspace-panel').waitFor()
  await desktop.locator('.statusbar').waitFor()

  if (await desktop.locator('header').getByRole('button', { name: '检查更新' }).count() !== 0) {
    throw new Error('update action must only appear inside application settings')
  }
  await desktop.getByRole('button', { name: '应用设置' }).click()
  const settingsDialog = desktop.getByRole('dialog', { name: '应用偏好' })
  await settingsDialog.waitFor()
  await settingsDialog.getByRole('heading', { name: '更新' }).waitFor()
  const updateButton = settingsDialog.getByRole('button', { name: '检查更新' })
  if (!await updateButton.isDisabled()) {
    throw new Error('Web preview must not expose a public update action')
  }
  await settingsDialog.getByText('本地预览不检查公开更新').waitFor()
  await settingsDialog.getByRole('button', { name: '关闭设置' }).click()
  await desktop.screenshot({ path: join(outputDir, 'desktop.png'), fullPage: true })

  const desktopMetrics = await desktop.evaluate(() => {
    const body = document.body
    const app = document.querySelector('.app-shell')
    const workspace = document.querySelector('.workspace-scroll')
    return {
      bodyScrollHeight: body.scrollHeight,
      bodyClientHeight: body.clientHeight,
      bodyOverflowY: getComputedStyle(body).overflowY,
      appHeight: app?.getBoundingClientRect().height ?? 0,
      workspaceScrollHeight: workspace?.scrollHeight ?? 0,
      workspaceClientHeight: workspace?.clientHeight ?? 0,
    }
  })

  if (desktopMetrics.bodyOverflowY !== 'hidden' || desktopMetrics.bodyScrollHeight > desktopMetrics.bodyClientHeight + 1) {
    throw new Error(`Desktop shell should not page-scroll: ${JSON.stringify(desktopMetrics)}`)
  }
  const desktopSidebarMetrics = await sidebarMetrics(desktop)
  assertSidebarLayout(desktopSidebarMetrics, 'Desktop sidebar')

  await desktop.getByRole('button', { name: /模型目录/ }).click()
  await desktop.getByRole('button', { name: '刷新模型目录' }).waitFor()
  await desktop.getByRole('button', { name: '刷新模型目录' }).click()
  await desktop.locator('.model-table').waitFor()
  await desktop.locator('.model-row').filter({ hasText: 'provider-reasoning-current' }).waitFor()
  await desktop.getByPlaceholder('搜索模型、别名或标签').fill('fast-current')
  await desktop.locator('.model-row').filter({ hasText: 'provider-fast-current' }).waitFor()
  if (await desktop.locator('.model-row').count() !== 1) {
    throw new Error('Model search did not filter the catalog to the matching entry.')
  }
  await desktop.getByPlaceholder('搜索模型、别名或标签').fill('')
  const modelRow = desktop.locator('.model-row').filter({ hasText: 'provider-reasoning-current' })
  await modelRow.getByRole('button', { name: '使用' }).click()
  await modelRow.getByRole('button', { name: '当前模型' }).waitFor()
  await desktop.screenshot({ path: join(outputDir, 'desktop-models.png'), fullPage: true })

  await desktop.locator('.top-navigation .top-nav-item[aria-label="服务商"]').click()
  await desktop.getByRole('heading', { name: '基础配置' }).waitFor()
  if (await desktop.getByLabel('默认模型').inputValue() !== 'provider-reasoning-current') {
    throw new Error('Selecting a model from the catalog did not persist it to the provider profile.')
  }
  await desktop.getByLabel('默认模型').fill('manual-smoke-model')
  await desktop.getByRole('button', { name: '保存更改' }).click()
  await desktop.getByRole('dialog', { name: '确认保存手动模型？' }).waitFor()
  await desktop.getByRole('button', { name: '取消' }).click()
  await desktop.getByRole('dialog', { name: '确认保存手动模型？' }).waitFor({ state: 'detached' })
  await desktop.getByLabel('默认模型').fill('provider-reasoning-current')
  await desktop.getByRole('button', { name: '保存更改' }).click()

  await desktop.getByRole('button', { name: '新增服务商' }).click()
  await desktop.getByLabel('服务商名称').fill('Smoke Test API')
  await desktop.getByLabel('接口地址').fill('https://smoke.example.com/v1')
  await desktop.getByLabel('默认模型').fill('gpt-smoke')
  await desktop.getByLabel('访问密钥').fill('sk-smoke-test')
  await desktop.getByLabel('备注').fill('由 qa:smoke 自动生成。')
  await desktop.getByRole('button', { name: '保存更改' }).click()
  await desktop.getByRole('dialog', { name: '确认保存手动模型？' }).waitFor()
  await desktop.getByRole('button', { name: '继续保存' }).click()
  await desktop.getByRole('dialog', { name: '确认保存手动模型？' }).waitFor({ state: 'detached' })
  await desktop.locator('.provider-row').filter({ hasText: 'Smoke Test API' }).waitFor()
  await desktop.getByRole('heading', { name: '基础配置' }).waitFor()

  await desktop.getByRole('button', { name: /切换前检查/ }).click()
  await desktop.getByRole('button', { name: '运行可用性测试' }).click()
  await desktop.getByText('开发预览不会发送真实服务商请求。').waitFor()
  await desktop.locator('.top-navigation .top-nav-item[aria-label="服务商"]').click()
  if (await desktop.getByRole('button', { name: '检查并切换到 Smoke Test API' }).count() !== 1) {
    throw new Error('Provider configuration must expose the selected-provider switch action.')
  }
  if (!await desktop.getByRole('button', { name: '检查并切换到 Smoke Test API' }).isDisabled()) {
    throw new Error('Preview mode must keep the selected-provider switch disabled.')
  }
  const pendingSwitchSlot = await desktop.locator('.provider-switch-slot').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })
  await desktop.locator('.provider-row').filter({ hasText: '示例服务商 A' }).click()
  const currentSwitch = desktop.getByRole('button', { name: '当前正在使用 示例服务商 A' })
  await currentSwitch.waitFor()
  if (!await currentSwitch.isDisabled()) {
    throw new Error('The active provider must show a disabled current-state command.')
  }
  const currentSwitchSlot = await desktop.locator('.provider-switch-slot').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })
  if (Math.abs(pendingSwitchSlot.width - currentSwitchSlot.width) > 1 || Math.abs(pendingSwitchSlot.height - currentSwitchSlot.height) > 1) {
    throw new Error(`Provider switch slot must remain stable: ${JSON.stringify({ pendingSwitchSlot, currentSwitchSlot })}`)
  }

  await desktop.locator('.provider-row').filter({ hasText: '示例服务商 C' }).click()
  await desktop.locator('.top-navigation .top-nav-item[aria-label="服务商"]').click()
  await desktop.getByRole('button', { name: '复制配置' }).click()
  await desktop.getByLabel('服务商名称').fill('Example Provider Smoke Copy')
  await desktop.getByRole('button', { name: '保存更改' }).click()
  await desktop.getByRole('dialog', { name: '确认保存手动模型？' }).waitFor()
  await desktop.getByRole('button', { name: '继续保存' }).click()
  await desktop.getByRole('dialog', { name: '确认保存手动模型？' }).waitFor({ state: 'detached' })
  await desktop.locator('.provider-row').filter({ hasText: 'Example Provider Smoke Copy' }).waitFor()
  await desktop.getByRole('button', { name: '删除服务商' }).click()
  await desktop.locator('.provider-row').filter({ hasText: 'Example Provider Smoke Copy' }).waitFor({ state: 'detached' })

  await desktop.locator('.provider-row').filter({ hasText: '示例服务商 B' }).click()
  await desktop.getByRole('button', { name: '设为默认' }).click()
  await desktop.locator('.provider-row').filter({ hasText: '示例服务商 B' }).locator('svg.lucide-star').waitFor()

  await desktop.locator('.provider-row').filter({ hasText: '示例服务商 C' }).click()
  await desktop.getByRole('button', { name: /切换前检查/ }).click()
  await desktop.getByText(/额度不足/).first().waitFor()
  await desktop.getByRole('heading', { name: '完成以下检查后即可切换' }).waitFor()
  await desktop.getByRole('heading', { name: '这些设置会在切换后继续生效' }).waitFor()
  await desktop.getByText('Responses 线路协议').waitFor()
  await desktop.screenshot({ path: join(outputDir, 'desktop-safety-billing.png'), fullPage: true })
  await desktop.getByRole('heading', { name: '完成以下检查后即可切换' }).waitFor()
  await desktop.locator('.check-list').first().waitFor()
  if (await desktop.locator('.compact-check-list').count()) {
    throw new Error('Switch check must not render a nested check list.')
  }
  if (await desktop.locator('.inspector-panel').count()) {
    throw new Error('Switch check must not render a duplicate right-side inspector.')
  }
  await desktop.locator('.provider-row').filter({ hasText: '示例服务商 B' }).click()
  await desktop.getByText('服务端已返回 JSON，但无法确认其可供 Codex 使用。').waitFor()
  await desktop.screenshot({ path: join(outputDir, 'desktop-safety-unconfirmed.png'), fullPage: true })

  await desktop.locator('.provider-row').filter({ hasText: '示例服务商 D' }).click()
  await desktop.getByText('最近一次连接测试通过。').waitFor()

  const safetyLayout = await desktop.evaluate(() => {
    const button = document.querySelector('.check-actions .primary-button')?.getBoundingClientRect()
    const panel = document.querySelector('.check-panel')?.getBoundingClientRect()
    return {
      buttonHeight: button?.height ?? 0,
      buttonRightInset: button && panel
        ? Math.abs(panel.right - button.right - 16)
        : null,
    }
  })
  if (safetyLayout.buttonHeight < 32 || safetyLayout.buttonHeight > 44 || (safetyLayout.buttonRightInset ?? 99) > 2) {
    throw new Error(`Safety check button is stretched or misaligned: ${JSON.stringify(safetyLayout)}`)
  }
  await desktop.getByRole('button', { name: /实验室/ }).click()
  await desktop.getByRole('heading', { name: '性价比中心' }).waitFor()
  if (await desktop.getByRole('heading', { name: '实验室' }).count() !== 0) {
    throw new Error('Labs must not repeat the top-level workspace title.')
  }
  await desktop.getByRole('heading', { name: '性价比排名' }).waitFor()
  await desktop.getByText('100 分').first().waitFor()
  await desktop.getByText('75 分').first().waitFor()
  await desktop.getByRole('button', { name: '运行固定测试' }).click()
  await desktop.getByText('已读取测试额度').waitFor()
  if (await desktop.getByLabel('测试额度').inputValue() !== '0.000524') {
    throw new Error('The preview cost test must prefill the returned cost candidate.')
  }
  await desktop.getByLabel('充值金额').fill('10')
  await desktop.getByLabel('平台实际额度').fill('1000')
  await desktop.getByRole('button', { name: '计算并保存' }).click()
  await desktop.locator('.lab-result-row').filter({ hasText: '示例服务商 D' }).filter({ hasText: '¥0.00000524' }).waitFor()
  await desktop.getByRole('heading', { name: '费用记录' }).waitFor()
  if (await desktop.getByText('返回能力探针').count() !== 0) throw new Error('Labs must use cost-focused language instead of the old response probe name.')
  await desktop.getByRole('button', { name: /安全与恢复/ }).click()
  await desktop.getByRole('heading', { name: '首次启动基线备份已就绪' }).waitFor()
  await desktop.getByRole('heading', { name: '已保护的恢复点' }).waitFor()
  await desktop.getByRole('button', { name: '立即备份当前状态' }).click()
  const manualRecoveryRow = desktop.locator('.recovery-row').filter({ hasText: '手动备份' })
  await manualRecoveryRow.waitFor()
  await manualRecoveryRow.getByRole('button', { name: '安全恢复' }).click()
  const restoreDialog = desktop.getByRole('dialog', { name: '确认回到这个恢复点？' })
  await restoreDialog.waitFor()
  const restoreButton = restoreDialog.getByRole('button', { name: '确认恢复' })
  if (!await restoreButton.isDisabled()) throw new Error('restore confirmation must require the confirmation phrase')
  await restoreDialog.getByPlaceholder('恢复').fill('恢复')
  await restoreButton.click()
  await restoreDialog.waitFor({ state: 'detached' })
  await desktop.getByRole('status').getByText('已恢复配置备份').waitFor()
  await desktop.getByRole('button', { name: /活动记录/ }).click()
  await desktop.getByText('已恢复配置备份').first().waitFor()
  await desktop.getByRole('button', { name: /安全与恢复/ }).click()
  await desktop.screenshot({ path: join(outputDir, 'desktop-protection.png'), fullPage: true })

  await desktop.getByRole('button', { name: /活动记录/ }).click()
  await desktop.getByRole('heading', { name: '活动记录' }).waitFor()
  await desktop.locator('.activity-list').waitFor()
  await desktop.screenshot({ path: join(outputDir, 'desktop-after-save.png'), fullPage: true })

  const compactDesktop = await newPage({ width: 980, height: 700 })
  await compactDesktop.goto(url, { waitUntil: 'networkidle' })
  await compactDesktop.locator('.app-shell').waitFor()
  await compactDesktop.locator('.top-navigation').waitFor()
  await compactDesktop.locator('.workspace-panel').waitFor()
  const compactMetrics = await compactDesktop.evaluate(() => ({
    bodyScrollHeight: document.body.scrollHeight,
    bodyClientHeight: document.body.clientHeight,
    bodyOverflowY: getComputedStyle(document.body).overflowY,
    fullWorkspaceWidth: document.querySelector('.workspace-panel')?.getBoundingClientRect().width ?? 0,
  }))
  if (compactMetrics.bodyOverflowY !== 'hidden' || compactMetrics.bodyScrollHeight > compactMetrics.bodyClientHeight + 1) {
    throw new Error(`Compact shell should not page-scroll: ${JSON.stringify(compactMetrics)}`)
  }
  await compactDesktop.getByRole('button', { name: '实验室' }).click()
  await compactDesktop.getByRole('heading', { name: '性价比中心' }).waitFor()
  const compactLabWidth = await compactDesktop.locator('.workspace-panel').evaluate((element) => element.getBoundingClientRect().width)
  if (compactLabWidth < 900 || await compactDesktop.locator('.provider-object-pane').count() !== 0) {
    throw new Error(`Compact labs workspace must be full-width: ${JSON.stringify({ compactLabWidth })}`)
  }
  await compactDesktop.locator('.top-navigation .top-nav-item[aria-label="服务商"]').click()
  const compactSidebarMetrics = await sidebarMetrics(compactDesktop)
  assertSidebarLayout(compactSidebarMetrics, 'Compact sidebar')
  await compactDesktop.getByRole('button', { name: /切换前检查/ }).click()
  await compactDesktop.getByRole('heading', { name: '完成以下检查后即可切换' }).waitFor()
  const compactSafetyLayout = await compactDesktop.evaluate(() => {
    const panel = document.querySelector('.check-panel')?.getBoundingClientRect()
    const button = document.querySelector('.check-actions .primary-button')?.getBoundingClientRect()
    return {
      buttonHeight: button?.height ?? 0,
      buttonLeftInset: button && panel
        ? Math.abs(button.left - panel.left - 16)
        : null,
      panelWidth: panel?.width ?? 0,
    }
  })
  if (compactSafetyLayout.buttonHeight < 32 || compactSafetyLayout.buttonHeight > 44 || (compactSafetyLayout.buttonLeftInset ?? 99) > 2) {
    throw new Error(`Compact safety controls are misaligned: ${JSON.stringify(compactSafetyLayout)}`)
  }
  await compactDesktop.screenshot({ path: join(outputDir, 'compact-desktop.png'), fullPage: true })

  const wideDesktop = await newPage({ width: 1880, height: 1200 })
  await wideDesktop.goto(url, { waitUntil: 'networkidle' })
  await wideDesktop.locator('.app-shell').waitFor()
  const wideSidebarMetrics = await sidebarMetrics(wideDesktop)
  assertSidebarLayout(wideSidebarMetrics, 'Wide desktop sidebar')
  await wideDesktop.getByRole('button', { name: /切换前检查/ }).click()
  await wideDesktop.getByRole('heading', { name: '完成以下检查后即可切换' }).waitFor()
  await wideDesktop.screenshot({ path: join(outputDir, 'wide-safety.png'), fullPage: true })

  const seriousConsoleEvents = consoleEvents.filter((event) => !event.includes('Download the React DevTools'))
  if (seriousConsoleEvents.length > 0) {
    throw new Error(`Console had relevant warnings/errors:\n${seriousConsoleEvents.join('\n')}`)
  }

  console.log(JSON.stringify({
    ok: true,
    url,
    outputDir,
    screenshots: ['desktop.png', 'desktop-models.png', 'desktop-safety-billing.png', 'desktop-safety-unconfirmed.png', 'desktop-protection.png', 'desktop-after-save.png', 'compact-desktop.png', 'wide-safety.png'],
    metrics: {
      desktop: desktopMetrics,
      compact: compactMetrics,
      sidebar: { desktop: desktopSidebarMetrics, compact: compactSidebarMetrics, wide: wideSidebarMetrics },
      safety: { desktop: safetyLayout, compact: compactSafetyLayout },
    },
    interaction: '应用设置中的更新检查 -> 模型目录 -> 刷新并选择模型 -> 新增服务商 -> 保存 -> 完整切换检查 -> 实验室费用记录 -> 手动备份 -> 双重确认恢复 -> 复制 -> 删除 -> 设为默认 -> 活动记录',
  }, null, 2))
} finally {
  await browser.close()
}
