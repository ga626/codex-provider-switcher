import {
  ChevronDown,
  Building2,
  Copy,
  Download,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  LogIn,
  MessageSquare,
  PlugZap,
  Save,
  ShieldCheck,
  Star,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { activateOfficialProvider, cancelChatGptLogin, beginChatGptLogin, deleteProfile, getChatGptLoginStatus, setDefaultProfile } from '../../adapter'
import type { AppState, ChatGptLoginStatus, EditableProfile, ModelCatalog, ProviderProfile } from '../../types'
import type { OperationId } from '../../operations'
import { FieldHint } from '../../shared/components'
import type { NewConnectionKind } from './ConnectionSourceDialog'
import { InlineModelCatalog } from './InlineModelCatalog'
import { providerConnectionKind } from './provider-utils'
import { codexCompatibility } from './model-utils'

const officialApiPresets = [
  { id: 'deepseek', label: 'DeepSeek 官方 API', name: 'DeepSeek 官方 API', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'openai', label: 'OpenAI Platform API', name: 'OpenAI Platform API', baseUrl: 'https://api.openai.com/v1' },
  { id: 'mimo', label: '小米 MiMo 官方 API', name: '小米 MiMo 官方 API', baseUrl: 'https://api.xiaomimimo.com/v1' },
  { id: 'gemini', label: 'Google Gemini 官方 API', name: 'Google Gemini 官方 API', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'grok', label: 'xAI Grok 官方 API', name: 'xAI Grok 官方 API', baseUrl: 'https://api.x.ai/v1' },
] as const

export function ProviderWorkspace({
  draft,
  selectedProfile,
  activeProviderName,
  busy,
  updateDraft,
  saveCurrentProfile,
  duplicateProfile,
  runAction,
  revealApiKey,
  selectedModelCatalog,
  onRefreshModels,
  onVerify,
  onToggleCodexSelection,
  environment,
  onOpenSetup,
  onOpenFeedback,
  feedbackAvailable,
  newConnectionKind,
}: {
  draft: EditableProfile
  selectedProfile: ProviderProfile | undefined
  activeProviderName?: string
  busy: string | null
  updateDraft: <K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) => void
  saveCurrentProfile: () => Promise<void>
  duplicateProfile: () => void
  runAction: (label: OperationId, action: () => Promise<AppState>) => Promise<void>
  revealApiKey: (profileId: string) => Promise<string | null>
  selectedModelCatalog: ModelCatalog | undefined
  onRefreshModels: () => void
  onVerify: () => void
  onToggleCodexSelection: (model: ModelCatalog['models'][number], enabled: boolean) => Promise<void>
  environment: AppState['connectionEnvironment']
  onOpenSetup: () => void
  onOpenFeedback: () => void
  feedbackAvailable: boolean
  newConnectionKind: NewConnectionKind | null
}) {
  const [keyVisible, setKeyVisible] = useState(false)
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const hasSavedKey = Boolean(selectedProfile?.hasApiKey && !draft.apiKey)
  const keyValue = keyVisible ? revealedKey ?? draft.apiKey : draft.apiKey
  const [modelQuery, setModelQuery] = useState(draft.model)
  const [modelOpen, setModelOpen] = useState(false)
  const [fullUrlMode, setFullUrlMode] = useState(draft.endpointMode === 'full')
  const [endpointTesting, setEndpointTesting] = useState(false)
  const [accountLoginState, setAccountLoginState] = useState<'idle' | 'waiting' | 'connected' | 'failed'>('idle')
  const [accountLoginDetail, setAccountLoginDetail] = useState('正在确认 Codex 与官方账号状态…')
  const [accountRuntime, setAccountRuntime] = useState<ChatGptLoginStatus | null>(null)
  const [officialModel, setOfficialModel] = useState('')
  const loginStatusTimer = useRef<number | null>(null)
  const loginGeneration = useRef(0)
  const usesDraftConnection = Boolean(
    !selectedProfile ||
      draft.name.trim() !== selectedProfile.name ||
      draft.baseUrl.trim() !== selectedProfile.baseUrl ||
      draft.apiKey.trim()
  )
  const canRefreshDraftModels = Boolean(
    draft.name.trim() && draft.baseUrl.trim() && draft.apiKey.trim()
  )
  const selectedConnectionKind = selectedProfile ? providerConnectionKind(selectedProfile) : null
  const isChatGptAccount = newConnectionKind === 'chatgpt-account' || selectedConnectionKind === 'chatgpt-account'
  const isOfficialApi = newConnectionKind === 'official-api' || selectedConnectionKind === 'official-api'
  const endpointLatency = selectedProfile?.capabilityProfile?.responseHeaderMs ?? selectedProfile?.capabilityProfile?.totalMs
  const endpointStatus = selectedProfile?.verificationStatus === 'verified' ? 'success' : selectedProfile?.verificationStatus && selectedProfile.verificationStatus !== 'not_checked' ? 'warning' : 'idle'

  useEffect(() => {
    setKeyVisible(false)
    setRevealedKey(null)
  }, [selectedProfile?.id])

  useEffect(() => setModelQuery(draft.model), [draft.model])

  useEffect(() => {
    setFullUrlMode(draft.endpointMode === 'full')
  }, [draft.endpointMode, selectedProfile?.id])

  useEffect(() => {
    setModelOpen(false)
  }, [selectedProfile?.id, newConnectionKind])

  const catalogJoinedCount = selectedModelCatalog?.models.filter((model) => model.codexEnabled ?? (model.id === draft.model || model.tags.includes('codex'))).length ?? 0
  const currentCatalogModel = selectedModelCatalog?.models.find((model) => model.id.toLocaleLowerCase() === draft.model.trim().toLocaleLowerCase())
  const currentCompatibility = currentCatalogModel ? codexCompatibility(currentCatalogModel) : null

  useEffect(() => () => {
    loginGeneration.current += 1
    if (loginStatusTimer.current) window.clearTimeout(loginStatusTimer.current)
  }, [])

  useEffect(() => {
    if (!isChatGptAccount) return
    let cancelled = false
    const generation = ++loginGeneration.current
    if (loginStatusTimer.current) window.clearTimeout(loginStatusTimer.current)
    void getChatGptLoginStatus().then((status) => {
      if (cancelled || generation !== loginGeneration.current) return
      setAccountRuntime(status)
      setAccountLoginState(status.state === 'connected' ? 'connected' : 'idle')
      setAccountLoginDetail(status.detail)
      if (status.state === 'waiting') {
        setAccountLoginState('waiting')
        loginStatusTimer.current = window.setTimeout(() => void pollOfficialLogin(1, generation), 1500)
      } else loginStatusTimer.current = window.setTimeout(() => void pollOfficialLogin(1, generation), 2500)
    }).catch((error) => {
      if (cancelled || generation !== loginGeneration.current) return
      setAccountLoginState('failed')
      setAccountLoginDetail(error instanceof Error ? error.message : '无法确认 Codex 登录状态。')
    })
    return () => { cancelled = true }
  }, [isChatGptAccount])

  async function pollOfficialLogin(attempt: number, generation: number) {
    try {
      const status = await getChatGptLoginStatus()
      if (generation !== loginGeneration.current) return
      setAccountRuntime(status)
      if (status.state === 'connected') {
        setAccountLoginState('connected')
        setAccountLoginDetail(status.detail)
        loginStatusTimer.current = window.setTimeout(() => void pollOfficialLogin(attempt + 1, generation), 2500)
        return
      }
      if (status.state === 'waiting') {
        setAccountLoginState('waiting')
        setAccountLoginDetail('仍在等待 OpenAI 官方页面完成授权…')
        loginStatusTimer.current = window.setTimeout(() => void pollOfficialLogin(attempt + 1, generation), 1500)
        return
      }
      setAccountLoginState('idle')
      setAccountLoginDetail(status.detail)
      loginStatusTimer.current = window.setTimeout(() => void pollOfficialLogin(attempt + 1, generation), 2500)
    } catch (error) {
      if (generation !== loginGeneration.current) return
      setAccountLoginState('failed')
      setAccountLoginDetail(error instanceof Error ? error.message : '无法确认登录状态，请稍后重试。')
      loginStatusTimer.current = window.setTimeout(() => void pollOfficialLogin(attempt + 1, generation), 5000)
    }
  }

  async function beginOfficialLogin() {
    const generation = ++loginGeneration.current
    if (loginStatusTimer.current) window.clearTimeout(loginStatusTimer.current)
    try {
      setAccountLoginDetail('正在检查隔离副本的登录状态…')
      const current = await getChatGptLoginStatus()
      if (generation !== loginGeneration.current) return
      setAccountRuntime(current)
      if (current.state === 'connected') {
        setAccountLoginState('connected')
        setAccountLoginDetail(current.detail)
        return
      }
      if (current.state === 'waiting') {
        setAccountLoginState('waiting')
        setAccountLoginDetail('登录流程已在运行，继续等待浏览器授权；不会再打开新窗口。')
        loginStatusTimer.current = window.setTimeout(() => void pollOfficialLogin(1, generation), 1500)
        return
      }
      setAccountLoginState('waiting')
      setAccountLoginDetail('正在启动 OpenAI 官方授权流程…')
      const started = await beginChatGptLogin()
      if (generation !== loginGeneration.current) return
      setAccountRuntime(started)
      setAccountLoginState(started.state === 'connected' ? 'connected' : started.state === 'waiting' ? 'waiting' : 'failed')
      setAccountLoginDetail(started.detail)
      if (started.state === 'waiting') loginStatusTimer.current = window.setTimeout(() => void pollOfficialLogin(1, generation), 1500)
    } catch (error) {
      if (generation !== loginGeneration.current) return
      setAccountLoginState('failed')
      setAccountLoginDetail(error instanceof Error ? error.message : '无法启动官方登录，请确认 Codex 已安装。')
    }
  }

  async function checkOfficialLogin() {
    const generation = ++loginGeneration.current
    if (loginStatusTimer.current) window.clearTimeout(loginStatusTimer.current)
    setAccountLoginDetail('正在向 Codex 查询登录结果…')
    await pollOfficialLogin(1, generation)
  }

  async function cancelOfficialLogin() {
    const generation = ++loginGeneration.current
    if (loginStatusTimer.current) window.clearTimeout(loginStatusTimer.current)
    try {
      await cancelChatGptLogin()
      if (generation !== loginGeneration.current) return
      setAccountLoginState('idle')
      setAccountLoginDetail('已取消等待；没有登出已有账号。')
      loginStatusTimer.current = window.setTimeout(() => void pollOfficialLogin(1, generation), 2500)
    } catch (error) {
      if (generation !== loginGeneration.current) return
      setAccountLoginState('failed')
      setAccountLoginDetail(error instanceof Error ? error.message : '未能取消登录，请重试。')
    }
  }

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

  function runEndpointTest() {
    if (endpointTesting || !selectedProfile || busy !== null) return
    setEndpointTesting(true)
    onVerify()
    window.setTimeout(() => setEndpointTesting(false), 900)
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
      <section className="connection-summary" aria-label="当前连接与变更范围">
        <div className="connection-banner">
          <div className="connection-status-icon">{isChatGptAccount ? <LogIn size={20} /> : isOfficialApi ? <Building2 size={20} /> : <PlugZap size={20} />}</div>
          <div className="connection-copy">
            <strong>{selectedProfile?.name ?? (isChatGptAccount ? 'ChatGPT 官方账号' : isOfficialApi ? '厂商官方 API' : '新建中转站')}</strong>
            <small>{isChatGptAccount ? '使用 OpenAI OAuth，不填写 API Key 或中转地址' : draft.baseUrl ? '连接信息已填写' : '填写连接信息后即可保存'}</small>
          </div>
          <div className={`connection-state ${(isChatGptAccount ? accountLoginState === 'connected' : selectedProfile?.active) ? 'active' : ''}`}>
            <span className="status-dot" />
            {isChatGptAccount ? (accountLoginState === 'connected' ? '身份已连接' : accountLoginState === 'waiting' ? '等待授权' : '未连接') : selectedProfile?.active ? '当前使用中' : '未启用'}
          </div>
        </div>
        <div className="connection-scope" aria-label="本次连接变更范围">
          <span><small>会更新</small><strong>服务商、接口地址、默认模型</strong></span>
          <span><small>会保留</small><strong>官方登录、MCP、插件、Skill、历史</strong></span>
        </div>
      </section>
      <section className={`surface-panel ${isChatGptAccount ? 'chatgpt-login-surface' : ''}`}>
        <div className="section-heading-row">
          <div>
            <h3>{isChatGptAccount ? '官方账号登录' : '基础配置'}</h3>
          </div>
           <span className="section-meta">{isChatGptAccount ? '账号密码仅在 OpenAI 页面输入' : '凭据仅保存在此设备'}</span>
        </div>
        {isChatGptAccount ? <div className="chatgpt-account-setup" data-tour="provider-form" data-guide-target="providers.form">
          <ol className="oauth-login-steps" aria-label="ChatGPT 官方账号登录步骤">
            <li className={accountLoginState !== 'idle' && accountLoginState !== 'failed' ? 'complete' : 'current'}><span>1</span><strong>打开登录</strong></li>
            <li className={accountLoginState === 'waiting' ? 'current' : accountLoginState === 'connected' ? 'complete' : ''}><span>2</span><strong>浏览器授权</strong></li>
            <li className={accountLoginState === 'connected' ? 'complete' : ''}><span>3</span><strong>自动确认</strong></li>
          </ol>
          <div className={`oauth-login-panel ${accountLoginState}`}>
            <div><span className="oauth-login-state-dot" /><span><strong>{accountLoginState === 'connected' ? 'Codex 已确认官方账号' : accountLoginState === 'waiting' ? '等待你在浏览器授权' : accountLoginState === 'failed' ? '登录未完成' : '尚未开始登录'}</strong><small>{accountLoginDetail}</small></span></div>
            <div className="oauth-login-actions">
              {accountLoginState === 'waiting' && <button className="ghost-button" type="button" onClick={() => void cancelOfficialLogin()}>取消登录</button>}
              {accountLoginState === 'waiting' && <button className="ghost-button" type="button" onClick={() => void checkOfficialLogin()}>检查登录结果</button>}
              <button className={accountLoginState === 'connected' ? 'ghost-button' : 'primary-button'} type="button" onClick={() => void beginOfficialLogin()} disabled={accountLoginState === 'waiting'}><LogIn size={16} />{accountLoginState === 'connected' ? '已连接' : '打开 OpenAI 登录'}</button>
            </div>
          </div>
          {accountLoginState === 'connected' && <div className="form-grid">
            <label><span className="field-label">官方模型标识</span><input value={officialModel} onChange={e => setOfficialModel(e.target.value)} placeholder="填写此账号可用的 Codex 模型" /></label>
            <button className="primary-button" type="button" disabled={busy !== null || !officialModel.trim()} onClick={() => { if (window.confirm('将创建恢复点并选择官方推理通道；重启目标 Codex 后生效。继续？')) void runAction('save', () => activateOfficialProvider(officialModel)) }}>使用官方模型</button>
          </div>}
          {accountRuntime?.codexVersion && <div className="oauth-runtime-summary">
            <span><strong>Codex</strong>{accountRuntime.codexVersion}</span>
            <span><strong>发现方式</strong>{accountRuntime.executableSource ?? '已验证安装'}</span>
            <span><strong>当前模式</strong>{accountLoginState === 'connected' && activeProviderName ? `官方身份已保留 · ${activeProviderName} 提供模型` : accountLoginState === 'connected' ? '官方身份已连接 · 请求通道另行确认' : activeProviderName ? `仅 ${activeProviderName} 提供模型` : '尚未建立连接'}</span>
          </div>}
          <details className="chatgpt-login-details">
            <summary>登录与配置说明</summary>
            <div className="chatgpt-login-details-body">
              <p>浏览器已有登录状态时通常只需确认；否则需要在 OpenAI 官方页面输入账号密码。</p>
              <dl className="chatgpt-account-facts"><div><dt>认证</dt><dd>OpenAI OAuth</dd></div><div><dt>请求去向</dt><dd>官方 Codex 后端</dd></div><div><dt>计费</dt><dd>ChatGPT 计划 / 工作区</dd></div></dl>
              <p className="chatgpt-account-preserve"><ShieldCheck size={16} /><span>MCP、插件、钩子、项目、偏好和本地历史不会因账号切换而删除。</span></p>
            </div>
          </details>
        </div> : <>
        <div className="form-grid" data-tour="provider-form" data-guide-target="providers.form">
          {isOfficialApi && <label className="wide official-provider-preset">
            <span className="field-label">选择厂商 <FieldHint text="厂商模板会预填官方接口地址；你仍需使用该厂商自己的 API Key。" /></span>
            <select name="official-api-provider" value={officialApiPresets.find((preset) => preset.baseUrl === draft.baseUrl)?.id ?? ''} onChange={(event) => {
              const preset = officialApiPresets.find((item) => item.id === event.target.value)
              if (!preset) return
              updateDraft('name', preset.name)
              updateDraft('baseUrl', preset.baseUrl)
            }}>
              <option value="" disabled>选择官方 API 厂商</option>
              {officialApiPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
            </select>
          </label>}
          <label data-tour="provider-name" data-guide-target="providers.name">
            <span className="field-label">{isOfficialApi ? '连接名称' : '中转站名称'} <FieldHint text="给这条连接起一个容易识别的名称，只保存在本机，不会发送给服务商。" /></span>
            <input name="provider-name" value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder="输入服务商名称" />
          </label>
          <label data-tour="provider-api-key" data-guide-target="providers.key">
            <span className="field-label">{isOfficialApi ? '厂商 API Key' : '中转站 API Key'} <FieldHint text="填写当前连接提供的访问密钥。它只保存在本机，用于刷新模型目录和执行连接检查。" /></span>
            <div className="key-field">
              <KeyRound size={15} />
              <input
                name="provider-api-key"
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
          <div className="endpoint-field wide provider-form-field" data-tour="provider-base-url" data-guide-target="providers.endpoint">
            <div className="field-label endpoint-heading"><span>{isOfficialApi ? '官方接口地址' : '中转接口地址'} <FieldHint text={isOfficialApi ? '由厂商模板预填；只有厂商明确要求时才修改。' : '自动模式会尝试带 /v1 和不带 /v1 的标准接口；完整 URL 模式按你填写的地址请求。'} /></span>
              <label className="endpoint-toggle" title={fullUrlMode ? '按填写地址请求，不自动补 /v1' : '自动匹配接口路径'}><input type="checkbox" checked={fullUrlMode} onChange={(event) => { const full = event.currentTarget.checked; setFullUrlMode(full); updateDraft('endpointMode', full ? 'full' : 'auto') }} /><span>完整 URL</span></label>
            </div>
            <div className="endpoint-input-row">
              <input name="provider-base-url" aria-label={isOfficialApi ? '官方接口地址' : '中转接口地址'} value={draft.baseUrl} onChange={(event) => updateDraft('baseUrl', event.target.value)} placeholder="https://api.provider.com" />
              <button className={`endpoint-speed-button ${endpointStatus}`} type="button" onClick={runEndpointTest} disabled={busy !== null || endpointTesting || !selectedProfile} title={endpointLatency ? `最近响应 ${endpointLatency} ms；点击重新测速` : '运行连接测速'} aria-label="运行连接测速"><Gauge size={16} className={endpointTesting ? 'spin' : ''} /><span>{endpointTesting ? '测速中' : endpointLatency ? `${endpointLatency} ms` : '测速'}</span></button>
            </div>
          </div>
          <div className="model-picker-field wide provider-form-field" data-tour="provider-model" data-guide-target="providers.model">
            <span className="field-label">默认模型 <FieldHint text={usesDraftConnection ? '填好名称、接口和访问密钥后即可获取模型列表。' : '获取只读取模型目录；保存后会作为 Codex 默认模型。'} />
              {draft.model.trim() && <span className={`current-model-compatibility ${currentCompatibility?.level ?? 'unknown'}`} title={currentCompatibility?.detail ?? '获取模型列表后可确认此模型的接入类型。'}>{currentCompatibility?.label ?? '目录未确认'}</span>}
            </span>
            <div className="model-picker-input">
              <div className="model-combobox-wrap">
                <input name="provider-model" aria-label="默认模型" role="combobox" aria-expanded={modelOpen} aria-controls="model-options" value={modelQuery} onChange={(event) => { setModelQuery(event.target.value); updateDraft('model', event.target.value) }} onKeyDown={(event) => { if (event.key === 'Escape') setModelOpen(false) }} placeholder="输入模型标识，或打开列表选择" />
                <button className={`model-open-button ${modelOpen ? 'open' : ''}`} type="button" aria-label={modelOpen ? '收起模型目录' : '展开模型目录'} aria-controls="model-options" onClick={() => setModelOpen((open) => !open)}><ChevronDown size={16} /></button>
              </div>
              <button className="model-download-button" type="button" aria-label="获取模型列表" title={usesDraftConnection ? '获取当前填写接口返回的模型列表' : '获取已保存服务商的模型列表'} disabled={busy !== null || (usesDraftConnection ? !canRefreshDraftModels : !selectedProfile)} onClick={() => { setModelOpen(true); onRefreshModels() }}><Download size={16} /></button>
            </div>
          </div>
          {modelOpen && <div className="wide inline-model-catalog-slot"><InlineModelCatalog catalog={selectedModelCatalog} currentModel={draft.model} busy={busy !== null} canPersistSelection={!usesDraftConnection && Boolean(selectedProfile) && selectedModelCatalog?.providerId === selectedProfile?.id} joinedCount={catalogJoinedCount} onToggleCodexSelection={onToggleCodexSelection} onSelect={(model) => { setModelQuery(model); updateDraft('model', model); setModelOpen(false) }} /></div>}
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
        </>}
      </section>
    </div>
  )
}
