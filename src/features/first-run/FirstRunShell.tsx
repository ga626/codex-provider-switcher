import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  GitCompareArrows,
  PlugZap,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { AppState, InitializationReport, InitializationStep, ValidationCheck } from '../../types'
import { PREPARATION_TASKS, PREPARATION_INTERVAL_MS } from './progress'

export type FirstRunPhase = 'consent' | 'preparing' | 'review' | 'ready' | 'failed'

const FIRST_RUN_FEED = PREPARATION_TASKS.map(([, title, detail]) => ({ title, detail }))

export const FIRST_RUN_STEP_COUNT = FIRST_RUN_FEED.length
// Keep the flow readable without making a short local check feel stalled.
export const FIRST_RUN_STEP_INTERVAL_MS = PREPARATION_INTERVAL_MS

function getCheckVisual(check: { ok: boolean; severity: 'required' | 'warning' | 'info' }) {
  if (check.ok) return { icon: <CheckCircle2 size={16} />, className: 'ok' }
  if (check.severity === 'warning' || check.severity === 'info') {
    return { icon: <AlertTriangle size={16} />, className: 'warning' }
  }
  return { icon: <XCircle size={16} />, className: 'danger' }
}

export function FirstRunShell({
  environment,
  phase,
  activeStep,
  taskResults = [],
  report = null,
  checks,
  error,
  busy,
  previewOnly = false,
  resultPreview = null,
  onPrepare,
  onContinue,
  onBack,
  onEnter,
}: {
  environment: AppState['connectionEnvironment']
  phase: FirstRunPhase
  activeStep: number
  taskResults?: Array<InitializationStep | undefined>
  report?: InitializationReport | null
  checks: ValidationCheck[]
  error: string | null
  busy: boolean
  previewOnly?: boolean
  resultPreview?: string | null
  onPrepare: () => void
  onContinue: () => void
  onBack: (target: 'setup' | 'review') => void
  onEnter: () => void
}) {
  const selectedLayer = environment.layers.find((layer) => layer.id === 'user-config') ?? environment.layers[0]
  const activePreparationIndex = Math.min(activeStep, FIRST_RUN_FEED.length - 1)
  const progress = phase === 'ready' || phase === 'review' ? 100 : phase === 'preparing' ? Math.min(96, Math.max(4, Math.round(((activePreparationIndex + 1) / FIRST_RUN_FEED.length) * 100))) : 0
  const showSetup = phase === 'consent' || phase === 'failed'
  const activePreparation = FIRST_RUN_FEED[activePreparationIndex]
  const preparationListRef = useRef<HTMLDivElement>(null)
  // A provider model and endpoint do not exist until the user adds a provider.
  // Keep them in the normal workspace audit, but do not misrepresent them as
  // incomplete connection-environment preparation on first launch.
  const environmentChecks = checks.filter((check) => check.id !== 'root-model' && check.id !== 'custom-base-url')
  const passedChecks = environmentChecks.filter((check) => check.ok).length
  const orderedChecks = [...environmentChecks].sort((left, right) => Number(left.ok) - Number(right.ok))
  const redSteps = report?.steps.filter(step => step.status === 'failure' || step.status === 'blocked') ?? []
  const orangeSteps = report?.steps.filter(step => step.status === 'warning') ?? []
  // Any unresolved item keeps the user in initialization. Warnings are useful
  // for explaining the kind of fallback, but they are not a safe entry state.
  const blocked = report ? !report.canContinue || redSteps.length > 0 || orangeSteps.length > 0 : false

  useEffect(() => {
    if (phase !== 'preparing') return
    const list = preparationListRef.current
    const activeRow = list?.children.item(activePreparationIndex)
    if (!(list && activeRow instanceof HTMLElement)) return
    // Start at the top, append new checks downward, then scroll only after the
    // viewport fills. Reserve one complete row for the next check so the
    // current item is never clipped at the bottom edge.
    const nextRowSpace = activePreparationIndex < FIRST_RUN_FEED.length - 1 ? 64 : 0
    const top = activeRow.offsetTop - list.offsetTop - (list.clientHeight - activeRow.offsetHeight - nextRowSpace)
    list.scrollTo({
      top: Math.max(0, top),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }, [activePreparationIndex, phase])

  return (
    <main className="first-run-shell">
      <section className={`first-run-card ${phase}`} aria-live="polite">
        <div className="first-run-brand"><span className="brand-mark"><GitCompareArrows size={20} /></span><span>Signalman AI</span></div>
        {showSetup && <>
          <div className="first-run-heading">
            <span className="first-run-kicker">第一次打开</span>
            <h1>先初始化 Signalman</h1>
            <p>Signalman AI 会先备份旧连接，再建立固定身份，让不同服务商可以稳定切换。</p>
          </div>
          <div className="first-run-impact" aria-label="准备连接环境会做什么">
            <div><ShieldCheck size={17} /><span>先创建一个可恢复的备份</span></div>
            <div><CheckCircle2 size={17} /><span>清理旧的官方/中转站身份冲突，固定使用 custom</span></div>
            <div><CheckCircle2 size={17} /><span>聊天历史、项目、MCP 和插件不会被删除</span></div>
          </div>
          <details className="first-run-details">
            <summary>查看具体会改什么</summary>
            <p>只在这台电脑上接管 Codex 连接配置：先备份旧配置和认证，再重建固定 custom 身份，写入后回读确认。不会上传配置、密钥或其他本机文件，也不会删除项目、插件、MCP 或聊天历史。</p>
          </details>
          {environment.layers.length === 0 && <p className="first-run-inline-error">{environment.detail}可以开始检查，获取具体原因；无法安全写入时会保留原件。</p>}
          {error && <div className="first-run-error"><XCircle size={17} /><span>{error}</span></div>}
          <div className="first-run-actions"><button className="primary-button first-run-primary" type="button" disabled={busy} onClick={onPrepare} data-dialog-initial-focus><ShieldCheck size={17} />{phase === 'failed' ? '重新初始化' : '开始初始化'}</button></div>
        </>}
        {phase === 'preparing' && <div className="first-run-progress-card">
          <div className="first-run-progress-heading">
            <div className="first-run-progress-icon"><RefreshCcw className="spin" size={20} /></div>
            <div className="first-run-heading"><span className="first-run-kicker">正在初始化</span><h1>建立固定连接身份</h1><p>Signalman 正在检查、备份并写入结果，请稍等片刻。</p></div>
          </div>
          <div className="first-run-progress-meta"><span>准备事项 {activePreparationIndex + 1} / {FIRST_RUN_FEED.length}</span><strong>结果待确认</strong></div>
          <div className="first-run-progress-track" role="progressbar" aria-label="准备事项展示进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ transform: `scaleX(${progress / 100})` }} /></div>
          <div ref={preparationListRef} className="first-run-step-list" aria-label="准备过程" role="list">
            {FIRST_RUN_FEED.slice(0, activePreparationIndex + 2).map((step, index) => <div className={`first-run-step ${index < activePreparationIndex ? `seen ${taskResults[index]?.status ?? ''}` : index === activePreparationIndex ? 'active' : ''}`} aria-current={index === activePreparationIndex ? 'step' : undefined} role="listitem" key={step.title}>
              <span className="first-run-step-marker">{index < activePreparationIndex && !previewOnly ? taskResults[index]?.status === 'success' ? <CheckCircle2 size={16} /> : taskResults[index]?.status === 'warning' ? <AlertTriangle size={16} /> : <XCircle size={16} /> : <span className="first-run-step-dot" />}</span>
              <span className="first-run-step-copy"><strong>{step.title}</strong><small>{step.detail}</small></span>
              <span className="first-run-step-state">{index < activePreparationIndex ? previewOnly ? '示例' : taskResults[index]?.status === 'success' ? '通过' : taskResults[index]?.status === 'warning' ? '已降级' : taskResults[index]?.status === 'blocked' ? '未执行' : '需处理' : index === activePreparationIndex ? '正在检查' : '待检查'}</span>
            </div>)}
          </div>
          <p className="first-run-live-line" aria-live="polite"><span className="first-run-live-dot" /><span><strong>当前事项</strong>{activePreparation.title} · {activePreparation.detail}</span></p>
          <p className="first-run-safety-note">不会上传配置或密钥。先备份再写入；发现问题会说明恢复结果。</p>
        </div>}
        {phase === 'review' && <div className="first-run-review">
          <div className="first-run-complete-heading">
            <div className={`first-run-review-icon ${blocked ? 'danger' : orangeSteps.length ? 'warning' : ''}`}>{previewOnly ? <CircleHelp size={21} /> : blocked ? <XCircle size={21} /> : orangeSteps.length ? <AlertTriangle size={21} /> : <CheckCircle2 size={21} />}</div>
            <div><span className="first-run-kicker">{previewOnly ? '开发预览' : '检查结束'}</span><h1>{previewOnly ? '检查结果示例' : blocked ? '还有问题，暂时不能进入' : '连接身份已经固定'}</h1></div>
          </div>
          <p className="first-run-complete-intro">{previewOnly ? '这里是检查界面的预览。' : blocked ? 'Signalman 还不能确认连接环境是安全、完整的，所以不会让你进入软件。请按下面的说明处理后，再点“重新检查”。' : '连接环境已经检查完，可以进入软件。'}</p>
          {error && <div className="first-run-error"><XCircle size={17} /><span>{error}</span></div>}
          <div className="first-run-review-summary">{previewOnly ? <><strong>检查结果预览</strong><span>用于查看各种情况会怎样显示。</span></> : report ? <><strong>{report.steps.filter(step => step.status === 'success').length} 项通过 · {orangeSteps.length} 项需要重试 · {redSteps.length} 项无法继续</strong><span>{blocked ? '先把下面的问题处理完，再重新检查。' : '全部通过，可以进入软件。'}</span></> : <><strong>{passedChecks}/{environmentChecks.length} 项检查通过</strong><span>当前连接环境检查结果如下。</span></>}</div>
          <div className="first-run-review-list" aria-label="检查结果">
            {report?.steps.map(step => {
              const visual = previewOnly ? { icon: <CircleHelp size={16} />, className: 'info' } : step.status === 'success' ? getCheckVisual({ ok: true, severity: 'required' }) : getCheckVisual({ ok: false, severity: step.status === 'warning' ? 'warning' : 'required' })
              return <div className={`first-run-review-row ${visual.className}`} key={step.id}>
                {visual.icon}<span><strong>{step.label}</strong>{step.status === 'success' ? <small>{step.detail}</small> : <details open={resultPreview ? true : undefined}><summary>查看原因与处理方式</summary><small>{step.detail}</small><p>{step.action}</p></details>}</span>
                <em>{previewOnly ? '示例' : step.status === 'success' ? '通过' : step.status === 'warning' ? '已降级' : step.status === 'blocked' ? '未执行' : '需处理'}</em>
              </div>
            })}
            {!report && orderedChecks.map((check) => {
              const visual = previewOnly ? { icon: <CircleHelp size={16} />, className: 'info' } : getCheckVisual(check)
              return <div className={`first-run-review-row ${visual.className}`} key={check.id}>
                {visual.icon}<span><strong>{check.label}</strong><small>{check.detail}</small></span>
                <em>{previewOnly ? '示例' : check.ok ? '通过' : check.severity === 'required' ? '需处理' : '待配置'}</em>
              </div>
            })}
          </div>
          <div className="first-run-complete-actions"><button className="ghost-button" type="button" onClick={() => onBack('setup')}><RotateCcw size={16} />上一步</button>{blocked && <button className="ghost-button" type="button" disabled={busy} onClick={onPrepare}><RefreshCcw size={16} />重新检查</button>}{!blocked && <button className="primary-button first-run-primary" type="button" disabled={busy} onClick={onContinue} data-dialog-initial-focus><ChevronDown size={17} />进入软件</button>}</div>
        </div>}
        {phase === 'ready' && <div className="first-run-complete">
          <div className="first-run-complete-heading">
            <div className="first-run-complete-icon">{previewOnly ? <CircleHelp size={22} /> : <CheckCircle2 size={22} />}</div>
            <div><span className="first-run-kicker">{previewOnly || resultPreview ? '开发预览' : '可以开始了'}</span><h1>{previewOnly || resultPreview ? '首次启动界面示例' : '连接环境已准备好'}</h1></div>
          </div>
          <p className="first-run-complete-intro">{previewOnly || resultPreview ? '隔离样本不代表这台电脑已经完成初始化。' : 'Signalman AI 会帮你管理多个 AI 服务商，在切换前检查连接，并在本机保留可恢复的配置。'}</p>
          <div className="first-run-complete-summary">
            {previewOnly || resultPreview ? <div><CircleHelp size={16} /><span><strong>仅供界面检查</strong><small>本机配置与备份状态尚未验证</small></span></div> : <>
              <div><CheckCircle2 size={16} /><span><strong>固定身份已建立</strong><small>{selectedLayer?.label ?? '当前 Codex 配置'}已完成接管</small></span></div>
              <div><CheckCircle2 size={16} /><span><strong>旧连接已备份</strong><small>原有设置可以从恢复入口找回</small></span></div>
              <div><CheckCircle2 size={16} /><span><strong>可以添加服务商</strong><small>现在进入工作台开始配置</small></span></div>
            </>}
          </div>
          <div className="first-run-complete-actions"><button className="ghost-button" type="button" onClick={() => onBack('review')}><RotateCcw size={16} />上一步</button><button className="primary-button first-run-primary" type="button" onClick={onEnter} data-dialog-initial-focus><PlugZap size={17} />进入 Signalman</button></div>
        </div>}
      </section>
      <p className="first-run-footer">本地优先 · 配置只保存在此设备</p>
    </main>
  )
}
