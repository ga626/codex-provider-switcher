import { AlertTriangle, CheckCircle2, ShieldCheck, XCircle } from 'lucide-react'
import type { ProviderProfile, ValidationCheck } from '../../types'

function checkVisual(check: ValidationCheck) {
  if (check.ok) return { icon: <CheckCircle2 size={16} />, className: 'ok' }
  if (check.severity === 'warning' || check.severity === 'info') return { icon: <AlertTriangle size={16} />, className: 'warning' }
  return { icon: <XCircle size={16} />, className: 'danger' }
}

function CheckList({ checks }: { checks: ValidationCheck[] }) {
  return <div className="check-list">
    {checks.map((check) => {
      const visual = checkVisual(check)
      return <div className={`check-row ${visual.className}`} key={check.id}>
        {visual.icon}
        <div><strong>{check.label}</strong><span>{check.detail}</span></div>
      </div>
    })}
  </div>
}

export function SafetyWorkspace({
  availabilityChecks,
  profileConfigChecks,
  configChecks,
  selectedProfile,
  busy,
  hasUnsavedChanges,
  onVerify,
}: {
  availabilityChecks: ValidationCheck[]
  profileConfigChecks: ValidationCheck[]
  configChecks: ValidationCheck[]
  selectedProfile: ProviderProfile | undefined
  busy: string | null
  hasUnsavedChanges: boolean
  onVerify: () => void
}) {
  const targetChecks = [...availabilityChecks, ...profileConfigChecks]
  return <div className="workspace-stack">
    <section className="surface-panel check-panel">
      <div className="section-heading-row">
        <div><span className="eyebrow">切换条件</span><h3>完成以下检查后即可切换</h3></div>
        <div className="check-actions">
          <span className="section-meta">{selectedProfile ? `当前：${selectedProfile.name}` : '请选择服务商'} · 检查不会修改现有服务商设置</span>
          <button className="primary-button" type="button" onClick={onVerify} disabled={!selectedProfile || hasUnsavedChanges || busy !== null}>
            <ShieldCheck size={16} />
            {!selectedProfile ? '先新增服务商' : hasUnsavedChanges ? '请先保存更改' : '运行可用性测试'}
          </button>
        </div>
      </div>
      <CheckList checks={targetChecks} />
      <div className="check-group-heading"><div><span className="eyebrow">Codex 运行设置</span><h4>这些设置会在切换后继续生效</h4></div><span>{configChecks.length} 项实际检查</span></div>
      <CheckList checks={configChecks} />
    </section>
  </div>
}
