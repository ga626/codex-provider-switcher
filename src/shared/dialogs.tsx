import { AlertTriangle, CheckCircle2, Copy, Download, GitCompareArrows, MessageSquare, PlugZap, RefreshCcw, RotateCcw, ShieldCheck, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { UpdateInstallProgress } from '../adapter'
import { createCompatibilityFeedback } from '../feedback'
import type { AppState, BackupItem, ProviderProfile, SwitchPreflight, UpdateInfo } from '../types'
import { ModalDialog } from './components'

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
}

function updateCheckTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function updateProgressLabel(progress: UpdateInstallProgress | null) {
  if (!progress) return ''
  if (progress.phase === 'installing') return '下载完成，正在安装并准备重启…'
  if (!progress.totalBytes) return progress.downloadedBytes > 0 ? '正在下载更新包…' : '正在连接更新包…'
  const percent = Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
  return `正在下载更新包：${percent}%`
}

export function RestartCodexNoticeDialog({ onClose }: { onClose: () => void }) {
  return <ModalDialog className="restart-notice-dialog" labelledBy="restart-notice-title" onClose={onClose}>
    <div className="confirm-dialog-icon"><RotateCcw size={20} /></div>
    <div><span className="eyebrow">切换已完成</span><h2 id="restart-notice-title">请在新对话中确认</h2><p>新配置已经写入并创建了恢复点。已打开的 Codex 或 ChatGPT 桌面端 Codex 对话会保留创建时的连接信息，不能被安全热切换。请结束当前对话后新建一个 Codex 对话，再确认实际服务商。</p></div>
    <div className="command-row"><button className="primary-button" type="button" onClick={onClose} data-dialog-initial-focus>我知道了</button></div>
  </ModalDialog>
}

export function ConnectionEnvironmentDialog({ environment, busy, onClose, onConfirm }: { environment: AppState['connectionEnvironment']; busy: boolean; onClose: () => void; onConfirm: (layerId: string) => void }) {
  const [layerId, setLayerId] = useState(environment.selectedLayerId ?? environment.layers[0]?.id ?? '')
  const selectedLayer = environment.layers.find((layer) => layer.id === layerId)
  return <ModalDialog className="connection-environment-dialog" labelledBy="connection-environment-title" onClose={onClose}>
    <div className="section-heading-row"><div><span className="eyebrow">开始使用</span><h2 id="connection-environment-title">准备连接环境</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭准备连接环境"><X size={16} /></button></div>
    <p>此操作会先创建恢复点，再确认 Signalman 写入的位置安全可控。此时不会创建没有地址、模型或密钥的空服务商；你保存并切换第一家服务商后才会一次性写入完整连接信息。项目、MCP、插件、hooks、历史记录和其他未知设置保持不变。</p>
    {environment.layers.length > 1 && <label className="environment-layer-select">要管理的配置层<select value={layerId} onChange={(event) => setLayerId(event.target.value)}>{environment.layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.label}</option>)}</select></label>}
    {selectedLayer && <div className="environment-preview"><strong>本次选择：{selectedLayer.label}</strong><span>{selectedLayer.detail}</span><ul><li>会确认后续配置与认证写入同一 Codex 目录</li><li>不会提前选择空的 custom 服务商</li><li>切换时会创建可恢复的备份并在写入后回读</li></ul></div>}
    <div className="command-row"><button className="ghost-button" type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" type="button" disabled={!layerId || busy} onClick={() => onConfirm(layerId)} data-dialog-initial-focus><ShieldCheck size={16} />一键准备连接环境</button></div>
  </ModalDialog>
}

