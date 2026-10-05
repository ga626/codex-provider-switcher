import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'

const runtime = resolve('.codex/runtime')
await mkdir(runtime, { recursive: true })
const root = await mkdtemp(join(runtime, 'initialization-test-'))
const app = join(root, 'app-data')
const codex = join(root, 'codex-home')
await mkdir(app)
await mkdir(codex)
const code = await new Promise((resolveCode, reject) => {
  const child = spawn('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', 'initialization_transaction_roundtrip', '--', '--ignored', '--test-threads=1'], {
    windowsHide: true, stdio: 'inherit', env: { ...process.env, CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL: 'development', CODEX_PROVIDER_SWITCHER_APP_DATA_DIR: app, CODEX_PROVIDER_SWITCHER_CODEX_HOME: codex },
  })
  child.on('error', reject)
  child.on('exit', resolveCode)
})
await writeFile(join(root, 'receipt.json'), JSON.stringify({ result: code === 0 ? 'passed' : 'failed', code, scope: '隔离初始化、健康备份、损坏备份替换、中断恢复、两项同时失败、模型目录失败降级及重试、损坏目录预览路径稳定、verified 事务不回滚、OAuth 保留、提交后状态读取失败；不操作真实 Codex' }, null, 2))
if (code !== 0) process.exit(code ?? 1)
console.log(`初始化原生回归通过：${root}`)
