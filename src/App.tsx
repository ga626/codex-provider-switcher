import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleHelp,
  Copy,
  Activity,
  Download,
  Eye,
  EyeOff,
  FlaskConical,
  GripVertical,
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
  Settings,
  ShieldCheck,
  Star,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
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
  runResponseProbe,
  restoreBackup,
  saveProfile,
  setDefaultProfile,
  saveCostCalibration,
  syncCurrentConfiguration,
  switchProfile,
  setBackupPolicy,
  toggleAutoStart,
  verifyProfile,
} from './adapter'
import type { AppState, BackupItem, ConfigurationProtection, CostCalibration, EditableProfile, ModelCatalog, ProviderProfile, SwitchPreflight, UpdateInfo, ValidationCheck } from './types'

type ViewId = 'providers' | 'models' | 'switch-check' | 'protection' | 'timeline' | 'lab'

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
      detail: model.length > 0
        ? providerModelLabel(model) === model ? model : `${providerModelLabel(model)}（模型标识：${model}）`
        : '需要填写 Codex 使用的模型名称。',
      severity: 'required',
    },
    {
      id: 'profile-api-key',
      label: '切换器访问密钥',
      ok: hasKey,
      detail: hasKey ? '已保存，可运行切换器的真实连接测试。' : '未保存；仍可安全切换，但本工具无法代替 Codex 验证服务商可用性。',
      severity: 'warning',
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
    severity: 'warning',
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

function isClearlyIncompatibleModel(model: ModelCatalog['models'][number]) {
  return model.tags.some((tag) => tag === 'embedding' || tag === 'audio')
}

function modelSelectionRank(model: ModelCatalog['models'][number]) {
  if (isClearlyIncompatibleModel(model)) return 3
  if (model.verifiedForResponses === 'verified') return 0
  if (model.tags.includes('responses-candidate')) return 1
  return 2
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

function decimalToScaled(value: string) {
  const [whole = '0', fraction = ''] = value.trim().split('.', 2)
  return BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, '0').slice(0, 12) || '0')
}

function providerModelLabel(model: string) {
  const mockLabels: Record<string, string> = {
    'reasoning-current': '当前推理模型',
    'reasoning-preview': '推理模型（预览）',
    'reasoning-verified': '推理模型（已验证）',
    'provider-reasoning-current': '默认推理模型',
    'provider-reasoning-stable': '稳定推理模型',
    'provider-fast-current': '默认快速模型',
    'provider-fast-stable': '稳定快速模型',
    'provider-chat-compatible': '兼容对话模型',
    'provider-embedding-large': '向量模型',
  }
  return mockLabels[model] ?? model
}

function useModalDialog(onClose: () => void) {
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusInitialAction = () => dialogRef.current?.querySelector<HTMLElement>('[data-dialog-initial-focus]')?.focus()
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const focusTimer = window.setTimeout(focusInitialAction, 0)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus()
    }
  }, [onClose])

  return dialogRef
}

