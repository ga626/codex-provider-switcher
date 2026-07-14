import {
  AlertTriangle,
  ArchiveRestore,
  CheckCircle2,
  Copy,
  KeyRound,
  PanelRightOpen,
  PlugZap,
  Plus,
  RefreshCcw,
  Save,
  ShieldCheck,
  Star,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import './App.css'
import {
  deleteProfile,
  loadState,
  refreshModels,
  restoreLatestBackup,
  saveProfile,
  setDefaultProfile,
  switchProfile,
  verifyProfile,
} from './adapter'
import type { AppState, EditableProfile, ModelCatalog, ProviderProfile, ValidationCheck } from './types'

const emptyProfile: EditableProfile = {
  id: '',
  name: '',
  baseUrl: '',
  model: '',
  note: '',
  apiKey: '',
}

function getCheckVisual(check: { ok: boolean; severity: 'required' | 'warning' | 'info' }) {
  if (check.ok) {
    return { icon: <CheckCircle2 className="ok-icon" size={18} />, className: 'check-ok' }
  }

  if (check.severity === 'warning' || check.severity === 'info') {
    return { icon: <AlertTriangle className="warn-icon" size={18} />, className: 'check-warn' }
  }

  return { icon: <XCircle className="danger-icon" size={18} />, className: 'check-bad' }
}

function toEditable(profile: ProviderProfile): EditableProfile {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    note: profile.note,
    apiKey: '',
  }
}

function profileChecks(
  profile: ProviderProfile | undefined,
  draft: EditableProfile,
  modelCatalog: ModelCatalog | undefined
): ValidationCheck[] {
  if (!profile && !draft.name && !draft.baseUrl) {
    return []
  }

  const name = draft.name.trim()
  const baseUrl = draft.baseUrl.trim()
  const model = draft.model.trim()
  const hasKey = draft.apiKey.trim().length > 0 || Boolean(profile?.hasApiKey)

  const checks: ValidationCheck[] = [
    {
      id: 'profile-name',
      label: '服务商名称',
      ok: name.length > 0,
      detail: name.length > 0 ? `当前选择：${name}` : '需要填写服务商名称。',
      severity: 'required' as const,
    },
    {
      id: 'profile-base-url',
      label: '接口地址',
      ok: /^https?:\/\/\S+/i.test(baseUrl),
      detail: /^https?:\/\/\S+/i.test(baseUrl) ? baseUrl : '需要填写 http 或 https 开头的接口地址。',
      severity: 'required' as const,
    },
    {
      id: 'profile-model',
      label: '模型名称',
      ok: model.length > 0,
      detail: model.length > 0 ? model : '需要填写 Codex 使用的模型名称。',
      severity: 'required' as const,
    },
    {
      id: 'profile-api-key',
      label: 'API 密钥',
      ok: hasKey,
      detail: hasKey ? '已保存密钥或本次已输入新密钥。' : '切换前必须保存 API 密钥。',
      severity: 'required' as const,
    },
  ]

  if (model.length > 0 && modelCatalog?.status === 'ok') {
    const modelIds = new Set(modelCatalog.models.map((item) => item.id))
    checks.push({
      id: 'profile-model-catalog',
      label: '模型目录匹配',
      ok: modelIds.has(model),
      detail: modelIds.has(model)
        ? '当前模型存在于最近一次 provider 模型目录。'
        : '当前模型不在最近一次 provider 模型目录中；可继续手动保存，但切换前需要确认。',
      severity: 'warning' as const,
    })
  }

  return checks
}

