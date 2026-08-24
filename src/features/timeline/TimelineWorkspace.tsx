import { useMemo, useState } from 'react'
import type { ActivityItem, AppState } from '../../types'
import { ModalDialog } from '../../shared/components'

type ActivityView = 'all' | 'needs_attention'
type ProblemState = 'attention' | 'unconfirmed' | 'failed' | 'recovered'

type ActivityProblem = {
  key: string
  operationKey: string
  state: ProblemState
  latest: ActivityItem
  occurrences: ActivityItem[]
}

type DiagnosticTarget = {
  item: ActivityItem
  occurrences: number
}

const views: Array<{ id: ActivityView; label: string; description: string }> = [
  { id: 'all', label: '全部操作', description: '按时间查看每一次操作；颜色会标出已完成、待确认和需要处理的结果。' },
  { id: 'needs_attention', label: '需要处理', description: '这里只保留尚未确认、失败或需要你决定下一步的问题。' },
]

function formattedTime(item: ActivityItem) {
  return item.occurredAt || item.time
}

function operationKind(item: ActivityItem) {
  if (item.operationKind) return item.operationKind
  if (item.eventName?.includes('model_catalog')) return 'model_catalog'
  if (item.eventName?.includes('verification')) return 'verification'
  if (item.eventName?.includes('switch')) return 'switch'
  if (item.title.includes('恢复')) return 'restore'
  if (item.title.includes('备份')) return 'backup'
  return 'workspace'
}

function operationKey(item: ActivityItem) {
  return item.operationKey || `${item.subject?.providerName ?? 'workspace'}:${operationKind(item)}`.toLowerCase()
}

function isUnconfirmed(item: ActivityItem) {
  const text = `${item.title} ${item.detail} ${item.result ?? ''}`
  return text.includes('未确认') || text.includes('待确认') || text.includes('超时') || item.result === 'unconfirmed'
}

function isAttention(item: ActivityItem) {
  return isUnconfirmed(item) || item.result === 'failure' || item.result === 'warning' || item.tone === 'warning' || item.tone === 'danger'
}

function resultLabel(item: ActivityItem) {
  if (item.result === 'failure' || item.tone === 'danger') return '未完成'
  if (isUnconfirmed(item)) return '尚未确认'
  if (item.result === 'warning' || item.tone === 'warning') return '需要处理'
  if (item.result === 'success' || item.tone === 'success') return '已完成'
  return '已记录'
}

function resultState(item: ActivityItem) {
  if (item.result === 'failure' || item.tone === 'danger') return 'failed'
  if (isUnconfirmed(item)) return 'unconfirmed'
  if (item.result === 'warning' || item.tone === 'warning') return 'attention'
  if (item.result === 'success' || item.tone === 'success') return 'completed'
  return 'recorded'
}

function problemState(item: ActivityItem): ProblemState {
  if (item.result === 'failure' || item.tone === 'danger') return 'failed'
  if (isUnconfirmed(item)) return 'unconfirmed'
  return 'attention'
}

function problemKey(item: ActivityItem) {
  if (item.problemKey) return item.problemKey
  const provider = item.subject?.providerName ?? 'workspace'
  const cause = item.diagnostics?.find((entry) => ['provider.error_code', 'http.status_code', 'verification.status', 'model_catalog.status'].includes(entry.key))?.value ?? 'attention'
  return `${provider}:${operationKind(item)}:${cause}`.toLowerCase()
}

function stageList(item: ActivityItem) {
  if (item.stages?.length) return item.stages
  return [{ state: isAttention(item) ? problemState(item) : 'completed', title: resultLabel(item), detail: item.detail }]
}

function titleForProblem(item: ActivityItem) {
  const provider = item.subject?.providerName ? `${item.subject.providerName}：` : ''
  if (isUnconfirmed(item)) return `${provider}检查结果尚未确认`
  return `${provider}${item.title}`
}

function humanReason(item: ActivityItem) {
  const http = item.diagnostics?.find((entry) => entry.key === 'http.status_code')?.value
  const providerCode = item.diagnostics?.find((entry) => entry.key === 'provider.error_code')?.value
  if (isUnconfirmed(item)) return '等待结束前没有收到可确认的最终结果；系统没有自动重发请求。'
  if (http === '401') return `服务商返回 401${providerCode ? `（${providerCode}）` : ''}，当前密钥可能无效或没有权限。`
  if (http === '429') return '服务商暂时限制了请求频率或额度，请等待后重新检查。'
  if (http && Number(http) >= 500) return `服务商暂时无法响应（HTTP ${http}），稍后重新检查即可。`
  return item.detail
}

