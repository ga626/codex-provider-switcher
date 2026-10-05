import { chromium } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { transform } from 'esbuild'

const url = process.env.QA_URL ?? process.env.QA_BASE_URL ?? 'http://127.0.0.1:47832/'
const outputDir = process.env.QA_OUTPUT_DIR ?? join(process.env.TEMP ?? process.cwd(), 'codex-switcher-qa')
const chromePath = process.env.QA_CHROME_PATH

await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch(chromePath ? { executablePath: chromePath } : { channel: 'chrome' })
const consoleEvents = []
const contexts = []

async function newPage(viewport) {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
  contexts.push(page.context())
  await page.context().tracing.start({ screenshots: true, snapshots: true, sources: false })
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
  // The development-only QA rail preserves a 1280px product canvas beside a
  // 220px rail, so verify it at its declared 1500px desktop floor.
  const desktop = await newPage({ width: 1500, height: 860 })
  await desktop.goto(url, { waitUntil: 'networkidle' })
  const desktopMetrics = await assertShell(desktop, 'Desktop')

  await desktop.getByRole('button', { name: '应用设置' }).click()
  const settings = desktop.getByRole('dialog', { name: '应用设置' })
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
  for (const label of ['环境', '设置', '模型', '测试']) {
    await connectionDock.locator('.dock-status-list dt').filter({ hasText: label }).waitFor()
  }
  await connectionDock.getByRole('heading', { name: '服务商可用性' }).waitFor()
  await connectionDock.getByRole('button', { name: '运行可用性测试' }).waitFor()
  await connectionDock.getByRole('button', { name: '当前正在使用' }).waitFor()
  for (const width of [1500, 1920]) {
    await desktop.setViewportSize({ width, height: 860 })
    const geometry = await desktop.evaluate(() => {
      const box = (selector) => {
        const element = document.querySelector(selector)
        if (!element) throw new Error(`Missing layout element: ${selector}`)
        const rect = element.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, right: rect.right }
      }
      return {
        name: box('[data-tour="provider-name"]'), key: box('[data-tour="provider-api-key"]'),
        endpoint: box('.endpoint-field'), model: box('.model-picker-field'),
        speed: box('.endpoint-speed-button'), download: box('.model-download-button'),
        input: box('.model-picker-input'), toggle: box('.endpoint-toggle'), heading: box('.endpoint-heading'),
        scopeColumns: getComputedStyle(document.querySelector('.connection-scope')).gridTemplateColumns,
        notePresent: Boolean(document.querySelector('input[name="provider-note"]')),
        addressBorder: getComputedStyle(document.querySelector('input[name="provider-base-url"]')).borderLeftWidth,
      }
    })
    if (Math.abs(geometry.name.y - geometry.key.y) > 1) throw new Error('名称与 API Key 必须同行')
    if (Math.abs(geometry.endpoint.width - geometry.model.width) > 1 || geometry.endpoint.width < geometry.name.width * 1.8) throw new Error('接口地址与默认模型必须占整行')
    if (geometry.speed.right > geometry.endpoint.right + 1 || geometry.download.right > geometry.input.right + 1) throw new Error('输入框尾部按钮越界')
    if (Math.abs(geometry.toggle.right - geometry.heading.right) > 1) throw new Error('完整 URL 必须在地址标题行右对齐')
    if (geometry.notePresent || geometry.scopeColumns.split(' ').length !== 1) throw new Error('配置页备注未移除或顶部摘要未合并为单列')
    if (geometry.addressBorder !== '0px') throw new Error('接口输入与测速必须共享外框，不能嵌套输入边框')
    await desktop.locator('.current-model-compatibility').waitFor()
    await desktop.screenshot({ path: join(outputDir, `provider-config-${width}.png`) })
  }
  await desktop.setViewportSize({ width: 1500, height: 860 })
  await desktop.getByRole('button', { name: '显示访问密钥' }).click()
  await desktop.getByRole('button', { name: '隐藏访问密钥' }).waitFor()
  const apiKey = desktop.getByRole('textbox', { name: '已保存访问密钥，输入新密钥即可替换' })
  if (await apiKey.getAttribute('type') !== 'text') throw new Error('The access-key eye must reveal the locally saved value')
  await desktop.getByRole('button', { name: '隐藏访问密钥' }).click()

  await desktop.getByRole('button', { name: '展开模型目录' }).click()
  await desktop.screenshot({ path: join(outputDir, 'provider-model-catalog-flat.png') })
  const modelInput = desktop.getByPlaceholder('搜索模型、厂商或能力')
  await modelInput.fill('5.6')
  for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    await desktop.locator('#model-options .model-row').filter({ hasText: model }).waitFor()
  }
  await desktop.getByRole('button', { name: '收起模型目录' }).click()
  if (await desktop.getByRole('button', { name: '报告兼容问题' }).count()) {
    throw new Error('A verified provider must not show the compatibility feedback action')
  }
  await desktop.locator('.provider-row').filter({ hasText: '服务商 C' }).click()
  await desktop.getByRole('button', { name: '报告兼容问题' }).click()
  await desktop.getByRole('heading', { name: '把这次问题告诉维护者' }).waitFor()
  await desktop.getByText(/不包含访问密钥、配置正文、文件路径、响应原文/).waitFor()
  await desktop.getByText('在线反馈尚未配置').waitFor()
  await desktop.getByRole('button', { name: '关闭反馈' }).click()
  await desktop.getByRole('button', { name: '使用说明', exact: true }).click()
  const guideHub = desktop.getByRole('dialog', { name: '选择要了解的功能' })
  await guideHub.waitFor()
  await guideHub.locator('.guide-chapter-card').filter({ hasText: '初始化配置' }).getByRole('button', { name: '开始' }).click()
  await desktop.getByRole('heading', { name: '选择连接来源' }).waitFor()
  if (await desktop.locator('.getting-started-progress').getAttribute('aria-label') !== '第 1 步，共 8 步') {
    throw new Error('The ready-state initialization guide did not skip the completed environment-preparation step')
  }
  await desktop.getByRole('button', { name: '稍后再说' }).click()
  const leftSplitter = desktop.getByRole('separator', { name: '调整服务商列表宽度' })
  const beforeLeftWidth = Number(await leftSplitter.getAttribute('aria-valuenow'))
  await leftSplitter.focus()
  await desktop.keyboard.press('Shift+ArrowRight')
  const afterLeftWidth = Number(await leftSplitter.getAttribute('aria-valuenow'))
  if (afterLeftWidth <= beforeLeftWidth) throw new Error('Keyboard splitter did not update the accessible width value')
  await desktop.screenshot({ path: join(outputDir, 'provider-workbench.png'), fullPage: true })

  await desktop.locator('.provider-row').filter({ hasText: 'DeepSeek 官方 API' }).click()
  const officialPresetBounds = await desktop.locator('.official-provider-preset select').boundingBox()
  if (!officialPresetBounds || officialPresetBounds.width > 540) {
    throw new Error('Official API provider selector must stay close to its option text instead of spanning the form')
  }

  await desktop.locator('.provider-row').filter({ hasText: '服务商 D' }).click()
  const dockSwitch = desktop.getByRole('button', { name: '检查并切换' })
  await dockSwitch.waitFor()
  if (process.env.QA_EXPECT_MOCK === 'true' && !await dockSwitch.isDisabled()) throw new Error('Browser preview must keep provider switching disabled')

  const qaRail = desktop.locator('aside[aria-label="开发版 QA 控制台"]')
  await qaRail.waitFor()
  await qaRail.getByRole('button', { name: /状态反馈预览/ }).click()
  await qaRail.getByRole('button', { name: '成功提示', exact: true }).click()
  await desktop.getByText('QA 外观预览：操作成功提示，没有执行产品操作。', { exact: true }).waitFor()
  await qaRail.getByRole('button', { name: '错误提示', exact: true }).click()
  await desktop.getByText('QA 外观预览：操作失败提示，没有发生真实错误。', { exact: true }).waitFor()
  await qaRail.getByRole('button', { name: '结束预览', exact: true }).click()
  await qaRail.getByRole('button', { name: '从第一页开始', exact: true }).click()
  await qaRail.getByRole('button', { name: '下一步', exact: true }).click()
  await desktop.getByRole('heading', { name: '建立固定连接身份' }).waitFor()
  await desktop.getByText('结果待确认', { exact: true }).waitFor()
  if (await desktop.locator('.first-run-step.done').count() || await desktop.locator('.first-run-step-state').filter({ hasText: '完成' }).count()) {
    throw new Error('首次启动计时信息流不能把展示过的事项标为已完成')
  }
  await desktop.getByRole('heading', { name: '检查结果示例' }).waitFor()
  if (await desktop.locator('.first-run-review-row em').filter({ hasText: '通过' }).count()) {
    throw new Error('开发预览不能把样本检查标为真实通过')
  }
  await qaRail.getByRole('button', { name: '上一步', exact: true }).click()
  const initializationRequests = []
  const trackInitialization = request => { if (/initialize|onboarding/.test(request.url())) initializationRequests.push(request.url()) }
  desktop.on('request', trackInitialization)
  await qaRail.getByRole('button', { name: '降级（阻止进入）', exact: true }).click()
  await desktop.getByRole('heading', { name: '还有问题，暂时不能进入', exact: true }).waitFor()
  if (await desktop.locator('.first-run-review-row.warning').count() !== 3) throw new Error('降级模拟应展示全部降级情景')
  if (await desktop.locator('.first-run-review-row.warning details[open]').count() !== 3) throw new Error('降级说明应默认展开')
  if (await desktop.getByRole('button', { name: '进入软件', exact: true }).count()) throw new Error('存在降级时不能进入软件')
  if (await desktop.getByRole('button', { name: '安全与恢复', exact: true }).count()) throw new Error('存在降级时不能进入安全与恢复')
  await qaRail.getByRole('button', { name: '从第一页开始', exact: true }).click()
  await qaRail.getByRole('button', { name: '必须处理的阻断', exact: true }).click()
  await desktop.getByRole('heading', { name: '还有问题，暂时不能进入', exact: true }).waitFor()
  if (await desktop.locator('.first-run-review-row.danger').count() !== 9) throw new Error('阻断模拟应展示全部阻断情景')
  const blockedNext = desktop.locator('.first-run-complete-actions').getByRole('button', { name: '下一步', exact: true })
  if (await blockedNext.count()) throw new Error('红色结果不能显示继续按钮')
  if (await desktop.getByRole('button', { name: '安全与恢复', exact: true }).count()) throw new Error('存在阻断时不能进入安全与恢复')
  if (initializationRequests.length) throw new Error(`模拟结果不能调用初始化或完成写入: ${initializationRequests.join(',')}`)
  desktop.off('request', trackInitialization)
  await qaRail.getByRole('button', { name: '从第一页开始', exact: true }).click()
  await desktop.getByRole('heading', { name: '先初始化 Signalman', exact: true }).waitFor()
  await qaRail.getByRole('button', { name: /载入基准日常样本/ }).click()
  await desktop.locator('.provider-row').first().waitFor()
  await qaRail.getByText('下一次模型刷新', { exact: true }).click()
  await qaRail.getByLabel('模型刷新响应条件').selectOption('failure')
  const refreshButton = desktop.getByRole('button', { name: '获取模型列表', exact: true })
  await refreshButton.click()
  await desktop.getByText('QA 模拟：本次模型刷新连接失败。原有目录保留，可再次刷新。', { exact: true }).waitFor()
  await refreshButton.click()
  await qaRail.getByRole('button', { name: /载入基准日常样本/ }).click()
  await qaRail.getByRole('button', { name: /边界排版检查/ }).click()
  const providerList = desktop.getByRole('listbox', { name: '服务商列表' })
  await providerList.waitFor()
  const lastProvider = desktop.locator('[data-provider-id="qa-density-provider-14"]')
  await lastProvider.waitFor()
  const scrollState = await providerList.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    return { clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop }
  })
  if (scrollState.scrollHeight <= scrollState.clientHeight || scrollState.scrollTop <= 0) {
    throw new Error(`边界服务商列表无法形成可滚动区域：${JSON.stringify(scrollState)}`)
  }
  await lastProvider.scrollIntoViewIfNeeded()
  await lastProvider.click()
  if (await lastProvider.getAttribute('aria-selected') !== 'true') throw new Error('边界服务商列表最后一项无法选择。')
  const providerGeometry = await providerList.locator('.provider-row').evaluateAll((rows) => rows.map((row) => {
    const rowBox = row.getBoundingClientRect()
    const stateBox = row.querySelector('.row-state')?.getBoundingClientRect()
    return { top: rowBox.top, bottom: rowBox.bottom, height: rowBox.height, stateWidth: stateBox?.width ?? 0, stateHeight: stateBox?.height ?? 0, stateTop: stateBox?.top ?? 0, stateBottom: stateBox?.bottom ?? 0 }
  }))
  for (let index = 0; index < providerGeometry.length; index += 1) {
    const row = providerGeometry[index]
    if (row.height < 63) throw new Error(`服务商条目高度被压缩：第 ${index + 1} 条仅 ${row.height}px。`)
    if (row.stateWidth < 7 || row.stateHeight < 7) throw new Error(`服务商状态点被压缩：第 ${index + 1} 条为 ${row.stateWidth}x${row.stateHeight}px。`)
    if (row.stateTop < row.top || row.stateBottom > row.bottom) throw new Error(`服务商状态点越过条目边界：第 ${index + 1} 条。`)
    if (index > 0 && providerGeometry[index - 1].bottom > row.top + 0.5) throw new Error(`服务商条目上下重叠：第 ${index} 与第 ${index + 1} 条。`)
  }
  const providerName = desktop.locator('input[name="provider-name"]')
  if (!(await providerName.inputValue()).includes('区域接入节点 14')) throw new Error('选择最后一项后右侧服务商表单没有更新。')
  await desktop.screenshot({ path: join(outputDir, 'qa-density-provider-list.png'), fullPage: true })

  // 同一套资料走真实页面；两种高度均核对，不以按钮存在代替内容已到达。
  for (const height of [860, 700]) {
    await desktop.setViewportSize({ width: 1500, height })
    await desktop.getByRole('button', { name: '服务商', exact: true }).click()
    await desktop.locator('[data-provider-id="qa-density-provider-01"]').click()
    await desktop.getByRole('button', { name: '展开模型目录' }).click()
    await desktop.getByPlaceholder('搜索模型、厂商或能力').fill('Qwen')
    await desktop.locator('#model-options .model-row').filter({ hasText: 'Qwen3-Coder' }).first().waitFor()
    await assertShell(desktop, `边界模型 ${height}`)
    await desktop.screenshot({ path: join(outputDir, `boundary-models-${height}.png`) })
    const selectableModel = desktop.locator('#model-options .model-row[role="button"]').filter({ hasText: 'Qwen3-Coder' }).first()
    const modelRowGeometry = await selectableModel.evaluate((row) => {
      const rowBox = row.getBoundingClientRect()
      const joinBox = row.querySelector('.model-join-toggle')?.getBoundingClientRect()
      return { rowLeft: rowBox.left, rowRight: rowBox.right, joinLeft: joinBox?.left ?? 0, joinRight: joinBox?.right ?? 0, rowHeight: rowBox.height, joinHeight: joinBox?.height ?? 0 }
    })
    if (modelRowGeometry.joinLeft < modelRowGeometry.rowLeft || modelRowGeometry.joinRight > modelRowGeometry.rowRight || modelRowGeometry.joinHeight > modelRowGeometry.rowHeight) {
      throw new Error(`模型行内的目录开关越界：${JSON.stringify(modelRowGeometry)}`)
    }
    await selectableModel.click()
    const selectedModelId = await desktop.locator('input[name="provider-model"]').inputValue()
    if (!selectedModelId.includes('Qwen3-Coder')) throw new Error(`点击模型行后没有选中模型：${selectedModelId}`)
    await desktop.getByRole('button', { name: '展开模型目录' }).click()
    await desktop.getByPlaceholder('搜索模型、厂商或能力').fill('Qwen')
    const keyboardModel = desktop.locator('#model-options .model-row[role="button"]').nth(1)
    await keyboardModel.focus()
    await keyboardModel.press('Enter')
    const keyboardSelectedModelId = await desktop.locator('input[name="provider-model"]').inputValue()
    if (keyboardSelectedModelId === selectedModelId || !keyboardSelectedModelId.includes('Qwen')) throw new Error('键盘无法选择模型行。')
    await desktop.getByRole('button', { name: '展开模型目录' }).click()
    await desktop.getByPlaceholder('搜索模型、厂商或能力').waitFor()
    await desktop.getByPlaceholder('搜索模型、厂商或能力').fill('不存在的筛选关键词')
    await desktop.getByText('没有匹配的模型', { exact: true }).waitFor()
    await desktop.getByRole('button', { name: '收起模型目录' }).click()
    for (const index of Array.from({ length: 18 }, (_, index) => index + 1)) {
      await desktop.locator(`[data-provider-id="qa-density-provider-${String(index).padStart(2, '0')}"]`).click()
      await assertShell(desktop, `边界连接状态 ${index} / ${height}`)
      if (index === 3) {
        await desktop.getByRole('button', { name: '展开模型目录' }).click()
        await desktop.getByText('还没有可展示的模型', { exact: true }).waitFor()
        await desktop.getByRole('button', { name: '收起模型目录' }).click()
      }
    }
    await desktop.getByRole('button', { name: '活动记录', exact: true }).click()
    await desktop.locator('.activity-operation').first().waitFor()
    await desktop.locator('.activity-operation').first().getByRole('button', { name: '查看', exact: true }).click()
    const detail = desktop.getByRole('dialog')
    await detail.getByText('查看技术信息').click()
    await detail.getByText(/req_20260918_regional_gateway/).waitFor()
    await assertShell(desktop, `边界诊断 ${height}`)
    await desktop.screenshot({ path: join(outputDir, `boundary-diagnostic-${height}.png`) })
    await desktop.getByRole('button', { name: '关闭详情', exact: true }).click()
    await desktop.getByRole('button', { name: '实验室', exact: true }).click()
    const ranking = desktop.locator('.lab-ranking-row').filter({ hasText: '区域接入节点' })
    if (await ranking.count() < 10) throw new Error('边界费用样本未进入实际排名。')
    const rankingHeaders = await desktop.locator('.lab-ranking-head .ranking-cell').evaluateAll((cells) => cells.map((cell) => Array.from(cell.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '').join('').trim()))
    if (rankingHeaders.join('|') !== '服务商|官方购买力|账单换算|稳定性|性价比分|管理') throw new Error(`费用排名列顺序错误：${rankingHeaders.join('|')}`)
    const evidenceLayout = await desktop.locator('.lab-ranking-row .evidence-hint button').evaluateAll((buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect()
      const official = button.closest('.ranking-official')?.getBoundingClientRect()
      return { x: box.x, relativeX: official ? box.x - official.x : -1, color: getComputedStyle(button).backgroundColor }
    }))
    if (evidenceLayout.length < 2) throw new Error('边界费用排名缺少可比较的 A/B/C 证据标记。')
    if (Math.max(...evidenceLayout.map((item) => item.x)) - Math.min(...evidenceLayout.map((item) => item.x)) > 1.5) throw new Error('A/B/C 证据标记没有固定在同一列。')
    if (evidenceLayout.some((item) => item.relativeX < 115 || item.relativeX > 135)) throw new Error(`A/B/C 证据标记离购买力数值过远：${JSON.stringify(evidenceLayout)}`)
    if (evidenceLayout.some((item) => item.color === 'rgba(0, 0, 0, 0)' || item.color === 'transparent')) throw new Error('证据标记没有可见的等级底色。')
    await ranking.last().scrollIntoViewIfNeeded()
    await ranking.last().getByRole('button', { name: /^(管理|详情)$/ }).click()
    await desktop.locator('.lab-history-row').last().scrollIntoViewIfNeeded()
    await assertShell(desktop, `边界费用 ${height}`)
    await desktop.screenshot({ path: join(outputDir, `boundary-lab-${height}.png`) })
    await desktop.getByRole('button', { name: '安全与恢复', exact: true }).click()
    const recoveries = desktop.locator('.recovery-row')
    if (await recoveries.count() < 10) throw new Error('边界恢复记录未显示。')
    await recoveries.last().scrollIntoViewIfNeeded()
    await assertShell(desktop, `边界恢复 ${height}`)
    await desktop.screenshot({ path: join(outputDir, `boundary-recovery-${height}.png`) })
    await recoveries.last().getByRole('button', { name: '安全恢复', exact: true }).click()
    await desktop.getByRole('dialog').getByRole('button', { name: '确认恢复', exact: true }).waitFor()
    if (!await desktop.getByRole('button', { name: '确认恢复', exact: true }).isDisabled()) throw new Error('恢复确认门禁丢失。')
    await desktop.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
    await desktop.getByRole('button', { name: '应用设置', exact: true }).click()
    await desktop.getByRole('dialog', { name: '应用设置' }).waitFor()
    await desktop.getByRole('button', { name: '关闭设置', exact: true }).click()
    await desktop.getByRole('button', { name: '使用说明', exact: true }).click()
    await desktop.getByRole('dialog', { name: '选择要了解的功能' }).waitFor()
    await desktop.getByRole('dialog').getByRole('button', { name: /关闭/ }).click()
  }
  await desktop.setViewportSize({ width: 1500, height: 860 })
  await desktop.getByRole('button', { name: '服务商', exact: true }).click()

  await qaRail.getByRole('button', { name: '载入基准日常样本', exact: true }).click()
  await lastProvider.waitFor({ state: 'hidden' })
  await desktop.locator('.provider-row').filter({ hasText: '服务商 D' }).waitFor()
  await desktop.locator('.provider-row').filter({ hasText: '服务商 D' }).click()

  await desktop.getByRole('button', { name: '实验室' }).click()
  await desktop.getByRole('heading', { name: '性价比中心' }).waitFor()
  const creditUnits = await desktop.getByLabel('额度单位').locator('option').allTextContents()
  for (const expectedUnit of ['美元额度（USD）', '人民币余额（CNY）', '平台额度/点数']) {
    if (!creditUnits.includes(expectedUnit)) throw new Error(`Cost center is missing credit unit: ${expectedUnit}`)
  }
  await desktop.getByRole('heading', { name: '服务商对比' }).waitFor()
  await desktop.getByRole('table', { name: '性价比排名' }).waitFor()
  const gradeColors = await desktop.evaluate(() => {
    const host = document.createElement('div')
    host.style.position = 'fixed'
    host.style.left = '-1000px'
    for (const grade of ['A', 'B', 'C']) host.insertAdjacentHTML('beforeend', `<span class="field-hint evidence-hint evidence-${grade}"><button>${grade}</button></span>`)
    document.body.append(host)
    const colors = Array.from(host.querySelectorAll('button'), (button) => getComputedStyle(button).backgroundColor)
    host.remove()
    return colors
  })
  if (new Set(gradeColors).size !== 3) throw new Error(`A/B/C 证据等级没有形成三种可辨识的颜色：${JSON.stringify(gradeColors)}`)
  await desktop.getByRole('button', { name: '运行固定测试' }).click()
  await desktop.getByText('需要从平台日志补充真实扣额').waitFor()
  if (await desktop.getByLabel('本次真实扣减').inputValue()) {
    throw new Error('An unverified response cost must not be treated as a platform debit')
  }
  await desktop.getByLabel('实际支付人民币').fill('10')
  await desktop.getByLabel('实际到账额度').fill('1000')
  await desktop.getByLabel('本次真实扣减').fill('0.000398')
  await desktop.locator('input[aria-label="已核对平台真实扣减"]').check()
  await desktop.getByRole('button', { name: '计算并保存' }).click()
  const demoRankingRow = desktop.locator('.lab-ranking-row').filter({ hasText: '服务商 D' })
  await demoRankingRow.waitFor()
  if (!/\d+ (?:次|条账单记录)/.test(await demoRankingRow.innerText())) throw new Error('Saved calibration did not render a sample count in the ranking row')
  await desktop.screenshot({ path: join(outputDir, 'cost-center.png'), fullPage: true })

  const compact = await newPage({ width: 1500, height: 700 })
  await compact.goto(url, { waitUntil: 'networkidle' })
  const compactMetrics = await assertShell(compact, 'QA minimum desktop')
  await compact.getByRole('button', { name: '实验室' }).click()
  await compact.getByRole('heading', { name: '性价比中心' }).waitFor()
  await compact.getByRole('table', { name: '性价比排名' }).waitFor()
  await compact.screenshot({ path: join(outputDir, 'compact-cost-center.png'), fullPage: true })

  // Rendered contract only: native filesystem isolation is verified separately.
  const compiledFixture = (await transform(await readFile('src/mockData.ts', 'utf8'), { loader: 'ts', format: 'esm', target: 'es2022' })).code
  const { initialState } = await import(`data:text/javascript;base64,${Buffer.from(compiledFixture).toString('base64')}`)
  const sessionPage = await newPage({ width: 1500, height: 700 })
  await sessionPage.addInitScript((fixture) => {
    let live = false
    const calls = []
    window.__qaCalls = calls
    const status = () => ({ mode: live ? 'live-copy' : 'fixture', inUse: live, snapshotReady: true, importReady: true, detail: live ? '真实副本界面合同样本' : '模拟界面合同样本' })
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command) => {
        calls.push(command)
        if (command === 'qa_open_live_validation_window') live = true
        if (command === 'qa_leave_live_validation') live = false
        if (command === 'load_state') {
          const value = structuredClone(fixture)
          value.profiles[0].name = live ? '真实副本界面合同样本' : '模拟界面合同样本'
          value.runtimeMode = 'desktop'
          return value
        }
        if (command.startsWith('qa_')) return status()
        if (command === 'plugin:window|set_title') return
        throw new Error(`Unexpected mocked native command: ${command}`)
      },
    }
  }, initialState)
  sessionPage.on('dialog', dialog => dialog.accept())
  await sessionPage.goto(url, { waitUntil: 'networkidle' })
  await assertShell(sessionPage, 'Same window before entering')
  for (let round = 0; round < 2; round++) {
    await sessionPage.getByRole('button', { name: round ? '继续上次' : '创建真实验证副本', exact: true }).click()
    await sessionPage.getByRole('button', { name: '返回模拟检查', exact: true }).waitFor()
    await sessionPage.locator('.provider-row').filter({ hasText: '真实副本界面合同样本' }).waitFor()
    await assertShell(sessionPage, 'Same window live mode')
    if (round === 0) await sessionPage.screenshot({ path: join(outputDir, 'qa-single-window.png'), fullPage: true })
    await sessionPage.getByRole('button', { name: '返回模拟检查', exact: true }).click()
    await sessionPage.locator('.provider-row').filter({ hasText: '模拟界面合同样本' }).waitFor()
    if (sessionPage.context().pages().length !== 1) throw new Error('QA mode opened a second page')
    if (round === 0) await sessionPage.getByText('继续与资料管理', { exact: true }).click()
  }
  const nativeCalls = await sessionPage.evaluate(() => window.__qaCalls)
  if (nativeCalls.some(command => /window\|(hide|close|create)/.test(command))) throw new Error('Mode change manipulated the product window')
  console.log('同窗口进入、返回、继续的界面合同通过；IPC 为无凭据模拟，真实目录隔离由原生测试另证。')

  const seriousConsoleEvents = consoleEvents.filter((event) => !event.includes('Download the React DevTools'))
  if (seriousConsoleEvents.length > 0) throw new Error(`Console had relevant warnings/errors:\n${seriousConsoleEvents.join('\n')}`)
  console.log(JSON.stringify({
    ok: true,
    url,
    outputDir,
    screenshots: ['provider-workbench.png', 'qa-density-provider-list.png', 'cost-center.png', 'compact-cost-center.png'],
    metrics: { desktop: desktopMetrics, compact: compactMetrics, providerList: scrollState },
    interaction: '服务商单页 -> 已保存访问密钥显示 -> 模型筛选 -> 边界列表滚动并选择最后一项 -> Dock 切换状态 -> 固定测试自动读费 -> 保存样本 -> 性价比排名',
  }, null, 2))
  for (const width of [1500, 1740]) {
    await compact.setViewportSize({ width, height: 700 })
    await assertShell(compact, `width-${width}`)
    const clipped = await compact.locator('.qa-control-rail button').evaluateAll(nodes => nodes.filter(n => n.scrollWidth > n.clientWidth + 2).map(n => n.textContent))
    if (clipped.length) throw new Error(`QA按钮文字裁切：${clipped.join('、')}`)
  }
  const baseline = process.env.QA_VISUAL_BASELINE
  const image = await compact.locator('.qa-control-header').screenshot({ animations: 'disabled' })
  await writeFile(join(outputDir, 'qa-header-current.png'), image)
  if (baseline && !image.equals(await readFile(baseline))) throw new Error('固定环境视觉基准发生变化，需人工查看，不能自动批准。')
  console.log(baseline ? '视觉基准一致' : '视觉基准比较未运行：尚未指定人工确认的基准；本次保存截图供检查。')
} catch (error) {
  for (let index = 0; index < contexts.length; index++) await contexts[index].tracing.stop({ path: join(outputDir, `failure-${index}.zip`) }).catch(() => {})
  throw error
} finally {
  await browser.close()
}
