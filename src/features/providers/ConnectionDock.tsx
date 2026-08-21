import { Activity, AlertTriangle, CheckCircle2, CircleHelp, PlugZap, ShieldCheck, XCircle } from 'lucide-react'
import type { AppState, ModelCatalog, ProviderProfile, ValidationCheck } from '../../types'
import { providerModelLabel } from './model-utils'

function getCheckVisual(check: { ok: boolean; severity: 'required' | 'warning' | 'info' }) {
  if (check.ok) return { icon: <CheckCircle2 size={14} />, className: 'ok' }
  if (check.severity === 'warning' || check.severity === 'info') return { icon: <AlertTriangle size={14} />, className: 'warning' }
  return { icon: <XCircle size={14} />, className: 'danger' }
}

export function ConnectionDock({
  profile,
  catalog,
  environment,
  hasUnsavedChanges,
  requiredFailures,
  riskCount,
  busy,
  canSwitch,
  preview,
  onSave,
  onRefreshModels,
  onVerify,
  onSwitch,
  onOpenSetup,
  onOpenGuide,
  availabilityChecks,
  profileConfigChecks,
  configChecks,
}: {
  profile: ProviderProfile | undefined
  catalog: ModelCatalog | undefined
  environment: AppState['connectionEnvironment']
  hasUnsavedChanges: boolean
  requiredFailures: number
  riskCount: number
  busy: string | null
  canSwitch: boolean
  preview: boolean
  onSave: () => void
  onRefreshModels: () => void
  onVerify: () => void
  onSwitch: () => void
  onOpenSetup: () => void
  onOpenGuide: () => void
  availabilityChecks: ValidationCheck[]
  profileConfigChecks: ValidationCheck[]
  configChecks: ValidationCheck[]
}) {
  const isCurrent = Boolean(profile?.active)
  const environmentReady = environment.status === 'ready'
  const modelReady = Boolean(profile?.model)
  const testAction = !environmentReady
    ? { label: '运行可用性测试', disabled: true, onClick: onVerify }
    : !profile
      ? { label: '运行可用性测试', disabled: true, onClick: onVerify }
      : hasUnsavedChanges
        ? { label: '请先保存配置', disabled: true, onClick: onSave }
        : !modelReady
          ? { label: '请先选择默认模型', disabled: true, onClick: onRefreshModels }
          : { label: '运行可用性测试', disabled: busy !== null || preview, onClick: onVerify }
  const switchAction = !environmentReady
    ? { label: '检查并切换', disabled: true, onClick: onSwitch }
    : !profile
      ? { label: '检查并切换', disabled: true, onClick: onSwitch }
      : hasUnsavedChanges
        ? { label: '保存配置后切换', disabled: true, onClick: onSave }
        : !modelReady
          ? { label: '选择模型后切换', disabled: true, onClick: onRefreshModels }
          : isCurrent
            ? { label: '当前正在使用', disabled: true, onClick: onSwitch }
            : { label: '检查并切换', disabled: !canSwitch, onClick: onSwitch }
  const availability = !profile ? '未选择' : profile.verificationStatus === 'not_checked' ? '尚未检查' : profile.verified ? '已通过' : '需要留意'
  const renderChecks = (title: string, checks: ValidationCheck[]) => <section className="dock-check-group"><h4>{title}</h4><div className="dock-check-list">{checks.map((check) => { const visual = getCheckVisual(check); return <div className={`dock-check-row ${visual.className}`} key={check.id}>{visual.icon}<div><strong>{check.label}</strong><span>{check.detail}</span></div></div> })}</div></section>
  return <aside id="connection-dock" className="connection-dock scroll-region" aria-label="连接与切换" data-tour="connection-dock">
    <div className="connection-dock-heading"><div><span>连接与切换</span><strong>{profile?.name ?? '未选择服务商'}</strong></div><button className="icon-button" type="button" onClick={onOpenGuide} aria-label="查看使用步骤" title="查看使用步骤"><CircleHelp size={16} /></button></div>
    {!environmentReady && <section className="dock-setup-callout" data-tour="environment-setup-action"><strong>先准备连接环境</strong><span>这一步会先创建恢复点并准备安全写入位置；不会先创建空服务商。</span><button className="primary-button" type="button" onClick={onOpenSetup} disabled={busy !== null}><ShieldCheck size={16} />一键准备连接环境</button></section>}
    <section className="dock-action-stack" aria-label="检查与切换操作"><button className={`primary-button dock-primary ${isCurrent ? 'current' : ''}`} type="button" disabled={switchAction.disabled || busy !== null} onClick={switchAction.onClick} data-tour="switch-preflight" data-guide-target="providers.switch"><PlugZap size={16} />{switchAction.label}</button><button className="ghost-button dock-secondary" type="button" disabled={testAction.disabled || busy !== null} onClick={testAction.onClick} data-tour="run-availability" data-guide-target="providers.availability"><Activity size={15} />{testAction.label}</button></section>
    <dl className="dock-status-list"><div className={environmentReady ? 'ok' : 'warning'}><dt>连接环境</dt><dd>{environmentReady ? '已准备' : '需要准备'}</dd></div><div className={hasUnsavedChanges ? 'warning' : 'ok'}><dt>配置</dt><dd>{hasUnsavedChanges ? '尚未保存' : profile ? '已保存' : '—'}</dd></div><div className={modelReady ? 'ok' : 'warning'}><dt>默认模型</dt><dd>{modelReady ? providerModelLabel(profile?.model ?? '') : '尚未选择'}</dd></div><div className={profile?.verified ? 'ok' : 'warning'}><dt>可用性</dt><dd>{availability}</dd></div></dl>
    {catalog?.status && catalog.status !== 'ok' && <p className="dock-note">模型目录：{catalog.statusDetail}</p>}
    {requiredFailures > 0 && environmentReady && <p className="dock-note warning">有 {requiredFailures} 项安全阻止；请查看完整诊断。</p>}
    {riskCount > 0 && requiredFailures === 0 && environmentReady && <p className="dock-note">存在 {riskCount} 项使用风险，检查后仍可由你确认继续。</p>}
    <div className="dock-diagnostics" aria-label="完整检查结果">{renderChecks('服务商可用性', availabilityChecks)}{renderChecks('当前配置', profileConfigChecks)}{renderChecks('Codex 运行设置', configChecks)}</div>
    <button className="dock-detail-link" type="button" onClick={onOpenGuide}>查看使用步骤</button>
  </aside>
}
