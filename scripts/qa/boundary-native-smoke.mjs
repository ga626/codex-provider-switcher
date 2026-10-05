import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'

// 每次使用全新隔离目录；测试拒绝非空资料，不删除旧回执。
const runtime = resolve('.codex/runtime')
await mkdir(runtime, { recursive: true })
const root = await mkdtemp(join(runtime, 'boundary-test-'))
const app = join(root, 'app-data')
const codex = join(root, 'codex-home')
await mkdir(app)
await mkdir(codex)
const code = await new Promise((resolveCode, reject) => {
  const child = spawn('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', 'boundary_fixture_roundtrip', '--', '--ignored', '--test-threads=1'], { windowsHide: true, stdio: 'inherit', env: { ...process.env, CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL: 'development', CODEX_PROVIDER_SWITCHER_APP_DATA_DIR: app, CODEX_PROVIDER_SWITCHER_CODEX_HOME: codex } })
  child.on('error', reject)
  child.on('exit', resolveCode)
})
await writeFile(join(root, 'receipt.json'), JSON.stringify({ result: code === 0 ? 'passed' : 'failed', root, code, scope: '原生隔离样本写入、真实 load_state 回读和恢复点完整性；不证明真实账号或 API 可用' }, null, 2))
if (code !== 0) process.exit(code ?? 1)
console.log(`原生边界回读通过：${root}`)
