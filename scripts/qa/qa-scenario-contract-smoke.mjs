import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const requiredScenarioIds = ['first-run-review', 'daily-baseline', 'daily-density', 'daily-operation-flow', 'controlled-live-validation']

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function gitText(args, fallback) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, ...args], { windowsHide: true })
    return stdout.trim() || fallback
  } catch {
    return fallback
  }
}

const [manifestText, scenarios, qaConsole, app, adapter, native] = await Promise.all([
  readFile(join(root, 'src/features/qa/scenario-manifest.json'), 'utf8'),
  readFile(join(root, 'src/features/qa/scenarios.ts'), 'utf8'),
  readFile(join(root, 'src/features/qa/QaScenarioConsole.tsx'), 'utf8'),
  readFile(join(root, 'src/App.tsx'), 'utf8'),
  readFile(join(root, 'src/adapter.ts'), 'utf8'),
  readFile(join(root, 'src-tauri/src/lib.rs'), 'utf8'),
])
const manifest = JSON.parse(manifestText)

assert(Array.isArray(manifest), 'QA 场景清单必须是数组。')
const firstRun = manifest.find(item => item.id === 'first-run-review')
assert(firstRun?.automation.includes('initialization-native') && firstRun.automation.includes('initialization-stream') && firstRun.automation.includes('first-run-progress'), '首次启动必须覆盖真实原生任务、网页进度传输和前端队列行为。')
for (const id of requiredScenarioIds) {
  const scenario = manifest.find((item) => item.id === id)
  assert(scenario, `场景清单缺少 ${id}`)
  assert(scenario.status === 'active', `${id} 必须是启用场景。`)
  assert(Array.isArray(scenario.impactPaths) && scenario.impactPaths.length > 0, `${id} 必须声明受影响路径。`)
  assert(Array.isArray(scenario.automation) && scenario.automation.length > 0, `${id} 必须声明自动检查。`)
  assert(/^\d{4}-\d{2}-\d{2}$/.test(scenario.lastReviewed), `${id} 必须记录最近复核日期。`)
}
assert(manifest.find((item) => item.id === 'daily-density').impactPaths.some((path) => path.includes('providers') || path === 'src/features/**'), '边界排版场景必须覆盖服务商列表。')
const boundary = JSON.parse(await readFile(join(root, 'src/features/qa/boundary-fixture.json'), 'utf8'))
assert(boundary.profiles.length >= 18, '边界资料缺少服务商状态。')
assert(boundary.profiles.filter(p => p.verified).every(p => p.lastVerificationStage === 'inference'), '成功样本必须与完成推理的阶段一致。')
assert(new Set(boundary.profiles.map((item) => item.verificationStatus)).size >= 18, '边界资料应覆盖不同检查结果而非重复同一状态。')
assert(boundary.modelCatalogs.some((item) => item.models.length === 0) && boundary.modelCatalogs.some((item) => item.models.length >= 30), '目录必须同时覆盖空与多条目。')
assert(boundary.costCalibrations.length >= 12 && boundary.backupCount >= 10, '费用与恢复列表缺少滚动样本。')
assert(boundary.activity.every((item) => item.subject && item.stages.length && item.diagnostics.length), '活动样本必须进入诊断详情，不仅是摘要。')
assert(native.includes('include_str!("../../src/features/qa/boundary-fixture.json")'), '桌面必须消费共享边界资料。')
assert(manifest.find((item) => item.id === 'daily-density').automation.includes('preview-ui'), '边界排版场景必须要求界面检查。')
assert(scenarios.includes("import scenarioManifest from './scenario-manifest.json'"), '场景类型必须从清单读取。')
assert(scenarios.includes('export const QA_SCENARIOS = scenarioManifest'), '场景清单必须是唯一来源。')
assert(qaConsole.includes('scenarioById'), 'QA 控制台必须读取场景清单。')
assert(native.includes('"first-run-review"') && native.includes('"daily-baseline"') && native.includes('"daily-density"') && native.includes('"daily-operation-flow"'), '原生重置白名单必须覆盖首次启动和三种隔离日常样本。')
assert(native.includes('fn qa_create_live_validation_snapshot()'), '真实验证必须先创建本机资料的保护快照。')
assert(native.includes('fn qa_import_live_validation_snapshot()'), '真实验证必须把导入副本与原始资料分开。')
assert(native.includes('fn qa_clear_live_validation_copy()'), '真实验证必须能清空验证副本。')
assert(app.includes('const qaControlRail = isDevelopmentBuild ? <QaControlRail'), 'QA 控制台没有被 development build 限制。')
assert(app.includes('playQaFeedbackPreview'), '状态反馈预览必须驱动明确标记的开发板状态。')
assert(!app.includes('qa-launcher'), 'QA 控制台不得插入产品顶部菜单。')
assert(!app.includes('操作流程演示已完成'), '状态预览不得伪装成真实操作流程完成。')
assert(app.includes('createQaLiveValidationSnapshot'), '真实验证控制面必须调用实际快照流程。')
assert(app.includes('importQaLiveValidationSnapshot'), '真实验证控制面必须调用实际导入流程。')
assert(qaConsole.includes('创建真实验证副本') && app.includes("action === 'enter'"), '真实入口必须创建隔离副本。')
assert(qaConsole.includes('官方账号登录') && qaConsole.includes('服务商 / 官方 API') && qaConsole.includes('实验室真实调用'), '真实功能验证必须提供三类核心功能入口。')
assert(app.includes('showQaRuntime') && app.includes('leaveQaLiveValidation'), '真实模式须刷新当前产品界面并能返回。')
assert(!app.includes('getCurrentWindow().hide()') && !qaConsole.includes('getCurrentWindow().close()'), '模式切换不得隐藏或关闭当前产品窗口。')
assert(qaConsole.includes('真实副本已就绪') && qaConsole.includes('qa_open_codex_target'), '真实副本必须说明目标边界并提供显式隔离目标入口。')
assert(!adapter.includes('是否继续？`)) throw new Error(\'已取消真实验证'), '普通真实操作不得重复弹 QA 确认。')
assert(adapter.includes("invoke<AppState>('qa_reset_scenario', { scenarioId })"), '前端没有调用受保护的 QA 重置命令。')
assert(native.includes('is_development_release_channel()'), '原生 QA 重置没有 development build 守卫。')
assert(native.includes('starts_with(&runtime_root)'), '原生 QA 重置没有隔离 runtime 路径守卫。')
assert(!manifestText.includes('OPENAI_API_KEY'), 'QA 场景清单不得包含 OpenAI 密钥字段。')
assert(!manifestText.includes('auth.json'), 'QA 场景清单不得包含认证文件内容。')
assert(!qaConsole.includes('onOpenDailyView'), '日常检查不得退化成产品页面的快捷导航。')

const sha = await gitText(['rev-parse', '--short=8', 'HEAD'], 'unknown')
const dirty = (await gitText(['status', '--porcelain'], '')).length > 0
const receipt = {
  kind: 'qa-scenario-contract-smoke/v2',
  generatedAt: new Date().toISOString(),
  sourceRevision: dirty ? `${sha}-dirty` : sha,
  runtimeBoundary: '.codex/runtime only',
  scenarios: requiredScenarioIds,
  assertions: ['single scenario manifest', 'development-only launcher', 'native development-only reset', 'runtime path confinement', 'feedback preview is not an operation proof', 'credential-free QA catalogue', 'scoped live feature entry points'],
  result: 'passed',
}
const receiptDir = join(root, '.codex', 'runtime', 'qa-receipts')
await mkdir(receiptDir, { recursive: true })
const receiptPath = join(receiptDir, 'latest-qa-scenario-contract-smoke.json')
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
console.log(`[PASS] QA 场景合同检查通过。回执：${receiptPath}`)
