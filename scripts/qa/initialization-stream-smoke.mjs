import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(resolve('.codex/runtime'), 'initialization-stream-'))
const app = join(root, 'app-data'), codex = join(root, 'codex-home')
await mkdir(app); await mkdir(codex)
const port = 47847
const child = spawn(resolve('src-tauri/target/debug/local_backend.exe'), ['--port', String(port)], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL: 'development', CODEX_PROVIDER_SWITCHER_APP_DATA_DIR: app, CODEX_PROVIDER_SWITCHER_CODEX_HOME: codex },
})
let processError
child.on('error', error => { processError = error })
let stderr = ''
child.stdout.resume(); child.stderr.on('data', data => { stderr += data })
const base = `http://127.0.0.1:${port}`
let result = 'failed'
try {
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (processError) throw processError
    if (child.exitCode !== null) throw new Error(`隔离后端启动失败：${stderr}`)
    try {
      const health = await fetch(base + '/api/health')
      const identity = await health.json()
      if (health.ok && identity.pid !== child.pid) throw new Error('测试端口由其他进程占用；停止验证，不调用初始化。')
      ready = health.ok && identity.pid === child.pid
    } catch (error) {
      if (error.message?.includes('其他进程')) throw error
    }
    if (ready) break
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  assert.ok(ready, '隔离后端未就绪')
  async function initialize() {
    const response = await fetch(base + '/api/config/initialize-stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onboarding: true }) })
    assert.equal(response.status, 200); assert.ok(response.headers.get('content-type').includes('application/x-ndjson'))
    const lines = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    const events = lines.filter(line => line.step).map(line => line.step)
    assert.deepEqual(events.filter(step => step.status === 'running').map(step => step.index), [0,1,2,3,4,5,6,7,8])
    const report = lines.at(-1).report
    assert.equal(report.steps.length, 9); assert.equal(report.state.runtimeMode, 'local_web_backend')
    for (const step of report.steps) assert.ok(events.some(event => event.index === step.index && event.status === step.status), '最终结果必须有真实回执')
    return report
  }
  let report = await initialize(); assert.ok(report.canContinue)
  const original = 'broken=[\n'
  await writeFile(join(codex, 'config.toml'), original); await writeFile(join(codex, 'auth.json'), '[]')
  report = await initialize(); assert.equal(report.canContinue, false)
  assert.equal(report.steps[2].status, 'failure'); assert.equal(report.steps[3].status, 'failure'); assert.equal(report.steps[7].status, 'blocked')
  assert.equal(await readFile(join(codex, 'config.toml'), 'utf8'), original)
  assert.equal(await readFile(join(codex, 'auth.json'), 'utf8'), '[]')
  await writeFile(join(codex, 'config.toml'), "model_provider='openai'\nmodel_catalog_json='C:/fixture/missing.json'\n[mcp_servers.keep]\ncommand='keep'\n")
  await writeFile(join(codex, 'auth.json'), '{}')
  report = await initialize(); assert.ok(report.canContinue)
  const written = await readFile(join(codex, 'config.toml'), 'utf8')
  assert.ok(!written.includes('model_catalog_json')); assert.ok(written.includes("command='keep'"))
  result = 'passed'
  console.log(`真实 HTTP 逐项回执与失败汇总通过：${root}`)
} finally {
  child.kill()
  await writeFile(join(root, 'receipt.json'), JSON.stringify({ result, scope: '真实本地后端流式初始化、两项同时失败、所有步骤汇总、拒绝不安全写入、清理旧目录指针；无真实用户配置' }, null, 2))
}
