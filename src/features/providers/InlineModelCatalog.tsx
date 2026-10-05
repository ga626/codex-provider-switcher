import { Boxes, Check, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ModelCatalog } from '../../types'
import { codexCompatibility, modelSelectionRank, providerModelLabel } from './model-utils'

export function InlineModelCatalog({ catalog, currentModel, busy, canPersistSelection, joinedCount, onToggleCodexSelection, onSelect }: {
  catalog: ModelCatalog | undefined
  currentModel: string
  busy: boolean
  canPersistSelection: boolean
  joinedCount: number
  onToggleCodexSelection: (model: ModelCatalog['models'][number], enabled: boolean) => Promise<void>
  onSelect: (model: string) => void
}) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const models = useMemo(() => Array.from(new Map((catalog?.models ?? []).map((model) => [model.id, model])).values())
    .filter((model) => !normalizedQuery || [model.id, ...model.aliases, ...model.tags].join(' ').toLocaleLowerCase().includes(normalizedQuery))
    .toSorted((left, right) => modelSelectionRank(left) - modelSelectionRank(right)), [catalog, normalizedQuery])
  const catalogStatus = catalog?.status ?? 'not_fetched'
  const catalogStatusLabel = catalogStatus === 'ok' ? '目录已读取' : catalogStatus === 'stale' ? '目录可能过期' : catalogStatus === 'not_fetched' ? '尚未读取' : '读取需要处理'

  return <>
    <section id="model-options" className="inline-model-catalog" aria-label="默认模型目录">
      <div className="inline-model-catalog-head">
        <div><strong>模型目录</strong><small title={`${catalogStatusLabel}${catalog?.fetchedAt ? ` · 更新于 ${catalog.fetchedAt}` : ''}`}>{models.length} 个 · {joinedCount} 个已加入 Codex</small></div>
        <label className="model-search"><Search size={15} /><input name="model-catalog-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型、厂商或能力" /></label>
      </div>
      <div className="model-table inline-model-table">
        <div className="model-table-head"><span>模型</span><span title="勾选的模型会显示在 Codex 模型列表中">显示在 Codex</span></div>
        {models.length ? models.map((model) => {
            const compatibility = codexCompatibility(model)
            const selected = currentModel.toLocaleLowerCase() === model.id.toLocaleLowerCase()
            const joined = model.codexEnabled ?? defaultCodexSelection(model, currentModel)
            const blocked = compatibility.level === 'unsupported'
            const select = () => { if (!blocked && !selected && !busy) onSelect(model.id) }
            return <div className={`model-row model-selectable ${selected ? 'selected' : ''} ${compatibility.level} ${joined ? 'codex-joined' : ''} ${blocked ? 'model-blocked' : ''}`} key={model.id} role="button" tabIndex={blocked || busy ? -1 : 0} aria-pressed={selected} aria-disabled={blocked || busy} title={compatibility.detail} onClick={select} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select() } }}>
              <span className="model-row-copy"><span className="model-title-line"><strong>{providerModelLabel(model.id)}</strong><em className={`compatibility-badge ${compatibility.level}`}>{compatibility.label}</em></span>{providerModelLabel(model.id) !== model.id && <small>模型标识：{model.id}</small>}{compatibility.level === 'unsupported' && <p className="model-compatibility-copy">{compatibility.summary}</p>}</span>
              <div className="model-row-actions"><label className={`model-join-toggle ${joined ? 'active' : ''}`} title={!canPersistSelection ? '保存服务商后可管理此项' : selected ? '当前默认模型必须保留在列表中' : joined ? '已显示在 Codex 模型列表' : '显示在 Codex 模型列表'} onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={joined} disabled={busy || !canPersistSelection || selected || blocked} onChange={(event) => void onToggleCodexSelection(model, event.currentTarget.checked)} /><span className="model-join-box" aria-hidden="true">{joined && <Check size={11} strokeWidth={2.5} />}</span><span>显示</span></label></div>
            </div>
        }) : <div className="empty-state"><Boxes size={28} /><strong>{normalizedQuery ? '没有匹配的模型' : '还没有可展示的模型'}</strong><span>{normalizedQuery ? '试试更换关键词。' : catalog?.statusDetail ?? '填写连接信息并刷新后，会在这里展示模型。'}</span></div>}
      </div>
    </section>
  </>
}

function defaultCodexSelection(model: ModelCatalog['models'][number], currentModel?: string) {
  return model.id === currentModel || model.tags.includes('codex')
}