function ModalDialog({
  className = '',
  labelledBy,
  onClose,
  children,
}: {
  className?: string
  labelledBy: string
  onClose: () => void
  children: ReactNode
}) {
  const dialogRef = useModalDialog(onClose)
  return (
    <div className="confirm-backdrop" role="presentation">
      <section ref={dialogRef} className={`confirm-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </section>
    </div>
  )
}

function SortableProviderRow({
  profile,
  index,
  selected,
  disabled,
  onSelect,
  onMove,
}: {
  profile: ProviderProfile
  index: number
  selected: boolean
  disabled: boolean
  onSelect: () => void
  onMove: (targetIndex: number) => void
}) {
  const { attributes, isDragging, isOver, listeners, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({
    id: profile.id,
    disabled,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-provider-id={profile.id}
      className={`provider-row ${selected ? 'selected' : ''} ${profile.active ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isOver ? 'drag-over' : ''}`}
      role="option"
      aria-selected={selected}
      tabIndex={disabled ? -1 : 0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.altKey && event.key === 'ArrowUp') {
          event.preventDefault()
          onMove(Math.max(0, index - 1))
        } else if (event.altKey && event.key === 'ArrowDown') {
          event.preventDefault()
          onMove(index + 1)
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      <button
        ref={setActivatorNodeRef}
        className="provider-drag-handle"
        type="button"
        title="拖动排序"
        aria-label={`拖动 ${profile.name} 调整列表顺序`}
        onClick={(event) => event.stopPropagation()}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={15} aria-hidden="true" />
      </button>
      <span className="provider-symbol" aria-hidden="true"><Server size={16} /></span>
      <span className="provider-row-main">
        <strong>
          {profile.name}
          {profile.isDefault && <Star size={12} />}
        </strong>
        <small>{profile.model ? `模型：${providerModelLabel(profile.model)}` : '尚未设置默认模型'}</small>
      </span>
      <span className={`row-state ${profile.verified ? 'ok' : 'warning'}`} />
    </div>
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

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
  const riskCount = switchGateChecks.filter((check) => !check.ok && check.severity !== 'required').length
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

  function handleProviderDragEnd({ active, over }: DragEndEvent) {
    if (!state || !over || active.id === over.id) return
    const targetIndex = state.profiles.findIndex((profile) => profile.id === over.id)
    if (targetIndex >= 0) {
      moveProvider(String(active.id), targetIndex)
    }
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
    if (state?.runtimeMode !== 'tauri_native') {
      return
    }
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

  async function confirmSwitch(riskAcknowledged: boolean) {
    if (!switchConfirm) return
    const { profileId, operationId } = switchConfirm
    setSwitchConfirm(null)
    await runAction('switch', () => switchProfile(profileId, operationId, riskAcknowledged))
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

  const primaryNavItems: Array<{ id: ViewId; label: string; note: string; icon: React.ReactNode }> = [
    { id: 'providers', label: '服务商', note: `${state.profiles.length} 个配置`, icon: <LayoutDashboard size={17} /> },
    { id: 'protection', label: '安全与恢复', note: state.configurationProtection.baselineReady ? '备份已就绪' : '需要处理', icon: <ShieldCheck size={17} /> },
    { id: 'timeline', label: '活动记录', note: latestActivity?.time ?? '暂无记录', icon: <Activity size={17} /> },
    { id: 'lab', label: '实验室', note: '费用比较', icon: <FlaskConical size={17} /> },
  ]
  const currentFileProfile = state.profiles.find((profile) => profile.active)
  const buildChannelLabel = state.runtimeMode !== 'tauri_native'
    ? '本地预览'
    : __CODEX_RELEASE_CHANNEL__ === 'stable'
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
        <nav className="top-navigation" aria-label="主导航">
          {primaryNavItems.map((item) => (
            <button key={item.id} className={`top-nav-item ${activeView === item.id || (item.id === 'providers' && ['models', 'switch-check'].includes(activeView)) ? 'selected' : ''}`} type="button" aria-label={item.label} title={item.label} onClick={() => setActiveView(item.id)}>
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="title-actions">
          {state.runtimeMode === 'browser_preview_mock' && <span className="preview-status" title="开发预览不会读取本机配置，也不会连接、验证或切换真实服务商。">预览 · 只读</span>}
          <div className="provider-command-bar" aria-label="当前正在使用的服务商">
            <span className="provider-current-label">正在使用</span>
            <strong>{currentFileProfile?.name ?? '未识别'}</strong>
            <span className="provider-current-model">{currentFileProfile?.model ? providerModelLabel(currentFileProfile.model) : '未设置模型'}</span>
          </div>
          {state.runtimeMode === 'tauri_native' && <span className="build-identity" title="用于确认当前运行的发布渠道">{buildChannelLabel} v{__APP_VERSION__}</span>}
          <button className="icon-button" type="button" onClick={() => setSettingsOpen(true)} title="应用设置" aria-label="应用设置">
            <Settings size={17} />
          </button>
        </div>
      </header>

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
          onConfirm={(riskAcknowledged) => void confirmSwitch(riskAcknowledged)}
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

      <section className={`workbench ${['providers', 'models', 'switch-check'].includes(activeView) ? 'provider-workbench' : ''}`}>
        {['providers', 'models', 'switch-check'].includes(activeView) && <aside className="provider-object-pane" aria-labelledby="saved-connections-title">
          <section className="sidebar-connections">
            <div className="sidebar-section-title">
              <span id="saved-connections-title">服务商列表</span>
              <button type="button" onClick={startNewProfile} disabled={busy !== null} aria-label="新增服务商">
                <Plus size={15} />
              </button>
            </div>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleProviderDragEnd}>
              <SortableContext items={state.profiles.map((profile) => profile.id)} strategy={verticalListSortingStrategy}>
                <div className="provider-list" role="listbox" aria-label="服务商列表">
                  {state.profiles.map((profile, index) => (
                    <SortableProviderRow
                      key={profile.id}
                      profile={profile}
                      index={index}
                      selected={profile.id === selectedId}
                      disabled={busy !== null}
                      onSelect={() => selectProfile(profile)}
                      onMove={(targetIndex) => moveProvider(profile.id, Math.min(state.profiles.length - 1, targetIndex))}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </section>
        </aside>}

        <section className={`workspace-panel ${['providers', 'models', 'switch-check'].includes(activeView) ? 'provider-context-panel' : 'full-workspace-panel'}`}>
          <WorkspaceHeader
            activeView={activeView}
            selectedProfile={selectedProfile}
            requiredFailures={requiredFailures}
            riskCount={riskCount}
            selectedModelCatalog={selectedModelCatalog}
            canSwitch={canSwitch}
            preview={state.runtimeMode === 'browser_preview_mock'}
            requestSwitch={requestSwitch}
            onViewChange={setActiveView}
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
                backupPolicy={state.backupPolicy}
                busy={busy}
                onRestoreRequested={(backup) => setRestoreConfirm(backup)}
                onBackupRequested={(confirmation) => void runAction('create-manual-backup', () => createManualBackup(confirmation))}
              />
            )}
            {activeView === 'timeline' && <TimelineWorkspace state={state} />}
            {activeView === 'lab' && <LabWorkspace state={state} selectedProfile={selectedProfile} busy={busy} runAction={runAction} />}
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
      {settingsOpen && (
        <ApplicationSettingsDialog
          autoStart={state.autoStart}
          backupPolicy={state.backupPolicy}
          desktopAvailable={state.runtimeMode === 'tauri_native'}
          busy={busy}
          buildChannelLabel={buildChannelLabel}
          updateInfo={updateInfo}
          updateBusy={updateBusy}
          updateSupported={state.runtimeMode === 'tauri_native' && (isStoreManagedBuild || isGitHubReleaseBuild)}
          storeManaged={isStoreManagedBuild}
          onClose={() => setSettingsOpen(false)}
          onToggle={(enabled) => void runAction('toggle-auto-start', () => toggleAutoStart(enabled))}
          onBackupPolicyChange={(automaticLimit, manualLimit) => void runAction('set-backup-policy', () => setBackupPolicy(automaticLimit, manualLimit))}
          onUpdate={() => void handleUpdate()}
        />
      )}
    </main>
  )
}

function WorkspaceHeader({
  activeView,
  selectedProfile,
  requiredFailures,
  riskCount,
  selectedModelCatalog,
  canSwitch,
  preview,
  requestSwitch,
  onViewChange,
}: {
  activeView: ViewId
  selectedProfile: ProviderProfile | undefined
  requiredFailures: number
  riskCount: number
  selectedModelCatalog: ModelCatalog | undefined
  canSwitch: boolean
  preview: boolean
  requestSwitch: () => Promise<void>
  onViewChange: (view: ViewId) => void
}) {
  if (activeView === 'lab') return null

  const isProviderContext = ['providers', 'models', 'switch-check'].includes(activeView)
  const copy: Record<ViewId, { title: string; note: string }> = {
    providers: {
      title: '服务商',
      note: selectedProfile ? `已选择 ${selectedProfile.name}` : '新增并管理服务商连接。',
    },
    models: {
      title: '模型目录',
      note: selectedModelCatalog?.statusDetail ?? '尚未同步模型目录。',
    },
    'switch-check': {
      title: '切换前检查',
      note: !selectedProfile ? '先新增并保存服务商。' : requiredFailures > 0 ? '请先处理会阻止安全写入的项目。' : riskCount > 0 ? '可以切换，但请先了解使用风险。' : '已满足切换条件。',
    },
    protection: {
      title: '配置保护',
      note: '查看备份、受保护内容和恢复入口。',
    },
    timeline: {
      title: '活动记录',
      note: '切换、检查和配置变更按时间记录。',
    },
    lab: {
      title: '实验室',
      note: '记录同一测试的实际花费，比较服务商性价比。',
    },
  }

  if (isProviderContext) {
    const switchLabel = !selectedProfile
      ? '先选择服务商'
      : selectedProfile.active
        ? '当前正在使用'
        : '检查并切换'
    return (
      <header className="workspace-header provider-workspace-header">
        <nav className="provider-workflow-nav" aria-label="服务商管理入口">
          <button className={activeView === 'providers' ? 'selected' : ''} type="button" onClick={() => onViewChange('providers')}>
            <Settings size={19} aria-hidden="true" />
            <span>配置</span>
          </button>
          <button className={activeView === 'models' ? 'selected' : ''} type="button" onClick={() => onViewChange('models')}>
            <Boxes size={19} aria-hidden="true" />
            <span>模型目录</span>
          </button>
          <button className={activeView === 'switch-check' ? 'selected' : ''} type="button" onClick={() => onViewChange('switch-check')}>
            <ShieldCheck size={19} aria-hidden="true" />
            <span>切换前检查</span>
          </button>
        </nav>
        <div className="provider-switch-slot">
          <button
            className={`provider-switch-command ${selectedProfile?.active ? 'current' : 'ready'}`}
            type="button"
            disabled={!selectedProfile || selectedProfile.active || !canSwitch}
            onClick={() => void requestSwitch()}
            aria-label={selectedProfile?.active ? `当前正在使用 ${selectedProfile.name}` : selectedProfile ? `检查并切换到 ${selectedProfile.name}` : switchLabel}
            title={preview ? '预览不会修改本机配置。' : selectedProfile ? `目标服务商：${selectedProfile.name}` : undefined}
          >
            <PlugZap size={18} />
            {switchLabel}
          </button>
        </div>
      </header>
    )
  }

  return (
    <header className="workspace-header">
      <div>
        <h2>{copy[activeView].title}</h2>
        <p>{copy[activeView].note}</p>
      </div>
      {activeView === 'switch-check' && <span className={`workspace-badge ${selectedProfile && requiredFailures === 0 ? (riskCount > 0 ? 'warning' : 'ok') : 'warning'}`}>
        {!selectedProfile ? '未选择服务商' : requiredFailures > 0 ? `${requiredFailures} 项阻止切换` : riskCount > 0 ? `可切换，但有 ${riskCount} 项风险` : '可以切换'}
      </span>}
    </header>
  )
}

function RestartCodexNoticeDialog({ onClose }: { onClose: () => void }) {
  return (
    <ModalDialog className="restart-notice-dialog" labelledBy="restart-notice-title" onClose={onClose}>
      <div className="confirm-dialog-icon"><RotateCcw size={20} /></div>
      <div>
        <span className="eyebrow">切换已完成</span>
        <h2 id="restart-notice-title">请重新打开 Codex</h2>
        <p>新配置已经写入并创建了恢复点，但当前正在运行的 Codex 或 ChatGPT 桌面端中的 Codex 会话不会自动切换。请关闭当前会话后重新打开，再确认实际工作正常。</p>
      </div>
      <div className="command-row">
        <button className="primary-button" type="button" onClick={onClose} data-dialog-initial-focus>我知道了</button>
      </div>
    </ModalDialog>
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
  const [keyVisible, setKeyVisible] = useState(false)
  const hasSavedKey = Boolean(selectedProfile?.hasApiKey && !draft.apiKey)
  return (
    <div className="workspace-stack">
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
            {providerModelLabel(draft.model) !== draft.model && <small className="model-purpose-note">用途：{providerModelLabel(draft.model)}。输入框内保留实际模型标识。</small>}
          </label>
          <label>
            访问密钥
            <div className="key-field">
              <KeyRound size={15} />
              <input
                value={draft.apiKey}
                onChange={(event) => updateDraft('apiKey', event.target.value)}
                placeholder={hasSavedKey ? '••••••••••••' : '粘贴访问密钥'}
                type={keyVisible ? 'text' : 'password'}
                aria-label={hasSavedKey ? '已保存访问密钥，输入新密钥即可替换' : '访问密钥'}
              />
              <button
                className="icon-button key-visibility-button"
                type="button"
                onClick={() => setKeyVisible((visible) => !visible)}
                title={keyVisible ? '隐藏本次输入的密钥' : '显示本次输入的密钥'}
                aria-label={keyVisible ? '隐藏本次输入的密钥' : '显示本次输入的密钥'}
              >
                {keyVisible ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {hasSavedKey && <small className="key-saved-note">已保存。重新输入可替换；已保存内容不会回传到界面。</small>}
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
  }).toSorted((left, right) => modelSelectionRank(left) - modelSelectionRank(right))
  const totalModels = selectedModelCatalog?.models.length ?? 0

  return (
    <div className="workspace-stack">
      <section className="surface-panel model-toolbar">
        <div>
          <span>当前服务商</span>
          <strong>{selectedProfile?.name ?? '未选择'}</strong>
          <small>{selectedProfile?.model ? `当前模型：${providerModelLabel(selectedProfile.model)}` : '选择左侧服务商后刷新模型目录'}</small>
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
                  <strong>{providerModelLabel(model.id)}</strong>
                  {providerModelLabel(model.id) !== model.id && <small>模型标识：{model.id}</small>}
                  {model.aliases.length > 0 && <small>别名：{model.aliases.join(', ')}</small>}
                  <div className="model-meta">
                    <span>服务商目录</span>
                    {selectedProfile?.model.toLocaleLowerCase() === model.id.toLocaleLowerCase() && model.verifiedForResponses === 'verified' && (
                      <span>当前模型可用性测试通过</span>
                    )}
                    {model.tags.map((tag) => <span key={tag}>{tag}</span>)}
                    {isClearlyIncompatibleModel(model) && <span className="model-incompatible">不适用于 Codex Responses</span>}
                  </div>
                </span>
                <button
                  className="ghost-button compact-button"
                  type="button"
                  onClick={() => selectModel(model.id)}
                  disabled={busy !== null || selectedProfile?.model === model.id || isClearlyIncompatibleModel(model)}
                  title={isClearlyIncompatibleModel(model) ? '该模型目录标签表明它不适用于 Codex Responses。' : undefined}
                >
                  {selectedProfile?.model === model.id ? '当前模型' : isClearlyIncompatibleModel(model) ? '不适用' : '使用'}
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
    <ModalDialog labelledBy="manual-model-dialog-title" onClose={onCancel}>
      <div className="confirm-dialog-icon"><AlertTriangle size={20} /></div>
      <div>
        <span className="eyebrow">未验证模型</span>
        <h2 id="manual-model-dialog-title">确认保存手动模型？</h2>
        <p>{model} 不在最近刷新到的服务商模型目录中。保存后可运行可用性测试；测试未确认不代表已有 Codex 使用会失败。</p>
      </div>
      <div className="command-row">
        <button className="ghost-button" type="button" onClick={onCancel} disabled={busy} data-dialog-initial-focus>取消</button>
        <button className="danger-button" type="button" onClick={onConfirm} disabled={busy}>继续保存</button>
      </div>
    </ModalDialog>
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
    <ModalDialog labelledBy="sync-dialog-title" onClose={onCancel}>
      <div className="confirm-dialog-icon"><GitCompareArrows size={20} /></div>
      <div>
        <span className="eyebrow">同步当前 Codex 配置</span>
        <h2 id="sync-dialog-title">确认更新切换器目录？</h2>
        <p>{drift.profileName} 当前保存的是 {drift.savedModel}，Codex 正在使用 {drift.currentModel}。此操作只更新切换器目录，不会写入 Codex 配置、认证文件或发起远端请求。</p>
      </div>
      <div className="command-row">
        <button className="ghost-button" type="button" onClick={onCancel} disabled={busy} data-dialog-initial-focus>取消</button>
        <button className="primary-button" type="button" onClick={onConfirm} disabled={busy}>确认同步</button>
      </div>
    </ModalDialog>
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
  backupPolicy,
  busy,
  onRestoreRequested,
  onBackupRequested,
}: {
  protection: ConfigurationProtection
  backups: BackupItem[]
  backupPolicy: AppState['backupPolicy']
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
  const baselineBackups = backups.filter((backup) => backup.kind === 'initial_install')
  const automaticBackups = backups.filter((backup) => backup.restoreReady && ['daily', 'before_switch', 'before_restore'].includes(backup.kind))
  const manualBackups = backups.filter((backup) => backup.restoreReady && backup.kind === 'manual')
  const historicalBackups = backups.filter((backup) => !backup.retentionManaged && backup.kind !== 'initial_install')
  const manualBackupLimitReached = manualBackups.length >= backupPolicy.manualLimit
  const RecoveryGroup = ({ title, note, items, permanent }: { title: string; note: string; items: BackupItem[]; permanent?: boolean }) => (
    <section className="recovery-group">
      <div className="recovery-group-heading"><div><strong>{title}</strong><span>{note}</span></div>{permanent && <span className="section-meta">永久保留</span>}</div>
      {items.length > 0 ? <div className="recovery-list">{items.map((backup) => (
        <div className="recovery-row" key={backup.id}>
          <div><strong>{backupTitle[backup.kind]}</strong><span>{backup.time} · {backup.files} 个文件</span><div className="recovery-categories">{backup.fileCategories.map((category) => <span key={category}>{category}</span>)}</div></div>
          <button className="danger-button" type="button" onClick={() => onRestoreRequested(backup)} disabled={busy !== null} title={backup.restoreDetail}><RotateCcw size={16} />安全恢复</button>
        </div>
      ))}</div> : <p className="section-meta">暂时没有恢复点。</p>}
    </section>
  )
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
            <span className="section-meta">自动保护保留 {backupPolicy.automaticLimit} 个；手动保存保留 {backupPolicy.manualLimit} 个。</span>
            <button className="primary-button" type="button" onClick={() => {
              if (!manualBackupLimitReached) {
                onBackupRequested()
                return
              }
              if (window.confirm(`已保留 ${backupPolicy.manualLimit} 个手动恢复点。继续将替换最早的手动恢复点，是否继续？`)) {
                onBackupRequested('替换')
              }
            }} disabled={busy !== null}>
              <Save size={16} />
              立即备份当前状态
            </button>
          </div>
        </div>
        <RecoveryGroup title="首次基线" note="首次运行前的原始状态，只保留一份。" items={baselineBackups} permanent />
        <RecoveryGroup title="自动保护" note="每天首次打开、切换前和恢复前自动保存。" items={automaticBackups} />
        <RecoveryGroup title="手动保存" note="由你主动保存当前可用状态。" items={manualBackups} />
        {historicalBackups.length > 0 && <details className="historical-backups"><summary>历史项目（{historicalBackups.length}）</summary><p>这些旧目录不会参与恢复或自动清理；它们保留在本机，等待你确认后再整理。</p></details>}
      </section>
    </div>
  )
}

function ApplicationSettingsDialog({
  autoStart,
  backupPolicy,
  desktopAvailable,
  busy,
  buildChannelLabel,
  updateInfo,
  updateBusy,
  updateSupported,
  storeManaged,
  onClose,
  onToggle,
  onBackupPolicyChange,
  onUpdate,
}: {
  autoStart: boolean
  backupPolicy: AppState['backupPolicy']
  desktopAvailable: boolean
  busy: string | null
  buildChannelLabel: string
  updateInfo: UpdateInfo | null
  updateBusy: boolean
  updateSupported: boolean
  storeManaged: boolean
  onClose: () => void
  onToggle: (enabled: boolean) => void
  onBackupPolicyChange: (automaticLimit: number, manualLimit: number) => void
  onUpdate: () => void
}) {
  const disabled = !desktopAvailable || busy !== null
  const updateStatus = updateBusy
    ? '正在检查更新…'
    : !updateSupported
      ? desktopAvailable ? '当前版本不检查公开更新' : '本地预览不检查公开更新'
      : storeManaged
        ? '在 Microsoft Store 获取更新'
        : updateInfo?.available
          ? `发现新版本 v${updateInfo.latestVersion}`
          : updateInfo
            ? '已是最新版本'
            : '尚未检查更新'
  const updateAction = storeManaged
    ? '前往 Microsoft Store'
    : updateInfo?.available
      ? `下载 v${updateInfo.latestVersion}`
      : '检查更新'
  return (
    <ModalDialog className="application-settings-dialog" labelledBy="application-settings-title" onClose={onClose}>
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">应用设置</span>
            <h2 id="application-settings-title">应用偏好</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭设置" data-dialog-initial-focus><X size={16} /></button>
        </div>
        <section className="settings-section" aria-labelledby="settings-startup-title">
          <div className="settings-section-heading">
            <h3 id="settings-startup-title">启动</h3>
            <p>控制应用何时打开，不会改变 Codex 的启动方式。</p>
          </div>
          <label className="setting-toggle-row">
            <span>
              <strong>开机后自动打开</strong>
              <small>{desktopAvailable ? '关闭后，下次登录 Windows 不会自动打开应用。' : '开发预览和 Web 诊断模式不会修改 Windows 启动项。'}</small>
            </span>
            <input
              type="checkbox"
              checked={autoStart}
              disabled={disabled}
              onChange={(event) => onToggle(event.target.checked)}
              aria-label="开机后自动打开"
            />
          </label>
        </section>
        <section className="settings-section" aria-labelledby="settings-protection-title">
          <div className="settings-section-heading">
            <h3 id="settings-protection-title">恢复保护</h3>
            <p>首次启动基线永久保留。恢复和手动保存请前往“安全与恢复”。</p>
          </div>
          <div className="settings-option-group">
            <label>
              自动保护
              <select value={backupPolicy.automaticLimit} disabled={busy !== null} onChange={(event) => onBackupPolicyChange(Number(event.target.value), backupPolicy.manualLimit)}>
                {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} 个</option>)}
              </select>
            </label>
            <label>
              手动保存
              <select value={backupPolicy.manualLimit} disabled={busy !== null} onChange={(event) => onBackupPolicyChange(backupPolicy.automaticLimit, Number(event.target.value))}>
                {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} 个</option>)}
              </select>
            </label>
          </div>
        </section>
        <section className="settings-section" aria-labelledby="settings-update-title">
          <div className="settings-section-heading">
            <h3 id="settings-update-title">更新</h3>
            <p>只从受信任的发布渠道获取新版本。</p>
          </div>
          <div className="settings-update-row">
            <div>
              <strong>v{__APP_VERSION__}</strong>
              <span>{buildChannelLabel}</span>
              <small>{updateStatus}</small>
            </div>
            <button className="ghost-button settings-update-button" type="button" onClick={onUpdate} disabled={updateBusy || !updateSupported}>
              {updateBusy ? <RefreshCcw className="spin" size={15} /> : updateInfo?.available && !storeManaged ? <Download size={15} /> : updateInfo && !updateInfo.available && !storeManaged ? <CheckCircle2 size={15} /> : <RefreshCcw size={15} />}
              {updateAction}
            </button>
          </div>
        </section>
    </ModalDialog>
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
    <ModalDialog labelledBy="restore-dialog-title" onClose={onCancel}>
      <div className="confirm-dialog-icon"><AlertTriangle size={20} /></div>
      <div>
        <span className="eyebrow">安全恢复 · {backup.time}</span>
        <h2 id="restore-dialog-title">确认回到这个恢复点？</h2>
        <p>将只回退本工具写入的服务商、模型、接口地址和本机登录信息。MCP、插件、项目设置和你后来新增的内容不会被覆盖。</p>
        <label className="restore-confirmation-field">
          输入“恢复”后启用确认按钮
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="恢复" autoFocus data-dialog-initial-focus />
        </label>
      </div>
      <div className="command-row">
        <button className="ghost-button" type="button" onClick={onCancel} disabled={busy}>取消</button>
        <button className="danger-button" type="button" onClick={() => onConfirm(confirmation)} disabled={busy || confirmation.trim() !== '恢复'}>
          <RotateCcw size={16} />
          确认恢复
        </button>
      </div>
    </ModalDialog>
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
  onConfirm: (riskAcknowledged: boolean) => void
}) {
  const [riskAcknowledged, setRiskAcknowledged] = useState(false)
  const hasRisk = Boolean(preflight.riskDetail)
  return (
    <ModalDialog className="switch-confirm-dialog" labelledBy="switch-dialog-title" onClose={onCancel}>
      <div className="confirm-dialog-icon"><GitCompareArrows size={20} /></div>
      <div>
        <span className="eyebrow">切换影响确认</span>
        <h2 id="switch-dialog-title">确认切换到 {preflight.targetName}？</h2>
        <p>{preflight.riskDetail ? '本次可以安全写入配置，但仍有使用风险。确认时会再次核对当前配置没有变化，再创建新的恢复点；不会显示访问密钥或完整配置内容。' : '该服务商最近一次连接测试已通过。确认时会再次核对当前配置没有变化，再创建新的恢复点；不会显示访问密钥或完整配置内容。'}</p>
        <dl className="switch-confirm-facts">
          <div><dt>目标模型</dt><dd>{preflight.targetModel}</dd></div>
          <div><dt>恢复点</dt><dd>{preflight.backupDetail}</dd></div>
          <div><dt>保护检查</dt><dd>{preflight.protectedDetail}</dd></div>
          {preflight.riskDetail && <div><dt>使用风险</dt><dd>{preflight.riskDetail}</dd></div>}
        </dl>
        {hasRisk && (
          <label className="risk-confirmation">
            <input type="checkbox" checked={riskAcknowledged} onChange={(event) => setRiskAcknowledged(event.target.checked)} data-dialog-initial-focus />
            <span>我已了解：这不会影响安全写入检查，但目标服务商的实际可用性尚未由本工具确认。</span>
          </label>
        )}
        <p>此预览有效至 {preflight.expiresAt}。完成后请关闭当前 Codex 会话，并在新的会话中确认实际 provider 使用情况。</p>
      </div>
      <div className="command-row">
        <button className="ghost-button" type="button" onClick={onCancel} disabled={busy} data-dialog-initial-focus={!hasRisk}>取消</button>
        <button className="primary-button" type="button" onClick={() => onConfirm(riskAcknowledged)} disabled={busy || (hasRisk && !riskAcknowledged)}>
          <PlugZap size={16} />
          确认切换
        </button>
      </div>
    </ModalDialog>
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

function LabWorkspace({
  state,
  selectedProfile,
  busy,
  runAction,
}: {
  state: AppState
  selectedProfile: ProviderProfile | undefined
  busy: string | null
  runAction: (label: string, action: () => Promise<AppState>) => Promise<void>
}) {
  const [labProviderId, setLabProviderId] = useState(selectedProfile?.id ?? state.currentProfileId)
  const [fundingMode, setFundingMode] = useState<CostCalibration['fundingMode']>('prepaid')
  const [paidCny, setPaidCny] = useState('')
  const [consumableCredit, setConsumableCredit] = useState('')
  const [debitCredit, setDebitCredit] = useState('')
  const profile = state.profiles.find((item) => item.id === labProviderId) ?? selectedProfile ?? state.profiles.find((item) => item.active)
  const latestProbe = (state.responseProbes ?? []).find((item) => item.providerId === profile?.id && item.probeVersion === 'response-observation-v1')
  const completedCalibrations = (state.costCalibrations ?? []).filter((item) => item.state === 'completed' && item.resultCny !== '0')
  const comparableRecords = completedCalibrations
    .filter((item) => item.model === (profile?.model || '未设置模型') && item.probeVersion === 'cost-calibration-v1')
    .toSorted((left, right) => {
      const difference = decimalToScaled(left.resultCny) - decimalToScaled(right.resultCny)
      return difference < 0n ? -1 : difference > 0n ? 1 : 0
    })
  const lowestCost = comparableRecords[0] ? decimalToScaled(comparableRecords[0].resultCny) : null
  const scoreFor = (item: CostCalibration) => {
    if (!lowestCost || comparableRecords.length < 2) return null
    const normalized = decimalToScaled(item.resultCny)
    if (normalized <= 0n) return null
    return Math.max(1, Math.min(100, Number((lowestCost * 100n) / normalized)))
  }

  useEffect(() => {
    if (latestProbe?.status === 'final_cost_inline' && latestProbe.costCandidate) {
      setDebitCredit(latestProbe.costCandidate)
    }
  }, [latestProbe?.costCandidate, latestProbe?.status])

  async function runCostTest() {
    if (!profile) return
    await runAction('run-cost-probe', () => runResponseProbe(profile.id))
  }

  async function saveCalibration() {
    if (!profile) return
    await runAction('save-cost-calibration', () => saveCostCalibration({
      providerId: profile.id,
      providerName: profile.name,
      fundingMode,
      paidCny,
      consumableCredit,
      debitCredit,
      creditUnitLabel: '平台额度',
      model: profile.model || '未设置模型',
      probeVersion: 'cost-calibration-v1',
    }))
    setDebitCredit('')
  }

  return (
    <div className="workspace-stack lab-workspace">
      <section className="lab-intro">
        <FlaskConical size={22} aria-hidden="true" />
        <div>
          <h3>性价比中心</h3>
          <p>用同一条固定测试的人民币成本，比较服务商。</p>
        </div>
      </section>
      <section className="surface-panel lab-ranking" aria-labelledby="lab-ranking-title">
        <div className="section-heading-row">
          <div>
            <h3 id="lab-ranking-title">性价比排名</h3>
          </div>
          <span className="section-meta">同一模型中，最低实际花费为 100 分</span>
        </div>
        {comparableRecords.length < 2 ? <p className="lab-empty">先为至少两个服务商保存同一模型的费用记录，才能生成排名。</p> : (
          <div className="lab-ranking-list">
            {comparableRecords.map((item, index) => (
              <div className="lab-ranking-row" key={item.id}>
                <span className="ranking-position">{index + 1}</span>
                <div><strong>{item.providerName}</strong><small>{providerModelLabel(item.model)} · {item.updatedAt}</small></div>
                <strong className="ranking-cost">¥{item.resultCny}</strong>
                <div className="ranking-score"><strong>{scoreFor(item)} 分</strong><span>越高越划算</span></div>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="surface-panel lab-record-cost">
        <div className="section-heading-row">
          <div>
            <h3>记录费用</h3>
            <p className="section-description">先运行一次固定测试。系统会尝试读取本次扣费并填入“测试额度”；若服务商没有返回费用，就按提示从平台使用日志复制。再填写充值金额和平台实际额度，保存后即可参与同模型排名。</p>
          </div>
        </div>
        <div className="lab-selected-provider">
          <label>
            服务商
            <select value={profile?.id ?? ''} onChange={(event) => { setLabProviderId(event.target.value); setDebitCredit('') }}>
              {state.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <span>{profile?.model ? providerModelLabel(profile.model) : '未设置模型'}</span>
        </div>
        <div className={`lab-probe-status ${latestProbe ? latestProbe.status : 'idle'}`}>
          <div>
            <strong>{latestProbe?.status === 'final_cost_inline' ? '已读取测试额度' : latestProbe ? '未读取到测试额度' : '尚未运行测试'}</strong>
            <span>{latestProbe?.status === 'final_cost_inline'
              ? '已从响应中读取费用候选值。请确认它与平台使用日志的扣费单位一致。'
              : latestProbe ? latestProbe.detail : '运行后会发出一条极短请求，不会切换服务商或改写 Codex 配置。'}</span>
          </div>
          <button className="primary-button" type="button" disabled={!profile || busy !== null} onClick={() => void runCostTest()}>
            <Activity size={15} />运行固定测试
          </button>
        </div>
        <div className="lab-form">
          <label>
            <span className="field-label">计费方式 <FieldHint text="充值：按实际付款换得平台余额。订阅固定：填写本账期的实际付款和可用总额度。" /></span>
            <select aria-label="计费方式" value={fundingMode} onChange={(event) => setFundingMode(event.target.value as CostCalibration['fundingMode'])}><option value="prepaid">充值</option><option value="subscription">订阅固定</option></select>
          </label>
          <label><span className="field-label">充值金额 <FieldHint text="购买这笔平台额度实际支付的人民币金额。" /></span><input aria-label="充值金额" type="text" inputMode="decimal" value={paidCny} onChange={(event) => setPaidCny(event.target.value)} placeholder="例如 10" /></label>
          <label><span className="field-label">平台实际额度 <FieldHint text="付款后可用于调用的总额度，含赠送和折扣，按平台后台余额填写。" /></span><input aria-label="平台实际额度" type="text" inputMode="decimal" value={consumableCredit} onChange={(event) => setConsumableCredit(event.target.value)} placeholder={fundingMode === 'subscription' ? '本账期可用总额度' : '充值后到账总额'} /></label>
          <label><span className="field-label">测试额度 <FieldHint text="固定测试被平台扣掉的额度。系统能读到时会自动填入；否则从平台使用日志复制。" /></span><input aria-label="测试额度" type="text" inputMode="decimal" value={debitCredit} onChange={(event) => setDebitCredit(event.target.value)} placeholder="运行测试后自动填写，或从日志复制" /></label>
        </div>
        <div className="lab-module-actions"><button className="primary-button" type="button" disabled={!profile || busy !== null || !paidCny || !consumableCredit || !debitCredit} onClick={() => void saveCalibration()}><Save size={15} />计算并保存</button><span>按三项数据换算固定测试的人民币成本。</span></div>
      </section>
      <section className="surface-panel lab-results" aria-labelledby="lab-results-title">
        <div className="section-heading-row"><div><h3 id="lab-results-title">费用记录</h3></div></div>
        {completedCalibrations.length === 0 ? <p className="lab-empty">保存一条费用记录后，这里会显示实际花费和记录时间。</p> : (
          <div className="lab-record-list">
            {completedCalibrations.map((item) => <div className="lab-result-row" key={item.id}><span>{item.providerName}</span><strong>¥{item.resultCny}</strong><small>{providerModelLabel(item.model)} · {item.fundingMode === 'subscription' ? '订阅' : '充值'} · {item.updatedAt}</small></div>)}
          </div>
        )}
      </section>
    </div>
  )
}

function FieldHint({ text }: { text: string }) {
  return (
    <span className="field-hint">
      <button type="button" aria-label="查看字段说明"><CircleHelp size={14} aria-hidden="true" /></button>
      <span role="tooltip">{text}</span>
    </span>
  )
}

export default App