export function FeedbackDialog({ state, selectedProfile, onClose, onCopied, onSubmitted }: { state: AppState; selectedProfile: ProviderProfile | undefined; onClose: () => void; onCopied: () => void; onSubmitted: (receipt: string) => void }) {
  const [consented, setConsented] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [diagnosticId] = useState(() => globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const relayUrl = import.meta.env.VITE_FEEDBACK_RELAY_URL?.trim()
  const feedback = useMemo(() => createCompatibilityFeedback(state, selectedProfile, diagnosticId), [diagnosticId, selectedProfile, state])
  const payload = JSON.stringify(feedback, null, 2)
  async function exportPayload() {
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `signalman-compatibility-${diagnosticId.slice(0, 12)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    await navigator.clipboard?.writeText(payload)
    onCopied()
    onClose()
  }
  async function submitPayload() {
    if (!relayUrl || !consented) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const response = await fetch(relayUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json().catch(() => ({})) as { receiptId?: string }
      onSubmitted(body.receiptId?.slice(0, 80) || '已接收')
      onClose()
    } catch (error) {
      setSubmitError(`在线提交暂时不可用（${errorMessage(error, '网络错误')}）。你仍可导出脱敏反馈。`)
    } finally {
      setSubmitting(false)
    }
  }
  return <ModalDialog className="feedback-dialog" labelledBy="feedback-title" onClose={onClose}>
    <div className="section-heading-row"><div><span className="eyebrow">问题反馈</span><h2 id="feedback-title">把这次问题告诉维护者</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭反馈"><X size={16} /></button></div>
    <p>内容会包含失败操作、接口域名与路径、模型目录摘要、检查结果和最近操作名称，方便维护者复现；不包含访问密钥、配置正文、文件路径、响应原文、Cookie、日志或截图。</p>
    <pre className="feedback-preview">{payload}</pre>
    {relayUrl ? <label className="feedback-consent"><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} />我确认提交以上脱敏诊断信息给 Signalman 维护者</label> : <p className="feedback-relay-unavailable">在线反馈尚未配置。可先导出这份脱敏诊断单后发送给维护者。</p>}
    {submitError && <p className="feedback-submit-error">{submitError}</p>}
    <div className="command-row"><button className="ghost-button" type="button" onClick={onClose}>取消</button><button className="ghost-button" type="button" onClick={() => void exportPayload()}><Copy size={16} />导出脱敏内容</button>{relayUrl && <button className="primary-button" type="button" disabled={!consented || submitting} onClick={() => void submitPayload()}><MessageSquare size={16} />{submitting ? '正在提交' : '提交给维护者'}</button>}</div>
  </ModalDialog>
}

export function ManualModelConfirmDialog({ model, busy, onCancel, onConfirm }: { model: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <ModalDialog labelledBy="manual-model-dialog-title" onClose={onCancel}>
    <div className="confirm-dialog-icon"><AlertTriangle size={20} /></div><div><span className="eyebrow">未验证模型</span><h2 id="manual-model-dialog-title">确认保存手动模型？</h2><p>{model} 不在最近刷新到的服务商模型目录中。保存后可运行可用性测试；测试未确认不代表已有 Codex 使用会失败。</p></div>
    <div className="command-row"><button className="ghost-button" type="button" onClick={onCancel} disabled={busy} data-dialog-initial-focus>取消</button><button className="danger-button" type="button" onClick={onConfirm} disabled={busy}>继续保存</button></div>
  </ModalDialog>
}

export function SyncCurrentConfigurationDialog({ drift, busy, onCancel, onConfirm }: { drift: NonNullable<AppState['configurationDrift']>; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <ModalDialog labelledBy="sync-dialog-title" onClose={onCancel}>
    <div className="confirm-dialog-icon"><GitCompareArrows size={20} /></div><div><span className="eyebrow">同步当前 Codex 配置</span><h2 id="sync-dialog-title">确认更新切换器目录？</h2><p>{drift.profileName} 当前保存的是 {drift.savedModel}，Codex 正在使用 {drift.currentModel}。此操作只更新切换器目录，不会写入 Codex 配置、认证文件或发起远端请求。</p></div>
    <div className="command-row"><button className="ghost-button" type="button" onClick={onCancel} disabled={busy} data-dialog-initial-focus>取消</button><button className="primary-button" type="button" onClick={onConfirm} disabled={busy}>确认同步</button></div>
  </ModalDialog>
}

export function ApplicationSettingsDialog({ autoStart, backupPolicy, desktopAvailable, busy, buildChannelLabel, updateInfo, updateBusy, updateProgress, updateError, updateSupported, storeManaged, onClose, onToggle, onBackupPolicyChange, onUpdate }: {
  autoStart: boolean; backupPolicy: AppState['backupPolicy']; desktopAvailable: boolean; busy: string | null; buildChannelLabel: string; updateInfo: UpdateInfo | null; updateBusy: boolean; updateProgress: UpdateInstallProgress | null; updateError: string | null; updateSupported: boolean; storeManaged: boolean; onClose: () => void; onToggle: (enabled: boolean) => void; onBackupPolicyChange: (automaticLimit: number, manualLimit: number) => void; onUpdate: () => void
}) {
  const disabled = !desktopAvailable || busy !== null
  const updateStatus = updateBusy ? updateProgressLabel(updateProgress) || '正在检查更新…' : !updateSupported ? desktopAvailable ? '当前版本不检查公开更新' : '本地预览不检查公开更新' : storeManaged ? '在 Microsoft Store 获取更新' : updateInfo?.available ? `发现新版本 v${updateInfo.latestVersion}` : updateInfo ? `当前已是最新版${updateCheckTime(updateInfo.checkedAt) ? ` · 检查于 ${updateCheckTime(updateInfo.checkedAt)}` : ''}` : '尚未检查更新'
  const updateAction = storeManaged ? '前往 Microsoft Store' : updateInfo?.available ? updateBusy ? '正在下载' : `下载并安装 v${updateInfo.latestVersion}` : '检查更新'
  return <ModalDialog className="application-settings-dialog" labelledBy="application-settings-title" onClose={onClose}>
    <div className="section-heading-row"><div><span className="eyebrow">应用设置</span><h2 id="application-settings-title">应用偏好</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭设置" data-dialog-initial-focus><X size={16} /></button></div>
    <section className="settings-section" aria-labelledby="settings-startup-title"><div className="settings-section-heading"><h3 id="settings-startup-title">启动</h3><p>控制应用何时打开，不会改变 Codex 的启动方式。</p></div><label className="setting-toggle-row"><span><strong>开机后自动打开</strong><small>{desktopAvailable ? '关闭后，下次登录 Windows 不会自动打开应用。' : '开发预览和 Web 诊断模式不会修改 Windows 启动项。'}</small></span><input type="checkbox" checked={autoStart} disabled={disabled} onChange={(event) => onToggle(event.target.checked)} aria-label="开机后自动打开" /></label></section>
    <section className="settings-section" aria-labelledby="settings-protection-title"><div className="settings-section-heading"><h3 id="settings-protection-title">恢复保护</h3><p>首次启动基线永久保留。恢复和手动保存请前往“安全与恢复”。</p></div><div className="settings-option-group"><label>自动保护<select value={backupPolicy.automaticLimit} disabled={busy !== null} onChange={(event) => onBackupPolicyChange(Number(event.target.value), backupPolicy.manualLimit)}>{Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} 个</option>)}</select></label><label>手动保存<select value={backupPolicy.manualLimit} disabled={busy !== null} onChange={(event) => onBackupPolicyChange(backupPolicy.automaticLimit, Number(event.target.value))}>{Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} 个</option>)}</select></label></div></section>
    <section className="settings-section" aria-labelledby="settings-update-title"><div className="settings-section-heading"><h3 id="settings-update-title">更新</h3><p>只从受信任的发布渠道获取新版本。</p></div><div className="settings-update-row"><div><strong>v{__APP_VERSION__}</strong><span>{buildChannelLabel}</span><small>{updateStatus}</small>{updateError && <small className="settings-update-error" role="alert">{updateError}</small>}</div><button className="ghost-button settings-update-button" type="button" onClick={onUpdate} disabled={updateBusy || !updateSupported}>{updateBusy ? <RefreshCcw className="spin" size={15} /> : updateInfo?.available && !storeManaged ? <Download size={15} /> : updateInfo && !updateInfo.available && !storeManaged ? <CheckCircle2 size={15} /> : <RefreshCcw size={15} />}{updateAction}</button></div></section>
  </ModalDialog>
}

export function RestoreConfirmDialog({ backup, busy, onCancel, onConfirm }: { backup: BackupItem; busy: boolean; onCancel: () => void; onConfirm: (confirmation: string) => void }) {
  const [confirmation, setConfirmation] = useState('')
  return <ModalDialog labelledBy="restore-dialog-title" onClose={onCancel}>
    <div className="confirm-dialog-icon"><AlertTriangle size={20} /></div><div><span className="eyebrow">安全恢复 · {backup.time}</span><h2 id="restore-dialog-title">确认回到这个恢复点？</h2><p>将只回退本工具写入的服务商、模型、接口地址和本机登录信息。MCP、插件、项目设置和你后来新增的内容不会被覆盖。</p><label className="restore-confirmation-field">输入“恢复”后启用确认按钮<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="恢复" autoFocus data-dialog-initial-focus /></label></div>
    <div className="command-row"><button className="ghost-button" type="button" onClick={onCancel} disabled={busy}>取消</button><button className="danger-button" type="button" onClick={() => onConfirm(confirmation)} disabled={busy || confirmation.trim() !== '恢复'}><RotateCcw size={16} />确认恢复</button></div>
  </ModalDialog>
}

export function SwitchConfirmDialog({ preflight, busy, onCancel, onConfirm }: { preflight: SwitchPreflight; busy: boolean; onCancel: () => void; onConfirm: (riskAcknowledged: boolean) => void }) {
  const [riskAcknowledged, setRiskAcknowledged] = useState(false)
  const hasRisk = Boolean(preflight.riskDetail)
  const availabilityPassed = preflight.availabilityStatus === 'verified'
  const availabilityAttempted = !['not_checked', 'missing_key', 'invalid_profile'].includes(preflight.availabilityStatus)
  return <ModalDialog className="switch-confirm-dialog" labelledBy="switch-dialog-title" onClose={onCancel}>
    <div className="confirm-dialog-icon"><GitCompareArrows size={20} /></div><div><span className="eyebrow">切换影响确认</span><h2 id="switch-dialog-title">确认切换到 {preflight.targetName}？</h2><p>{availabilityPassed ? '切换前已重新完成可用性测试。确认时会再次核对当前配置没有变化，再创建新的恢复点；不会显示访问密钥或完整配置内容。' : '切换前已执行可用性测试，但本次没有确认目标服务商可用。确认时会再次核对当前配置没有变化；继续切换需要你明确承担使用风险。'}</p><dl className="switch-confirm-facts"><div><dt>目标模型</dt><dd>{preflight.targetModel}</dd></div><div><dt>恢复点</dt><dd>{preflight.backupDetail}</dd></div><div><dt>保护检查</dt><dd>{preflight.protectedDetail}</dd></div><div className={availabilityPassed ? 'preflight-availability passed' : 'preflight-availability warning'}><dt>本次可用性测试</dt><dd><strong>{availabilityPassed ? '已通过' : availabilityAttempted ? '已执行但未确认' : '未能发起'}</strong><span>{preflight.availabilityDetail}</span><small>检查时间：{preflight.availabilityCheckedAt}</small></dd></div>{preflight.riskDetail && <div><dt>使用风险</dt><dd>{preflight.riskDetail}</dd></div>}</dl>{hasRisk && <label className="risk-confirmation"><input type="checkbox" checked={riskAcknowledged} onChange={(event) => setRiskAcknowledged(event.target.checked)} data-dialog-initial-focus /><span>我已了解：这不会影响安全写入检查，但目标服务商的实际可用性尚未由本工具确认。</span></label>}<p>此预览有效至 {preflight.expiresAt}。完成后请关闭当前 Codex 会话，并在新的会话中确认实际 provider 使用情况。</p></div>
    <div className="command-row"><button className="ghost-button" type="button" onClick={onCancel} disabled={busy} data-dialog-initial-focus={!hasRisk}>取消</button><button className="primary-button" type="button" onClick={() => onConfirm(riskAcknowledged)} disabled={busy || (hasRisk && !riskAcknowledged)}><PlugZap size={16} />确认切换</button></div>
  </ModalDialog>
}