function copyDiagnosticPackage(item: ActivityItem) {
  const lines = [
    `${isAttention(item) ? '问题' : '操作'}：${isAttention(item) ? titleForProblem(item) : item.title}`,
    `时间：${formattedTime(item)}`,
    item.subject?.providerName ? `服务商：${item.subject.providerName}` : '',
    item.subject?.model ? `模型：${item.subject.model}` : '',
    `结论：${humanReason(item)}`,
    item.nextStep ? `建议：${item.nextStep}` : '',
    '',
    '技术事实（已脱敏）：',
    ...stageList(item).map((stage) => `- ${stage.title}：${stage.detail}`),
    ...(item.diagnostics ?? []).map((entry) => `- ${entry.label}：${entry.value}`),
    item.correlationId ? `- 关联编号：${item.correlationId}` : '',
    item.eventName ? `- 事件类型：${item.eventName}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

function ProblemCard({ problem, onViewDiagnostic }: { problem: ActivityProblem; onViewDiagnostic: (target: DiagnosticTarget) => void }) {
  const [open, setOpen] = useState(false)
  const { latest, occurrences, state } = problem
  const stateLabel = state === 'failed' ? '未完成' : state === 'unconfirmed' ? '尚未确认' : '需要处理'
  return (
    <article className={`activity-problem activity-problem--${state}`}>
      <div className="activity-problem-topline">
        <span className="activity-state-badge">{stateLabel}</span>
        <time dateTime={latest.occurredAt}>{formattedTime(latest)} 最近发生</time>
      </div>
      <div className="activity-problem-copy">
        <strong>{titleForProblem(latest)}</strong>
        <p>{humanReason(latest)}</p>
        <small>共 {occurrences.length} 次{occurrences.length > 1 ? '；已按同一原因合并' : ''}</small>
      </div>
      {latest.nextStep && <div className="activity-next-action"><span>建议下一步</span><p>{latest.nextStep}</p></div>}
      <div className="activity-card-actions">
        <button className="ghost-button" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? '收起排查过程' : '查看排查过程'}</button>
        <button className="ghost-button" type="button" onClick={() => onViewDiagnostic({ item: latest, occurrences: occurrences.length })}>查看诊断详情</button>
      </div>
      {open && <ol className="activity-stage-list" aria-label="排查过程">
        {stageList(latest).map((stage, index) => <li className={`activity-stage activity-stage--${stage.state}`} key={`${stage.title}-${index}`}><span aria-hidden="true" /><div><strong>{stage.title}</strong><p>{stage.detail}</p></div></li>)}
      </ol>}
    </article>
  )
}

function OperationRow({ item, onViewDetail }: { item: ActivityItem; onViewDetail: (target: DiagnosticTarget) => void }) {
  const object = [item.subject?.providerName, item.subject?.model].filter(Boolean).join(' · ') || '当前工作区'
  return (
    <article className={`activity-operation activity-operation--${resultState(item)}`}>
      <span className="activity-operation-marker" aria-hidden="true" />
      <div className="activity-operation-identity"><time dateTime={item.occurredAt}>{formattedTime(item)}</time><span>{object}</span></div>
      <strong className="activity-operation-title">{item.title}</strong>
      <p className="activity-operation-description">{isAttention(item) ? humanReason(item) : item.detail}</p>
      <div className="activity-operation-actions"><span className="activity-operation-result">{resultLabel(item)}</span><button className="ghost-button" type="button" onClick={() => onViewDetail({ item, occurrences: 1 })}>查看详情</button></div>
    </article>
  )
}

function DiagnosticDialog({ target, copied, onCopy, onClose }: { target: DiagnosticTarget; copied: boolean; onCopy: () => void; onClose: () => void }) {
  const { item, occurrences } = target
  const isProblem = isAttention(item)
  return <ModalDialog className="activity-diagnostic-dialog" labelledBy="activity-diagnostic-title" onClose={onClose}>
    <div className="section-heading-row"><div><span className="eyebrow">{isProblem ? '诊断详情' : '操作详情'}</span><h2 id="activity-diagnostic-title">{isProblem ? '完整诊断包' : '完整操作记录'}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭详情" data-dialog-initial-focus>×</button></div>
    <pre className="activity-diagnostic-package">{copyDiagnosticPackage(item)}{occurrences > 1 ? `\n\n相同原因已合并：共 ${occurrences} 次。` : ''}</pre>
    <div className="command-row"><button className="ghost-button" type="button" onClick={onClose}>关闭</button><button className="primary-button" type="button" onClick={onCopy}>{copied ? '诊断包已复制' : '复制诊断包'}</button></div>
  </ModalDialog>
}

export function TimelineWorkspace({ state }: { state: AppState }) {
  const [view, setView] = useState<ActivityView>('all')
  const [query, setQuery] = useState('')
  const [diagnosticTarget, setDiagnosticTarget] = useState<DiagnosticTarget | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const { openProblems, recentOperations } = useMemo(() => {
    const latestByOperation = new Map<string, ActivityItem>()
    for (const item of state.activity) {
      const key = operationKey(item)
      if (!latestByOperation.has(key)) latestByOperation.set(key, item)
    }
    const grouped = new Map<string, ActivityProblem>()
    for (const item of state.activity) {
      if (!isAttention(item)) continue
      const key = problemKey(item)
      const existing = grouped.get(key)
      if (existing) existing.occurrences.push(item)
      else grouped.set(key, { key, operationKey: operationKey(item), state: problemState(item), latest: item, occurrences: [item] })
    }
    const normalizedQuery = query.trim().toLowerCase()
    const matchesQuery = (item: ActivityItem) => !normalizedQuery || [item.title, item.detail, item.subject?.providerName, item.subject?.model, item.nextStep].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery)
    const problems = [...grouped.values()].map((problem) => ({ ...problem, state: latestByOperation.get(problem.operationKey)?.result === 'success' || latestByOperation.get(problem.operationKey)?.tone === 'success' ? 'recovered' as const : problem.state }))
    return {
      openProblems: problems.filter((problem) => problem.state !== 'recovered' && matchesQuery(problem.latest)),
      recentOperations: state.activity.filter(matchesQuery).slice(0, 40),
    }
  }, [query, state.activity])

  async function copyDiagnostic() {
    if (!diagnosticTarget) return
    try {
      await navigator.clipboard.writeText(copyDiagnosticPackage(diagnosticTarget.item))
      setCopiedId(diagnosticTarget.item.id)
    } catch {
      setCopiedId(null)
    }
  }

  const selectedView = views.find((item) => item.id === view) ?? views[0]
  return (
    <div className="workspace-stack activity-workspace">
      <section className="surface-panel activity-panel" data-guide-target="timeline.list">
        <header className="activity-panel-heading"><div><span className="eyebrow">本机记录</span><h3>操作与诊断记录</h3><p>{selectedView.description}</p></div><small>只保留脱敏后的本机记录，不会记录密钥、配置正文、请求内容或完整响应。</small></header>
        <div className="activity-toolbar"><div className="activity-view-tabs" role="tablist" aria-label="操作与问题视图">{views.map((option) => <button className={view === option.id ? 'active' : ''} type="button" role="tab" aria-selected={view === option.id} key={option.id} onClick={() => setView(option.id)}>{option.label}{option.id === 'needs_attention' && openProblems.length > 0 ? <span>{openProblems.length}</span> : null}</button>)}</div><label><span className="sr-only">搜索操作与问题</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索服务商、模型或原因" /></label></div>
        {view === 'all' ? <section className="activity-section" aria-labelledby="all-operations-title"><div className="activity-section-heading"><div><span className="eyebrow">按时间排列</span><h4 id="all-operations-title">全部操作</h4></div><small>显示最近 {recentOperations.length} 条</small></div><div className="activity-operation-list">{recentOperations.length ? recentOperations.map((item) => <OperationRow key={item.id} item={item} onViewDetail={setDiagnosticTarget} />) : <div className="activity-empty"><strong>没有匹配的操作记录</strong><span>换个关键词再试。</span></div>}</div></section> : <section className="activity-section" aria-labelledby="attention-title"><div className="activity-section-heading"><div><span className="eyebrow">需要你关注</span><h4 id="attention-title">需要处理</h4></div><small>{openProblems.length ? `${openProblems.length} 个问题等待处理` : '现在没有未解决的问题'}</small></div>{openProblems.length ? <div className="activity-problem-list">{openProblems.map((problem) => <ProblemCard key={problem.key} problem={problem} onViewDiagnostic={setDiagnosticTarget} />)}</div> : <div className="activity-clear"><strong>现在没有需要处理的问题</strong><span>新的未确认或失败检查会显示在这里，并自动合并相同原因。</span></div>}</section>}
      </section>
      {diagnosticTarget && <DiagnosticDialog target={diagnosticTarget} copied={copiedId === diagnosticTarget.item.id} onCopy={() => void copyDiagnostic()} onClose={() => setDiagnosticTarget(null)} />}
    </div>
  )
}
