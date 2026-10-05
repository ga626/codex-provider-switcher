import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { changeSet, identity, matchesPath, runChecks, saveReceipt } from './qa-runner.mjs'
const root = process.cwd()
const ci = process.argv.includes('--ci')
const baseArg = process.argv.findIndex(arg => arg === '--base')
const base = baseArg >= 0 ? process.argv[baseArg + 1] : process.env.QA_BASE_SHA
if (baseArg >= 0 && !base) throw new Error('--base 需要明确的 Git 基线。')
const manifest = JSON.parse(await readFile('src/features/qa/scenario-manifest.json', 'utf8'))
const files = await changeSet(base)
const broad = files.some(file => /^(src\/types.ts|src\/operations.ts|src-tauri\/src\/|scripts\/qa\/|\.github\/workflows\/|package)/.test(file))
const selected = manifest.filter(s => s.status === 'active' && (broad || s.impactPaths.some(p => files.some(f => matchesPath(f, p)))))
const selectedIds = selected.map(s => s.id)
const checks = [...(ci ? [] : ['lint', 'build']), 'qa:runner:test', 'qa:scenario:smoke',
  ...(selectedIds.includes('first-run-review') ? ['qa:first-run:test', 'qa:initialization-native', 'qa:initialization-stream'] : []),
  ...(selected.some(s => s.automation.includes('preview-ui')) ? ['qa:preview-smoke'] : []),
  ...(selectedIds.includes('daily-density') ? ['qa:boundary-native'] : []),
  ...(selectedIds.includes('controlled-live-validation') ? ['qa:safety-native'] : [])]
function execute(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run ' + script] : ['run', script], { windowsHide: true, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('exit ' + code)))
  })
}
const receipt = await runChecks(checks, execute, r => saveReceipt(join(root, '.codex/runtime/qa-receipts'), r), {
  ...await identity(), mode: ci ? 'ci' : 'local', base: base ?? 'working-tree', changedFiles: files, selectedScenarioIds: selectedIds,
  skipped: [...(ci ? ['lint/build 由 CI 专门步骤执行'] : []), ...manifest.filter(s => !selectedIds.includes(s.id)).map(s => s.id + '：改动未命中'), '真实账号、付费 API、真实 Codex 切换及安装未运行'],
  boundary: '模拟/副本合同通过不代表真实账号和服务商通过；用户体验确认另列。',
})
console.log(receipt.result + ' ' + receipt.runId + '：' + receipt.checks.map(c => c.name + '=' + c.result).join('；'))
if (receipt.result !== 'passed') process.exitCode = 1
