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
    const pane = rect('.navigation-pane')
    const workspaces = rect('.sidebar-workspaces')
    const connections = rect('.sidebar-connections')
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
  if (metrics.sectionGap === null || metrics.sectionGap < 8 || metrics.sectionGap > 24) {
    throw new Error(`${label}: workspace and connection sections are not clearly separated: ${JSON.stringify(metrics)}`)
  }
  if (metrics.titleToFirstRow === null || metrics.titleToFirstRow < 6 || metrics.titleToFirstRow > 20) {
    throw new Error(`${label}: saved connections have an unexpected title-to-list gap: ${JSON.stringify(metrics)}`)
  }
  if (metrics.listToPaneBottom === null || metrics.listToPaneBottom < 10 || metrics.listToPaneBottom > 24) {
    throw new Error(`${label}: provider list does not own the remaining sidebar height: ${JSON.stringify(metrics)}`)
  }
  if (metrics.providerOverflowY !== 'auto') {
    throw new Error(`${label}: provider list must own its vertical scrolling: ${JSON.stringify(metrics)}`)
  }
}

try {
  const desktop = await newPage({ width: 1440, height: 1000 })
  await desktop.goto(url, { waitUntil: 'networkidle' })
  await desktop.locator('.app-shell').waitFor()
  await desktop.locator('.navigation-pane').waitFor()
  await desktop.locator('.workspace-panel').waitFor()
  await desktop.locator('.inspector-panel').waitFor()
  await desktop.locator('.statusbar').waitFor()

  const updateButton = desktop.locator('header').getByRole('button', { name: '检查更新' })
  await updateButton.click()
  await desktop.locator('header').getByRole('button', { name: '已是最新版' }).waitFor()
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
  await desktop.getByRole('heading', { name: '模型目录' }).waitFor()
  await desktop.getByRole('button', { name: '刷新模型目录' }).click()
  await desktop.getByText('已返回 6 个示例模型。').first().waitFor()
  await desktop.locator('.model-table').waitFor()
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

  await desktop.getByRole('button', { name: /服务商/ }).first().click()
  await desktop.getByRole('heading', { name: /编辑|新增服务商/ }).waitFor()
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
  await desktop.getByLabel('API 密钥').fill('sk-smoke-test')
  await desktop.getByLabel('备注').fill('由 qa:smoke 自动生成。')
  await desktop.getByRole('button', { name: '保存更改' }).click()
  await desktop.getByRole('dialog', { name: '确认保存手动模型？' }).waitFor()
  await desktop.getByRole('button', { name: '仍然保存' }).click()
  await desktop.getByRole('dialog', { name: '确认保存手动模型？' }).waitFor({ state: 'detached' })
  await desktop.locator('.provider-row').filter({ hasText: 'Smoke Test API' }).waitFor()
  await desktop.getByRole('heading', { name: '编辑 Smoke Test API' }).waitFor()

  await desktop.getByRole('button', { name: /安全检查/ }).click()
  await desktop.getByRole('button', { name: '运行可用性测试' }).click()
  await desktop.getByText('没有连接远端服务商').waitFor()
  await desktop.getByRole('button', { name: /服务商/ }).first().click()
  if (!await desktop.getByRole('button', { name: '切换到 Smoke Test API' }).isDisabled()) {
    throw new Error('Preview mode must not enable a simulated provider switch.')
  }

  await desktop.locator('.provider-row').filter({ hasText: '示例服务商 C' }).click()
  await desktop.getByRole('button', { name: '复制配置' }).click()
  await desktop.getByLabel('服务商名称').fill('Example Provider Smoke Copy')
  await desktop.getByRole('button', { name: '保存更改' }).click()
  await desktop.locator('.provider-row').filter({ hasText: 'Example Provider Smoke Copy' }).waitFor()
  await desktop.getByRole('button', { name: '删除服务商' }).click()
  await desktop.locator('.provider-row').filter({ hasText: 'Example Provider Smoke Copy' }).waitFor({ state: 'detached' })

  await desktop.locator('.provider-row').filter({ hasText: '示例服务商 B' }).click()
  await desktop.getByRole('button', { name: '设为默认' }).click()
  await desktop.locator('.provider-row').filter({ hasText: '示例服务商 B' }).locator('svg').waitFor()

  await desktop.getByRole('button', { name: /安全检查/ }).click()
  await desktop.getByRole('heading', { name: '安全检查' }).waitFor()
  await desktop.locator('.check-list').first().waitFor()
  await desktop.locator('.check-list.compact-check-list').first().waitFor()
  const safetyLayout = await desktop.evaluate(() => {
    const button = document.querySelector('.safety-run-button')?.getBoundingClientRect()
    const summary = document.querySelector('.safety-summary')?.getBoundingClientRect()
    const icon = document.querySelector('.switch-card-heading .switch-icon')?.getBoundingClientRect()
    const label = document.querySelector('.switch-card-heading span:last-child')?.getBoundingClientRect()
    return {
      buttonHeight: button?.height ?? 0,
      buttonCenterDelta: button && summary
        ? Math.abs((button.top + button.height / 2) - (summary.top + summary.height / 2))
        : null,
      switchIconCenterDelta: icon && label
        ? Math.abs((icon.top + icon.height / 2) - (label.top + label.height / 2))
        : null,
    }
  })
  if (safetyLayout.buttonHeight < 32 || safetyLayout.buttonHeight > 44 || (safetyLayout.buttonCenterDelta ?? 99) > 2) {
    throw new Error(`Safety check button is stretched or misaligned: ${JSON.stringify(safetyLayout)}`)
  }
  if ((safetyLayout.switchIconCenterDelta ?? 99) > 2) {
    throw new Error(`Switch card icon is not vertically aligned with its label: ${JSON.stringify(safetyLayout)}`)
  }
  await desktop.getByRole('button', { name: '恢复最近备份' }).click()
  await desktop.getByRole('dialog', { name: '确认恢复配置？' }).waitFor()
  await desktop.getByRole('button', { name: '取消' }).click()
  await desktop.getByRole('dialog', { name: '确认恢复配置？' }).waitFor({ state: 'detached' })
  await desktop.screenshot({ path: join(outputDir, 'desktop-safety.png'), fullPage: true })

  await desktop.getByRole('button', { name: /活动记录/ }).click()
  await desktop.getByRole('heading', { name: '活动记录' }).waitFor()
  await desktop.locator('.activity-list').waitFor()
  await desktop.screenshot({ path: join(outputDir, 'desktop-after-save.png'), fullPage: true })

  const compactDesktop = await newPage({ width: 980, height: 760 })
  await compactDesktop.goto(url, { waitUntil: 'networkidle' })
  await compactDesktop.locator('.app-shell').waitFor()
  await compactDesktop.locator('.navigation-pane').waitFor()
  await compactDesktop.locator('.workspace-panel').waitFor()
  await compactDesktop.locator('.inspector-panel').waitFor()
  const compactMetrics = await compactDesktop.evaluate(() => ({
    bodyScrollHeight: document.body.scrollHeight,
    bodyClientHeight: document.body.clientHeight,
    bodyOverflowY: getComputedStyle(document.body).overflowY,
  }))
  if (compactMetrics.bodyOverflowY !== 'hidden' || compactMetrics.bodyScrollHeight > compactMetrics.bodyClientHeight + 1) {
    throw new Error(`Compact shell should not page-scroll: ${JSON.stringify(compactMetrics)}`)
  }
  const compactSidebarMetrics = await sidebarMetrics(compactDesktop)
  assertSidebarLayout(compactSidebarMetrics, 'Compact sidebar')
  await compactDesktop.getByRole('button', { name: /安全检查/ }).click()
  await compactDesktop.getByRole('heading', { name: '安全检查' }).waitFor()
  const compactSafetyLayout = await compactDesktop.evaluate(() => {
    const summary = document.querySelector('.safety-summary')?.getBoundingClientRect()
    const button = document.querySelector('.safety-run-button')?.getBoundingClientRect()
    const cards = [...document.querySelectorAll('.safety-summary > div')].map((element) => element.getBoundingClientRect())
    return {
      buttonHeight: button?.height ?? 0,
      buttonTop: button?.top ?? 0,
      cardBottom: cards.length ? Math.max(...cards.map((card) => card.bottom)) : 0,
      summaryWidth: summary?.width ?? 0,
    }
  })
  if (compactSafetyLayout.buttonHeight < 32 || compactSafetyLayout.buttonHeight > 44 || compactSafetyLayout.buttonTop < compactSafetyLayout.cardBottom + 8) {
    throw new Error(`Compact safety controls overlap or stretch: ${JSON.stringify(compactSafetyLayout)}`)
  }
  await compactDesktop.screenshot({ path: join(outputDir, 'compact-desktop.png'), fullPage: true })

  const wideDesktop = await newPage({ width: 1880, height: 1200 })
  await wideDesktop.goto(url, { waitUntil: 'networkidle' })
  await wideDesktop.locator('.app-shell').waitFor()
  const wideSidebarMetrics = await sidebarMetrics(wideDesktop)
  assertSidebarLayout(wideSidebarMetrics, 'Wide desktop sidebar')
  await wideDesktop.getByRole('button', { name: /安全检查/ }).click()
  await wideDesktop.getByRole('heading', { name: '安全检查' }).waitFor()
  await wideDesktop.screenshot({ path: join(outputDir, 'wide-safety.png'), fullPage: true })

  const seriousConsoleEvents = consoleEvents.filter((event) => !event.includes('Download the React DevTools'))
  if (seriousConsoleEvents.length > 0) {
    throw new Error(`Console had relevant warnings/errors:\n${seriousConsoleEvents.join('\n')}`)
  }

  console.log(JSON.stringify({
    ok: true,
    url,
    outputDir,
    screenshots: ['desktop.png', 'desktop-models.png', 'desktop-safety.png', 'desktop-after-save.png', 'compact-desktop.png', 'wide-safety.png'],
    metrics: {
      desktop: desktopMetrics,
      compact: compactMetrics,
      sidebar: { desktop: desktopSidebarMetrics, compact: compactSidebarMetrics, wide: wideSidebarMetrics },
      safety: { desktop: safetyLayout, compact: compactSafetyLayout },
    },
    interaction: '检查更新 -> 模型目录 -> 刷新并选择模型 -> 新增服务商 -> 保存 -> 安全检查显示预览边界 -> 复制 -> 删除 -> 设为默认 -> 活动记录',
  }, null, 2))
} finally {
  await browser.close()
}
