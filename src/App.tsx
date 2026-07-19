import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Copy,
  Activity,
  Download,
  GitCompareArrows,
  KeyRound,
  LayoutDashboard,
  PlugZap,
  Plus,
  RefreshCcw,
  RotateCcw,
  Save,
  Search,
  Server,
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
  checkForUpdate,
  loadState,
  openUpdate,
  refreshModels,
  restoreLatestBackup,
  saveProfile,
  setDefaultProfile,
  syncCurrentConfiguration,
  switchProfile,
  verifyProfile,
} from './adapter'
import type { AppState, BackupItem, EditableProfile, ModelCatalog, ProviderProfile, UpdateInfo, ValidationCheck } from './types'

type ViewId = 'providers' | 'models' | 'safety' | 'timeline'

const emptyProfile: EditableProfile = {
  id: '',
  name: '',
  baseUrl: '',
  model: '',
  note: '',
  apiKey: '',
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

function getCheckVisual(check: { ok: boolean; severity: 'required' | 'warning' | 'info' }) {
  if (check.ok) {
    return { icon: <CheckCircle2 size={16} />, className: 'ok' }
  }

  if (check.severity === 'warning' || check.severity === 'info') {
    return { icon: <AlertTriangle size={16} />, className: 'warning' }
  }

  return { icon: <XCircle size={16} />, className: 'danger' }
}

function profileConfigurationChecks(profile: ProviderProfile | undefined, draft: EditableProfile): ValidationCheck[] {
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
      severity: 'required',
    },
    {
      id: 'profile-base-url',
      label: '接口地址',
      ok: /^https?:\/\/\S+/i.test(baseUrl),
      detail: /^https?:\/\/\S+/i.test(baseUrl) ? baseUrl : '需要填写 http 或 https 开头的接口地址。',
      severity: 'required',
    },
    {
      id: 'profile-model',
      label: '模型名称',
      ok: model.length > 0,
      detail: model.length > 0 ? model : '需要填写 Codex 使用的模型名称。',
      severity: 'required',
    },
    {
      id: 'profile-api-key',
      label: 'API 密钥',
      ok: hasKey,
      detail: hasKey ? '已保存密钥或本次已输入新密钥。' : '切换前必须保存 API 密钥。',
      severity: 'required',
    },
  ]

  return checks
}

function providerAvailabilityChecks(
  profile: ProviderProfile | undefined,
  modelCatalog: ModelCatalog | undefined
): ValidationCheck[] {
  if (!profile) return []

  const checks: ValidationCheck[] = [{
    id: 'provider-inference-probe',
    label: '服务商可用性测试',
    ok: profile.verified && profile.verificationStatus === 'verified',
    detail: verificationDetail(profile),
    severity: 'required',
  }]

  if (profile.model.length > 0 && modelCatalog?.status === 'ok') {
    const modelIds = new Set(modelCatalog.models.map((item) => item.id))
    checks.push({
      id: 'profile-model-catalog',
      label: '模型目录匹配',
      ok: modelIds.has(profile.model),
      detail: modelIds.has(profile.model)
        ? '当前模型存在于最近一次服务商模型目录。'
        : '当前模型不在最近一次服务商模型目录中；这只影响模型选择提示，不代表模型不能调用。',
      severity: 'info',
    })
  }

  return checks
}

function verificationDetail(profile: ProviderProfile | undefined) {
  if (!profile?.lastVerificationDetail) {
    return '尚未运行可用性测试。切换前必须发送一笔短时、低 token 的 Responses 请求。'
  }

  const diagnostics = [
    profile.lastVerificationHttpStatus ? `HTTP ${profile.lastVerificationHttpStatus}` : '',
    profile.lastVerificationProviderCode ? `服务商代码：${profile.lastVerificationProviderCode}` : '',
  ].filter(Boolean)

  return diagnostics.length > 0
    ? `${profile.lastVerificationDetail}（${diagnostics.join('，')}）`
    : profile.lastVerificationDetail
}

