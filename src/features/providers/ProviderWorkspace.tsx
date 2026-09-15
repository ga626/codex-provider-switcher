import {
  ChevronDown,
  Building2,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LogIn,
  MessageSquare,
  PlugZap,
  RefreshCcw,
  Save,
  ShieldCheck,
  Star,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { beginChatGptLogin, deleteProfile, getChatGptLoginStatus, setDefaultProfile } from '../../adapter'
import type { AppState, EditableProfile, ModelCatalog, ProviderProfile } from '../../types'
import type { OperationId } from '../../operations'
import { FieldHint } from '../../shared/components'
import type { NewConnectionKind } from './ConnectionSourceDialog'
import { InlineModelCatalog } from './InlineModelCatalog'

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
  newConnectionKind,
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
  newConnectionKind: NewConnectionKind | null
}) {
  const [keyVisible, setKeyVisible] = useState(false)
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const hasSavedKey = Boolean(selectedProfile?.hasApiKey && !draft.apiKey)
  const keyValue = keyVisible ? revealedKey ?? draft.apiKey : draft.apiKey
  const [modelQuery, setModelQuery] = useState(draft.model)
  const [modelOpen, setModelOpen] = useState(false)
  const [accountLoginState, setAccountLoginState] = useState<'idle' | 'waiting' | 'connected' | 'failed'>('idle')
  const [accountLoginDetail, setAccountLoginDetail] = useState('将在系统浏览器中打开 OpenAI 官方登录页。')
  const loginStatusTimer = useRef<number | null>(null)
  const usesDraftConnection = Boolean(
    !selectedProfile ||
      draft.name.trim() !== selectedProfile.name ||
      draft.baseUrl.trim() !== selectedProfile.baseUrl ||
      draft.apiKey.trim()
  )
  const canRefreshDraftModels = Boolean(
    draft.name.trim() && draft.baseUrl.trim() && draft.apiKey.trim()
  )
  const connectionIdentity = `${selectedProfile?.id ?? ''} ${selectedProfile?.name ?? ''} ${selectedProfile?.baseUrl ?? ''}`.toLocaleLowerCase()
  const isChatGptAccount = newConnectionKind === 'chatgpt-account' || connectionIdentity.includes('chatgpt') || connectionIdentity.includes('oauth')
  const isOfficialApi = newConnectionKind === 'official-api' || [
    'api.deepseek.com',
    'api.openai.com',
    'api.xiaomimimo.com',
    'generativelanguage.googleapis.com',
    'api.x.ai',
  ].some((host) => connectionIdentity.includes(host))

  useEffect(() => {
    setKeyVisible(false)
    setRevealedKey(null)
  }, [selectedProfile?.id])

  useEffect(() => setModelQuery(draft.model), [draft.model])

  useEffect(() => {
    setModelOpen(false)
  }, [selectedProfile?.id, newConnectionKind])

  useEffect(() => () => {
    if (loginStatusTimer.current) window.clearTimeout(loginStatusTimer.current)
  }, [])

  async function pollOfficialLogin(attempt: number) {
    try {
      const status = await getChatGptLoginStatus()
      if (status.state === 'connected') {
        setAccountLoginState('connected')
        setAccountLoginDetail(status.detail)
        return
      }
      if (__CODEX_RELEASE_CHANNEL__ !== 'development' && attempt < 120) {
        setAccountLoginState('waiting')
        setAccountLoginDetail('仍在等待 OpenAI 官方页面完成授权…')
        loginStatusTimer.current = window.setTimeout(() => void pollOfficialLogin(attempt + 1), 2500)
        return
      }
      setAccountLoginState('idle')
      setAccountLoginDetail(status.detail)
    } catch (error) {
      setAccountLoginState('failed')
      setAccountLoginDetail(error instanceof Error ? error.message : '无法确认登录状态，请稍后重试。')
    }
  }

  async function beginOfficialLogin() {
    if (loginStatusTimer.current) window.clearTimeout(loginStatusTimer.current)
    setAccountLoginState('waiting')
    setAccountLoginDetail('正在启动 OpenAI 官方授权流程…')
    try {
      const started = await beginChatGptLogin()
      setAccountLoginDetail(started.detail)
      if (__CODEX_RELEASE_CHANNEL__ !== 'development') {
        loginStatusTimer.current = window.setTimeout(() => void pollOfficialLogin(1), 2500)
      }
    } catch (error) {
      setAccountLoginState('failed')
      setAccountLoginDetail(error instanceof Error ? error.message : '无法启动官方登录，请确认 Codex 已安装。')
    }
  }

  async function checkOfficialLogin() {
    if (loginStatusTimer.current) window.clearTimeout(loginStatusTimer.current)
    setAccountLoginDetail('正在向 Codex 查询登录结果…')
    await pollOfficialLogin(__CODEX_RELEASE_CHANNEL__ === 'development' ? 120 : 1)
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
        <div className="connection-status-icon">{isChatGptAccount ? <LogIn size={20} /> : isOfficialApi ? <Building2 size={20} /> : <PlugZap size={20} />}</div>
        <div className="connection-copy">
          <strong>{selectedProfile?.name ?? (isChatGptAccount ? 'ChatGPT 官方账号' : isOfficialApi ? '厂商官方 API' : '新建中转站')}</strong>
          <small>{isChatGptAccount ? '使用 OpenAI OAuth，不填写 API Key 或中转地址' : draft.baseUrl ? '连接信息已填写' : '填写连接信息后即可保存'}</small>
        </div>
        <div className={`connection-state ${selectedProfile?.active ? 'active' : ''}`}>
          <span className="status-dot" />
          {selectedProfile?.active ? '当前使用中' : '未启用'}
        </div>
      </section>
      <section className={`surface-panel ${isChatGptAccount ? 'chatgpt-login-surface' : ''}`}>
        <div className="section-heading-row">
          <div>
            {!isChatGptAccount && <span className="eyebrow">{isOfficialApi ? '官方 API' : '服务商设置'}</span>}
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
              {accountLoginState === 'waiting' && <button className="ghost-button" type="button" onClick={() => void checkOfficialLogin()}>检查登录结果</button>}
              <button className={accountLoginState === 'connected' ? 'ghost-button' : 'primary-button'} type="button" onClick={() => void beginOfficialLogin()} disabled={accountLoginState === 'waiting'}><LogIn size={16} />{accountLoginState === 'connected' ? '重新登录' : '打开 OpenAI 登录'}</button>
            </div>
          </div>
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
          <label data-tour="provider-base-url" data-guide-target="providers.endpoint">
            <span className="field-label">{isOfficialApi ? '官方接口地址' : '中转接口地址'} <FieldHint text={isOfficialApi ? '由厂商模板预填；只有厂商明确要求时才修改。' : '填写中转站提供的 API 基地址。Codex 连接失败时，可以尝试在末尾补上 /v1。'} /></span>
            <input name="provider-base-url" value={draft.baseUrl} onChange={(event) => updateDraft('baseUrl', event.target.value)} placeholder="https://api.provider.com/v1" />
          </label>
          <label className="model-picker-field" data-tour="provider-model" data-guide-target="providers.model">
            <span className="field-label">默认模型 <FieldHint text={usesDraftConnection ? '填好名称、接口和访问密钥后即可刷新；刷新不会保存配置。' : '刷新只读取模型目录；保存后会作为 Codex 默认模型。'} /></span>
            <div className="model-picker-input">
              <div className="model-combobox-wrap">
                <input name="provider-model" role="combobox" aria-expanded={modelOpen} aria-controls="model-options" value={modelQuery} onChange={(event) => { setModelQuery(event.target.value); updateDraft('model', event.target.value) }} onKeyDown={(event) => { if (event.key === 'Escape') setModelOpen(false) }} placeholder="输入模型标识，或展开目录选择" />
                <button className={`model-open-button ${modelOpen ? 'open' : ''}`} type="button" aria-label={modelOpen ? '收起模型目录' : '展开模型目录'} aria-controls="model-options" onClick={() => setModelOpen((open) => !open)}><ChevronDown size={16} /></button>
              </div>
              <button className="ghost-button model-refresh-button" type="button" aria-label="刷新模型目录" title={usesDraftConnection ? '使用当前填写的接口和密钥刷新模型目录，不会保存配置' : '刷新已保存服务商的模型目录'} disabled={busy !== null || (usesDraftConnection ? !canRefreshDraftModels : !selectedProfile)} onClick={onRefreshModels}><RefreshCcw size={16} /></button>
            </div>
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
          {modelOpen && <div className="wide inline-model-catalog-slot"><InlineModelCatalog catalog={selectedModelCatalog} currentModel={draft.model} busy={busy !== null} onSelect={(model) => { setModelQuery(model); updateDraft('model', model); setModelOpen(false) }} /></div>}
          <label className="wide">
            备注
            <textarea name="provider-note" value={draft.note} onChange={(event) => updateDraft('note', event.target.value)} rows={3} placeholder="用于识别这条连接" />
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
        </>}
      </section>
    </div>
  )
}
