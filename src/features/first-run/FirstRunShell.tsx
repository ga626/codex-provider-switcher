import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  GitCompareArrows,
  PlugZap,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AppState, ValidationCheck } from '../../types'

export type FirstRunPhase = 'consent' | 'preparing' | 'review' | 'ready' | 'failed'

const FIRST_RUN_FEED = [
  { title: '读取配置位置', detail: '确认当前电脑上要管理的 Codex 配置层' },
  { title: '检查配置文件', detail: '确认配置文件可以读取，避免覆盖未知内容' },
  { title: '解析 TOML 语法', detail: '检查配置结构是否能被 Codex 正常解析' },
  { title: '确认根模型', detail: '确认 Codex 有可用的默认模型入口' },
  { title: '确认服务商入口', detail: '检查 custom 服务商分组是否存在且可定位' },
  { title: '确认 Responses 线路', detail: '确认切换器使用 Codex 兼容的请求协议' },
  { title: '检查认证方式', detail: '确认不会覆盖密钥或其他登录信息' },
  { title: '创建恢复点', detail: '先保存原始配置，出现问题可以完整撤回' },
  { title: '写入连接设置', detail: '只补齐 Signalman 管理范围内的连接字段' },
  { title: '回读写入结果', detail: '重新读取刚刚写入的内容，确认没有写坏' },
  { title: '复核保护范围', detail: '确认项目、MCP、插件和历史记录没有被改动' },
  { title: '生成检查摘要', detail: '整理成你接下来可以查看的结果清单' },
] as const