function verificationLabel(profile: ProviderProfile | undefined) {
  if (!profile) return '未保存'
  if (profile.verified && profile.verificationStatus === 'verified') {
    return profile.verificationResponseShape === 'compatible_response'
      ? '可调用（兼容响应）'
      : '可调用（标准 Responses）'
  }
  const labels: Record<Exclude<ProviderProfile['verificationStatus'], 'verified'>, string> = {
    not_checked: '未运行测试',
    missing_key: '测试未执行',
    invalid_profile: '测试未执行',
    unauthorized: '认证被拒绝',
    billing_unavailable: '额度或配额不足',
    rate_limited: '服务商正在限流',
    model_unavailable: '模型不可用',
    endpoint_or_model_unavailable: '路径或模型不可用',
    request_incompatible: '请求不被接受',
    protocol_incompatible: '旧版协议结果',
    response_shape_unconfirmed: '服务端已响应，结果待确认',
    response_unparseable: '服务端已响应，无法解析',
    service_error: '服务商异常',
    timeout: '请求超时，未得出结论',
    network_error: '网络不可达',
    transport_error: '传输过程异常',
    provider_error: '服务商返回错误',
  }
  return labels[profile.verificationStatus] ?? '待验证'
}

function requiresManualModelConfirmation(
  draft: EditableProfile,
  profile: ProviderProfile | undefined,
  catalog: ModelCatalog | undefined
) {
  const model = draft.model.trim()
  if (!model || model === profile?.model) return false
  return catalog?.status !== 'ok' || !catalog.models.some((item) => item.id.toLocaleLowerCase() === model.toLocaleLowerCase())
}

function draftMatchesProfile(draft: EditableProfile, profile: ProviderProfile | undefined) {
  if (!profile) return !draft.name && !draft.baseUrl && !draft.model && !draft.note && !draft.apiKey
  return (
    draft.name.trim() === profile.name &&
    draft.baseUrl.trim() === profile.baseUrl &&
    draft.model.trim() === profile.model &&
    draft.note.trim() === profile.note &&
    draft.apiKey.trim().length === 0
  )
}

