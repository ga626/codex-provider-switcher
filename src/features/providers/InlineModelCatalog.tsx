import { AlertTriangle, Boxes, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ModalDialog } from '../../shared/components'
import type { ModelCatalog } from '../../types'
import { codexCompatibility, modelSelectionRank, providerModelLabel, type CodexCompatibilityLevel } from './model-utils'

const levelOrder: CodexCompatibilityLevel[] = ['verified', 'partial', 'unsupported']
const levelCopy = {
  verified: { title: '已验证' },
  partial: { title: '需确认' },
  unsupported: { title: '暂不可用' },
}

export function InlineModelCatalog({ catalog, currentModel, busy, onSelect }: {
  catalog: ModelCatalog | undefined
  currentModel: string
  busy: boolean
  onSelect: (model: string) => void
}) {
  const [query, setQuery] = useState('')
  const [riskModel, setRiskModel] = useState<ModelCatalog['models'][number] | null>(null)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const models = useMemo(() => Array.from(new Map((catalog?.models ?? []).map((model) => [model.id, model])).values())
    .filter((model) => !normalizedQuery || [model.id, ...model.aliases, ...model.tags].join(' ').toLocaleLowerCase().includes(normalizedQuery))
    .toSorted((left, right) => modelSelectionRank(left) - modelSelectionRank(right)), [catalog, normalizedQuery])
  const grouped = levelOrder.map((level) => ({ level, models: models.filter((model) => codexCompatibility(model).level === level) }))

  function requestModel(model: ModelCatalog['models'][number]) {
    const level = codexCompatibility(model).level
    if (level === 'verified') onSelect(model.id)
    else setRiskModel(model)
  }

  return <>
    {riskModel && <ModelRiskDialog model={riskModel} busy={busy} onCancel={() => setRiskModel(null)} onConfirm={() => {
      const id = riskModel.id
      setRiskModel(null)
      onSelect(id)
    }} />}
    <section id="model-options" className="inline-model-catalog" aria-label="默认模型目录">
      <div className="inline-model-catalog-head">
        <div><strong>模型目录</strong><small>{models.length} 个</small></div>
        <label className="model-search"><Search size={15} /><input name="model-catalog-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型、厂商或能力" /></label>
      </div>
      <div className="model-table inline-model-table">
        {models.length ? grouped.map(({ level, models: levelModels }) => levelModels.length > 0 && <section className={`model-group ${level}`} key={level} aria-labelledby={`inline-model-group-${level}`}>
          <header><strong id={`inline-model-group-${level}`}>{levelCopy[level].title}</strong><b>{levelModels.length}</b></header>
          {levelModels.map((model) => {
            const compatibility = codexCompatibility(model)
            const selected = currentModel.toLocaleLowerCase() === model.id.toLocaleLowerCase()
            return <div className={`model-row ${selected ? 'selected' : ''} ${compatibility.level}`} key={model.id}>
              <span><div className="model-title-line"><strong>{providerModelLabel(model.id)}</strong><em className={`compatibility-badge ${compatibility.level}`}>{compatibility.label}</em></div>{compatibility.level !== 'verified' && <p className="model-compatibility-copy">{compatibility.summary}</p>}{providerModelLabel(model.id) !== model.id && <details className="model-technical-detail"><summary>模型标识</summary><code>{model.id}</code></details>}</span>
              <button className={compatibility.level === 'unsupported' ? 'ghost-button compact-button muted-action' : 'ghost-button compact-button'} type="button" onClick={() => requestModel(model)} disabled={busy || selected}>{selected ? '当前' : compatibility.level === 'verified' ? '选择' : compatibility.level === 'partial' ? '查看风险' : '查看原因'}</button>
            </div>
          })}
        </section>) : <div className="empty-state"><Boxes size={28} /><strong>{normalizedQuery ? '没有匹配的模型' : '还没有可展示的模型'}</strong><span>{normalizedQuery ? '试试更换关键词。' : catalog?.statusDetail ?? '填写连接信息并刷新后，会在这里展示模型。'}</span></div>}
      </div>
    </section>
  </>
}

function ModelRiskDialog({ model, busy, onCancel, onConfirm }: { model: ModelCatalog['models'][number]; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const compatibility = codexCompatibility(model)
  const allow = compatibility.level === 'partial'
  return <ModalDialog className="model-risk-dialog" labelledBy="inline-model-risk-title" onClose={onCancel}><div className="confirm-dialog-icon"><AlertTriangle size={20} /></div><div><span className="eyebrow">{compatibility.label}</span><h2 id="inline-model-risk-title">{providerModelLabel(model.id)} 还不能当作完整 Codex 模型</h2><p>{compatibility.detail}</p><ul className="risk-detail-list">{compatibility.missing.map((item) => <li key={item}>{item}</li>)}</ul>{allow && <p className="switch-after-note">继续只会把它填入默认模型；保存和真正切换时仍会再次检查。</p>}</div><div className="command-row"><button className="ghost-button" type="button" onClick={onCancel} disabled={busy} data-dialog-initial-focus>{allow ? '返回' : '知道了'}</button>{allow && <button className="danger-button" type="button" onClick={onConfirm} disabled={busy}>仍然选择</button>}</div></ModalDialog>
}