function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [selectedId, setSelectedId] = useState('a6api')
  const [draft, setDraft] = useState<EditableProfile>(emptyProfile)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function loadInitialState() {
      setBusy('refresh')
      try {
        const next = await loadState()
        setState(next)
        const selected = next.profiles.find((profile) => profile.id === next.currentProfileId) ?? next.profiles[0]
        if (selected) {
          setSelectedId(selected.id)
          setDraft(toEditable(selected))
        }
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载切换器状态失败。')
      } finally {
        setBusy(null)
      }
    }

    void loadInitialState()
  }, [])

  async function refresh() {
    setBusy('refresh')
    try {
      const next = await loadState()
      setState(next)
      const selected = next.profiles.find((profile) => profile.id === selectedId) ?? next.profiles[0]
      if (selected) {
        setSelectedId(selected.id)
        setDraft(toEditable(selected))
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载切换器状态失败。')
    } finally {
      setBusy(null)
    }
  }

  const selectedProfile = useMemo(() => {
    return state?.profiles.find((profile) => profile.id === selectedId)
  }, [selectedId, state])

  const currentProfile = useMemo(() => {
    return state?.profiles.find((profile) => profile.id === state.currentProfileId)
  }, [state])

  const selectedModelCatalog = useMemo(() => {
    return state?.modelCatalogs.find((catalog) => catalog.providerId === selectedId)
  }, [selectedId, state])

  const displayChecks = useMemo(() => {
    return [...(state?.checks ?? []), ...profileChecks(selectedProfile, draft, selectedModelCatalog)]
  }, [draft, selectedModelCatalog, selectedProfile, state])

  const failingChecks = displayChecks.filter((check) => !check.ok)
  const requiredFailures = failingChecks.filter((check) => check.severity === 'required').length
  const latestActivity = state?.activity[0]
  const legacyActive = Boolean(state?.legacySwitcher.processRunning || state?.legacySwitcher.portInUse)
  const legacyImported = Boolean(state?.legacySwitcher.imported)

  function updateDraft<K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  async function runAction(label: string, action: () => Promise<AppState>) {
    setBusy(label)
    try {
      const next = await action()
      setState(next)
      const selected = next.profiles.find((profile) => profile.id === selectedId) ?? next.profiles[0]
      if (selected) {
        setSelectedId(selected.id)
        setDraft(toEditable(selected))
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败。')
    } finally {
      setBusy(null)
    }
  }

  async function saveCurrentProfile() {
    setBusy('save')
    try {
      const next = await saveProfile(draft)
      setState(next)
      const saved =
        next.profiles.find((profile) => draft.id && profile.id === draft.id) ??
        next.profiles.find(
          (profile) =>
            profile.name === draft.name.trim() &&
            profile.baseUrl === draft.baseUrl.trim()
        ) ??
        next.profiles.find((profile) => profile.id === selectedId) ??
        next.profiles[0]
      if (saved) {
        setSelectedId(saved.id)
        setDraft(toEditable(saved))
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存配置失败。')
    } finally {
      setBusy(null)
    }
  }

  function startNewProfile() {
    setSelectedId('')
    setDraft(emptyProfile)
  }

  function duplicateProfile() {
    if (!selectedProfile) return
    setSelectedId('')
    setDraft({
      ...toEditable(selectedProfile),
      id: '',
      name: `${selectedProfile.name} 副本`,
      apiKey: '',
    })
  }

  if (!state) {
    return (
      <main className="loading-shell">
        <RefreshCcw className="spin" size={24} />
        <span>正在加载服务商切换工作台</span>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">
            {state.runtimeMode === 'tauri_native' ? '本机真实后端' : '浏览器假数据'}
          </p>
          <h1>CodeX Provider Switcher</h1>
        </div>
        <div className="topbar-actions">
          <button className="ghost-button" type="button" onClick={refresh} disabled={busy !== null}>
            <RefreshCcw size={16} />
            刷新
          </button>
        </div>
      </header>

      {error && (
        <section className="error-banner">
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="关闭错误提示">
            <X size={16} />
          </button>
        </section>
      )}

      <section className="operations-panel">
        <div className="operations-main">
          <div className="section-heading">
            <div>
              <p className="eyebrow">常用操作</p>
              <h2>切换 / 验证</h2>
              <p className="section-note">当前状态和高频动作放在同一层，减少来回扫视。</p>
            </div>
          </div>
          <div className="operations-row">
            <button
              className="primary-button"
              type="button"
              onClick={() => selectedProfile && runAction('switch', () => switchProfile(selectedProfile.id))}
              disabled={!selectedProfile || selectedProfile.active || busy !== null}
            >
              <PlugZap size={16} />
              切换到此服务商
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => selectedProfile && runAction('verify', () => verifyProfile(selectedProfile.id))}
              disabled={!selectedProfile || busy !== null}
            >
              <ShieldCheck size={16} />
              验证配置
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => selectedProfile && runAction('refresh-models', () => refreshModels(selectedProfile.id))}
              disabled={!selectedProfile || busy !== null}
            >
              <RefreshCcw size={16} />
              刷新模型目录
            </button>
          </div>
        </div>

        <div className="quick-status-grid">
          <article className="status-card current">
            <div className="status-icon">
              <PlugZap size={20} />
            </div>
            <div>
              <span>当前服务商</span>
              <strong>{currentProfile?.name ?? '未知'}</strong>
              <small>{currentProfile?.baseUrl}</small>
            </div>
          </article>
          <article className="status-card">
            <div className={requiredFailures === 0 ? 'status-icon ok' : 'status-icon danger'}>
              {requiredFailures === 0 ? <ShieldCheck size={20} /> : <AlertTriangle size={20} />}
            </div>
            <div>
              <span>安全门禁</span>
              <strong>{requiredFailures === 0 ? '可切换' : `${requiredFailures} 个阻断项`}</strong>
              <small>{requiredFailures === 0 ? `${displayChecks.length} 项检查通过` : '请先处理红色检查项'}</small>
            </div>
          </article>
          <article className="status-card">
            <div className="status-icon muted">
              <CheckCircle2 size={20} />
            </div>
            <div>
              <span>最近结果</span>
              <strong>{latestActivity?.title ?? '暂无操作'}</strong>
              <small>{latestActivity?.detail ?? '完成切换或验证后会更新。'}</small>
            </div>
          </article>
          <article className="status-card">
            <div className={legacyActive ? 'status-icon warning' : 'status-icon ok'}>
              {legacyActive ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}
            </div>
            <div>
              <span>旧版交接</span>
              <strong>{legacyActive ? '旧版仍在运行' : '未检测到占用'}</strong>
              <small>
                {legacyImported
                  ? `已导入：${state.legacySwitcher.importedAt ?? '时间未知'}`
                  : state.legacySwitcher.profileExists
                    ? `待导入：端口 ${state.legacySwitcher.port}`
                    : '未发现旧版配置'}
              </small>
            </div>
          </article>
        </div>
      </section>

      <section className="management-grid">
        <aside className="provider-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">服务商</p>
              <h2>切换目录</h2>
              <p className="section-note">选择一个服务商进行切换或编辑。</p>
            </div>
            <span>{state.profiles.length}</span>
          </div>
          <button className="primary-button add-provider-button" type="button" onClick={startNewProfile} disabled={busy !== null}>
            <Plus size={16} />
            新增服务商
          </button>
          <div className="provider-list">
            {state.profiles.map((profile) => (
              <button
                key={profile.id}
                className={`provider-card ${profile.id === selectedId ? 'selected' : ''} ${profile.active ? 'active' : ''}`}
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setSelectedId(profile.id)
                  setDraft(toEditable(profile))
                }}
              >
                <div className="provider-main">
                  <div className="provider-name">
                    <strong>{profile.name}</strong>
                    {profile.isDefault && <Star size={14} />}
                  </div>
                  <span>{profile.baseUrl}</span>
                </div>
                <div className="provider-meta">
                  <span className={profile.verified ? 'pill ok' : 'pill warning'}>
                    {profile.verified ? '已验证' : '待检查'}
                  </span>
                  {profile.active && <span className="pill active">当前</span>}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <div className="right-stack">
          <section className="detail-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">编辑</p>
                <h2>{draft.id ? `编辑 ${draft.name}` : '新增服务商'}</h2>
                <p className="section-note">保存后不会明文展示 API 密钥；留空表示沿用已保存密钥。</p>
              </div>
              <PanelRightOpen size={20} />
            </div>

            <div className="form-grid">
              <label>
                服务商名称
                <input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder="示例 API" />
              </label>
              <label>
                接口地址
                <input value={draft.baseUrl} onChange={(event) => updateDraft('baseUrl', event.target.value)} placeholder="https://example.com/v1" />
              </label>
              <label>
                模型
                <input
                  value={draft.model}
                  onChange={(event) => updateDraft('model', event.target.value)}
                  placeholder="先刷新模型目录，或手动输入 provider 支持的模型"
                />
              </label>
              <label className="wide">
                API 密钥
                <div className="key-field">
                  <KeyRound size={16} />
                  <input
                    value={draft.apiKey}
                    onChange={(event) => updateDraft('apiKey', event.target.value)}
                    placeholder={selectedProfile?.hasApiKey ? '已保存密钥。如需替换请重新输入。' : '粘贴 API 密钥'}
                    type="password"
                  />
                </div>
              </label>
              <label className="wide">
                备注
                <textarea value={draft.note} onChange={(event) => updateDraft('note', event.target.value)} rows={3} />
              </label>
            </div>

            <div className="model-catalog-panel">
              <div className="model-catalog-heading">
                <div>
                  <strong>模型目录</strong>
                  <span>
                    {selectedModelCatalog
                      ? selectedModelCatalog.statusDetail
                      : '尚未刷新模型目录；不会自动迁移当前模型。'}
                  </span>
                </div>
                <button
                  className="ghost-button compact-button"
                  type="button"
                  onClick={() => selectedProfile && runAction('refresh-models', () => refreshModels(selectedProfile.id))}
                  disabled={!selectedProfile || busy !== null}
                >
                  <RefreshCcw size={14} />
                  刷新
                </button>
              </div>
              <div className="model-catalog-meta">
                <span className={`pill ${selectedModelCatalog?.status === 'ok' ? 'ok' : 'warning'}`}>
                  {selectedModelCatalog?.status ?? 'not_fetched'}
                </span>
                {selectedModelCatalog?.fetchedAt && <span>刷新时间：{selectedModelCatalog.fetchedAt}</span>}
              </div>
              {selectedModelCatalog?.models.length ? (
                <div className="model-option-list">
                  {selectedModelCatalog.models.map((model) => (
                    <button
                      className={`model-option ${draft.model === model.id ? 'selected' : ''}`}
                      type="button"
                      key={model.id}
                      onClick={() => updateDraft('model', model.id)}
                    >
                      <span>
                        <strong>{model.id}</strong>
                        {model.aliases.length > 0 && <small>别名：{model.aliases.join(', ')}</small>}
                      </span>
                      {model.tags.slice(0, 2).map((tag) => (
                        <span className="pill ok" key={tag}>{tag}</span>
                      ))}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="empty-catalog-note">
                  没有可展示的模型。可以先刷新目录，或手动填写 provider 已确认支持的模型名。
                </p>
              )}
            </div>

            <div className="action-row">
              <button
                className="primary-button"
                type="button"
                disabled={!draft.name || !draft.baseUrl || busy !== null}
                onClick={saveCurrentProfile}
              >
                <Save size={16} />
                保存配置
              </button>
              <button className="ghost-button" type="button" onClick={duplicateProfile} disabled={!selectedProfile}>
                <Copy size={16} />
                复制
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={() => selectedProfile && runAction('default', () => setDefaultProfile(selectedProfile.id))}
                disabled={!selectedProfile || selectedProfile.isDefault}
              >
                <Star size={16} />
                设为默认
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => selectedProfile && runAction('delete', () => deleteProfile(selectedProfile.id))}
                disabled={!selectedProfile || selectedProfile.active || selectedProfile.isDefault}
              >
                <Trash2 size={16} />
                删除
              </button>
            </div>
          </section>

          <section className="diagnostics-grid">
            <article className="check-panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">验证</p>
                  <h2>配置安全</h2>
                  <p className="section-note">点击“验证配置”会刷新当前服务商状态，并把结果写入时间线。</p>
                </div>
              </div>
              <div className="check-list">
                {displayChecks.map((check) => (
                  <div className={`check-row ${getCheckVisual(check).className}`} key={check.id}>
                    {getCheckVisual(check).icon}
                    <div>
                      <strong>{check.label}</strong>
                      <span>{check.detail}</span>
                    </div>
                  </div>
                ))}
              </div>
            </article>

            <article className="activity-panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">时间线</p>
                  <h2>最近活动</h2>
                </div>
              </div>
              <div className="activity-list">
                {state.activity.slice(0, 4).map((item) => (
                  <div className={`activity-item ${item.tone}`} key={item.id}>
                    <time>{item.time}</time>
                    <div>
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          </section>

          <details className="developer-recovery">
            <summary>高级恢复与启动选项</summary>
            <div className="developer-recovery-body">
              <div>
                <p className="eyebrow">恢复</p>
                <h2>备份</h2>
                <p className="section-note">每次切换前会自动生成一个回滚点。这里面向排障和回滚，不作为普通用户的主流程。</p>
              </div>
              <button
                className="ghost-button"
                type="button"
                onClick={() => runAction('restore-backup', () => restoreLatestBackup())}
                disabled={busy !== null || state.backups.length === 0}
              >
                <ArchiveRestore size={16} />
                恢复最近备份
              </button>
            </div>
            <div className="advanced-setting-row">
              <div>
                <strong>开机自启动</strong>
                <span>当前不作为主功能展示；需要 Tauri 原生层读写 Windows 启动项并通过安装包验证后再开放。</span>
              </div>
              <span className="pill warning">待原生验证</span>
            </div>
            <div className="advanced-setting-row">
              <div>
                <strong>旧版切换器</strong>
                <span>
                  {legacyActive
                    ? `检测到旧版进程或 ${state.legacySwitcher.port} 端口仍在使用；最终切换前它继续作为 fallback。`
                    : '未检测到旧版进程或端口占用；最终切换仍需新会话执行。'}
                </span>
              </div>
              <span className={legacyActive ? 'pill warning' : 'pill ok'}>{legacyActive ? '交接前' : '可接管'}</span>
            </div>
            <div className="backup-list">
              {state.backups.slice(0, 3).map((backup) => (
                <div className="backup-row" key={backup.id}>
                  <strong>{backup.label}</strong>
                  <span>{backup.time} · {backup.files} 个文件</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      </section>
    </main>
  )
}

export default App
