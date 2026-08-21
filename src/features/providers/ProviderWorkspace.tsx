import {
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  MessageSquare,
  PlugZap,
  RefreshCcw,
  Save,
  ShieldCheck,
  Star,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { deleteProfile, setDefaultProfile } from '../../adapter'
import type { AppState, EditableProfile, ModelCatalog, ProviderProfile } from '../../types'
import type { OperationId } from '../../operations'
import { FieldHint } from '../../shared/components'

export function ProviderWorkspace({
  draft,
  selectedProfile,
  busy,
  updateDraft,
  saveCurrentProfile,
  duplicateProfile,
  runAction,
  revealApiKey,
  selectedModelCatalog,
  onRefreshModels,
  environment,
  onOpenSetup,
  onOpenFeedback,
  feedbackAvailable,
}: {
  draft: EditableProfile
  selectedProfile: ProviderProfile | undefined
  busy: string | null
  updateDraft: <K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) => void
  saveCurrentProfile: () => Promise<void>
  duplicateProfile: () => void
  runAction: (label: OperationId, action: () => Promise<AppState>) => Promise<void>
  revealApiKey: (profileId: string) => Promise<string | null>
  selectedModelCatalog: ModelCatalog | undefined
  onRefreshModels: () => void
  environment: AppState['connectionEnvironment']
  onOpenSetup: () => void
  onOpenFeedback: () => void
  feedbackAvailable: boolean
}) {
  const [keyVisible, setKeyVisible] = useState(false)
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const hasSavedKey = Boolean(selectedProfile?.hasApiKey && !draft.apiKey)
  const keyValue = keyVisible ? revealedKey ?? draft.apiKey : draft.apiKey
  const [modelQuery, setModelQuery] = useState(draft.model)
  const [modelOpen, setModelOpen] = useState(false)
  const [modelSearchActive, setModelSearchActive] = useState(false)
  const usesDraftConnection = Boolean(
    !selectedProfile ||
      draft.name.trim() !== selectedProfile.name ||
      draft.baseUrl.trim() !== selectedProfile.baseUrl ||
      draft.apiKey.trim()
  )
  const canRefreshDraftModels = Boolean(
    draft.name.trim() && draft.baseUrl.trim() && draft.apiKey.trim()
  )
  const filteredModels = useMemo(() => {
    // Opening the picker shows the full catalog. Typing explicitly activates
    // filtering so a query identical to the selected model still works.
    const query = modelOpen && modelSearchActive ? modelQuery.trim().toLowerCase() : ''
    if (!query) return selectedModelCatalog?.models.slice(0, 8) ?? []
    return (selectedModelCatalog?.models ?? []).filter((model) => [model.id, ...model.aliases, ...model.tags].some((value) => value.toLowerCase().includes(query))).slice(0, 8)
  }, [modelOpen, modelQuery, modelSearchActive, selectedModelCatalog])

  useEffect(() => {
    setKeyVisible(false)
    setRevealedKey(null)
  }, [selectedProfile?.id])

  useEffect(() => setModelQuery(draft.model), [draft.model])

  async function toggleKeyVisibility() {
    if (keyVisible) {
      setKeyVisible(false)
      return
    }
    if (revealedKey || draft.apiKey) {
      setKeyVisible(true)
      return
    }
    if (!selectedProfile?.hasApiKey) return
    const value = await revealApiKey(selectedProfile.id)
    if (value) {
      setRevealedKey(value)
      setKeyVisible(true)
    }
  }

  return (
    <div className="workspace-stack">
      {environment.status !== 'ready' && <section className={`environment-setup ${environment.status}`} data-tour="environment-setup" data-guide-target="providers.environment">
        <div>
          <span className="setup-step-number">1</span>
          <div className="setup-copy"><strong>先准备连接环境</strong>
          <p>{environment.detail}</p>
          </div>
        </div>
        <button className="primary-button" type="button" disabled={busy !== null} onClick={onOpenSetup} data-tour="environment-setup-action" data-guide-target="providers.environment"><ShieldCheck size={16} />一键准备连接环境</button>
      </section>}
      <section className="connection-banner">
        <div className="connection-status-icon"><PlugZap size={20} /></div>
        <div className="connection-copy">
          <strong>{selectedProfile?.name ?? '新建服务商'}</strong>
          <small>{draft.baseUrl ? '连接信息已填写' : '填写连接信息后即可保存'}</small>
        </div>
        <div className={`connection-state ${selectedProfile?.active ? 'active' : ''}`}>
          <span className="status-dot" />
          {selectedProfile?.active ? '当前使用中' : '未启用'}
        </div>
      </section>
      <section className="surface-panel">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">服务商设置</span>
            <h3>基础配置</h3>
          </div>
           <span className="section-meta">凭据仅保存在此设备</span>
        </div>
        <div className="form-grid" data-tour="provider-form" data-guide-target="providers.form">
          <label data-tour="provider-name" data-guide-target="providers.name">
            <span className="field-label">服务商名称 <FieldHint text="给这条连接起一个容易识别的名称，只保存在本机，不会发送给服务商。" /></span>
            <input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder="输入服务商名称" />
          </label>
          <label data-tour="provider-base-url" data-guide-target="providers.endpoint">
            <span className="field-label">接口地址 <FieldHint text="填写服务商提供的 API 基地址。Codex 连接失败时，可以尝试在末尾补上 /v1。" /></span>
            <input value={draft.baseUrl} onChange={(event) => updateDraft('baseUrl', event.target.value)} placeholder="https://api.provider.com/v1" />
          </label>
          <label className="model-picker-field" data-tour="provider-model" data-guide-target="providers.model">
            <span className="field-label">默认模型 <FieldHint text={usesDraftConnection ? '填好名称、接口和访问密钥后即可刷新；刷新不会保存配置。' : '刷新只读取模型目录；保存后会作为 Codex 默认模型。'} /></span>
            <div className="model-picker-input">
              <div className="model-combobox-wrap">
                <input role="combobox" aria-expanded={modelOpen} aria-controls="model-options" value={modelQuery} onFocus={() => { setModelOpen(true); setModelSearchActive(false) }} onChange={(event) => { setModelOpen(true); setModelSearchActive(true); setModelQuery(event.target.value); updateDraft('model', event.target.value) }} onKeyDown={(event) => { if (event.key === 'Escape') { setModelOpen(false); setModelSearchActive(false) }; if (event.key === 'Enter' && filteredModels[0]) { setModelQuery(filteredModels[0].id); updateDraft('model', filteredModels[0].id); setModelOpen(false); setModelSearchActive(false) } }} placeholder="输入 5.6 搜索模型" />
                <button className="model-open-button" type="button" aria-label={modelOpen ? '收起模型列表' : '展开模型列表'} onMouseDown={(event) => event.preventDefault()} onClick={() => setModelOpen((open) => { setModelSearchActive(false); return !open })}><ChevronDown size={16} /></button>
                {modelOpen && <div id="model-options" className="model-suggestions scroll-region" role="listbox" aria-label="可选模型">
                  {filteredModels.length > 0 ? filteredModels.map((model) => <button key={model.id} type="button" role="option" aria-selected={model.id === draft.model} onClick={() => { setModelQuery(model.id); updateDraft('model', model.id); setModelOpen(false); setModelSearchActive(false) }}><strong>{model.id}</strong></button>) : <span className="model-empty">没有匹配的模型，可直接手动输入。</span>}
                </div>}
              </div>
              <button className="ghost-button model-refresh-button" type="button" aria-label="刷新模型目录" title={usesDraftConnection ? '使用当前填写的接口和密钥刷新模型目录，不会保存配置' : '刷新已保存服务商的模型目录'} disabled={busy !== null || (usesDraftConnection ? !canRefreshDraftModels : !selectedProfile)} onClick={onRefreshModels}><RefreshCcw size={16} /></button>
            </div>
          </label>
          <label data-tour="provider-api-key" data-guide-target="providers.key">
            <span className="field-label">访问密钥 <FieldHint text="填写服务商提供的访问密钥。它只保存在本机，用于刷新模型目录和执行连接检查。" /></span>
            <div className="key-field">
              <KeyRound size={15} />
              <input
                value={keyValue}
                onChange={(event) => {
                  setRevealedKey(null)
                  updateDraft('apiKey', event.target.value)
                }}
                placeholder={hasSavedKey ? '••••••••••••' : '粘贴访问密钥'}
                type={keyVisible ? 'text' : 'password'}
                aria-label={hasSavedKey ? '已保存访问密钥，输入新密钥即可替换' : '访问密钥'}
              />
              <button
                className="icon-button key-visibility-button"
                type="button"
                onClick={() => void toggleKeyVisibility()}
                disabled={busy !== null || (!draft.apiKey && !selectedProfile?.hasApiKey)}
                title={keyVisible ? '隐藏访问密钥' : '显示访问密钥'}
                aria-label={keyVisible ? '隐藏访问密钥' : '显示访问密钥'}
              >
                {keyVisible ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>
          <label className="wide">
            备注
            <textarea value={draft.note} onChange={(event) => updateDraft('note', event.target.value)} rows={3} placeholder="用于识别这条连接" />
          </label>
        </div>
        <div className="command-row" data-guide-target="providers.actions">
          <button className="primary-button" type="button" disabled={!draft.name || !draft.baseUrl || busy !== null} onClick={() => void saveCurrentProfile()} data-tour="save-provider" data-guide-target="providers.save">
            <Save size={16} />
            保存更改
          </button>
          <button className="ghost-button" type="button" onClick={duplicateProfile} disabled={!selectedProfile || busy !== null}>
            <Copy size={16} />
            复制配置
          </button>
          <button
            className="ghost-button"
            type="button"
            onClick={() => selectedProfile && runAction('default', () => setDefaultProfile(selectedProfile.id))}
            disabled={!selectedProfile || selectedProfile.isDefault || busy !== null}
          >
            <Star size={16} />
            设为默认
          </button>
          <button
            className="danger-button"
            type="button"
            onClick={() => selectedProfile && runAction('delete', () => deleteProfile(selectedProfile.id))}
            disabled={!selectedProfile || selectedProfile.active || selectedProfile.isDefault || busy !== null}
          >
            <Trash2 size={16} />
            删除服务商
          </button>
          {feedbackAvailable && <button className="ghost-button feedback-action" type="button" onClick={onOpenFeedback} disabled={busy !== null} data-guide-target="providers.feedback">
            <MessageSquare size={16} />
            报告兼容问题
          </button>}
        </div>
      </section>
    </div>
  )
}
