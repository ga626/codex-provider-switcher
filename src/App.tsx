import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Copy,
  Activity,
  Download,
  GripVertical,
  GitCompareArrows,
  KeyRound,
  LayoutDashboard,
  PlugZap,
  Plus,
  Power,
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
  createManualBackup,
  isGitHubReleaseBuild,
  isStoreManagedBuild,
  loadState,
  openUpdate,
  prepareSwitch,
  refreshModels,
  reorderProfiles,
  restoreBackup,
  saveProfile,
  setDefaultProfile,
  syncCurrentConfiguration,
  switchProfile,
  toggleAutoStart,
  verifyProfile,
} from './adapter'
import type { AppState, BackupItem, ConfigurationProtection, EditableProfile, ModelCatalog, ProviderProfile, SwitchPreflight, UpdateInfo, ValidationCheck } from './types'

type ViewId = 'providers' | 'models' | 'switch-check' | 'protection' | 'application' | 'timeline'

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

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
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
      label: '访问密钥',
      ok: hasKey,
      detail: hasKey ? '已保存访问密钥。' : '切换前需要保存访问密钥。',
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
    return '尚未运行连接测试。'
  }

  return profile.verified && profile.verificationStatus === 'verified'
    ? '最近一次连接测试通过。'
    : profile.lastVerificationDetail
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
  const [notice, setNotice] = useState<string | null>(null)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [restoreConfirm, setRestoreConfirm] = useState<BackupItem | null>(null)
  const [switchConfirm, setSwitchConfirm] = useState<SwitchPreflight | null>(null)
  const [manualModelConfirm, setManualModelConfirm] = useState<string | null>(null)
  const [syncConfirm, setSyncConfirm] = useState(false)
  const [restartNotice, setRestartNotice] = useState(false)
  const [draggedProviderId, setDraggedProviderId] = useState<string | null>(null)

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
        setError(errorMessage(err, '加载切换器状态失败。'))
      } finally {
        setBusy(null)
      }
    }

    void loadInitialState()
  }, [])

  useEffect(() => {
    if (!notice) return undefined
    const timeout = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(timeout)
  }, [notice])

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
      setError(errorMessage(err, '加载切换器状态失败。'))
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
      if (label === 'switch') {
        setRestartNotice(true)
      }
      setNotice(next.activity[0]?.title ?? '操作已完成')
      setError(null)
    } catch (err) {
      try {
        const latest = await loadState()
        setState(latest)
      } catch {
        // Preserve the operation error when the follow-up state refresh also fails.
      }
      setError(errorMessage(err, '操作失败。'))
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
      setNotice(next.activity[0]?.title ?? '已保存配置')
      setError(null)
    } catch (err) {
      setError(errorMessage(err, '保存配置失败。'))
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

  function moveProvider(profileId: string, targetIndex: number) {
    if (!state) return
    const sourceIndex = state.profiles.findIndex((profile) => profile.id === profileId)
    if (sourceIndex < 0 || sourceIndex === targetIndex) return
    const nextIds = state.profiles.map((profile) => profile.id)
    const [movedId] = nextIds.splice(sourceIndex, 1)
    nextIds.splice(targetIndex, 0, movedId)
    void runAction('reorder-profiles', () => reorderProfiles(nextIds))
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
    if (isStoreManagedBuild) {
      setUpdateBusy(true)
      try {
        const next = await checkForUpdate()
        setUpdateInfo(next)
        await openUpdate(next.releaseUrl)
        setError(null)
      } catch (err) {
      setError(errorMessage(err, '无法打开 Microsoft Store。'))
      } finally {
        setUpdateBusy(false)
      }
      return
    }
    if (!isGitHubReleaseBuild) {
      return
    }
    if (updateInfo?.available) {
      try {
        await openUpdate(updateInfo.downloadUrl ?? updateInfo.releaseUrl)
        setError(null)
      } catch (err) {
      setError(errorMessage(err, '无法打开更新下载。'))
      }
      return
    }

    setUpdateBusy(true)
    try {
      const next = await checkForUpdate()
      setUpdateInfo(next)
      setError(null)
    } catch (err) {
      setError(errorMessage(err, '检查更新失败。'))
    } finally {
      setUpdateBusy(false)
    }
  }

  async function restoreLatest(confirmation: string) {
    if (!restoreConfirm) return
    await runAction('restore-backup', () => restoreBackup(restoreConfirm.id, confirmation))
    setRestoreConfirm(null)
  }

  async function requestSwitch() {
    if (!selectedProfile || !canSwitch) return
    setBusy('prepare-switch')
    try {
      setSwitchConfirm(await prepareSwitch(selectedProfile.id))
      setError(null)
    } catch (err) {
      setError(errorMessage(err, '切换前检查失败。'))
    } finally {
      setBusy(null)
    }
  }

  async function confirmSwitch() {
    if (!switchConfirm) return
    const { profileId, operationId } = switchConfirm
    setSwitchConfirm(null)
    await runAction('switch', () => switchProfile(profileId, operationId))
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
    { id: 'application', label: '应用设置', note: state.autoStart ? '开机启动已开启' : '开机启动未开启', icon: <Power size={17} /> },
    { id: 'models', label: '模型目录', note: selectedModelCatalog?.status === 'ok' ? '已同步' : '待刷新', icon: <Boxes size={17} /> },
    { id: 'switch-check', label: '切换前检查', note: !selectedProfile ? '先新增服务商' : hasUnsavedChanges ? '请先保存' : requiredFailures === 0 ? '可以切换' : `${requiredFailures} 项待处理`, icon: <ShieldCheck size={17} /> },
    { id: 'protection', label: '配置保护', note: state.configurationProtection.baselineReady ? '备份已就绪' : '需要处理', icon: <ShieldCheck size={17} /> },
    { id: 'timeline', label: '活动记录', note: latestActivity?.time ?? '暂无记录', icon: <Activity size={17} /> },
  ]
  const selectedIsCurrent = Boolean(selectedProfile?.active)
  const updateLabel = updateBusy
    ? '正在检查'
    : isStoreManagedBuild
      ? '在 Store 检查更新'
      : !isGitHubReleaseBuild
        ? '开发版不检查更新'
      : updateInfo?.available
      ? `下载 v${updateInfo.latestVersion}`
      : updateInfo
        ? '已是最新版'
        : '检查更新'
  const buildChannelLabel = __CODEX_RELEASE_CHANNEL__ === 'stable'
    ? '稳定版'
    : __CODEX_RELEASE_CHANNEL__ === 'candidate'
      ? '维护候选'
      : __CODEX_RELEASE_CHANNEL__ === 'store'
        ? '商店版'
        : '开发版'

  return (
    <main className="app-shell" data-view={activeView}>
      <header className="app-titlebar">
        <div className="brand-lockup">
          <span className="brand-mark"><GitCompareArrows size={20} /></span>
          <div>
            <h1>Signalman AI</h1>
            <p>服务商连接管理</p>
          </div>
        </div>
        <div className="title-actions">
          <span className="build-identity" title="用于确认当前运行的版本和构建来源">
            {buildChannelLabel} v{__APP_VERSION__} · {__CODEX_BUILD_SHA__.slice(0, 7)}
          </span>
          <button
            className="ghost-button update-button"
            type="button"
            onClick={handleUpdate}
            disabled={updateBusy || (!isStoreManagedBuild && !isGitHubReleaseBuild)}
            title={isStoreManagedBuild ? '在 Microsoft Store 中检查更新' : isGitHubReleaseBuild ? (updateInfo?.available ? `下载 ${updateInfo.latestVersion} 安装包` : '检查 GitHub Release 更新') : '开发版和维护者候选版不检查公开更新'}
          >
            {updateBusy
              ? <RefreshCcw className="spin" size={15} />
              : updateInfo && !updateInfo.available && !isStoreManagedBuild
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

      {state.startupNotice && (
        <section className="error-banner">
          <AlertTriangle size={18} />
          <span>{state.startupNotice.detail} 诊断编号：{state.startupNotice.code}</span>
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

      {notice && (
        <div className="success-toast" role="status">
          <CheckCircle2 size={17} />
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="关闭完成提示"><X size={15} /></button>
        </div>
      )}

      {restoreConfirm && (
        <RestoreConfirmDialog
          backup={restoreConfirm}
          busy={busy !== null}
          onCancel={() => setRestoreConfirm(null)}
          onConfirm={(confirmation) => void restoreLatest(confirmation)}
        />
      )}

      {switchConfirm && (
        <SwitchConfirmDialog
          preflight={switchConfirm}
          busy={busy !== null}
          onCancel={() => setSwitchConfirm(null)}
          onConfirm={() => void confirmSwitch()}
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
              {state.profiles.map((profile, index) => (
                <div
                  key={profile.id}
                  className={`provider-row ${profile.id === selectedId ? 'selected' : ''} ${profile.active ? 'active' : ''} ${draggedProviderId === profile.id ? 'dragging' : ''}`}
                  role="button"
                  tabIndex={busy === null ? 0 : -1}
                  draggable={busy === null}
                  aria-label={`${profile.name}。按住拖动可调整列表顺序；按 Alt 加方向键也可移动。`}
                  onDragStart={(event) => {
                    setDraggedProviderId(profile.id)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', profile.id)
                  }}
                  onDragEnd={() => setDraggedProviderId(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault()
                    const sourceId = event.dataTransfer.getData('text/plain') || draggedProviderId
                    setDraggedProviderId(null)
                    if (sourceId) moveProvider(sourceId, index)
                  }}
                  onClick={() => selectProfile(profile)}
                  onKeyDown={(event) => {
                    if (event.altKey && event.key === 'ArrowUp') {
                      event.preventDefault()
                      moveProvider(profile.id, Math.max(0, index - 1))
                    } else if (event.altKey && event.key === 'ArrowDown') {
                      event.preventDefault()
                      moveProvider(profile.id, Math.min(state.profiles.length - 1, index + 1))
                    } else if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      selectProfile(profile)
                    }
                  }}
                >
                  <span className="provider-drag-handle" title="按住拖动排序" aria-hidden="true"><GripVertical size={15} /></span>
                  <span className="provider-symbol" aria-hidden="true"><Server size={16} /></span>
                  <span className="provider-row-main">
                    <strong>
                      {profile.name}
                      {profile.isDefault && <Star size={12} />}
                    </strong>
                    <small>{profile.baseUrl}</small>
                  </span>
                  <span className={`row-state ${profile.verified ? 'ok' : 'warning'}`} />
                </div>
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
            canSwitch={canSwitch}
            selectedIsCurrent={selectedIsCurrent}
            onSwitchRequested={requestSwitch}
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
            {activeView === 'switch-check' && (
              <SafetyWorkspace
                availabilityChecks={availabilityChecks}
                profileConfigChecks={profileConfigChecks}
                configChecks={state.checks}
                selectedProfile={selectedProfile}
                busy={busy}
                hasUnsavedChanges={hasUnsavedChanges}
                runAction={runAction}
              />
            )}
            {activeView === 'protection' && (
              <ConfigurationProtectionWorkspace
                protection={state.configurationProtection}
                backups={state.backups}
                busy={busy}
                onRestoreRequested={(backup) => setRestoreConfirm(backup)}
                onBackupRequested={(confirmation) => void runAction('create-manual-backup', () => createManualBackup(confirmation))}
              />
            )}
            {activeView === 'application' && (
              <ApplicationSettingsWorkspace
                autoStart={state.autoStart}
                desktopAvailable={state.runtimeMode === 'tauri_native'}
                busy={busy}
                onToggle={(enabled) => void runAction('toggle-auto-start', () => toggleAutoStart(enabled))}
              />
            )}
            {activeView === 'timeline' && <TimelineWorkspace state={state} />}
          </div>
        </section>

      </section>

      <footer className="statusbar">
        <span>{busy ? `正在执行：${busy}` : '就绪'}</span>
        <span>本机资料仅保存在此设备</span>
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
      {restartNotice && <RestartCodexNoticeDialog onClose={() => setRestartNotice(false)} />}
    </main>
  )
}

function WorkspaceHeader({
  activeView,
  selectedProfile,
  requiredFailures,
  selectedModelCatalog,
  canSwitch,
  selectedIsCurrent,
  onSwitchRequested,
}: {
  activeView: ViewId
  selectedProfile: ProviderProfile | undefined
  requiredFailures: number
  selectedModelCatalog: ModelCatalog | undefined
  canSwitch: boolean
  selectedIsCurrent: boolean
  onSwitchRequested: () => void
}) {
  const showSwitchAction = activeView === 'switch-check'
  const copy: Record<ViewId, { title: string; note: string }> = {
    providers: {
      title: selectedProfile ? `编辑 ${selectedProfile.name}` : '新增服务商',
      note: '管理连接配置、默认项和安全操作。',
    },
    models: {
      title: '模型目录',
      note: selectedModelCatalog?.statusDetail ?? '尚未同步模型目录。',
    },
    'switch-check': {
      title: '切换前检查',
      note: !selectedProfile ? '先新增并保存服务商。' : requiredFailures === 0 ? '已满足切换条件。' : '请先处理未通过的项目。',
    },
    protection: {
      title: '配置保护',
      note: '查看备份、受保护内容和恢复入口。',
    },
    application: {
      title: '应用设置',
      note: '控制应用本身的启动方式，不会改动 Codex 配置。',
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
      {showSwitchAction && (
        <div className="workspace-header-actions">
          <span className={`workspace-badge ${selectedProfile && requiredFailures === 0 ? 'ok' : 'warning'}`}>
            {!selectedProfile ? '未选择服务商' : requiredFailures === 0 ? '可以切换' : `${requiredFailures} 项待处理`}
          </span>
          <button className="primary-button header-switch-button" type="button" onClick={onSwitchRequested} disabled={!canSwitch}>
            <PlugZap size={16} />
            {selectedIsCurrent ? '当前使用中' : selectedProfile ? `切换到 ${selectedProfile.name}` : '先新增服务商'}
          </button>
        </div>
      )}
    </header>
  )
}

function RestartCodexNoticeDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="confirm-backdrop" role="presentation">
      <section className="confirm-dialog restart-notice-dialog" role="dialog" aria-modal="true" aria-labelledby="restart-notice-title">
        <div className="confirm-dialog-icon"><RotateCcw size={20} /></div>
        <div>
          <span className="eyebrow">切换已完成</span>
          <h2 id="restart-notice-title">请重新打开 Codex</h2>
          <p>新配置已经写入并创建了恢复点，但当前正在运行的 Codex 或 ChatGPT 桌面端中的 Codex 会话不会自动切换。请关闭当前会话后重新打开，再确认实际工作正常。</p>
        </div>
        <div className="command-row">
          <button className="primary-button" type="button" onClick={onClose}>我知道了</button>
        </div>
      </section>
    </div>
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
            访问密钥
            <div className="key-field">
              <KeyRound size={15} />
              <input
                value={draft.apiKey}
                onChange={(event) => updateDraft('apiKey', event.target.value)}
                placeholder={selectedProfile?.hasApiKey ? '已保存访问密钥；如需替换请重新输入。' : '粘贴访问密钥'}
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
          <button className="danger-button" type="button" onClick={onConfirm} disabled={busy}>继续保存</button>
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
  selectedProfile,
  busy,
  hasUnsavedChanges,
  runAction,
}: {
  availabilityChecks: ValidationCheck[]
  profileConfigChecks: ValidationCheck[]
  configChecks: ValidationCheck[]
  selectedProfile: ProviderProfile | undefined
  busy: string | null
  hasUnsavedChanges: boolean
  runAction: (label: string, action: () => Promise<AppState>) => Promise<void>
}) {
  const targetChecks = [...availabilityChecks, ...profileConfigChecks]
  return (
    <div className="workspace-stack">
      <section className="surface-panel check-panel">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">切换条件</span>
            <h3>完成以下检查后即可切换</h3>
          </div>
          <div className="check-actions">
            <span className="section-meta">{selectedProfile ? `当前：${selectedProfile.name}` : '请选择服务商'} · 检查不会修改现有服务商设置</span>
            <button
              className="primary-button"
              type="button"
              onClick={() => selectedProfile && runAction('verify', () => verifyProfile(selectedProfile.id))}
              disabled={!selectedProfile || hasUnsavedChanges || busy !== null}
            >
              <ShieldCheck size={16} />
              {!selectedProfile ? '先新增服务商' : hasUnsavedChanges ? '请先保存更改' : '运行可用性测试'}
            </button>
          </div>
        </div>
        <div className="check-list">
          {targetChecks.map((check) => {
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
        <div className="check-group-heading">
          <div>
            <span className="eyebrow">Codex 运行设置</span>
            <h4>这些设置会在切换后继续生效</h4>
          </div>
          <span>{configChecks.length} 项实际检查</span>
        </div>
        <div className="check-list">
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
    </div>
  )
}

function ConfigurationProtectionWorkspace({
  protection,
  backups,
  busy,
  onRestoreRequested,
  onBackupRequested,
}: {
  protection: ConfigurationProtection
  backups: BackupItem[]
  busy: string | null
  onRestoreRequested: (backup: BackupItem) => void
  onBackupRequested: (confirmation?: string) => void
}) {
  const backupTitle: Record<BackupItem['kind'], string> = {
    initial_install: '首次启动基线备份',
    daily: '今日自动备份',
    manual: '手动备份',
    before_switch: '切换前备份',
    before_restore: '恢复前备份',
    legacy_backup: '旧版备份',
    invalid_backup: '未完成的备份目录',
  }
  const recoverableBackups = backups.filter((backup) => backup.restoreReady)
  const invalidBackupCount = backups.length - recoverableBackups.length
  const manualBackupLimitReached = backups.filter((backup) => backup.kind === 'manual').length >= 3
  return (
    <div className="workspace-stack">
      <section className="surface-panel protection-overview">
        <div className="protection-hero">
          <div>
            <span className="eyebrow">备份状态</span>
            <h3>{protection.baselineReady ? '首次启动基线备份已就绪' : '首次启动基线备份尚未完成'}</h3>
            <p>{protection.baselineDetail}</p>
          </div>
          <ShieldCheck size={34} aria-hidden="true" />
        </div>
        <div className="protection-scope">
          <div>
            <span className="eyebrow">本工具管理</span>
            <strong>服务商、模型和接口地址</strong>
          </div>
          <div>
            <span className="eyebrow">保持不变</span>
            <strong>MCP、插件、项目设置和个人偏好</strong>
          </div>
        </div>
      </section>
      <section className="surface-panel protection-list-panel">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">保留的设置</span>
            <h3>切换时会保留这些设置</h3>
          </div>
          <span className="section-meta">仅显示状态，不显示内容或密钥</span>
        </div>
        <div className="protection-grid">
          {protection.items.map((item) => (
            <article className={`protection-item ${item.state}`} key={item.id}>
              <CheckCircle2 size={17} aria-hidden="true" />
              <div>
                <strong>{item.label}{typeof item.count === 'number' ? ` · ${item.count} 项` : ''}</strong>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="surface-panel recovery-panel">
        <div className="section-heading-row">
          <div><span className="eyebrow">恢复中心</span><h3>已保护的恢复点</h3></div>
          <div className="recovery-actions">
            <span className="section-meta">每天首次打开会自动备份；也可以保存当前状态。</span>
            <button className="primary-button" type="button" onClick={() => {
              if (!manualBackupLimitReached) {
                onBackupRequested()
                return
              }
              if (window.confirm('已保留 3 个手动恢复点。继续将替换最早的手动恢复点，是否继续？')) {
                onBackupRequested('替换')
              }
            }} disabled={busy !== null}>
              <Save size={16} />
              立即备份当前状态
            </button>
          </div>
        </div>
        {recoverableBackups.length > 0 ? <div className="recovery-list">
          {recoverableBackups.map((backup) => (
            <div className="recovery-row" key={backup.id}>
              <div>
                <strong>{backupTitle[backup.kind]}</strong>
                <span>{backup.time} · {backup.files} 个文件</span>
                <div className="recovery-categories">{backup.fileCategories.map((category) => <span key={category}>{category}</span>)}</div>
              </div>
              <button className="danger-button" type="button" onClick={() => onRestoreRequested(backup)} disabled={busy !== null} title={backup.restoreDetail}>
                <RotateCcw size={16} />
                安全恢复
              </button>
            </div>
          ))}
        </div> : <div className="empty-state recovery-empty"><RotateCcw size={26} /><strong>首次启动基线备份尚未完成</strong><span>完成前不会允许切换服务商。</span></div>}
        {invalidBackupCount > 0 && <p className="section-meta">检测到 {invalidBackupCount} 个未完成或损坏的备份目录，已从安全恢复列表隐藏，不会自动删除。</p>}
      </section>
    </div>
  )
}

function ApplicationSettingsWorkspace({
  autoStart,
  desktopAvailable,
  busy,
  onToggle,
}: {
  autoStart: boolean
  desktopAvailable: boolean
  busy: string | null
  onToggle: (enabled: boolean) => void
}) {
  const disabled = !desktopAvailable || busy !== null
  return (
    <div className="workspace-stack">
      <section className="surface-panel application-settings-panel">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">启动方式</span>
            <h3>开机后自动打开</h3>
          </div>
          <span className={`section-meta ${autoStart ? 'status-ok' : ''}`}>{autoStart ? '已开启' : '默认关闭'}</span>
        </div>
        <p>只在你主动开启后，Signalman AI 才会在下次登录 Windows 时自动打开。安装、升级和首次使用都不会自动开启。</p>
        <label className="setting-toggle-row">
          <span>
            <strong>开启开机启动</strong>
            <small>{desktopAvailable ? '关闭后，下次登录不会自动打开应用。' : '开发预览和 Web 诊断模式不会修改 Windows 启动项。'}</small>
          </span>
          <input
            type="checkbox"
            checked={autoStart}
            disabled={disabled}
            onChange={(event) => onToggle(event.target.checked)}
            aria-label="开启开机启动"
          />
        </label>
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
  onConfirm: (confirmation: string) => void
}) {
  const [confirmation, setConfirmation] = useState('')
  return (
    <div className="confirm-backdrop" role="presentation">
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="restore-dialog-title">
        <div className="confirm-dialog-icon"><AlertTriangle size={20} /></div>
        <div>
          <span className="eyebrow">安全恢复 · {backup.time}</span>
          <h2 id="restore-dialog-title">确认回到这个恢复点？</h2>
          <p>将只回退本工具写入的服务商、模型、接口地址和本机登录信息。MCP、插件、项目设置和你后来新增的内容不会被覆盖。</p>
          <label className="restore-confirmation-field">
            输入“恢复”后启用确认按钮
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="恢复" autoFocus />
          </label>
        </div>
        <div className="command-row">
          <button className="ghost-button" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="danger-button" type="button" onClick={() => onConfirm(confirmation)} disabled={busy || confirmation.trim() !== '恢复'}>
            <RotateCcw size={16} />
            确认恢复
          </button>
        </div>
      </section>
    </div>
  )
}

function SwitchConfirmDialog({
  preflight,
  busy,
  onCancel,
  onConfirm,
}: {
  preflight: SwitchPreflight
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="confirm-backdrop" role="presentation">
      <section className="confirm-dialog switch-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="switch-dialog-title">
        <div className="confirm-dialog-icon"><GitCompareArrows size={20} /></div>
        <div>
          <span className="eyebrow">切换影响确认</span>
          <h2 id="switch-dialog-title">确认切换到 {preflight.targetName}？</h2>
          <p>该服务商最近一次连接测试已通过。确认时会再次核对当前配置没有变化，再创建新的恢复点；不会显示访问密钥或完整配置内容。</p>
          <dl className="switch-confirm-facts">
            <div><dt>目标模型</dt><dd>{preflight.targetModel}</dd></div>
            <div><dt>恢复点</dt><dd>{preflight.backupDetail}</dd></div>
            <div><dt>保护检查</dt><dd>{preflight.protectedDetail}</dd></div>
          </dl>
          <p>此预览有效至 {preflight.expiresAt}。完成后请关闭当前 Codex 会话，并在新的会话中确认实际 provider 使用情况。</p>
        </div>
        <div className="command-row">
          <button className="ghost-button" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="primary-button" type="button" onClick={onConfirm} disabled={busy}>
            <PlugZap size={16} />
            确认切换
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
