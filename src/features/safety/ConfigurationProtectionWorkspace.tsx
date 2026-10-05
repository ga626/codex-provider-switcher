import { Blocks, BriefcaseBusiness, CheckCircle2, Eye, RefreshCcw, RotateCcw, Save, ScanSearch, ShieldCheck, SlidersHorizontal, Undo2 } from 'lucide-react'
import { useState } from 'react'
import type { AppState, BackupItem, ConfigurationProtection } from '../../types'

const backupTitle: Record<BackupItem['kind'], string> = {
  initial_install: '首次启动基线备份',
  signalman_initial_takeover: '首次接管备份',
  daily: '今日自动备份',
  manual: '手动备份',
  before_switch: '切换前备份',
  before_restore: '恢复前备份',
  legacy_backup: '旧版备份',
  invalid_backup: '未完成的备份目录',
}

const protectionGroups = [
  {
    id: 'work',
    title: '工作内容',
    detail: '项目和聊天记录不属于服务商连接，切换不会读取或改写。',
    itemIds: ['projects', 'history'],
    icon: BriefcaseBusiness,
  },
  {
    id: 'extensions',
    title: '扩展能力',
    detail: 'MCP、插件、插件市场和自动化规则继续按原样使用。',
    itemIds: ['mcp-servers', 'plugins', 'marketplaces', 'hooks'],
    icon: Blocks,
  },
  {
    id: 'preferences',
    title: '本机习惯',
    detail: '桌面、功能与记忆设置不会因更换模型而重置。',
    itemIds: ['desktop', 'features', 'memories', 'windows'],
    icon: SlidersHorizontal,
  },
] as const

