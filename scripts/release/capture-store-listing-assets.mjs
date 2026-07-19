import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const baseUrl = process.env.STORE_LISTING_URL ?? 'http://127.0.0.1:47832/'
const outputDir = process.env.STORE_LISTING_OUTPUT_DIR ?? join(process.cwd(), 'release-assets', 'store-listing')
const version = process.env.STORE_LISTING_VERSION ?? JSON.parse(await readFile('package.json', 'utf8')).version
const versionDir = join(outputDir, version)

await mkdir(versionDir, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const consoleErrors = []
page.on('console', (message) => {
  if (['error', 'warning'].includes(message.type()) && !message.text().includes('React DevTools')) {
    consoleErrors.push(`${message.type()}: ${message.text()}`)
  }
})
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.locator('.app-shell').waitFor()
  await page.addStyleTag({ content: '.preview-banner { display: none !important; }' })

  const visibleText = await page.locator('body').innerText()
  for (const forbidden of ['sk-', 'api.owlai.tech', 'auth.json', 'config.toml', 'C:\\Users\\ga990']) {
    if (visibleText.includes(forbidden)) {
      throw new Error(`Store screenshot contains a forbidden private/demo marker: ${forbidden}`)
    }
  }

  const captures = [
    ['01-providers.png', async () => {}],
    ['02-models.png', async () => {
      await page.getByRole('button', { name: /模型目录/ }).click()
      await page.getByRole('heading', { name: '模型目录' }).waitFor()
      await page.getByRole('button', { name: '刷新模型目录' }).click()
      await page.getByText('已返回 6 个示例模型。').first().waitFor()
    }],
    ['03-safety.png', async () => {
      await page.getByRole('button', { name: /安全检查/ }).click()
      await page.getByRole('heading', { name: '安全检查' }).waitFor()
    }],
    ['04-activity.png', async () => {
      await page.getByRole('button', { name: /活动记录/ }).click()
      await page.getByRole('heading', { name: '活动记录' }).waitFor()
    }],
  ]

  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    source: 'browser-preview-mock with repository example data; no network calls to providers',
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    screenshots: [],
  }

  for (const [name, prepare] of captures) {
    await prepare()
    const filePath = join(versionDir, name)
    await page.screenshot({ path: filePath, fullPage: true })
    const bytes = await readFile(filePath)
    if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error(`${name} is not a PNG file`)
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    if (width !== 1440 || height < 900) throw new Error(`${name} has unexpected dimensions: ${width}x${height}`)
    manifest.screenshots.push({ name, width, height, sha256: createHash('sha256').update(bytes).digest('hex') })
  }

  if (consoleErrors.length > 0) throw new Error(`Screenshot capture produced console errors:\n${consoleErrors.join('\n')}`)
  await writeFile(join(versionDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ok: true, outputDir: versionDir, screenshots: manifest.screenshots }, null, 2))
} finally {
  await browser.close()
}
