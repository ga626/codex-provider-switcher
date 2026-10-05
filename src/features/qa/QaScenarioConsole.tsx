import { AlertTriangle, XCircle, ArrowLeft, ArrowRight, ClipboardCheck, FlaskConical, LogIn, Maximize2, Play, PlugZap, RefreshCcw, ShieldCheck } from 'lucide-react'
import type { QaLiveValidationStatus } from '../../adapter'
import { scenarioById, type DailyQaScenarioId } from './scenarios'
import { FIRST_RUN_PREVIEW_GROUPS, type FirstRunResultPreview } from '../first-run/result-preview'
import { useEffect, useState } from 'react'
import { setQaNetworkCondition, type QaNetworkCondition } from '../../adapter'
import { QaEvidencePanel } from './QaEvidencePanel'
import { invoke } from '@tauri-apps/api/core'

export function QaControlRail({
  busy,
  firstRunActive,
  liveStatus,
  dailyScenario,
  operationPreview,
  onStartFirstRun,
  onMoveFirstRun,
  firstRunBlocked,
  resultPreview,
  onPreviewFirstRun,
  onLoadDaily,
  onCreateLiveSnapshot,
  onImportLiveSnapshot,
  onOpenLiveValidation,
  onLeaveLiveValidation,
  onClearLiveCopy,
  onPreview,
  onOpenOfficial,
  onOpenProviders,
  onOpenLab,
  currentView,
}: {
  busy: boolean
  firstRunActive: boolean
  liveStatus: QaLiveValidationStatus | null
  dailyScenario: DailyQaScenarioId | null
  operationPreview: string | null
  onStartFirstRun: () => void
  onMoveFirstRun: (direction: 'back' | 'next') => void
  firstRunBlocked: boolean
  resultPreview: FirstRunResultPreview | null
  onPreviewFirstRun: (kind: FirstRunResultPreview) => void
  onLoadDaily: (scenario: DailyQaScenarioId) => void
  onCreateLiveSnapshot: () => void
  onImportLiveSnapshot: () => void
  onOpenLiveValidation: () => void
  onLeaveLiveValidation: () => void
  onClearLiveCopy: () => void
  onPreview: (state: 'loading' | 'success' | 'error' | 'normal') => void
  onOpenOfficial: () => void
  onOpenProviders: () => void
  onOpenLab: () => void
  currentView: string
}) {
  const live = liveStatus?.mode === 'live-copy'
  const [condition, setCondition] = useState<QaNetworkCondition>('normal')
  const [conditionError, setConditionError] = useState('')
  useEffect(() => {
    const consumed = () => setCondition('normal')
    window.addEventListener('qa-condition-consumed', consumed)
    return () => window.removeEventListener('qa-condition-consumed', consumed)
  }, [])
  useEffect(() => { setCondition('normal') }, [dailyScenario])
  return <aside className="qa-control-rail" aria-label="开发版 QA 控制台">
    <header className="qa-control-header">
      <span className="qa-control-icon"><FlaskConical size={17} /></span>
      <div><strong>QA 控制台</strong><small>{live ? '真实资料副本 · 可能联网' : '模拟资料 · 不代表真实通过'}</small></div>
    </header>
    <div className="qa-control-sections">
      <section className="qa-control-section" aria-label="首次启动检查">
        <div className="qa-section-heading"><span>01</span><strong>首次启动检查</strong></div>
        <button className={`qa-section-primary${firstRunActive ? ' active' : ''}`} type="button" onClick={onStartFirstRun} disabled={busy || live}><Play size={15} />从第一页开始</button>
        <div className="qa-action-pair"><button type="button" onClick={() => onMoveFirstRun('back')} disabled={busy || !firstRunActive}><ArrowLeft size={14} />上一步</button><button type="button" onClick={() => onMoveFirstRun('next')} disabled={busy || !firstRunActive || firstRunBlocked}>下一步<ArrowRight size={14} /></button></div>
        <div className="qa-first-run-sample-actions" aria-label="首次启动结果模拟">
          {FIRST_RUN_PREVIEW_GROUPS.map(group => <button key={group.id} type="button" className={resultPreview === group.id && firstRunActive ? 'active' : ''} disabled={busy || live} onClick={() => onPreviewFirstRun(group.id)}>{group.id === 'blocked-all' ? <XCircle size={14} /> : <AlertTriangle size={14} />}{group.label}</button>)}
        </div>
      </section>

      <section className="qa-control-section" aria-label="日常检查">
        <div className="qa-section-heading"><span>02</span><strong>日常检查</strong></div>
        <button className={`qa-section-primary${dailyScenario === 'daily-baseline' ? ' active' : ''}`} type="button" onClick={() => onLoadDaily('daily-baseline')} disabled={busy || live}><FlaskConical size={15} />{scenarioById['daily-baseline'].action}</button>
        <button className={`qa-daily-action${dailyScenario === 'daily-density' ? ' active' : ''}`} type="button" onClick={() => onLoadDaily('daily-density')} disabled={busy || live}>
          <Maximize2 size={14} /><span><strong>{scenarioById['daily-density'].title}</strong><small>长文本、更多条目、窄窗口</small></span>
        </button>
        <button className={`qa-daily-action${dailyScenario === 'daily-operation-flow' ? ' active' : ''}`} type="button" onClick={() => onLoadDaily('daily-operation-flow')} disabled={busy || live}>
          <RefreshCcw size={14} /><span><strong>{scenarioById['daily-operation-flow'].title}</strong><small>{operationPreview ?? '只预览加载、成功与错误反馈'}</small></span>
        </button>
        {!live && dailyScenario === 'daily-operation-flow' && <div className="qa-preview-controls" aria-label="停住查看反馈">
          <p>只看外观，不执行操作。选中后保持，直到你切换。</p>
          <div className="qa-action-pair">{(['loading', 'success', 'error', 'normal'] as const).map((value, index) => <button type="button" key={value} onClick={() => onPreview(value)}>{['加载中', '成功提示', '错误提示', '结束预览'][index]}</button>)}</div>
        </div>}
        {!live && <details className="qa-conditions"><summary>下一次模型刷新</summary><p>仍点右侧原来的刷新按钮。只影响下一次；不是服务商实测。</p><label>响应条件<select aria-label="模型刷新响应条件" value={condition} disabled={busy} onChange={async event => { const value = event.target.value as QaNetworkCondition; try { await setQaNetworkCondition(value); setCondition(value); setConditionError('') } catch { setConditionError('当前状态不允许注入模拟条件。') } }}><option value="normal">正常</option><option value="slow">延迟 3 秒</option><option value="failure">连接失败一次</option></select></label><p role="status">{conditionError}</p></details>}
      </section>

      <section className="qa-control-section qa-live-section" aria-label="真实功能验证">
        <div className="qa-section-heading"><span>03</span><strong>真实功能验证</strong></div>
        {live ? <button className="qa-section-primary" type="button" disabled={busy} onClick={onLeaveLiveValidation}><ArrowLeft size={15} />返回模拟检查</button> : <button className="qa-section-primary" type="button" onClick={onCreateLiveSnapshot} disabled={busy || liveStatus?.inUse || !('__TAURI_INTERNALS__' in window)}><ShieldCheck size={15} />创建真实验证副本</button>}
        <p className="qa-live-status"><ClipboardCheck size={13} />{live ? '真实副本已就绪 · 原件不回写' : liveStatus?.inUse ? '真实副本正在使用' : liveStatus?.importReady ? '已有资料，可继续上次' : '进入前自动备份与校验'}</p>
        {live && <section className="qa-live-checks" aria-label="真实功能验证入口">
          <div><strong>进入副本后可验证</strong><small>每项都会调用真实流程，可能登录、联网或产生费用。</small></div>
          <button type="button" onClick={onOpenOfficial}><LogIn size={15} /><span><strong>官方账号登录</strong><small>验证 OAuth 登录、状态读取和退出</small></span></button>
          <button type="button" onClick={onOpenProviders}><PlugZap size={15} /><span><strong>服务商 / 官方 API</strong><small>验证新增、模型读取、测试和切换</small></span></button>
          <button type="button" onClick={onOpenLab}><FlaskConical size={15} /><span><strong>实验室真实调用</strong><small>验证请求探针、计费结果和记录</small></span></button>
        </section>}
        {live && <details><summary>隔离 Codex 测试目标</summary><p>让独立 Codex CLI 读取本副本。不会接管日常 Desktop，也不能证明桌面语音可用。退出真实模式前请先结束任务。</p><button className="qa-live-action" type="button" disabled={busy} onClick={async () => { if (!window.confirm('打开独立 Codex 终端，使用当前副本；你发送的任务可能真实计费。继续？')) return; try { setConditionError(await invoke<string>('qa_open_codex_target')) } catch (error) { setConditionError(String(error)) } }}>打开隔离 Codex</button><p role="status">{conditionError}</p></details>}
        {!live && <details><summary>继续与资料管理</summary>
          <button className="qa-live-action" type="button" onClick={() => { if (window.confirm('继续真实副本：登录和请求可能产生真实费用，不回写原件。继续？')) onOpenLiveValidation() }} disabled={busy || liveStatus?.inUse || !liveStatus?.importReady}>继续上次</button>
          <button className="qa-live-action" type="button" onClick={() => { if (window.confirm('从最近快照重建，当前副本保留但不再作为活动副本。继续？')) onImportLiveSnapshot() }} disabled={busy || liveStatus?.inUse || !liveStatus?.snapshotReady}>从备份重新开始</button>
          <button className="qa-live-action" type="button" onClick={() => { if (window.confirm('清空验证副本，无法撤销；加密快照和原件保留。继续？')) onClearLiveCopy() }} disabled={busy || liveStatus?.inUse || !('__TAURI_INTERNALS__' in window)}>清空验证副本</button>
        </details>}
        <details><summary>复制范围与清理说明</summary><p>复制选中连接环境的配置、文件认证、服务商和活动记录，不复制聊天历史、插件文件或系统密钥库。禁用外部认证助手；能唯一匹配服务商时，重建只读副本凭据的本软件助手。登录凭据只存副本文件。</p><p>清空只删除验证副本，加密快照保留；不回写原件。</p>{liveStatus?.includedFiles?.length ? <p>已包含：{liveStatus.includedFiles.join('、')}</p> : null}{liveStatus?.missingFiles?.length ? <p>未找到：{liveStatus.missingFiles.join('、')}</p> : null}<button type="button" disabled={busy || live || liveStatus?.inUse || !('__TAURI_INTERNALS__' in window)} onClick={async () => { if (!window.confirm('删除新版 QA 加密快照，无法撤销；原件与当前副本不删除。继续？')) return; try { await invoke('qa_clear_snapshots'); setConditionError('新版加密快照已删除。旧版快照未迁移，不会自动删除。') } catch { setConditionError('未完成清理，请先返回模拟检查后重试。') } }}>清理加密快照</button></details>
      </section>
      <QaEvidencePanel scenario={firstRunActive ? 'first-run-review' : dailyScenario ?? 'not-selected'} mode={live ? 'live-copy' : 'fixture'} view={currentView} />
    </div>
    <footer className="qa-control-footer">{busy ? <><Play size={13} />{operationPreview ? '外观预览中，可在左侧结束' : '产品操作进行中'}</> : live ? '副本内真实操作；原件不回写' : '普通样本不读取真实账号；备份须主动确认'}</footer>
  </aside>
}