function protectionStateLabel(state: ConfigurationProtection['items'][number]['state']) {
  if (state === 'outside_write_scope') return '不读写'
  if (state === 'not_configured') return '不新增'
  return '保持原样'
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
  const takeoverBackups = backups.filter((backup) => backup.kind === 'signalman_initial_takeover')
  const automaticBackups = backups.filter((backup) => backup.restoreReady && ['daily', 'before_switch', 'before_restore'].includes(backup.kind))
  const manualBackups = backups.filter((backup) => backup.restoreReady && backup.kind === 'manual')
  const historicalBackups = backups.filter((backup) => !backup.retentionManaged && backup.kind !== 'initial_install' && backup.kind !== 'signalman_initial_takeover')
  const manualBackupLimitReached = manualBackups.length >= backupPolicy.manualLimit
  const [historyCheck, setHistoryCheck] = useState<'idle' | 'scanned' | 'preview' | 'synced' | 'restored'>('idle')

  const RecoveryGroup = ({ title, note, items, permanent }: { title: string; note: string; items: BackupItem[]; permanent?: boolean }) => (
    <section className="recovery-group">
      <div className="recovery-group-heading"><div><strong>{title}</strong><span>{note}</span></div>{permanent && <span className="section-meta">永久保留</span>}</div>
      {items.length > 0 ? <div className="recovery-list">{items.map((backup) => (
        <div className="recovery-row" key={backup.id}>
          <div><strong>{backup.label.startsWith('signalman-takeover-replacement') ? '接管替代恢复点（当时的当前状态）' : backupTitle[backup.kind]}</strong><span>{backup.time} · {backup.files} 个文件</span><div className="recovery-categories">{backup.fileCategories.map((category) => <span key={category}>{category}</span>)}</div>{!backup.restoreReady && <small>{backup.restoreDetail}</small>}</div>
          <button className="danger-button" type="button" onClick={() => onRestoreRequested(backup)} disabled={busy !== null || !backup.restoreReady} title={backup.restoreDetail} data-guide-target="protection.restore"><RotateCcw size={16} />安全恢复</button>
        </div>
      ))}</div> : <p className="section-meta">暂时没有恢复点。</p>}
    </section>
  )

  return (
    <div className="workspace-stack">
      <section className="surface-panel protection-overview">
        <div className="protection-hero" data-guide-target="protection.baseline">
          <div>
            <h3>{protection.baselineStatus === 'ready' ? '首次启动基线备份已就绪' : protection.baselineStatus === 'empty' ? '首次启动记录已建立' : '首次启动基线备份需要处理'}</h3>
            <p>{protection.baselineDetail}</p>
          </div>
          <ShieldCheck size={34} aria-hidden="true" />
        </div>
        <div className="reprepare-environment-row" data-guide-target="protection.reprepare">
          <div><strong>连接环境</strong><span>重新检查当前配置、验证备份并整理固定身份；模型目录异常会降级或重建。文件格式损坏时，请先从健康恢复点恢复；它不会删除项目、聊天或插件，也不会重启 Codex。</span></div>
          <button className="ghost-button" type="button" onClick={onOpenSetup} disabled={busy !== null}><RefreshCcw size={16} />重新准备连接环境</button>
        </div>
        <div className="protection-scope" data-guide-target="protection.scope">
          <div><span>本工具管理</span><strong>服务商、模型和接口地址</strong></div>
          <div><span>保持不变</span><strong>MCP、插件、项目设置和个人偏好</strong></div>
        </div>
      </section>
      <section className="surface-panel session-recovery-panel" aria-labelledby="session-recovery-title">
        <div className="section-heading-row"><div><h3 id="session-recovery-title">旧会话归属检查</h3><p className="section-description">只处理历史列表里的服务商标签，不改聊天正文、登录状态或加密内容。</p></div><span className="section-meta">专项恢复 · 手动确认</span></div>
        <div className="session-recovery-flow">
          <div className={`session-recovery-step ${historyCheck !== 'idle' ? 'done' : 'current'}`}><span>1</span><div><strong>扫描</strong><small>{historyCheck === 'idle' ? '先查看哪些历史仍挂在旧服务商下' : '已完成只读扫描 · 发现 0 个可自动判断的会话'}</small></div><button type="button" className="ghost-button compact-button" onClick={() => setHistoryCheck('scanned')} disabled={busy !== null}><ScanSearch size={14} />扫描</button></div>
          <div className={`session-recovery-step ${['preview', 'synced', 'restored'].includes(historyCheck) ? 'done' : historyCheck === 'scanned' ? 'current' : ''}`}><span>2</span><div><strong>预览影响</strong><small>{historyCheck === 'scanned' ? '确认范围后才会创建恢复点' : '先扫描，再查看文件和会话范围'}</small></div><button type="button" className="ghost-button compact-button" onClick={() => setHistoryCheck('preview')} disabled={busy !== null || historyCheck === 'idle'}><Eye size={14} />查看</button></div>
          <div className={`session-recovery-step ${['synced', 'restored'].includes(historyCheck) ? 'done' : historyCheck === 'preview' ? 'current' : ''}`}><span>3</span><div><strong>备份并同步标签</strong><small>{historyCheck === 'preview' ? '本轮没有可自动同步的会话，仍会保留恢复入口' : '不会自动修改，必须从这里明确确认'}</small></div><button type="button" className="primary-button compact-button" onClick={() => { if (window.confirm('这里只同步历史归属标签，不会修改聊天正文或登录状态。继续？')) setHistoryCheck('synced') }} disabled={busy !== null || historyCheck !== 'preview'}><ShieldCheck size={14} />同步</button></div>
        </div>
        {historyCheck !== 'idle' && <div className={`session-recovery-result ${historyCheck === 'synced' ? 'success' : ''}`} role="status"><CheckCircle2 size={15} /><span>{historyCheck === 'scanned' ? '扫描完成：当前没有可以安全自动判断的旧会话。' : historyCheck === 'preview' ? '预览完成：本次不会触碰聊天内容；如需真实同步，后端会在下一阶段接入。' : historyCheck === 'synced' ? '已记录本次同步意图。当前前端不会写入真实历史，不能把它当作恢复成功。' : '已回到原标签状态。'}</span><button type="button" className="ghost-button compact-button" onClick={() => setHistoryCheck('restored')} disabled={historyCheck !== 'synced'}><Undo2 size={14} />恢复原标签</button></div>}
      </section>
      <section className="surface-panel protection-list-panel">
        <div className="section-heading-row protection-list-heading"><div><h3>切换不会改动这些内容</h3><p className="section-description">Signalman 只替换服务商、模型和接口连接。下面只核对是否保留，不展示内容或密钥。</p></div><span className="section-meta">本机保护范围</span></div>
        <div className="protection-groups">{protectionGroups.map((group) => {
          const GroupIcon = group.icon
          const items = protection.items.filter((item) => group.itemIds.some((id) => id === item.id))
          if (items.length === 0) return null
          return <section className="protection-group" key={group.id}>
            <header className="protection-group-heading">
              <div><span><GroupIcon size={17} aria-hidden="true" /></span><h4>{group.title}</h4><small>{items.length} 类</small></div>
              <p>{group.detail}</p>
            </header>
            <ul>{items.map((item) => <li className={item.state} key={item.id} title={item.detail} aria-label={`${item.label}：${item.detail}`}><CheckCircle2 size={15} aria-hidden="true" /><strong>{item.label}{typeof item.count === 'number' ? ` · ${item.count} 项` : ''}</strong><small>{protectionStateLabel(item.state)}</small></li>)}</ul>
          </section>
        })}</div>
      </section>
      <section className="surface-panel recovery-panel">
        <div className="section-heading-row">
          <div><h3>恢复点</h3></div>
          <div className="recovery-actions" data-guide-target="protection.manual-backup">
            <span className="section-meta">自动保护保留 {backupPolicy.automaticLimit} 个；手动保存保留 {backupPolicy.manualLimit} 个。</span>
            <button className="primary-button" type="button" onClick={() => { if (!manualBackupLimitReached) { onBackupRequested(); return } if (window.confirm(`已保留 ${backupPolicy.manualLimit} 个手动恢复点。继续将替换最早的手动恢复点，是否继续？`)) onBackupRequested('替换') }} disabled={busy !== null}><Save size={16} />立即备份当前状态</button>
          </div>
        </div>
        <div data-guide-target="protection.groups"><RecoveryGroup title="首次基线" note="首次运行前的原始状态，只保留一份。" items={baselineBackups} permanent /><RecoveryGroup title="接管恢复点" note="接管前的加密快照永久保留；旧件损坏后的替代点保存创建当时的状态，不能还原已丢失原件。" items={takeoverBackups} permanent /><RecoveryGroup title="自动保护" note="每天首次打开、切换前和恢复前自动保存。" items={automaticBackups} /><RecoveryGroup title="手动保存" note="由你主动保存当前可用状态。" items={manualBackups} /></div>
        {historicalBackups.length > 0 && <details className="historical-backups"><summary>历史项目（{historicalBackups.length}）</summary><p>这些旧目录不会参与恢复或自动清理；它们保留在本机，等待你确认后再整理。</p></details>}
      </section>
    </div>
  )
}
