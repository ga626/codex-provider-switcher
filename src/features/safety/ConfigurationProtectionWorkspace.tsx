import { CheckCircle2, RefreshCcw, RotateCcw, Save, ShieldCheck } from 'lucide-react'
import type { AppState, BackupItem, ConfigurationProtection } from '../../types'

const backupTitle: Record<BackupItem['kind'], string> = {
  initial_install: '首次启动基线备份',
  daily: '今日自动备份',
  manual: '手动备份',
  before_switch: '切换前备份',
  before_restore: '恢复前备份',
  legacy_backup: '旧版备份',
  invalid_backup: '未完成的备份目录',
}

export function ConfigurationProtectionWorkspace({
  protection,
  backups,
  backupPolicy,
  busy,
  onRestoreRequested,
  onBackupRequested,
  onOpenSetup,
}: {
  protection: ConfigurationProtection
  backups: BackupItem[]
  backupPolicy: AppState['backupPolicy']
  busy: string | null
  onRestoreRequested: (backup: BackupItem) => void
  onBackupRequested: (confirmation?: string) => void
  onOpenSetup: () => void
}) {
  const baselineBackups = backups.filter((backup) => backup.kind === 'initial_install')
  const automaticBackups = backups.filter((backup) => backup.restoreReady && ['daily', 'before_switch', 'before_restore'].includes(backup.kind))
  const manualBackups = backups.filter((backup) => backup.restoreReady && backup.kind === 'manual')
  const historicalBackups = backups.filter((backup) => !backup.retentionManaged && backup.kind !== 'initial_install')
  const manualBackupLimitReached = manualBackups.length >= backupPolicy.manualLimit

  const RecoveryGroup = ({ title, note, items, permanent }: { title: string; note: string; items: BackupItem[]; permanent?: boolean }) => (
    <section className="recovery-group">
      <div className="recovery-group-heading"><div><strong>{title}</strong><span>{note}</span></div>{permanent && <span className="section-meta">永久保留</span>}</div>
      {items.length > 0 ? <div className="recovery-list">{items.map((backup) => (
        <div className="recovery-row" key={backup.id}>
          <div><strong>{backupTitle[backup.kind]}</strong><span>{backup.time} · {backup.files} 个文件</span><div className="recovery-categories">{backup.fileCategories.map((category) => <span key={category}>{category}</span>)}</div></div>
          <button className="danger-button" type="button" onClick={() => onRestoreRequested(backup)} disabled={busy !== null} title={backup.restoreDetail} data-guide-target="protection.restore"><RotateCcw size={16} />安全恢复</button>
        </div>
      ))}</div> : <p className="section-meta">暂时没有恢复点。</p>}
    </section>
  )

  return (
    <div className="workspace-stack">
      <section className="surface-panel protection-overview">
        <div className="protection-hero" data-guide-target="protection.baseline">
          <div>
            <span className="eyebrow">备份状态</span>
            <h3>{protection.baselineStatus === 'ready' ? '首次启动基线备份已就绪' : protection.baselineStatus === 'empty' ? '首次启动记录已建立' : '首次启动基线备份需要处理'}</h3>
            <p>{protection.baselineDetail}</p>
          </div>
          <ShieldCheck size={34} aria-hidden="true" />
        </div>
        <div className="reprepare-environment-row" data-guide-target="protection.reprepare">
          <div><strong>连接环境</strong><span>重新扫描配置层并创建恢复点，只准备 Signalman 管理的连接设置。</span></div>
          <button className="ghost-button" type="button" onClick={onOpenSetup} disabled={busy !== null}><RefreshCcw size={16} />重新准备连接环境</button>
        </div>
        <div className="protection-scope" data-guide-target="protection.scope">
          <div><span className="eyebrow">本工具管理</span><strong>服务商、模型和接口地址</strong></div>
          <div><span className="eyebrow">保持不变</span><strong>MCP、插件、项目设置和个人偏好</strong></div>
        </div>
      </section>
      <section className="surface-panel protection-list-panel">
        <div className="section-heading-row"><div><span className="eyebrow">保留的设置</span><h3>切换时会保留这些设置</h3></div><span className="section-meta">仅显示状态，不显示内容或密钥</span></div>
        <div className="protection-grid">{protection.items.map((item) => <article className={`protection-item ${item.state}`} key={item.id}><CheckCircle2 size={17} aria-hidden="true" /><div><strong>{item.label}{typeof item.count === 'number' ? ` · ${item.count} 项` : ''}</strong></div></article>)}</div>
      </section>
      <section className="surface-panel recovery-panel">
        <div className="section-heading-row">
          <div><span className="eyebrow">恢复中心</span><h3>已保护的恢复点</h3></div>
          <div className="recovery-actions" data-guide-target="protection.manual-backup">
            <span className="section-meta">自动保护保留 {backupPolicy.automaticLimit} 个；手动保存保留 {backupPolicy.manualLimit} 个。</span>
            <button className="primary-button" type="button" onClick={() => { if (!manualBackupLimitReached) { onBackupRequested(); return } if (window.confirm(`已保留 ${backupPolicy.manualLimit} 个手动恢复点。继续将替换最早的手动恢复点，是否继续？`)) onBackupRequested('替换') }} disabled={busy !== null}><Save size={16} />立即备份当前状态</button>
          </div>
        </div>
        <div data-guide-target="protection.groups"><RecoveryGroup title="首次基线" note="首次运行前的原始状态，只保留一份。" items={baselineBackups} permanent /><RecoveryGroup title="自动保护" note="每天首次打开、切换前和恢复前自动保存。" items={automaticBackups} /><RecoveryGroup title="手动保存" note="由你主动保存当前可用状态。" items={manualBackups} /></div>
        {historicalBackups.length > 0 && <details className="historical-backups"><summary>历史项目（{historicalBackups.length}）</summary><p>这些旧目录不会参与恢复或自动清理；它们保留在本机，等待你确认后再整理。</p></details>}
      </section>
    </div>
  )
}