function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [selectedId, setSelectedId] = useState('example-provider-a')
  const [activeView, setActiveView] = useState<ViewId>('providers')
  const [draft, setDraft] = useState<EditableProfile>(emptyProfile)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [restoreConfirm, setRestoreConfirm] = useState<BackupItem | null>(null)
  const [manualModelConfirm, setManualModelConfirm] = useState<string | null>(null)
  const [syncConfirm, setSyncConfirm] = useState(false)

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

  const selectedModelCatalog = useMemo(() => {
    return state?.modelCatalogs.find((catalog) => catalog.providerId === selectedId)
  }, [selectedId, state])

  const profileConfigChecks = useMemo(() => {
    return profileConfigurationChecks(selectedProfile, draft)
  }, [draft, selectedProfile])
  const availabilityChecks = useMemo(() => {
    return providerAvailabilityChecks(selectedProfile, selectedModelCatalog)
  }, [selectedModelCatalog, selectedProfile])
  const configChecks = state?.checks ?? []
  const switchGateChecks = [...configChecks, ...profileConfigChecks, ...availabilityChecks]
  const requiredFailures = switchGateChecks.filter((check) => !check.ok && check.severity === 'required').length
  const hasUnsavedChanges = !draftMatchesProfile(draft, selectedProfile)
  const latestActivity = state?.activity[0]
  const canSwitch = Boolean(
    selectedProfile &&
      state?.runtimeMode !== 'browser_preview_mock' &&
      !selectedProfile.active &&
      !hasUnsavedChanges &&
      requiredFailures === 0 &&
      busy === null
  )

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
      try {
        const latest = await loadState()
        setState(latest)
      } catch {
        // Preserve the operation error when the follow-up state refresh also fails.
      }
      setError(err instanceof Error ? err.message : '操作失败。')
    } finally {
      setBusy(null)
    }
  }

  async function saveEditableProfile(nextDraft: EditableProfile, busyLabel: string) {
    setBusy(busyLabel)
    try {
      const next = await saveProfile(nextDraft)
      setState(next)
      const saved =
        next.profiles.find((profile) => nextDraft.id && profile.id === nextDraft.id) ??
        next.profiles.find(
          (profile) => profile.name === nextDraft.name.trim() && profile.baseUrl === nextDraft.baseUrl.trim()
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

  async function saveCurrentProfile(manualModelConfirmed = false) {
    if (!manualModelConfirmed && requiresManualModelConfirmation(draft, selectedProfile, selectedModelCatalog)) {
      setManualModelConfirm(draft.model.trim())
      return
    }
    await saveEditableProfile(draft, 'save')
  }

  async function selectModel(model: string) {
    await saveEditableProfile({ ...draft, model }, 'save-model')
  }

  function selectProfile(profile: ProviderProfile) {
    setSelectedId(profile.id)
    setDraft(toEditable(profile))
  }

  function startNewProfile() {
    setSelectedId('')
    setDraft(emptyProfile)
    setActiveView('providers')
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
    setActiveView('providers')
  }

  async function handleUpdate() {
    if (updateInfo?.available) {
      try {
        await openUpdate(updateInfo.downloadUrl ?? updateInfo.releaseUrl)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : '无法打开更新下载。')
      }
      return
    }

    setUpdateBusy(true)
    try {
      const next = await checkForUpdate()
      setUpdateInfo(next)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '检查更新失败。')
    } finally {
      setUpdateBusy(false)
    }
  }

  async function restoreLatest() {
    await runAction('restore-backup', restoreLatestBackup)
    setRestoreConfirm(null)
  }

  if (!state && error) {
    return (
      <main className="loading-shell runtime-error-shell">
        <AlertTriangle className="danger-icon" size={28} />
        <div>
          <strong>连接服务未启动</strong>
          <span>{error}</span>
        </div>
        <button className="ghost-button" type="button" onClick={refresh} disabled={busy !== null}>
          <RefreshCcw size={16} />
          重试
        </button>
      </main>
    )
  }

  if (!state) {
    return (
      <main className="loading-shell">
        <RefreshCcw className="spin" size={24} />
        <span>正在加载服务商切换工作台</span>
      </main>
    )
  }

  const navItems: Array<{ id: ViewId; label: string; note: string; icon: React.ReactNode }> = [
    { id: 'providers', label: '服务商', note: `${state.profiles.length} 个配置`, icon: <LayoutDashboard size={17} /> },
    { id: 'models', label: '模型目录', note: selectedModelCatalog?.status === 'ok' ? '已同步' : '待刷新', icon: <Boxes size={17} /> },
    { id: 'safety', label: '安全检查', note: hasUnsavedChanges ? '请先保存' : requiredFailures === 0 ? '可以切换' : `${requiredFailures} 个待处理`, icon: <ShieldCheck size={17} /> },
    { id: 'timeline', label: '活动记录', note: latestActivity?.time ?? '暂无记录', icon: <Activity size={17} /> },
  ]
  const selectedIsCurrent = Boolean(selectedProfile?.active)
  const switchCardState = selectedIsCurrent ? 'current' : hasUnsavedChanges || requiredFailures > 0 ? 'blocked' : 'ready'
  const updateLabel = updateBusy
    ? '正在检查'
    : updateInfo?.available
      ? `下载 v${updateInfo.latestVersion}`
      : updateInfo
        ? '已是最新版'
        : '检查更新'

  return (
    <main className="app-shell" data-view={activeView}>
      <header className="app-titlebar">
        <div className="brand-lockup">
          <span className="brand-mark"><GitCompareArrows size={20} /></span>
          <div>
            <h1>CodeX Provider Switcher</h1>
            <p>服务商连接管理</p>
          </div>
        </div>
        <div className="title-actions">
          <button
            className="ghost-button update-button"
            type="button"
            onClick={handleUpdate}
            disabled={updateBusy}
            title={updateInfo?.available ? `下载 ${updateInfo.latestVersion} 安装包` : '检查 GitHub Release 更新'}
          >
            {updateBusy
              ? <RefreshCcw className="spin" size={15} />
              : updateInfo && !updateInfo.available
                ? <CheckCircle2 size={15} />
                : <Download size={15} />}
            {updateLabel}
          </button>
        </div>
      </header>

      {state.runtimeMode === 'browser_preview_mock' && (
        <section className="error-banner preview-banner">
          <AlertTriangle size={18} />
          <span>开发预览不读取本机配置，也不会连接、验证或切换真实服务商。</span>
        </section>
      )}

      {error && (
        <section className="error-banner">
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="关闭错误提示">
            <X size={16} />
          </button>
        </section>
      )}

      {restoreConfirm && (
        <RestoreConfirmDialog
          backup={restoreConfirm}
          busy={busy !== null}
          onCancel={() => setRestoreConfirm(null)}
          onConfirm={() => void restoreLatest()}
        />
      )}

      {manualModelConfirm && (
        <ManualModelConfirmDialog
          model={manualModelConfirm}
          busy={busy !== null}
          onCancel={() => setManualModelConfirm(null)}
          onConfirm={() => {
            setManualModelConfirm(null)
            void saveCurrentProfile(true)
          }}
        />
      )}

      <section className="workbench">
        <aside className="navigation-pane">
          <section className="sidebar-workspaces" aria-labelledby="workspace-nav-title">
            <div className="nav-group-label" id="workspace-nav-title">工作区</div>
            <nav className="nav-list" aria-label="主导航">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  className={`nav-item ${activeView === item.id ? 'selected' : ''}`}
                  type="button"
                  onClick={() => setActiveView(item.id)}
                >
                  {item.icon}
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.note}</small>
                  </span>
                </button>
              ))}
            </nav>
          </section>

          <section className="sidebar-connections" aria-labelledby="saved-connections-title">
            <div className="sidebar-section-title">
              <span id="saved-connections-title">服务商列表</span>
              <button type="button" onClick={startNewProfile} disabled={busy !== null} aria-label="新增服务商">
                <Plus size={15} />
              </button>
            </div>

            <div className="provider-list" aria-label="服务商列表">
              {state.profiles.map((profile) => (
                <button
                  key={profile.id}
                  className={`provider-row ${profile.id === selectedId ? 'selected' : ''} ${profile.active ? 'active' : ''}`}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => selectProfile(profile)}
                >
                  <span className="provider-symbol" aria-hidden="true"><Server size={16} /></span>
                  <span className="provider-row-main">
                    <strong>
                      {profile.name}
                      {profile.isDefault && <Star size={12} />}
                    </strong>
                    <small>{profile.baseUrl}</small>
                  </span>
                  <span className={`row-state ${profile.verified ? 'ok' : 'warning'}`} />
                </button>
              ))}
            </div>
          </section>

        </aside>

        <section className="workspace-panel">
          <WorkspaceHeader
            activeView={activeView}
            selectedProfile={selectedProfile}
            requiredFailures={requiredFailures}
            selectedModelCatalog={selectedModelCatalog}
          />
          <div className="workspace-scroll">
            {activeView === 'providers' && (
              <ProviderWorkspace
                draft={draft}
                selectedProfile={selectedProfile}
                busy={busy}
                updateDraft={updateDraft}
                saveCurrentProfile={saveCurrentProfile}
                duplicateProfile={duplicateProfile}
                runAction={runAction}
              />
            )}
            {activeView === 'models' && (
              <ModelsWorkspace
                key={selectedProfile?.id ?? 'no-provider'}
                selectedProfile={selectedProfile}
                selectedModelCatalog={selectedModelCatalog}
                busy={busy}
                selectModel={selectModel}
                runAction={runAction}
              />
            )}
            {activeView === 'safety' && (
              <SafetyWorkspace
                availabilityChecks={availabilityChecks}
                profileConfigChecks={profileConfigChecks}
                configChecks={configChecks}
                safeMode={state.safeMode}
                selectedProfile={selectedProfile}
                busy={busy}
                hasUnsavedChanges={hasUnsavedChanges}
                backups={state.backups}
                configurationDrift={state.configurationDrift}
                onRestoreRequested={() => setRestoreConfirm(state.backups[0] ?? null)}
                onSyncRequested={() => setSyncConfirm(true)}
                runAction={runAction}
              />
            )}
            {activeView === 'timeline' && <TimelineWorkspace state={state} />}
          </div>
        </section>

        <aside className="inspector-panel">
          <div className="inspector-section current-object">
            <div className="panel-heading">
              <span>当前目标</span>
              <strong>{selectedProfile?.name ?? '新增服务商'}</strong>
            </div>
            <dl className="inspector-facts">
              <div>
                <dt>状态</dt>
                <dd className={selectedProfile?.active ? 'value-good' : ''}>{selectedProfile?.active ? '运行中' : '未启用'}</dd>
              </div>
              <div>
                <dt>验证</dt>
                <dd className={selectedProfile?.verified ? 'value-good' : ''}>{verificationLabel(selectedProfile)}</dd>
              </div>
              <div>
                <dt>模型</dt>
                <dd>{draft.model || '未设置'}</dd>
              </div>
            </dl>
          </div>

          <div className={`switch-card ${switchCardState}`}>
            <div>
              <div className="switch-card-heading">
                <span className="switch-icon"><ShieldCheck size={16} /></span>
                <span>
                  {selectedIsCurrent
                    ? '当前连接'
                    : hasUnsavedChanges
                      ? '请先保存更改'
                    : requiredFailures === 0
                      ? '安全检查已通过'
                      : '需要处理安全项'}
                </span>
              </div>
              <strong>
                {selectedIsCurrent
                  ? '当前已启用'
                  : hasUnsavedChanges
                    ? '尚未保存'
                  : requiredFailures === 0
                    ? '可以切换'
                    : `${requiredFailures} 个阻断项`}
              </strong>
              <p>
                {selectedIsCurrent
                  ? '选择其他连接后可执行切换。'
                  : hasUnsavedChanges
                    ? '保存后需要运行真实服务商检查。'
                  : requiredFailures === 0
                    ? '切换前会自动生成恢复点。'
                    : '先处理必填项，再执行服务商切换。'}
              </p>
            </div>
            <button
              className="primary-button"
              type="button"
              onClick={() => selectedProfile && runAction('switch', () => switchProfile(selectedProfile.id))}
              disabled={!canSwitch}
            >
              <PlugZap size={16} />
              {selectedIsCurrent ? '当前使用中' : `切换到 ${selectedProfile?.name ?? '此服务商'}`}
            </button>
          </div>

          <div className="inspector-section checks-mini">
            <div className="panel-heading">
              <span>切换前置条件</span>
              <strong>{switchGateChecks.length} 项</strong>
            </div>
            <div className="mini-check-list">
              {switchGateChecks.slice(0, 7).map((check) => {
                const visual = getCheckVisual(check)
                return (
                  <div className={`mini-check ${visual.className}`} key={check.id}>
                    {visual.icon}
                    <span>{check.label}</span>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="inspector-section">
            <div className="panel-heading">
              <span>最近活动</span>
              <strong>{latestActivity?.time ?? '暂无'}</strong>
            </div>
            <p className="inspector-note">{latestActivity?.detail ?? '完成检查或切换后会更新。'}</p>
          </div>
        </aside>
      </section>

      <footer className="statusbar">
        <span>{busy ? `正在执行：${busy}` : '就绪'}</span>
        <span>{state.safeMode ? '安全模式开启' : '安全模式关闭'}</span>
        <span>凭据仅保存在此设备</span>
      </footer>
      {syncConfirm && state.configurationDrift && (
        <SyncCurrentConfigurationDialog
          drift={state.configurationDrift}
          busy={busy !== null}
          onCancel={() => setSyncConfirm(false)}
          onConfirm={() => {
            setSyncConfirm(false)
            void runAction('sync-current-config', syncCurrentConfiguration)
          }}
        />
      )}
    </main>
  )
}

function WorkspaceHeader({
  activeView,
  selectedProfile,
  requiredFailures,
  selectedModelCatalog,
}: {
  activeView: ViewId
  selectedProfile: ProviderProfile | undefined
  requiredFailures: number
  selectedModelCatalog: ModelCatalog | undefined
}) {
  const copy: Record<ViewId, { title: string; note: string }> = {
    providers: {
      title: selectedProfile ? `编辑 ${selectedProfile.name}` : '新增服务商',
      note: '管理连接配置、默认项和安全操作。',
    },
    models: {
      title: '模型目录',
      note: selectedModelCatalog?.statusDetail ?? '尚未同步模型目录。',
    },
    safety: {
      title: '安全检查',
      note: requiredFailures === 0 ? '当前配置满足切换前置条件。' : '还有必填检查未通过。',
    },
    timeline: {
      title: '活动记录',
      note: '切换、检查和配置变更按时间记录。',
    },
  }

  return (
    <header className="workspace-header">
      <div>
        <h2>{copy[activeView].title}</h2>
        <p>{copy[activeView].note}</p>
      </div>
      <span className={`workspace-badge ${requiredFailures === 0 ? 'ok' : 'warning'}`}>
        {requiredFailures === 0 ? '安全门禁通过' : `${requiredFailures} 个阻断项`}
      </span>
    </header>
  )
}

function ProviderWorkspace({
  draft,
  selectedProfile,
  busy,
  updateDraft,
  saveCurrentProfile,
  duplicateProfile,
  runAction,
}: {
  draft: EditableProfile
  selectedProfile: ProviderProfile | undefined
  busy: string | null
  updateDraft: <K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) => void
  saveCurrentProfile: () => Promise<void>
  duplicateProfile: () => void
  runAction: (label: string, action: () => Promise<AppState>) => Promise<void>
}) {
  return (
    <div className="workspace-stack">
      <section className="connection-banner">
        <div className="connection-status-icon"><PlugZap size={20} /></div>
        <div className="connection-copy">
          <span>连接配置</span>
          <strong>{selectedProfile?.name ?? '新建服务商'}</strong>
          <small>{draft.baseUrl || '填写接口地址后检查连接'}</small>
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
            默认模型
            <input
              value={draft.model}
              onChange={(event) => updateDraft('model', event.target.value)}
              placeholder="先刷新模型目录，或手动输入服务商支持的模型"
            />
          </label>
          <label>
            API 密钥
            <div className="key-field">
              <KeyRound size={15} />
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
            <textarea value={draft.note} onChange={(event) => updateDraft('note', event.target.value)} rows={3} placeholder="用于识别这条连接" />
          </label>
        </div>
        <div className="command-row">
          <button className="primary-button" type="button" disabled={!draft.name || !draft.baseUrl || busy !== null} onClick={() => void saveCurrentProfile()}>
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
        </div>
      </section>

    </div>
  )
}

function ModelsWorkspace({
  selectedProfile,
  selectedModelCatalog,
  busy,
  selectModel,
  runAction,
}: {
  selectedProfile: ProviderProfile | undefined
  selectedModelCatalog: ModelCatalog | undefined
  busy: string | null
  selectModel: (model: string) => Promise<void>
  runAction: (label: string, action: () => Promise<AppState>) => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleModels = Array.from(
    new Map((selectedModelCatalog?.models ?? []).map((model) => [model.id, model])).values()
  ).filter((model) => {
    if (!normalizedQuery) return true
    return [model.id, ...model.aliases, ...model.tags]
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  })
  const totalModels = selectedModelCatalog?.models.length ?? 0

  return (
    <div className="workspace-stack">
      <section className="surface-panel model-toolbar">
        <div>
          <span>当前服务商</span>
          <strong>{selectedProfile?.name ?? '未选择'}</strong>
          <small>{selectedProfile?.baseUrl ?? '选择左侧服务商后刷新模型目录'}</small>
        </div>
        <div className="model-toolbar-actions">
          <label className="model-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型、别名或标签" />
          </label>
          <button
            className="primary-button"
            type="button"
            onClick={() => selectedProfile && runAction('refresh-models', () => refreshModels(selectedProfile.id))}
            disabled={!selectedProfile || busy !== null}
          >
            <RefreshCcw size={16} />
            刷新模型目录
          </button>
        </div>
      </section>

      <section className="surface-panel">
        <div className="model-table">
          <div className="model-table-head">
            <span>模型 {normalizedQuery ? `(${visibleModels.length}/${totalModels})` : `(${totalModels})`}</span>
            <span>选择</span>
          </div>
          {visibleModels.length ? (
            visibleModels.map((model) => (
              <div className={`model-row ${selectedProfile?.model === model.id ? 'selected' : ''}`} key={model.id}>
                <span>
                  <strong>{model.id}</strong>
                  {model.aliases.length > 0 && <small>别名：{model.aliases.join(', ')}</small>}
                  <div className="model-meta">
                    <span>服务商目录</span>
                    {selectedProfile?.model.toLocaleLowerCase() === model.id.toLocaleLowerCase() && model.verifiedForResponses === 'verified' && (
                      <span>当前模型可用性测试通过</span>
                    )}
                    {model.tags.map((tag) => <span key={tag}>{tag}</span>)}
                  </div>
                </span>
                <button
                  className="ghost-button compact-button"
                  type="button"
                  onClick={() => selectModel(model.id)}
                  disabled={busy !== null || selectedProfile?.model === model.id}
                >
                  {selectedProfile?.model === model.id ? '当前模型' : '使用'}
                </button>
              </div>
            ))
          ) : (
            <div className="empty-state">
              <Boxes size={28} />
              <strong>{normalizedQuery ? '没有匹配的模型' : '还没有可展示的模型'}</strong>
              <span>{normalizedQuery ? '尝试更换关键词，或清空搜索条件。' : selectedModelCatalog?.statusDetail ?? '刷新后只展示服务商实际返回的模型列表。'}</span>
            </div>
          )}
        </div>
      </section>

    </div>
  )
}

function ManualModelConfirmDialog({
  model,
  busy,
  onCancel,
  onConfirm,
}: {
  model: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="confirm-backdrop" role="presentation">
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-model-dialog-title">
        <div className="confirm-dialog-icon"><AlertTriangle size={20} /></div>
        <div>
          <span className="eyebrow">未验证模型</span>
          <h2 id="manual-model-dialog-title">确认保存手动模型？</h2>
          <p>{model} 不在最近刷新到的服务商模型目录中。保存后可运行可用性测试；测试未确认不代表已有 Codex 使用会失败。</p>
        </div>
        <div className="command-row">
          <button className="ghost-button" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="danger-button" type="button" onClick={onConfirm} disabled={busy}>仍然保存</button>
        </div>
      </section>
    </div>
  )
}

function SyncCurrentConfigurationDialog({
  drift,
  busy,
  onCancel,
  onConfirm,
}: {
  drift: NonNullable<AppState['configurationDrift']>
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="confirm-backdrop" role="presentation">
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="sync-dialog-title">
        <div className="confirm-dialog-icon"><GitCompareArrows size={20} /></div>
        <div>
          <span className="eyebrow">同步当前 Codex 配置</span>
          <h2 id="sync-dialog-title">确认更新切换器目录？</h2>
          <p>{drift.profileName} 当前保存的是 {drift.savedModel}，Codex 正在使用 {drift.currentModel}。此操作只更新切换器目录，不会写入 Codex 配置、认证文件或发起远端请求。</p>
        </div>
        <div className="command-row">
          <button className="ghost-button" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="primary-button" type="button" onClick={onConfirm} disabled={busy}>确认同步</button>
        </div>
      </section>
    </div>
  )
}

function SafetyWorkspace({
  availabilityChecks,
  profileConfigChecks,
  configChecks,
  safeMode,
  selectedProfile,
  busy,
  hasUnsavedChanges,
  backups,
  configurationDrift,
  onRestoreRequested,
  onSyncRequested,
  runAction,
}: {
  availabilityChecks: ValidationCheck[]
  profileConfigChecks: ValidationCheck[]
  configChecks: ValidationCheck[]
  safeMode: boolean
  selectedProfile: ProviderProfile | undefined
  busy: string | null
  hasUnsavedChanges: boolean
  backups: BackupItem[]
  configurationDrift: AppState['configurationDrift']
  onRestoreRequested: () => void
  onSyncRequested: () => void
  runAction: (label: string, action: () => Promise<AppState>) => Promise<void>
}) {
  const latestBackup = backups[0]
  return (
    <div className="workspace-stack">
      <section className="surface-panel safety-summary">
        <div>
          <ShieldCheck size={22} />
          <span>安全模式</span>
          <strong>{safeMode ? '已开启' : '未开启'}</strong>
        </div>
        <div>
          <KeyRound size={22} />
          <span>服务商可用性测试</span>
          <strong>切换前必须通过</strong>
          <small>发起一笔短时、低 token 的已认证 Responses 请求。未通过时不会改写 Codex 配置。</small>
        </div>
        <button
          className="primary-button safety-run-button"
          type="button"
          onClick={() => selectedProfile && runAction('verify', () => verifyProfile(selectedProfile.id))}
          disabled={!selectedProfile || hasUnsavedChanges || busy !== null}
        >
          <ShieldCheck size={16} />
          {hasUnsavedChanges ? '请先保存更改' : '运行可用性测试'}
        </button>
      </section>
      <section className="surface-panel">
        <div className="check-section-heading">
          <div>
            <span>目标服务商可用性</span>
            <strong>{selectedProfile?.name ?? '未选择'}</strong>
          </div>
          <small>测试只覆盖一次短请求；它是切换门槛，但不替代长上下文、工具调用或最终 Codex 验收。</small>
        </div>
        <div className="check-list">
          {availabilityChecks.map((check) => {
            const visual = getCheckVisual(check)
            return (
              <div className={`check-row ${visual.className}`} key={check.id}>
                {visual.icon}
                <div>
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
              </div>
            )
          })}
        </div>
      </section>
      <section className="surface-panel compact-surface">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">切换门禁</span>
            <h3>目标配置完整性</h3>
          </div>
          <span className="section-meta">地址、模型、密钥与真实可用性测试都必须通过</span>
        </div>
        <div className="check-list compact-check-list">
          {profileConfigChecks.map((check) => {
            const visual = getCheckVisual(check)
            return (
              <div className={`check-row ${visual.className}`} key={check.id}>
                {visual.icon}
                <div>
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
              </div>
            )
          })}
        </div>
        <div className="path-grid verification-boundary">
          <div>
            <span>配置写入</span>
            <strong>只有切换时才生成恢复点</strong>
          </div>
          <div>
            <span>可用性测试</span>
            <strong>手动运行，不写入 Codex 配置</strong>
          </div>
        </div>
      </section>
      {configurationDrift && (
        <section className="surface-panel compact-surface configuration-drift-panel">
          <div className="section-heading-row">
            <div>
              <span className="eyebrow">当前配置差异</span>
              <h3>同步目录前请确认</h3>
            </div>
            <span className="section-meta">不会改写 Codex 配置</span>
          </div>
          <p>{configurationDrift.detail}</p>
          <div className="command-row">
            <button className="primary-button" type="button" onClick={onSyncRequested} disabled={busy !== null}>
              <GitCompareArrows size={16} />
              同步当前模型到目录
            </button>
          </div>
        </section>
      )}
      <section className="surface-panel compact-surface">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">切换门禁</span>
            <h3>Codex 当前配置</h3>
          </div>
          <span className="section-meta">切换后仍须保持的本地不变量</span>
        </div>
        <div className="check-list compact-check-list">
          {configChecks.map((check) => {
            const visual = getCheckVisual(check)
            return (
              <div className={`check-row ${visual.className}`} key={check.id}>
                {visual.icon}
                <div>
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
              </div>
            )
          })}
        </div>
      </section>
      <section className="surface-panel recovery-panel">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">恢复中心</span>
            <h3>最近备份</h3>
          </div>
          <span className="section-meta">切换前自动生成</span>
        </div>
        {latestBackup ? (
          <div className="recovery-row">
            <div>
              <strong>{latestBackup.label}</strong>
              <span>{latestBackup.time} · {latestBackup.files} 个备份文件</span>
            </div>
            <button className="danger-button" type="button" onClick={onRestoreRequested} disabled={busy !== null}>
              <RotateCcw size={16} />
              恢复最近备份
            </button>
          </div>
        ) : (
          <div className="empty-state recovery-empty">
            <RotateCcw size={26} />
            <strong>尚未创建恢复点</strong>
            <span>成功切换服务商前会自动生成配置和凭据备份。</span>
          </div>
        )}
      </section>
    </div>
  )
}

function RestoreConfirmDialog({
  backup,
  busy,
  onCancel,
  onConfirm,
}: {
  backup: BackupItem
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="confirm-backdrop" role="presentation">
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="restore-dialog-title">
        <div className="confirm-dialog-icon"><AlertTriangle size={20} /></div>
        <div>
          <span className="eyebrow">恢复最近备份</span>
          <h2 id="restore-dialog-title">确认恢复配置？</h2>
          <p>将恢复 {backup.label} 中的 Codex 配置和凭据。恢复后需要重新检查当前服务商状态。</p>
        </div>
        <div className="command-row">
          <button className="ghost-button" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="danger-button" type="button" onClick={onConfirm} disabled={busy}>
            <RotateCcw size={16} />
            确认恢复
          </button>
        </div>
      </section>
    </div>
  )
}

function TimelineWorkspace({ state }: { state: AppState }) {
  return (
    <div className="workspace-stack">
      <section className="surface-panel">
        <div className="activity-list">
          {state.activity.map((item) => (
            <div className={`activity-item ${item.tone}`} key={item.id}>
              <time>{item.time}</time>
              <div>
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

export default App