export const FIRST_RUN_STEP_COUNT = FIRST_RUN_FEED.length

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
  checks,
  error,
  busy,
  onPrepare,
  onContinue,
  onBack,
  onEnter,
}: {
  environment: AppState['connectionEnvironment']
  phase: FirstRunPhase
  activeStep: number
  checks: ValidationCheck[]
  error: string | null
  busy: boolean
  onPrepare: (layerId: string) => void
  onContinue: () => void
  onBack: (target: 'setup' | 'review') => void
  onEnter: () => void
}) {
  const [consented, setConsented] = useState(false)
  const [layerId, setLayerId] = useState(environment.selectedLayerId ?? environment.layers[0]?.id ?? '')
  const selectedLayer = environment.layers.find((layer) => layer.id === layerId)
  const progress = phase === 'ready' || phase === 'review' ? 100 : phase === 'preparing' ? Math.min(96, Math.max(4, Math.round((activeStep / FIRST_RUN_FEED.length) * 100))) : 0
  const showSetup = phase === 'consent' || phase === 'failed'
  const activePreparation = FIRST_RUN_FEED[Math.min(activeStep, FIRST_RUN_FEED.length - 1)]
  const preparationListRef = useRef<HTMLDivElement>(null)
  // A provider model and endpoint do not exist until the user adds a provider.
  // Keep them in the normal workspace audit, but do not misrepresent them as
  // incomplete connection-environment preparation on first launch.
  const environmentChecks = checks.filter((check) => check.id !== 'root-model' && check.id !== 'custom-base-url')
  const passedChecks = environmentChecks.filter((check) => check.ok).length
  const orderedChecks = [...environmentChecks].sort((left, right) => Number(left.ok) - Number(right.ok))

  useEffect(() => {
    if (phase !== 'preparing') return
    const list = preparationListRef.current
    const activeRow = list?.children.item(Math.min(activeStep, FIRST_RUN_FEED.length - 1))
    if (activeRow instanceof HTMLElement) activeRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [activeStep, phase])

  useEffect(() => {
    if (!layerId && environment.layers[0]) setLayerId(environment.layers[0].id)
  }, [environment.layers, layerId])

  return (
    <main className="first-run-shell">
      <section className={`first-run-card ${phase}`} aria-live="polite">
        <div className="first-run-brand"><span className="brand-mark"><GitCompareArrows size={20} /></span><span>Signalman AI</span></div>
        {showSetup && <>
          <div className="first-run-heading">
            <span className="first-run-kicker">第一次打开</span>
            <h1>先把连接环境准备好</h1>
            <p>Signalman AI 帮你管理多个 AI 服务商，在切换前检查连接并保留恢复点。</p>
          </div>
          <div className="first-run-impact" aria-label="准备连接环境会做什么">
            <div><ShieldCheck size={17} /><span>先创建一个可恢复的备份</span></div>
            <div><CheckCircle2 size={17} /><span>只统一 Signalman 管理的连接设置</span></div>
            <div><CheckCircle2 size={17} /><span>项目、MCP、插件和历史记录不会被改动</span></div>
          </div>
          <details className="first-run-details">
            <summary>查看具体会改什么</summary>
            <p>只在这台电脑上整理服务商连接需要的 Codex 设置，先备份、写入后再回读确认。不会上传配置、密钥或其他本机文件，也不会读取或改动项目、插件、MCP 和历史记录。</p>
          </details>
          {environment.layers.length > 1 && <label className="first-run-layer-select">选择要管理的配置层<select value={layerId} onChange={(event) => setLayerId(event.target.value)}>{environment.layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.label}</option>)}</select></label>}
          {environment.layers.length === 0 && <p className="first-run-inline-error">没有找到可管理的 Codex 配置层。</p>}
          {error && <div className="first-run-error"><XCircle size={17} /><span>{error}</span></div>}
          <label className="first-run-consent"><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} />我已了解：程序会先备份，再准备连接环境</label>
          <div className="first-run-actions"><button className="primary-button first-run-primary" type="button" disabled={!consented || !layerId || busy} onClick={() => onPrepare(layerId)} data-dialog-initial-focus><ShieldCheck size={17} />{phase === 'failed' ? '重新准备连接环境' : '准备连接环境'}</button></div>
        </>}
        {phase === 'preparing' && <div className="first-run-progress-card">
          <div className="first-run-progress-heading">
            <div className="first-run-progress-icon"><RefreshCcw className="spin" size={20} /></div>
            <div className="first-run-heading"><span className="first-run-kicker">正在准备</span><h1>把连接环境整理好</h1><p>Signalman 正在逐项检查并保存结果，请稍等片刻。</p></div>
          </div>
          <div className="first-run-progress-meta"><span>准备进度</span><strong>{progress}%</strong></div>
          <div className="first-run-progress-track" role="progressbar" aria-label="准备连接环境进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div ref={preparationListRef} className="first-run-step-list" aria-label="准备过程">
            {FIRST_RUN_FEED.map((step, index) => <div className={`first-run-step ${index < activeStep ? 'done' : index === activeStep ? 'active' : ''}`} key={step.title}>
              <span className="first-run-step-marker">{index < activeStep ? <CheckCircle2 size={15} /> : index === activeStep ? <RefreshCcw className="spin" size={15} /> : <span className="first-run-step-dot" />}</span>
              <span className="first-run-step-copy"><strong>{step.title}</strong><small>{step.detail}</small></span>
              <span className="first-run-step-state">{index < activeStep ? '已完成' : index === activeStep ? '进行中' : '等待'}</span>
            </div>)}
          </div>
          <p className="first-run-live-line" aria-live="polite"><span className="first-run-live-dot" />{activePreparation.detail}</p>
          <p className="first-run-safety-note">不会上传配置或密钥。遇到问题会恢复原文件。</p>
        </div>}
        {phase === 'review' && <div className="first-run-review">
          <div className="first-run-complete-heading">
            <div className="first-run-review-icon"><CheckCircle2 size={21} /></div>
            <div><span className="first-run-kicker">检查完成</span><h1>连接环境检查完毕</h1></div>
          </div>
          <p className="first-run-complete-intro">后台已经完成真实检查和配置准备。先看一眼结果，确认后再继续下一步。</p>
          <div className="first-run-review-summary"><strong>{passedChecks}/{environmentChecks.length || 0} 项检查通过</strong><span>{environmentChecks.length - passedChecks > 0 ? `${environmentChecks.length - passedChecks} 项待配置，不影响继续使用。` : '全部通过。'}恢复点已创建。</span></div>
          <div className="first-run-review-list" aria-label="检查结果">
            {environmentChecks.length === 0 && <div className="first-run-review-empty">已完成连接环境准备，当前没有需要展示的额外检查项。</div>}
            {orderedChecks.map((check) => {
              const visual = getCheckVisual(check)
              return <div className={`first-run-review-row ${visual.className}`} key={check.id}>
                {visual.icon}<span><strong>{check.label}</strong><small>{check.detail}</small></span>
                <em>{check.ok ? '通过' : check.severity === 'required' ? '需处理' : '待配置'}</em>
              </div>
            })}
          </div>
          <div className="first-run-complete-actions"><button className="ghost-button" type="button" onClick={() => onBack('setup')}><RotateCcw size={16} />上一步</button><button className="primary-button first-run-primary" type="button" onClick={onContinue} data-dialog-initial-focus><ChevronDown size={17} />下一步</button></div>
        </div>}
        {phase === 'ready' && <div className="first-run-complete">
          <div className="first-run-complete-heading">
            <div className="first-run-complete-icon"><CheckCircle2 size={22} /></div>
            <div><span className="first-run-kicker">可以开始了</span><h1>连接环境已准备好</h1></div>
          </div>
          <p className="first-run-complete-intro">Signalman AI 会帮你管理多个 AI 服务商，在切换前检查连接，并在本机保留可恢复的配置。</p>
          <div className="first-run-complete-summary">
            <div><CheckCircle2 size={16} /><span><strong>配置已就绪</strong><small>{selectedLayer?.label ?? '当前 Codex 配置'}已完成准备</small></span></div>
            <div><CheckCircle2 size={16} /><span><strong>恢复点已创建</strong><small>原有设置可以随时恢复</small></span></div>
            <div><CheckCircle2 size={16} /><span><strong>可以添加服务商</strong><small>现在进入工作台开始配置</small></span></div>
          </div>
          <div className="first-run-complete-actions"><button className="ghost-button" type="button" onClick={() => onBack('review')}><RotateCcw size={16} />上一步</button><button className="primary-button first-run-primary" type="button" onClick={onEnter} data-dialog-initial-focus><PlugZap size={17} />进入 Signalman</button></div>
        </div>}
      </section>
      <p className="first-run-footer">本地优先 · 配置只保存在此设备</p>
    </main>
  )
}
