import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronDown,
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
  MessageSquare,
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
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  deleteProfile,
  checkForUpdate,
  completeOnboarding,
  createManualBackup,
  deleteCostCalibration,
  isGitHubReleaseBuild,
  isStoreManagedBuild,
  loadState,
  openUpdate,
  prepareConnectionEnvironment,
  prepareSwitch,
  previewModels,
  refreshModels,
  revealProfileApiKey,
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
import type { AppState, BackupItem, ConfigurationProtection, CostCalibration, EditableProfile, ModelCatalog, ProviderProfile, ResponseProbeObservation, SwitchPreflight, UpdateInfo, ValidationCheck } from './types'
import type { UpdateInstallProgress } from './adapter'
import { createCompatibilityFeedback } from './feedback'
import { operationElapsedLabel, operationStatusLabel, type ActiveOperation, type OperationId } from './operations'

type ViewId = 'providers' | 'models' | 'switch-check' | 'protection' | 'timeline' | 'lab'
type GuideChapterId = 'initialization' | 'providers' | 'protection' | 'timeline' | 'lab' | 'overview'
type NoticeTone = 'success' | 'warning' | 'danger' | 'info'
type NoticeState = { message: string; tone: NoticeTone }
type FirstRunPhase = 'consent' | 'preparing' | 'review' | 'ready' | 'failed'
type GuideProgress = Record<GuideChapterId, { lastStep: number; completedAt?: string; dismissedAt?: string }>

const GUIDE_PROGRESS_KEY = 'signalman-ai-guide-progress-v1'

const guideChapterForView = (view: ViewId): GuideChapterId => {
  if (view === 'protection') return 'protection'
  if (view === 'timeline') return 'timeline'
  if (view === 'lab') return 'lab'
  return 'providers'
}

function readGuideProgress(): GuideProgress {
  const empty = (): GuideProgress => ({
    initialization: { lastStep: 0 },
    providers: { lastStep: 0 },
    protection: { lastStep: 0 },
    timeline: { lastStep: 0 },
    lab: { lastStep: 0 },
    overview: { lastStep: 0 },
  })
  try {
    const stored = window.localStorage.getItem(GUIDE_PROGRESS_KEY)
    if (!stored) return empty()
    const parsed = JSON.parse(stored) as Partial<GuideProgress>
    const fallback = empty()
    return Object.fromEntries(Object.keys(fallback).map((id) => [id, { ...fallback[id as GuideChapterId], ...parsed[id as GuideChapterId] }])) as GuideProgress
  } catch {
    return empty()
  }
}
const FIRST_RUN_FEED = [
  { title: '读取配置位置', detail: '确认当前电脑上要管理的 Codex 配置层' },
  { title: '检查配置文件', detail: '确认配置文件可以读取，避免覆盖未知内容' },
  { title: '解析 TOML 语法', detail: '检查配置结构是否能被 Codex 正常解析' },
  { title: '确认根模型', detail: '确认 Codex 有可用的默认模型入口' },
  { title: '确认服务商入口', detail: '检查 custom 服务商分组是否存在且可定位' },
  { title: '确认 Responses 线路', detail: '确认切换器使用 Codex 兼容的请求协议' },
  { title: '检查认证方式', detail: '确认不会覆盖密钥或其他登录信息' },
  { title: '创建恢复点', detail: '先保存原始配置，出现问题可以完整撤回' },
  { title: '写入连接设置', detail: '只补齐 Signalman 管理范围内的连接字段' },
  { title: '回读写入结果', detail: '重新读取刚刚写入的内容，确认没有写坏' },
  { title: '复核保护范围', detail: '确认项目、MCP、插件和历史记录没有被改动' },
  { title: '生成检查摘要', detail: '整理成你接下来可以查看的结果清单' },
] as const

const BENCHMARK_MODELS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, cacheWriteUsdPerMillion: 6.25, outputUsdPerMillion: 30 },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.2, cacheWriteUsdPerMillion: 2.5, outputUsdPerMillion: 12 },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, cacheWriteUsdPerMillion: 0.25, outputUsdPerMillion: 1.2 },
  { id: 'gpt-5.5', label: 'GPT-5.5', inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, cacheWriteUsdPerMillion: 0, outputUsdPerMillion: 30 },
] as const

// The official API price table is in USD. A fixed, dated reference keeps saved samples comparable.
// Snapshot: Wise mid-market USD/CNY, 2026-08-09 (latest available when this reference was refreshed).
const OFFICIAL_USD_TO_CNY = 6.74545

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

function updateFailureMessage(error: unknown, fallback: string) {
  const detail = errorMessage(error, fallback).toLowerCase()
  if (detail.includes('timeout') || detail.includes('timed out')) {
    return '检查更新超时。请确认网络可用；如果 GitHub 需要代理，请在 Windows 中开启系统代理后重试。'
  }
  if (detail.includes('proxy') || detail.includes('connection') || detail.includes('network') || detail.includes('dns')) {
    return '暂时无法连接 GitHub 更新服务。请检查网络；如果你使用代理，请确认已在 Windows 中开启系统代理后重试。'
  }
  if (detail.includes('signature') || detail.includes('manifest')) {
    return '更新包验证未通过，已停止安装。请稍后重试或前往项目发布页确认版本。'
  }
  if (detail.includes('http')) {
    return 'GitHub 更新服务暂时未返回有效结果。请稍后重试。'
  }
  return fallback
}

function updateCheckTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function updateProgressLabel(progress: UpdateInstallProgress | null) {
  if (!progress) return ''
  if (progress.phase === 'installing') return '下载完成，正在安装并准备重启…'
  if (!progress.totalBytes) return progress.downloadedBytes > 0 ? '正在下载更新包…' : '正在连接更新包…'
  const percent = Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
  return `正在下载更新包：${percent}%`
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

  if (profile.model.length > 0 && modelCatalogCanBeUsed(modelCatalog)) {
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

function modelCatalogCanBeUsed(catalog: ModelCatalog | undefined): catalog is ModelCatalog {
  return catalog?.status === 'ok' || catalog?.status === 'stale'
}

function requiresManualModelConfirmation(
  draft: EditableProfile,
  profile: ProviderProfile | undefined,
  catalog: ModelCatalog | undefined
) {
  const model = draft.model.trim()
  if (!model || model === profile?.model) return false
  return !modelCatalogCanBeUsed(catalog) || !catalog?.models.some((item) => item.id.toLocaleLowerCase() === model.toLocaleLowerCase())
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

function scaledToDecimal(value: bigint) {
  const whole = value / 1_000_000_000_000n
  const fraction = (value % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function medianScaled(values: bigint[]) {
  const sorted = values.toSorted((left, right) => left < right ? -1 : left > right ? 1 : 0)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2n
}

function formatCny(value: string, maximumFractionDigits = 2) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits,
  }).format(Number(value))
}

function benchmarkModelLabel(model: string) {
  return BENCHMARK_MODELS.find((item) => item.id === model)?.label ?? model
}

function estimateOfficialCny(probe: ResponseProbeObservation | undefined, modelId: string) {
  const model = BENCHMARK_MODELS.find((item) => item.id === modelId)
  const usage = probe?.usage
  if (!model || !usage || usage.inputTokens === undefined || usage.outputTokens === undefined) return null

  const inputTokens = Math.max(0, usage.inputTokens)
  const cachedTokens = Math.min(inputTokens, Math.max(0, usage.cachedTokens ?? 0))
  const cacheWriteTokens = Math.max(0, usage.cacheWriteTokens ?? 0)
  const outputTokens = Math.max(0, usage.outputTokens)
  // Cached input is included in input_tokens, so bill the remainder at the normal input rate.
  const usd = (
    (inputTokens - cachedTokens) * model.inputUsdPerMillion
    + cachedTokens * model.cachedInputUsdPerMillion
    + cacheWriteTokens * model.cacheWriteUsdPerMillion
    + outputTokens * model.outputUsdPerMillion
  ) / 1_000_000
  return decimalToScaled((usd * OFFICIAL_USD_TO_CNY).toFixed(12))
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
  const [draftModelCatalog, setDraftModelCatalog] = useState<ModelCatalog | null>(null)
  const [activeOperation, setActiveOperation] = useState<ActiveOperation | null>(null)
  const [operationNow, setOperationNow] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<UpdateInstallProgress | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [restoreConfirm, setRestoreConfirm] = useState<BackupItem | null>(null)
  const [switchConfirm, setSwitchConfirm] = useState<SwitchPreflight | null>(null)
  const [manualModelConfirm, setManualModelConfirm] = useState<string | null>(null)
  const [syncConfirm, setSyncConfirm] = useState(false)
  const [restartNotice, setRestartNotice] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [guideHubOpen, setGuideHubOpen] = useState(false)
  const [guideChapter, setGuideChapter] = useState<GuideChapterId | null>(null)
  const [guideProgress, setGuideProgress] = useState<GuideProgress>(readGuideProgress)
  const [setupDialogOpen, setSetupDialogOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [firstRun, setFirstRun] = useState<boolean | null>(null)
  const [firstRunPhase, setFirstRunPhase] = useState<FirstRunPhase>('consent')
  const [firstRunTransitioning, setFirstRunTransitioning] = useState(false)
  const [firstRunError, setFirstRunError] = useState<string | null>(null)
  const [preparationStep, setPreparationStep] = useState(0)
  const preparationTimer = useRef<number | null>(null)
  const [paneWidths, setPaneWidths] = useState({ left: 276, right: 360 })
  const [resizingPane, setResizingPane] = useState<'left' | 'right' | null>(null)
  const resizeStart = useRef<{ x: number; left: number; right: number } | null>(null)
  const initialGuideHandled = useRef(false)
  const guideTriggerRef = useRef<HTMLElement | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const busy = activeOperation?.id ?? null

  function beginOperation(id: OperationId) {
    setActiveOperation({ id, startedAt: Date.now() })
  }

  function finishOperation(id: OperationId) {
    setActiveOperation((current) => current?.id === id ? null : current)
  }

  useEffect(() => {
    if (!activeOperation) return undefined
    setOperationNow(Date.now())
    const timer = window.setInterval(() => setOperationNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activeOperation])

  useEffect(() => {
    if (__CODEX_RELEASE_CHANNEL__ !== 'development' || !('__TAURI_INTERNALS__' in window)) return

    // Keep the native window visibly distinct from the daily stable app. This
    // is deliberately loaded only in Tauri, so the browser preview stays free
    // of native API calls.
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      void getCurrentWindow().setTitle(`Signalman AI · 开发版 · ${__CODEX_BUILD_SHA__}`)
    }).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!resizingPane) return undefined
    const onMove = (event: PointerEvent) => {
      const start = resizeStart.current
      if (!start) return
      const delta = event.clientX - start.x
      if (resizingPane === 'left') {
        setPaneWidths((current) => ({ ...current, left: Math.max(220, Math.min(380, start.left + delta)) }))
      } else {
        setPaneWidths((current) => ({ ...current, right: Math.max(320, Math.min(460, start.right - delta)) }))
      }
    }
    const onUp = () => {
      resizeStart.current = null
      setResizingPane(null)
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [resizingPane])

  function beginResize(pane: 'left' | 'right', event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeStart.current = { x: event.clientX, left: paneWidths.left, right: paneWidths.right }
    setResizingPane(pane)
  }

  function resizePaneWithKeyboard(pane: 'left' | 'right', event: React.KeyboardEvent<HTMLDivElement>) {
    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : 0
    if (!direction && !['Home', 'End', 'Enter'].includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 32 : 8
    setPaneWidths((current) => {
      if (event.key === 'Enter') {
        return pane === 'left'
          ? { ...current, left: current.left === 220 ? 276 : 220 }
          : { ...current, right: current.right === 320 ? 360 : 320 }
      }
      if (pane === 'left') {
        const next = event.key === 'Home' ? 220 : event.key === 'End' ? 380 : Math.max(220, Math.min(380, current.left + direction * step))
        return { ...current, left: next }
      }
      const next = event.key === 'Home' ? 320 : event.key === 'End' ? 460 : Math.max(320, Math.min(460, current.right - direction * step))
      return { ...current, right: next }
    })
  }

  useEffect(() => {
    async function loadInitialState() {
      beginOperation('refresh')
      try {
        const next = await loadState()
        setState(next)
        const selected = next.profiles.find((profile) => profile.id === next.currentProfileId) ?? next.profiles[0]
        if (selected) {
          setSelectedId(selected.id)
          setDraft(toEditable(selected))
        }
        setError(null)
        const needsFirstRun = next.connectionEnvironment.status !== 'ready' || !next.connectionEnvironment.onboardingCompleted
        setFirstRun(needsFirstRun)
        setFirstRunPhase(needsFirstRun && next.connectionEnvironment.status === 'ready' ? 'ready' : 'consent')
      } catch (err) {
        setError(errorMessage(err, '加载切换器状态失败。'))
      } finally {
        finishOperation('refresh')
      }
    }

    void loadInitialState()
  }, [])

  useEffect(() => () => {
    if (preparationTimer.current !== null) window.clearInterval(preparationTimer.current)
  }, [])

  useEffect(() => {
    if (!notice) return undefined
    const timeout = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    try {
      window.localStorage.setItem(GUIDE_PROGRESS_KEY, JSON.stringify(guideProgress))
    } catch {
      // Guide progress is a convenience feature. A blocked local store must not affect the app.
    }
  }, [guideProgress])

  useEffect(() => {
    let activeRegion: HTMLElement | null = null
    const onPointerMove = (event: PointerEvent) => {
      const region = (event.target as HTMLElement | null)?.closest<HTMLElement>('.scroll-region') ?? null
      if (activeRegion && activeRegion !== region) activeRegion.removeAttribute('data-scrollbar-intent')
      activeRegion = region
      if (!region) return
      const bounds = region.getBoundingClientRect()
      const nearScrollbar = event.clientX >= bounds.right - 14 || event.clientY >= bounds.bottom - 14
      if (nearScrollbar) region.setAttribute('data-scrollbar-intent', 'true')
      else region.removeAttribute('data-scrollbar-intent')
    }
    document.addEventListener('pointermove', onPointerMove)
    return () => {
      document.removeEventListener('pointermove', onPointerMove)
      activeRegion?.removeAttribute('data-scrollbar-intent')
    }
  }, [])

  async function refresh() {
    beginOperation('refresh')
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
      finishOperation('refresh')
    }
  }

  const selectedProfile = useMemo(() => {
    return state?.profiles.find((profile) => profile.id === selectedId)
  }, [selectedId, state])

  const selectedModelCatalog = useMemo(() => {
    return state?.modelCatalogs.find((catalog) => catalog.providerId === selectedId)
  }, [selectedId, state])
  const usesDraftConnection = Boolean(
    !selectedProfile ||
      draft.name.trim() !== selectedProfile.name ||
      draft.baseUrl.trim() !== selectedProfile.baseUrl ||
      draft.apiKey.trim()
  )
  const visibleModelCatalog = usesDraftConnection ? draftModelCatalog ?? undefined : selectedModelCatalog

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
    if (key === 'name' || key === 'baseUrl' || key === 'apiKey') {
      setDraftModelCatalog(null)
    }
    setDraft((current) => ({ ...current, [key]: value }))
  }

  async function refreshDraftModels() {
    beginOperation('preview-models')
    try {
      const catalog = await previewModels(draft)
      setDraftModelCatalog(catalog)
      setNotice({
        message: catalog.status === 'ok' ? '模型目录已刷新' : '模型目录未能刷新',
        tone: catalog.status === 'ok' ? 'success' : 'warning',
      })
      setError(null)
    } catch (err) {
      setError(errorMessage(err, '无法刷新模型目录。'))
    } finally {
      finishOperation('preview-models')
    }
  }

  async function runAction(label: OperationId, action: () => Promise<AppState>) {
    beginOperation(label)
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
      const activity = next.activity[0]
      setNotice({ message: activity?.title ?? '操作已完成', tone: activity?.tone ?? 'success' })
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
      finishOperation(label)
    }
  }

  async function prepareFirstRun(layerId: string) {
    setFirstRunPhase('preparing')
    setFirstRunError(null)
    setPreparationStep(0)
    beginOperation('prepare-connection-environment')
    let phase = 0
    preparationTimer.current = window.setInterval(() => {
      phase = Math.min(FIRST_RUN_FEED.length, phase + 1)
      setPreparationStep(phase)
    }, 600)
    try {
      // The backend operation is real; the visible feed gives it enough time
      // to be understood instead of flashing straight to the result screen.
      const [next] = await Promise.all([
        prepareConnectionEnvironment(layerId, true),
        new Promise((resolve) => window.setTimeout(resolve, FIRST_RUN_FEED.length * 600 + 450)),
      ])
      setState(next)
      const selected = next.profiles.find((profile) => profile.id === selectedId) ?? next.profiles[0]
      if (selected) {
        setSelectedId(selected.id)
        setDraft(toEditable(selected))
      }
      setFirstRunPhase('review')
      setPreparationStep(FIRST_RUN_FEED.length)
      setNotice({ message: '连接环境已准备好', tone: 'success' })
      setError(null)
    } catch (err) {
      setFirstRunPhase('failed')
      setFirstRunError(errorMessage(err, '准备连接环境失败。原有文件没有被替换。'))
    } finally {
      if (preparationTimer.current !== null) window.clearInterval(preparationTimer.current)
      preparationTimer.current = null
      finishOperation('prepare-connection-environment')
    }
  }

  async function enterSignalman() {
    beginOperation('complete-onboarding')
    try {
      const next = await completeOnboarding()
      setState(next)
    } catch (err) {
      setFirstRunError(errorMessage(err, '无法保存首次使用完成状态。请重试。'))
      return
    } finally {
      finishOperation('complete-onboarding')
    }
    setFirstRunTransitioning(true)
    setFirstRun(false)
    setActiveView('providers')
    window.setTimeout(() => {
      setFirstRunTransitioning(false)
      if (!initialGuideHandled.current) {
        initialGuideHandled.current = true
        setGuideChapter('initialization')
      }
    }, 520)
  }

  function openGuideHub() {
    guideTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setGuideHubOpen(true)
  }

  function openGuideChapter(chapter: GuideChapterId) {
    guideTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : guideTriggerRef.current
    setGuideHubOpen(false)
    setGuideChapter(chapter)
  }

  function closeGuide() {
    setGuideChapter(null)
    window.requestAnimationFrame(() => guideTriggerRef.current?.focus())
  }

  function updateGuideProgress(chapter: GuideChapterId, next: Partial<GuideProgress[GuideChapterId]>) {
    setGuideProgress((current) => ({ ...current, [chapter]: { ...current[chapter], ...next } }))
  }

  async function saveEditableProfile(nextDraft: EditableProfile, busyLabel: OperationId) {
    beginOperation(busyLabel)
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
        setDraftModelCatalog(null)
      }
      const activity = next.activity[0]
      setNotice({ message: activity?.title ?? '已保存配置', tone: activity?.tone ?? 'success' })
      setError(null)
    } catch (err) {
      setError(errorMessage(err, '保存配置失败。'))
    } finally {
      finishOperation(busyLabel)
    }
  }

  async function revealSavedApiKey(profileId: string) {
    beginOperation('reveal-key')
    try {
      setError(null)
      return await revealProfileApiKey(profileId)
    } catch (err) {
      setError(errorMessage(err, '无法读取已保存的访问密钥。'))
      return null
    } finally {
      finishOperation('reveal-key')
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
    setDraftModelCatalog(null)
  }

  function startNewProfile() {
    setSelectedId('')
    setDraft(emptyProfile)
    setDraftModelCatalog(null)
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
      setUpdateError(null)
      beginOperation('check-update')
      try {
        const next = await checkForUpdate()
        setUpdateInfo(next)
        finishOperation('check-update')
        beginOperation('install-update')
        await openUpdate(next.releaseUrl)
        setError(null)
      } catch (err) {
        setUpdateError(errorMessage(err, '无法打开 Microsoft Store。'))
      } finally {
        setUpdateBusy(false)
        finishOperation('check-update')
        finishOperation('install-update')
      }
      return
    }
    if (!isGitHubReleaseBuild) {
      return
    }
    if (updateInfo?.available) {
      setUpdateBusy(true)
      setUpdateError(null)
      setUpdateProgress({ phase: 'downloading', downloadedBytes: 0 })
      beginOperation('install-update')
      try {
        await openUpdate(updateInfo.downloadUrl ?? updateInfo.releaseUrl, setUpdateProgress)
      } catch (err) {
        setUpdateError(updateFailureMessage(err, '下载更新失败。'))
      } finally {
        setUpdateBusy(false)
        setUpdateProgress(null)
        finishOperation('install-update')
      }
      return
    }

    setUpdateBusy(true)
    setUpdateProgress(null)
    setUpdateError(null)
    beginOperation('check-update')
    try {
      const next = await checkForUpdate()
      setUpdateInfo(next)
    } catch (err) {
      setUpdateError(updateFailureMessage(err, '检查更新失败。'))
    } finally {
      setUpdateBusy(false)
      finishOperation('check-update')
    }
  }

  async function restoreLatest(confirmation: string) {
    if (!restoreConfirm) return
    await runAction('restore-backup', () => restoreBackup(restoreConfirm.id, confirmation))
    setRestoreConfirm(null)
  }

  async function requestSwitch() {
    if (!selectedProfile || !canSwitch) return
    beginOperation('prepare-switch')
    try {
      const preflight = await prepareSwitch(selectedProfile.id)
      setSwitchConfirm(preflight)

      // The preflight probe persists the latest verification result. Refresh
      // the visible state before opening the dialog so the checklist behind it
      // cannot keep showing a stale green result after a failed probe.
      try {
        const latest = await loadState()
        setState(latest)
        const latestSelected = latest.profiles.find((profile) => profile.id === selectedProfile.id)
        if (latestSelected) {
          setSelectedId(latestSelected.id)
          setDraft(toEditable(latestSelected))
        }
      } catch {
        // The preflight result is still authoritative for the confirmation
        // dialog; a state refresh failure must not hide it.
      }
      setError(null)
    } catch (err) {
      setError(errorMessage(err, '切换前检查失败。'))
    } finally {
      finishOperation('prepare-switch')
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

  if (firstRun === true) {
    return <FirstRunShell
      environment={state.connectionEnvironment}
      phase={firstRunPhase}
      activeStep={preparationStep}
      checks={state.checks}
      error={firstRunError}
      busy={busy !== null}
      onPrepare={(layerId) => void prepareFirstRun(layerId)}
      onContinue={() => setFirstRunPhase('ready')}
      onBack={(target) => setFirstRunPhase(target === 'setup' ? 'consent' : 'review')}
      onEnter={enterSignalman}
    />
  }

  const primaryNavItems: Array<{ id: ViewId; label: string; note: string; icon: React.ReactNode }> = [
    { id: 'providers', label: '服务商', note: `${state.profiles.length} 个配置`, icon: <LayoutDashboard size={17} /> },
    { id: 'protection', label: '安全与恢复', note: state.configurationProtection.baselineStatus === 'ready' ? '备份已就绪' : state.configurationProtection.baselineStatus === 'empty' ? '等待首次配置' : '需要处理', icon: <ShieldCheck size={17} /> },
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
  const buildIdentityLabel = __CODEX_RELEASE_CHANNEL__ === 'development'
    ? `开发版 · ${__CODEX_BUILD_SHA__}`
    : `${buildChannelLabel} · v${__APP_VERSION__}`

  return (
    <main className={`app-shell${firstRunTransitioning ? ' first-run-transitioning' : ''}`} data-view={activeView}>
      <header className="app-titlebar">
        <div className="brand-lockup">
          <span className="brand-mark"><GitCompareArrows size={20} /></span>
          <div>
            <h1>Signalman AI</h1>
            <p>服务商连接管理</p>
          </div>
        </div>
        <nav className="top-navigation" aria-label="主导航" data-guide-target="overview.navigation">
          {primaryNavItems.map((item) => (
            <button key={item.id} className={`top-nav-item ${activeView === item.id || (item.id === 'providers' && ['models', 'switch-check'].includes(activeView)) ? 'selected' : ''}`} type="button" aria-label={item.label} title={item.label} onClick={() => setActiveView(item.id)}>
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="title-actions">
          {state.runtimeMode === 'browser_preview_mock' && <span className="preview-status" title="开发预览不会读取本机配置，也不会连接、验证或切换真实服务商。">预览 · 只读</span>}
          <div className="provider-command-bar" aria-label="当前正在使用的服务商" data-guide-target="overview.current">
            <span className="provider-current-label">正在使用</span>
            <strong>{currentFileProfile?.name ?? '未识别'}</strong>
            <span className="provider-current-model">{currentFileProfile?.model ? providerModelLabel(currentFileProfile.model) : '未设置模型'}</span>
          </div>
          <button className="icon-button" type="button" onClick={openGuideHub} title="使用说明" aria-label="打开使用说明" data-guide-target="overview.help">
            <CircleHelp size={17} />
          </button>
          <button className="icon-button" type="button" onClick={() => setSettingsOpen(true)} title="应用设置" aria-label="应用设置" data-guide-target="overview.settings">
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
        <div className={`success-toast ${notice.tone}`} role="status">
          {notice.tone === 'success' ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          <span>{notice.message}</span>
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

      <section className={`workbench ${['providers', 'models', 'switch-check'].includes(activeView) ? `provider-workbench ${activeView === 'providers' ? 'has-provider-dock' : ''}` : ''}`} style={{ '--provider-left': `${paneWidths.left}px`, '--provider-right': `${paneWidths.right}px` } as React.CSSProperties}>
        {['providers', 'models', 'switch-check'].includes(activeView) && <aside id="provider-object-pane" className="provider-object-pane" aria-labelledby="saved-connections-title">
          <section className="sidebar-connections">
            <div className="sidebar-section-title">
              <span id="saved-connections-title">服务商列表</span>
              <span
                className="provider-add-transition-target"
                data-transition-target="provider-add"
              >
                <button type="button" onClick={startNewProfile} disabled={busy !== null} aria-label="新增服务商" data-tour="provider-add" data-guide-target="providers.add">
                  <Plus size={15} />
                </button>
              </span>
            </div>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleProviderDragEnd}>
              <SortableContext items={state.profiles.map((profile) => profile.id)} strategy={verticalListSortingStrategy}>
                <div className="provider-list scroll-region" role="listbox" aria-label="服务商列表" data-tour="provider-list" data-guide-target="providers.list">
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
        {['providers', 'models', 'switch-check'].includes(activeView) && <div className="pane-resizer pane-resizer-left" role="separator" aria-orientation="vertical" aria-label="调整服务商列表宽度" aria-controls="provider-object-pane" aria-valuemin={220} aria-valuemax={380} aria-valuenow={paneWidths.left} tabIndex={0} onPointerDown={(event) => beginResize('left', event)} onKeyDown={(event) => resizePaneWithKeyboard('left', event)} />}

        <section id="provider-context-panel" className={`workspace-panel ${['providers', 'models', 'switch-check'].includes(activeView) ? 'provider-context-panel' : 'full-workspace-panel'}`}>
          <WorkspaceHeader
            activeView={activeView}
            selectedProfile={selectedProfile}
            requiredFailures={requiredFailures}
            riskCount={riskCount}
            selectedModelCatalog={selectedModelCatalog}
            onOpenGuide={() => openGuideChapter(guideChapterForView(activeView))}
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
                revealApiKey={revealSavedApiKey}
                selectedModelCatalog={visibleModelCatalog}
                onRefreshModels={() => {
                  if (usesDraftConnection) {
                    void refreshDraftModels()
                  } else if (selectedProfile) {
                    void runAction('refresh-models', () => refreshModels(selectedProfile.id))
                  }
                }}
                environment={state.connectionEnvironment}
                onOpenSetup={() => setSetupDialogOpen(true)}
                onOpenFeedback={() => setFeedbackOpen(true)}
                feedbackAvailable={Boolean(selectedProfile && (error || !selectedProfile.verified && selectedProfile.verificationStatus !== 'not_checked' || selectedModelCatalog?.status && !['ok', 'not_fetched'].includes(selectedModelCatalog.status) || availabilityChecks.some((check) => !check.ok)))}
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
                onOpenSetup={() => setSetupDialogOpen(true)}
              />
            )}
            {activeView === 'timeline' && <TimelineWorkspace state={state} />}
            {activeView === 'lab' && <LabWorkspace state={state} selectedProfile={selectedProfile} busy={busy} runAction={runAction} onOpenGuide={() => openGuideChapter('lab')} />}
          </div>
        </section>
        {activeView === 'providers' && <>
        <div className="pane-resizer pane-resizer-right" role="separator" aria-orientation="vertical" aria-label="调整连接与切换栏宽度" aria-controls="connection-dock" aria-valuemin={320} aria-valuemax={460} aria-valuenow={paneWidths.right} tabIndex={0} onPointerDown={(event) => beginResize('right', event)} onKeyDown={(event) => resizePaneWithKeyboard('right', event)} />
        <ConnectionDock
          profile={selectedProfile}
          catalog={selectedModelCatalog}
          environment={state.connectionEnvironment}
          hasUnsavedChanges={hasUnsavedChanges}
          requiredFailures={requiredFailures}
          riskCount={riskCount}
          busy={busy}
          canSwitch={canSwitch}
          preview={state.runtimeMode === 'browser_preview_mock'}
          onSave={() => void saveCurrentProfile()}
          onRefreshModels={() => {
            if (usesDraftConnection) {
              void refreshDraftModels()
            } else if (selectedProfile) {
              void runAction('refresh-models', () => refreshModels(selectedProfile.id))
            }
          }}
          onVerify={() => selectedProfile && void runAction('verify-profile', () => verifyProfile(selectedProfile.id))}
          onSwitch={() => void requestSwitch()}
          onOpenSetup={() => setSetupDialogOpen(true)}
          onOpenGuide={() => openGuideChapter('providers')}
          availabilityChecks={availabilityChecks}
          profileConfigChecks={profileConfigChecks}
          configChecks={state.checks}
        /></>}

      </section>

      <footer className="statusbar">
        <div className="statusbar-left">
          <span className={busy ? 'statusbar-operation is-busy' : 'statusbar-operation'} aria-live="polite">
            {busy && <RefreshCcw className="spin" size={13} aria-hidden="true" />}
            {operationStatusLabel(busy)}
            {busy && <small className="statusbar-operation-elapsed">{operationElapsedLabel(activeOperation, operationNow)}</small>}
          </span>
          <span>{state.connectionEnvironment.status === 'ready' ? '连接环境已准备' : '需要准备连接环境'}</span>
          <span>本机资料仅保存在此设备</span>
        </div>
        <div className="statusbar-right">
          <button className="statusbar-link" type="button" onClick={openGuideHub} data-guide-target="overview.statusbar-help">使用说明</button>
          {state.runtimeMode === 'tauri_native' && <span className="build-identity statusbar-build" title={__CODEX_RELEASE_CHANNEL__ === 'development' ? '开发版使用隔离数据；稳定版和真实 Codex 配置不会被读取或修改。' : '用于确认当前运行的发布渠道'}>{buildIdentityLabel}</span>}
        </div>
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
          updateProgress={updateProgress}
          updateError={updateError}
          updateSupported={state.runtimeMode === 'tauri_native' && (isStoreManagedBuild || isGitHubReleaseBuild)}
          storeManaged={isStoreManagedBuild}
          onClose={() => setSettingsOpen(false)}
          onToggle={(enabled) => void runAction('toggle-auto-start', () => toggleAutoStart(enabled))}
          onBackupPolicyChange={(automaticLimit, manualLimit) => void runAction('set-backup-policy', () => setBackupPolicy(automaticLimit, manualLimit))}
          onUpdate={() => void handleUpdate()}
        />
      )}
      {feedbackOpen && <FeedbackDialog state={state} selectedProfile={selectedProfile} onClose={() => setFeedbackOpen(false)} onCopied={() => setNotice({ message: '脱敏反馈已复制', tone: 'success' })} onSubmitted={(receipt) => setNotice({ message: `问题已提交给维护者：${receipt}`, tone: 'success' })} />}
      {setupDialogOpen && <ConnectionEnvironmentDialog environment={state.connectionEnvironment} busy={busy !== null} onClose={() => setSetupDialogOpen(false)} onConfirm={(layerId) => { setSetupDialogOpen(false); void runAction('prepare-connection-environment', () => prepareConnectionEnvironment(layerId)) }} />}
      {guideHubOpen && <GuideHubDialog
        progress={guideProgress}
        onClose={() => { setGuideHubOpen(false); window.requestAnimationFrame(() => guideTriggerRef.current?.focus()) }}
        onStart={openGuideChapter}
      />}
      {guideChapter && <ProductGuideTour
        chapter={guideChapter}
        environment={state.connectionEnvironment}
        progress={guideProgress[guideChapter]}
        onClose={closeGuide}
        onOpenView={setActiveView}
        onProgress={(next) => updateGuideProgress(guideChapter, next)}
        onContinueProviders={() => openGuideChapter('providers')}
      />}
    </main>
  )
}

function WorkspaceHeader({
  activeView,
  selectedProfile,
  requiredFailures,
  riskCount,
  selectedModelCatalog,
  onOpenGuide,
}: {
  activeView: ViewId
  selectedProfile: ProviderProfile | undefined
  requiredFailures: number
  riskCount: number
  selectedModelCatalog: ModelCatalog | undefined
  onOpenGuide: () => void
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
    return (
      <header className="workspace-header provider-workspace-header">
        <div>
          <h2>服务商配置</h2>
          <p>{selectedProfile ? `正在编辑 ${selectedProfile.name}；保存、模型、检查和切换都在这里完成。` : '新增或选择一个服务商后，按右侧提示继续。'}</p>
        </div>
        <button className="icon-button workspace-guide-button" type="button" onClick={onOpenGuide} aria-label="查看服务商使用说明" title="查看服务商使用说明" data-guide-target="providers.page-help"><CircleHelp size={16} /></button>
      </header>
    )
  }

  return (
    <header className="workspace-header">
      <div>
        <h2>{copy[activeView].title}</h2>
        <p>{copy[activeView].note}</p>
      </div>
      <button className="icon-button workspace-guide-button" type="button" onClick={onOpenGuide} aria-label={`查看${copy[activeView].title}使用说明`} title={`查看${copy[activeView].title}使用说明`} data-guide-target={`${guideChapterForView(activeView)}.page-help`}><CircleHelp size={16} /></button>
      {activeView === 'switch-check' && <span className={`workspace-badge ${selectedProfile && requiredFailures === 0 ? (riskCount > 0 ? 'warning' : 'ok') : 'warning'}`}>
        {!selectedProfile ? '未选择服务商' : requiredFailures > 0 ? `${requiredFailures} 项阻止切换` : riskCount > 0 ? `可切换，但有 ${riskCount} 项风险` : '可以切换'}
      </span>}
    </header>
  )
}

function FirstRunShell({
  environment,
  phase,
  activeStep,
  checks,
  error,
  busy,
  onPrepare,
  onContinue,
  onBack,
  onEnter,
}: {
  environment: AppState['connectionEnvironment']
  phase: FirstRunPhase
  activeStep: number
  checks: ValidationCheck[]
  error: string | null
  busy: boolean
  onPrepare: (layerId: string) => void
  onContinue: () => void
  onBack: (target: 'setup' | 'review') => void
  onEnter: () => void
}) {
  const [consented, setConsented] = useState(false)
  const [layerId, setLayerId] = useState(environment.selectedLayerId ?? environment.layers[0]?.id ?? '')
  const selectedLayer = environment.layers.find((layer) => layer.id === layerId)
  const progress = phase === 'ready' || phase === 'review' ? 100 : phase === 'preparing' ? Math.min(96, Math.max(4, Math.round((activeStep / FIRST_RUN_FEED.length) * 100))) : 0
  const showSetup = phase === 'consent' || phase === 'failed'
  const activePreparation = FIRST_RUN_FEED[Math.min(activeStep, FIRST_RUN_FEED.length - 1)]
  const preparationListRef = useRef<HTMLDivElement>(null)
  // A provider model and endpoint do not exist until the user adds a provider.
  // Keep them in the normal workspace audit, but do not misrepresent them as
  // incomplete connection-environment preparation on first launch.
  const environmentChecks = checks.filter((check) => check.id !== 'root-model' && check.id !== 'custom-base-url')
  const passedChecks = environmentChecks.filter((check) => check.ok).length
  const orderedChecks = [...environmentChecks].sort((left, right) => Number(left.ok) - Number(right.ok))

  useEffect(() => {
    if (phase !== 'preparing') return
    const list = preparationListRef.current
    const activeRow = list?.children.item(Math.min(activeStep, FIRST_RUN_FEED.length - 1))
    if (activeRow instanceof HTMLElement) activeRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [activeStep, phase])

  useEffect(() => {
    if (!layerId && environment.layers[0]) setLayerId(environment.layers[0].id)
  }, [environment.layers, layerId])

  return (
    <main className="first-run-shell">
      <section className={`first-run-card ${phase}`} aria-live="polite">
        <div className="first-run-brand"><span className="brand-mark"><GitCompareArrows size={20} /></span><span>Signalman AI</span></div>
        {showSetup && <>
          <div className="first-run-heading">
            <span className="first-run-kicker">第一次打开</span>
            <h1>先把连接环境准备好</h1>
            <p>Signalman AI 帮你管理多个 AI 服务商，在切换前检查连接并保留恢复点。</p>
          </div>
          <div className="first-run-impact" aria-label="准备连接环境会做什么">
            <div><ShieldCheck size={17} /><span>先创建一个可恢复的备份</span></div>
            <div><CheckCircle2 size={17} /><span>只统一 Signalman 管理的连接设置</span></div>
            <div><CheckCircle2 size={17} /><span>项目、MCP、插件和历史记录不会被改动</span></div>
          </div>
          <details className="first-run-details">
            <summary>查看具体会改什么</summary>
            <p>只在这台电脑上整理服务商连接需要的 Codex 设置，先备份、写入后再回读确认。不会上传配置、密钥或其他本机文件，也不会读取或改动项目、插件、MCP 和历史记录。</p>
          </details>
          {environment.layers.length > 1 && <label className="first-run-layer-select">选择要管理的配置层<select value={layerId} onChange={(event) => setLayerId(event.target.value)}>{environment.layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.label}</option>)}</select></label>}
          {environment.layers.length === 0 && <p className="first-run-inline-error">没有找到可管理的 Codex 配置层。</p>}
          {error && <div className="first-run-error"><XCircle size={17} /><span>{error}</span></div>}
          <label className="first-run-consent"><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} />我已了解：程序会先备份，再准备连接环境</label>
          <div className="first-run-actions"><button className="primary-button first-run-primary" type="button" disabled={!consented || !layerId || busy} onClick={() => onPrepare(layerId)} data-dialog-initial-focus><ShieldCheck size={17} />{phase === 'failed' ? '重新准备连接环境' : '准备连接环境'}</button></div>
        </>}
        {phase === 'preparing' && <div className="first-run-progress-card">
          <div className="first-run-progress-heading">
            <div className="first-run-progress-icon"><RefreshCcw className="spin" size={20} /></div>
            <div className="first-run-heading"><span className="first-run-kicker">正在准备</span><h1>把连接环境整理好</h1><p>Signalman 正在逐项检查并保存结果，请稍等片刻。</p></div>
          </div>
          <div className="first-run-progress-meta"><span>准备进度</span><strong>{progress}%</strong></div>
          <div className="first-run-progress-track" role="progressbar" aria-label="准备连接环境进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div ref={preparationListRef} className="first-run-step-list" aria-label="准备过程">
            {FIRST_RUN_FEED.map((step, index) => <div className={`first-run-step ${index < activeStep ? 'done' : index === activeStep ? 'active' : ''}`} key={step.title}>
              <span className="first-run-step-marker">{index < activeStep ? <CheckCircle2 size={15} /> : index === activeStep ? <RefreshCcw className="spin" size={15} /> : <span className="first-run-step-dot" />}</span>
              <span className="first-run-step-copy"><strong>{step.title}</strong><small>{step.detail}</small></span>
              <span className="first-run-step-state">{index < activeStep ? '已完成' : index === activeStep ? '进行中' : '等待'}</span>
            </div>)}
          </div>
          <p className="first-run-live-line" aria-live="polite"><span className="first-run-live-dot" />{activePreparation.detail}</p>
          <p className="first-run-safety-note">不会上传配置或密钥。遇到问题会恢复原文件。</p>
        </div>}
        {phase === 'review' && <div className="first-run-review">
          <div className="first-run-complete-heading">
            <div className="first-run-review-icon"><CheckCircle2 size={21} /></div>
            <div><span className="first-run-kicker">检查完成</span><h1>连接环境检查完毕</h1></div>
          </div>
          <p className="first-run-complete-intro">后台已经完成真实检查和配置准备。先看一眼结果，确认后再继续下一步。</p>
          <div className="first-run-review-summary"><strong>{passedChecks}/{environmentChecks.length || 0} 项检查通过</strong><span>{environmentChecks.length - passedChecks > 0 ? `${environmentChecks.length - passedChecks} 项待配置，不影响继续使用。` : '全部通过。'}恢复点已创建。</span></div>
          <div className="first-run-review-list" aria-label="检查结果">
            {environmentChecks.length === 0 && <div className="first-run-review-empty">已完成连接环境准备，当前没有需要展示的额外检查项。</div>}
            {orderedChecks.map((check) => {
              const visual = getCheckVisual(check)
              return <div className={`first-run-review-row ${visual.className}`} key={check.id}>
                {visual.icon}<span><strong>{check.label}</strong><small>{check.detail}</small></span>
                <em>{check.ok ? '通过' : check.severity === 'required' ? '需处理' : '待配置'}</em>
              </div>
            })}
          </div>
          <div className="first-run-complete-actions"><button className="ghost-button" type="button" onClick={() => onBack('setup')}><RotateCcw size={16} />上一步</button><button className="primary-button first-run-primary" type="button" onClick={onContinue} data-dialog-initial-focus><ChevronDown size={17} />下一步</button></div>
        </div>}
        {phase === 'ready' && <div className="first-run-complete">
          <div className="first-run-complete-heading">
            <div className="first-run-complete-icon"><CheckCircle2 size={22} /></div>
            <div><span className="first-run-kicker">可以开始了</span><h1>连接环境已准备好</h1></div>
          </div>
          <p className="first-run-complete-intro">Signalman AI 会帮你管理多个 AI 服务商，在切换前检查连接，并在本机保留可恢复的配置。</p>
          <div className="first-run-complete-summary">
            <div><CheckCircle2 size={16} /><span><strong>配置已就绪</strong><small>{selectedLayer?.label ?? '当前 Codex 配置'}已完成准备</small></span></div>
            <div><CheckCircle2 size={16} /><span><strong>恢复点已创建</strong><small>原有设置可以随时恢复</small></span></div>
            <div><CheckCircle2 size={16} /><span><strong>可以添加服务商</strong><small>现在进入工作台开始配置</small></span></div>
          </div>
          <div className="first-run-complete-actions"><button className="ghost-button" type="button" onClick={() => onBack('review')}><RotateCcw size={16} />上一步</button><button className="primary-button first-run-primary" type="button" onClick={onEnter} data-dialog-initial-focus><PlugZap size={17} />进入 Signalman</button></div>
        </div>}
      </section>
      <p className="first-run-footer">本地优先 · 配置只保存在此设备</p>
    </main>
  )
}

function RestartCodexNoticeDialog({ onClose }: { onClose: () => void }) {
  return (
    <ModalDialog className="restart-notice-dialog" labelledBy="restart-notice-title" onClose={onClose}>
      <div className="confirm-dialog-icon"><RotateCcw size={20} /></div>
      <div>
        <span className="eyebrow">切换已完成</span>
            <h2 id="restart-notice-title">请在新对话中确认</h2>
            <p>新配置已经写入并创建了恢复点。已打开的 Codex 或 ChatGPT 桌面端 Codex 对话会保留创建时的连接信息，不能被安全热切换。请结束当前对话后新建一个 Codex 对话，再确认实际服务商。</p>
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

function ConnectionDock({
  profile,
  catalog,
  environment,
  hasUnsavedChanges,
  requiredFailures,
  riskCount,
  busy,
  canSwitch,
  preview,
  onSave,
  onRefreshModels,
  onVerify,
  onSwitch,
  onOpenSetup,
  onOpenGuide,
  availabilityChecks,
  profileConfigChecks,
  configChecks,
}: {
  profile: ProviderProfile | undefined
  catalog: ModelCatalog | undefined
  environment: AppState['connectionEnvironment']
  hasUnsavedChanges: boolean
  requiredFailures: number
  riskCount: number
  busy: string | null
  canSwitch: boolean
  preview: boolean
  onSave: () => void
  onRefreshModels: () => void
  onVerify: () => void
  onSwitch: () => void
  onOpenSetup: () => void
  onOpenGuide: () => void
  availabilityChecks: ValidationCheck[]
  profileConfigChecks: ValidationCheck[]
  configChecks: ValidationCheck[]
}) {
  const isCurrent = Boolean(profile?.active)
  const environmentReady = environment.status === 'ready'
  const modelReady = Boolean(profile?.model)
  const testAction = !environmentReady
    ? { label: '运行可用性测试', disabled: true, onClick: onVerify }
    : !profile
      ? { label: '运行可用性测试', disabled: true, onClick: onVerify }
      : hasUnsavedChanges
        ? { label: '请先保存配置', disabled: true, onClick: onSave }
        : !modelReady
          ? { label: '请先选择默认模型', disabled: true, onClick: onRefreshModels }
          : { label: '运行可用性测试', disabled: busy !== null || preview, onClick: onVerify }
  const switchAction = !environmentReady
    ? { label: '检查并切换', disabled: true, onClick: onSwitch }
    : !profile
      ? { label: '检查并切换', disabled: true, onClick: onSwitch }
      : hasUnsavedChanges
        ? { label: '保存配置后切换', disabled: true, onClick: onSave }
        : !modelReady
          ? { label: '选择模型后切换', disabled: true, onClick: onRefreshModels }
          : isCurrent
            ? { label: '当前正在使用', disabled: true, onClick: onSwitch }
            : { label: '检查并切换', disabled: !canSwitch, onClick: onSwitch }
  const availability = !profile ? '未选择' : profile.verificationStatus === 'not_checked' ? '尚未检查' : profile.verified ? '已通过' : '需要留意'
  const renderChecks = (title: string, checks: ValidationCheck[]) => <section className="dock-check-group"><h4>{title}</h4><div className="dock-check-list">{checks.map((check) => { const visual = getCheckVisual(check); return <div className={`dock-check-row ${visual.className}`} key={check.id}>{visual.icon}<div><strong>{check.label}</strong><span>{check.detail}</span></div></div> })}</div></section>
  return <aside id="connection-dock" className="connection-dock scroll-region" aria-label="连接与切换" data-tour="connection-dock">
    <div className="connection-dock-heading"><div><span>连接与切换</span><strong>{profile?.name ?? '未选择服务商'}</strong></div><button className="icon-button" type="button" onClick={onOpenGuide} aria-label="查看使用步骤" title="查看使用步骤"><CircleHelp size={16} /></button></div>
    {!environmentReady && <section className="dock-setup-callout" data-tour="environment-setup-action">
      <strong>先准备连接环境</strong>
      <span>这一步会先创建恢复点并准备安全写入位置；不会先创建空服务商。</span>
      <button className="primary-button" type="button" onClick={onOpenSetup} disabled={busy !== null}><ShieldCheck size={16} />一键准备连接环境</button>
    </section>}
    <section className="dock-action-stack" aria-label="检查与切换操作">
      <button className={`primary-button dock-primary ${isCurrent ? 'current' : ''}`} type="button" disabled={switchAction.disabled || busy !== null} onClick={switchAction.onClick} data-tour="switch-preflight" data-guide-target="providers.switch"><PlugZap size={16} />{switchAction.label}</button>
      <button className="ghost-button dock-secondary" type="button" disabled={testAction.disabled || busy !== null} onClick={testAction.onClick} data-tour="run-availability" data-guide-target="providers.availability"><Activity size={15} />{testAction.label}</button>
    </section>
    <dl className="dock-status-list">
      <div className={environmentReady ? 'ok' : 'warning'}><dt>连接环境</dt><dd>{environmentReady ? '已准备' : '需要准备'}</dd></div>
      <div className={hasUnsavedChanges ? 'warning' : 'ok'}><dt>配置</dt><dd>{hasUnsavedChanges ? '尚未保存' : profile ? '已保存' : '—'}</dd></div>
      <div className={modelReady ? 'ok' : 'warning'}><dt>默认模型</dt><dd>{modelReady ? providerModelLabel(profile?.model ?? '') : '尚未选择'}</dd></div>
      <div className={profile?.verified ? 'ok' : 'warning'}><dt>可用性</dt><dd>{availability}</dd></div>
    </dl>
    {catalog?.status && catalog.status !== 'ok' && <p className="dock-note">模型目录：{catalog.statusDetail}</p>}
    {requiredFailures > 0 && environmentReady && <p className="dock-note warning">有 {requiredFailures} 项安全阻止；请查看完整诊断。</p>}
    {riskCount > 0 && requiredFailures === 0 && environmentReady && <p className="dock-note">存在 {riskCount} 项使用风险，检查后仍可由你确认继续。</p>}
    <div className="dock-diagnostics" aria-label="完整检查结果">
      {renderChecks('服务商可用性', availabilityChecks)}
      {renderChecks('当前配置', profileConfigChecks)}
      {renderChecks('Codex 运行设置', configChecks)}
    </div>
    <button className="dock-detail-link" type="button" onClick={onOpenGuide}>查看使用步骤</button>
  </aside>
}

function ConnectionEnvironmentDialog({ environment, busy, onClose, onConfirm }: { environment: AppState['connectionEnvironment']; busy: boolean; onClose: () => void; onConfirm: (layerId: string) => void }) {
  const [layerId, setLayerId] = useState(environment.selectedLayerId ?? environment.layers[0]?.id ?? '')
  const selectedLayer = environment.layers.find((layer) => layer.id === layerId)
  return <ModalDialog className="connection-environment-dialog" labelledBy="connection-environment-title" onClose={onClose}>
    <div className="section-heading-row"><div><span className="eyebrow">开始使用</span><h2 id="connection-environment-title">准备连接环境</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭准备连接环境"><X size={16} /></button></div>
    <p>此操作会先创建恢复点，再确认 Signalman 写入的位置安全可控。此时不会创建没有地址、模型或密钥的空服务商；你保存并切换第一家服务商后才会一次性写入完整连接信息。项目、MCP、插件、hooks、历史记录和其他未知设置保持不变。</p>
    {environment.layers.length > 1 && <label className="environment-layer-select">要管理的配置层<select value={layerId} onChange={(event) => setLayerId(event.target.value)}>{environment.layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.label}</option>)}</select></label>}
    {selectedLayer && <div className="environment-preview"><strong>本次选择：{selectedLayer.label}</strong><span>{selectedLayer.detail}</span><ul><li>会确认后续配置与认证写入同一 Codex 目录</li><li>不会提前选择空的 custom 服务商</li><li>切换时会创建可恢复的备份并在写入后回读</li></ul></div>}
    <div className="command-row"><button className="ghost-button" type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" type="button" disabled={!layerId || busy} onClick={() => onConfirm(layerId)} data-dialog-initial-focus><ShieldCheck size={16} />一键准备连接环境</button></div>
  </ModalDialog>
}

function FeedbackDialog({ state, selectedProfile, onClose, onCopied, onSubmitted }: { state: AppState; selectedProfile: ProviderProfile | undefined; onClose: () => void; onCopied: () => void; onSubmitted: (receipt: string) => void }) {
  const [consented, setConsented] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [diagnosticId] = useState(() => globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const relayUrl = import.meta.env.VITE_FEEDBACK_RELAY_URL?.trim()
  const feedback = useMemo(() => createCompatibilityFeedback(state, selectedProfile, diagnosticId), [diagnosticId, selectedProfile, state])
  const payload = JSON.stringify(feedback, null, 2)
  async function copyPayload() {
    await navigator.clipboard?.writeText(payload)
    onCopied()
    onClose()
  }
  async function submitPayload() {
    if (!relayUrl || !consented) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const response = await fetch(relayUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json().catch(() => ({})) as { receiptId?: string }
      onSubmitted(body.receiptId?.slice(0, 80) || '已接收')
      onClose()
    } catch (error) {
      setSubmitError(`在线提交暂时不可用（${errorMessage(error, '网络错误')}）。你仍可导出脱敏反馈。`)
    } finally {
      setSubmitting(false)
    }
  }
  return <ModalDialog className="feedback-dialog" labelledBy="feedback-title" onClose={onClose}>
    <div className="section-heading-row"><div><span className="eyebrow">问题反馈</span><h2 id="feedback-title">把这次问题告诉维护者</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭反馈"><X size={16} /></button></div>
    <p>内容会包含失败操作、接口域名与路径、模型目录摘要、检查结果和最近操作名称，方便维护者复现；不包含访问密钥、配置正文、文件路径、响应原文、Cookie、日志或截图。</p>
    <pre className="feedback-preview">{payload}</pre>
    {relayUrl ? <label className="feedback-consent"><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} />我确认提交以上脱敏诊断信息给 Signalman 维护者</label> : <p className="feedback-relay-unavailable">在线反馈尚未配置。可先导出这份脱敏诊断单后发送给维护者。</p>}
    {submitError && <p className="feedback-submit-error">{submitError}</p>}
    <div className="command-row"><button className="ghost-button" type="button" onClick={onClose}>取消</button><button className="ghost-button" type="button" onClick={() => void copyPayload()}><Copy size={16} />导出脱敏内容</button>{relayUrl && <button className="primary-button" type="button" disabled={!consented || submitting} onClick={() => void submitPayload()}><MessageSquare size={16} />{submitting ? '正在提交' : '提交给维护者'}</button>}</div>
  </ModalDialog>
}

type TourStep = { title: string; detail: string; target: string }
type TourRect = { top: number; left: number; right: number; bottom: number; width: number; height: number }

export function GettingStartedDialog({ environment, onClose, onOpenProviders }: { environment: AppState['connectionEnvironment']; onClose: () => void; onOpenProviders: () => void }) {
  const allSteps: TourStep[] = [
    { title: '先统一连接环境', detail: '新安装的电脑可能有不同的 Codex 配置。先点“一键准备连接环境”，选择配置层并创建恢复点，之后才开始检查服务商。', target: 'environment-setup-action' },
    { title: '添加服务商', detail: '在左侧点击加号，新增一个服务商。已有配置可以直接点选，不必重复添加。', target: 'provider-add' },
    { title: '填写服务商名称', detail: '给这条连接起一个容易辨认的名字，例如“公司中转站”。', target: 'provider-name' },
    { title: '填写接口地址', detail: '粘贴服务商提供的 API 基地址。Codex 连接失败时，可尝试在地址末尾补上 /v1。', target: 'provider-base-url' },
    { title: '填写访问密钥', detail: '粘贴访问密钥。默认只显示星号，点击眼睛可以在本机临时查看，密钥不会进入反馈内容。', target: 'provider-api-key' },
    { title: '选择默认模型', detail: '填好名称、接口和密钥后可直接点刷新图标；模型目录会先显示在这里，不会保存配置。点开模型框可搜索和滚动选择。', target: 'provider-model' },
    { title: '保存配置', detail: '确认名称、接口、模型和密钥后，点击保存更改。保存后右侧状态会更新。', target: 'save-provider' },
    { title: '运行可用性测试', detail: '在右侧顶部运行测试。这里会实际请求当前服务商，并把超时、限流、鉴权等结果分开显示。', target: 'run-availability' },
    { title: '检查并切换', detail: '最后点检查并切换。它会再次检查当前配置；有风险时会明确告诉你，安全阻止不会被绕过。', target: 'switch-preflight' },
  ]
  const steps = environment.status === 'ready' ? allSteps.slice(1) : allSteps
  const [step, setStep] = useState(0)
  const current = steps[Math.min(step, steps.length - 1)]
  const [rect, setRect] = useState<TourRect | null>(null)
  const [cardPosition, setCardPosition] = useState<{ top: number; left: number } | null>(null)
  const [targetMissing, setTargetMissing] = useState(false)
  const cardRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let missingTimer: number | undefined
    let frame: number | undefined
    let observer: ResizeObserver | undefined
    const measure = () => {
      const element = document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`)
      if (!element) {
        setRect(null)
        setTargetMissing(false)
        if (missingTimer === undefined) missingTimer = window.setTimeout(() => setTargetMissing(true), 800)
        return
      }
      if (missingTimer !== undefined) window.clearTimeout(missingTimer)
      missingTimer = undefined
      setTargetMissing(false)
      const first = element.getBoundingClientRect()
      if (first.top < 16 || first.bottom > window.innerHeight - 16) {
        element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: media.matches ? 'auto' : 'smooth' })
      }
      const read = () => {
        const next = element.getBoundingClientRect()
        setRect({ top: next.top, left: next.left, right: next.right, bottom: next.bottom, width: next.width, height: next.height })
      }
      read()
      observer?.disconnect()
      observer = new ResizeObserver(read)
      observer.observe(element)
    }
    const schedule = () => { if (frame !== undefined) window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(measure) }
    measure()
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') onClose() })
    return () => {
      if (missingTimer !== undefined) window.clearTimeout(missingTimer)
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [current.target, onClose])

  useLayoutEffect(() => {
    const update = () => {
      const card = cardRef.current
      if (!card) return
      const margin = 18
      const cardWidth = card.offsetWidth
      const cardHeight = card.offsetHeight
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      if (!rect) {
        setCardPosition({ top: Math.max(margin, (viewportHeight - cardHeight) / 2), left: Math.max(margin, (viewportWidth - cardWidth) / 2) })
        return
      }
      const below = rect.bottom + 16
      const above = rect.top - cardHeight - 16
      const top = below + cardHeight <= viewportHeight - margin ? below : above >= margin ? above : Math.min(viewportHeight - cardHeight - margin, Math.max(margin, below))
      const left = Math.min(viewportWidth - cardWidth - margin, Math.max(margin, rect.left))
      setCardPosition({ top, left })
    }
    update()
    window.addEventListener('resize', update)
    return () => { window.removeEventListener('resize', update) }
  }, [rect, step])

  function nextStep() {
    onOpenProviders()
    if (step >= steps.length - 1) onClose()
    else setStep((value) => value + 1)
  }

  return <div className="tour-layer" role="dialog" aria-modal="false" aria-labelledby="getting-started-title">
    <div className="tour-scrim" aria-hidden="true" />
    {rect && <div className="tour-spotlight" style={{ top: rect.top - 8, left: rect.left - 8, width: rect.width + 16, height: rect.height + 16 }} />}
    <section ref={cardRef} className={`tour-card ${cardPosition || targetMissing ? '' : 'is-unpositioned'}`} style={cardPosition ? { top: cardPosition.top, left: cardPosition.left } : undefined}>
      <div className="tour-arrow" aria-hidden="true" />
      <div className="getting-started-progress" aria-label={`第 ${step + 1} 步，共 ${steps.length} 步`}>{steps.map((_, index) => <span key={index} className={index <= step ? 'active' : ''} />)}</div>
      <div className="tour-card-heading"><span className="tour-step-index">{step + 1}</span><div><span className="eyebrow">开始使用 · {step + 1}/{steps.length}</span><h2 id="getting-started-title">{current.title}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭使用说明"><X size={16} /></button></div>
      <p>{current.detail}</p>
      {step === 0 && <p className="guide-status">当前状态：{environment.detail}</p>}
      {targetMissing && <p className="guide-status guide-status-warning">当前页面暂时没有这个控件。你可以先切换到服务商页，教学会在控件出现后继续定位。</p>}
      <div className="command-row"><button className="ghost-button" type="button" onClick={onClose}>稍后再说</button>{step > 0 && <button className="ghost-button" type="button" onClick={() => setStep((value) => value - 1)}>上一步</button>}<button className="primary-button" type="button" onClick={nextStep}>{step < steps.length - 1 ? '下一步' : '完成并开始使用'}</button></div>
    </section>
  </div>
}

type GuideStep = { id: string; title: string; detail: string; target: string; view?: ViewId }
type GuideChapter = { title: string; summary: string; steps: GuideStep[] }

const GUIDE_CHAPTERS: Record<GuideChapterId, GuideChapter> = {
  initialization: {
    title: '初始化配置', summary: '准备连接环境并跑通第一个服务商。', steps: [
      { id: 'environment', title: '先准备连接环境', detail: '新电脑的 Codex 配置可能不同。先创建恢复点，再只统一 Signalman 管理的连接字段；项目、MCP、插件和历史记录不会被改动。', target: 'providers.environment', view: 'providers' },
      { id: 'add', title: '新增服务商', detail: '点击加号新增一条连接；已有服务商直接从列表选择，不需要重复添加。', target: 'providers.add', view: 'providers' },
      { id: 'name', title: '填写服务商名称', detail: '给这条连接起一个容易认出的名字，例如“公司中转站”。', target: 'providers.name', view: 'providers' },
      { id: 'endpoint', title: '填写接口地址', detail: '粘贴服务商提供的 API 基地址。Codex 连接失败时，可尝试在末尾补上 /v1。', target: 'providers.endpoint', view: 'providers' },
      { id: 'key', title: '填写访问密钥', detail: '密钥默认隐藏；点击眼睛只会在本机临时显示，反馈内容不会包含密钥。', target: 'providers.key', view: 'providers' },
      { id: 'model', title: '选择默认模型', detail: '填好名称、接口和密钥后就能点击刷新图标。目录先显示在表单里，不会保存配置；展开后可搜索和滚动选择。', target: 'providers.model', view: 'providers' },
      { id: 'save', title: '保存配置', detail: '保存后，右侧检查会读取这条新配置。未保存的修改不能直接拿去测试或切换。', target: 'providers.save', view: 'providers' },
      { id: 'availability', title: '运行可用性测试', detail: '这里会实际请求当前服务商，并分别显示超时、限流、鉴权或协议问题；它不会切换 Codex 配置。', target: 'providers.availability', view: 'providers' },
      { id: 'switch', title: '检查并切换', detail: '最后执行检查并切换。安全阻止不能绕过；使用风险会明确说明，并在确认前让你选择是否继续。', target: 'providers.switch', view: 'providers' },
    ],
  },
  providers: {
    title: '服务商', summary: '管理已有连接、模型、测试和切换。', steps: [
      { id: 'list', title: '服务商列表', detail: '点击条目开始编辑；可用拖动手柄或键盘调整显示顺序。', target: 'providers.list', view: 'providers' },
      { id: 'add', title: '新增一条连接', detail: '加号会打开一条空白配置，不会覆盖现有服务商。', target: 'providers.add', view: 'providers' },
      { id: 'form', title: '基础配置', detail: '名称、接口、默认模型和访问密钥在这里填写；备注只用于本机识别。', target: 'providers.form', view: 'providers' },
      { id: 'model', title: '模型选择与刷新', detail: '未保存时，刷新会使用当前填写的接口和密钥，不写入本机目录；已保存时，刷新对应服务商的模型目录。模型框支持搜索和滚动选择。', target: 'providers.model', view: 'providers' },
      { id: 'save', title: '保存与管理', detail: '保存后才会更新检查结果。这里还可以复制配置、设为默认或删除不再需要的服务商。', target: 'providers.actions', view: 'providers' },
      { id: 'availability', title: '可用性测试', detail: '测试会请求当前服务商，不会改写 Codex 配置。结果会区分限流、鉴权、超时和响应格式。', target: 'providers.availability', view: 'providers' },
      { id: 'switch', title: '检查并切换', detail: '切换前会重新核对当前配置并创建恢复点。安全检查和使用风险是两种不同状态。', target: 'providers.switch', view: 'providers' },
      { id: 'feedback', title: '报告兼容问题', detail: '服务商异常且需要维护者适配时会出现此按钮。提交内容不含密钥、配置正文、文件路径或响应原文。', target: 'providers.feedback', view: 'providers' },
    ],
  },
  protection: {
    title: '安全与恢复', summary: '查看保护范围、备份和恢复入口。', steps: [
      { id: 'baseline', title: '首次启动基线', detail: '这是首次写入前的恢复点，会永久保留，用于确认原始状态。', target: 'protection.baseline', view: 'protection' },
      { id: 'environment', title: '重新准备连接环境', detail: '当连接设置需要重新扫描时使用。它会创建恢复点，只处理 Signalman 管理的连接字段。', target: 'protection.reprepare', view: 'protection' },
      { id: 'scope', title: '保护范围', detail: '这里明确区分本工具管理的服务商、模型和接口地址，以及始终保持不变的 MCP、插件和项目设置。', target: 'protection.scope', view: 'protection' },
      { id: 'backup', title: '立即备份当前状态', detail: '手动备份适合保存一个已验证可用的状态。达到数量上限时会先提示你将替换最早的一条。', target: 'protection.manual-backup', view: 'protection' },
      { id: 'groups', title: '恢复点分类', detail: '首次基线、自动保护和手动保存分别说明来源和保留方式。', target: 'protection.groups', view: 'protection' },
      { id: 'restore', title: '安全恢复', detail: '恢复前需要输入“恢复”确认。它只回退 Signalman 写入的字段，不覆盖你的 MCP、插件和项目设置。', target: 'protection.restore', view: 'protection' },
    ],
  },
  timeline: {
    title: '活动记录', summary: '查看最近的保存、检查、切换和恢复动作。', steps: [
      { id: 'activity', title: '活动记录', detail: '每条记录显示发生时间、动作结果和必要说明，方便你确认最近一次操作做了什么。', target: 'timeline.list', view: 'timeline' },
      { id: 'tone', title: '状态颜色', detail: '绿色表示完成，黄色表示需要留意，红色表示失败或阻止；请优先查看最靠前的一条。', target: 'timeline.item', view: 'timeline' },
      { id: 'read-only', title: '只读排查入口', detail: '这里不会修改配置。遇到问题时先核对最近一条记录，再回到对应工作区处理。', target: 'timeline.list', view: 'timeline' },
    ],
  },
  lab: {
    title: '实验室', summary: '用同一固定测试记录费用并比较性价比。', steps: [
      { id: 'model', title: '固定测试模型', detail: '排名只比较同一模型和同一固定测试请求；切换模型后会显示它自己的结果。', target: 'lab.model', view: 'lab' },
      { id: 'ranking', title: '成本结果与排名', detail: '保存一条样本就会显示本次成本；有两个服务商后才会出现横向排名。', target: 'lab.ranking', view: 'lab' },
      { id: 'official', title: '官方对照与评分', detail: '官方对照表示本次成本占官方估算成本的百分比；评分以本表最低成本为 100 分。', target: 'lab.ranking', view: 'lab' },
      { id: 'samples', title: '管理原始样本', detail: '展开某个服务商可查看原始样本并删除错误记录。多次样本会取中位数，建议测 3 次但不强制。', target: 'lab.ranking', view: 'lab' },
      { id: 'provider', title: '选择要测试的服务商', detail: '先选择服务商，再确认固定模型。测试不会切换 Codex 配置。', target: 'lab.provider', view: 'lab' },
      { id: 'probe', title: '运行固定测试', detail: '系统会发送一条极短请求；如果响应里有可用费用信息，会自动填入测试额度。', target: 'lab.probe', view: 'lab' },
      { id: 'cost', title: '填写费用字段', detail: '充值金额填写人民币；平台实际额度和测试额度只需来自同一个平台余额体系，不需要与其他服务商统一单位。', target: 'lab.cost-fields', view: 'lab' },
      { id: 'save', title: '计算并保存', detail: '人民币成本按充值金额乘以测试额度再除以平台实际额度计算。保存后会立即更新上方结果。', target: 'lab.save', view: 'lab' },
    ],
  },
  overview: {
    title: '整体功能', summary: '认识工作区、状态栏、设置、更新和反馈入口。', steps: [
      { id: 'navigation', title: '主工作区', detail: '顶部在服务商、安全与恢复、活动记录和实验室之间切换；模型目录和切换前检查属于服务商上下文。', target: 'overview.navigation' },
      { id: 'current', title: '当前正在使用', detail: '这里显示当前 Codex 配置识别到的服务商和模型，不代表其他服务商已经被删除。', target: 'overview.current' },
      { id: 'help', title: '使用说明目录', detail: '任何时候都可以从问号或状态栏打开目录，选择需要重看的章节。', target: 'overview.help' },
      { id: 'settings', title: '应用设置', detail: '设置中包含开机启动、备份数量和检查更新；不会把你的本机资料上传到外部。', target: 'overview.settings' },
      { id: 'status', title: '状态栏', detail: '状态栏显示当前操作、连接环境状态和本机资料边界。', target: 'overview.statusbar-help' },
    ],
  },
}

function GuideHubDialog({ progress, onClose, onStart }: { progress: GuideProgress; onClose: () => void; onStart: (chapter: GuideChapterId) => void }) {
  const chapterIds = Object.keys(GUIDE_CHAPTERS) as GuideChapterId[]
  return <ModalDialog className="guide-hub-dialog" labelledBy="guide-hub-title" onClose={onClose}>
    <div className="section-heading-row">
      <div><span className="eyebrow">使用说明</span><h2 id="guide-hub-title">选择要了解的功能</h2></div>
      <button className="icon-button" type="button" onClick={onClose} aria-label="关闭使用说明" data-dialog-initial-focus><X size={16} /></button>
    </div>
    <p className="guide-hub-intro">初始化配置会在首次准备完成后自动打开。其他说明可按当前需要随时重看。</p>
    <div className="guide-chapter-list">
      {chapterIds.map((id) => {
        const chapter = GUIDE_CHAPTERS[id]
        const state = progress[id]
        const status = state.completedAt ? '已看过' : state.dismissedAt ? `继续第 ${Math.min(state.lastStep + 1, chapter.steps.length)} 步` : '未开始'
        return <section className="guide-chapter-card" key={id}>
          <div><strong>{chapter.title}</strong><span>{chapter.summary}</span><small>{chapter.steps.length} 步 · {status}</small></div>
          <button className="ghost-button" type="button" onClick={() => onStart(id)}>{state.completedAt ? '重新查看' : state.dismissedAt ? '继续' : '开始'}</button>
        </section>
      })}
    </div>
  </ModalDialog>
}

function ProductGuideTour({ chapter, environment, progress, onClose, onOpenView, onProgress, onContinueProviders }: {
  chapter: GuideChapterId
  environment: AppState['connectionEnvironment']
  progress: GuideProgress[GuideChapterId]
  onClose: () => void
  onOpenView: (view: ViewId) => void
  onProgress: (next: Partial<GuideProgress[GuideChapterId]>) => void
  onContinueProviders: () => void
}) {
  const chapterDefinition = GUIDE_CHAPTERS[chapter]
  const steps = chapter === 'initialization' && environment.status === 'ready' ? chapterDefinition.steps.slice(1) : chapterDefinition.steps
  const [step, setStep] = useState(() => Math.min(progress.lastStep, Math.max(0, steps.length - 1)))
  const [rect, setRect] = useState<TourRect | null>(null)
  const [targetMissing, setTargetMissing] = useState(false)
  const [cardPosition, setCardPosition] = useState<{ top: number; left: number } | null>(null)
  const cardRef = useRef<HTMLElement | null>(null)
  const current = steps[Math.min(step, steps.length - 1)]

  useEffect(() => {
    setStep(Math.min(progress.lastStep, Math.max(0, steps.length - 1)))
  }, [chapter, progress.lastStep, steps.length])

  useLayoutEffect(() => {
    if (current.view) onOpenView(current.view)
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    let missingTimer: number | undefined
    let observer: ResizeObserver | undefined
    const measure = () => {
      const element = document.querySelector<HTMLElement>(`[data-guide-target="${current.target}"]`)
      if (!element || element.offsetParent === null) {
        setRect(null)
        if (missingTimer === undefined) missingTimer = window.setTimeout(() => setTargetMissing(true), 450)
        return
      }
      if (missingTimer !== undefined) window.clearTimeout(missingTimer)
      missingTimer = undefined
      setTargetMissing(false)
      const bounds = element.getBoundingClientRect()
      if (bounds.top < 18 || bounds.bottom > window.innerHeight - 18) element.scrollIntoView({ block: 'nearest', behavior: media.matches ? 'auto' : 'smooth' })
      const read = () => {
        const next = element.getBoundingClientRect()
        setRect({ top: next.top, left: next.left, right: next.right, bottom: next.bottom, width: next.width, height: next.height })
      }
      read()
      observer?.disconnect()
      observer = new ResizeObserver(read)
      observer.observe(element)
    }
    const schedule = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(measure) }
    frame = window.requestAnimationFrame(measure)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      window.cancelAnimationFrame(frame)
      if (missingTimer !== undefined) window.clearTimeout(missingTimer)
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [current.target, current.view, onOpenView])

  useLayoutEffect(() => {
    const update = () => {
      const card = cardRef.current
      if (!card) return
      const margin = 18
      const cardWidth = card.offsetWidth
      const cardHeight = card.offsetHeight
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      if (!rect) {
        setCardPosition({
          top: Math.max(margin, (viewportHeight - cardHeight) / 2),
          left: Math.max(margin, (viewportWidth - cardWidth) / 2),
        })
        return
      }
      const below = rect.bottom + 16
      const above = rect.top - cardHeight - 16
      const top = below + cardHeight <= viewportHeight - margin
        ? below
        : above >= margin
          ? above
          : Math.min(viewportHeight - cardHeight - margin, Math.max(margin, below))
      const left = Math.min(viewportWidth - cardWidth - margin, Math.max(margin, rect.left))
      setCardPosition({ top: Math.max(margin, top), left: Math.max(margin, left) })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [rect, step, targetMissing, chapter])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onProgress({ lastStep: step, dismissedAt: new Date().toISOString() }); onClose() } }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, onProgress, step])

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    card.focus()
  }, [chapter, step])

  const advance = () => {
    if (step < steps.length - 1) {
      const next = step + 1
      setStep(next)
      onProgress({ lastStep: next, dismissedAt: undefined })
      return
    }
    onProgress({ lastStep: 0, completedAt: new Date().toISOString(), dismissedAt: undefined })
    onClose()
  }
  const dismiss = () => { onProgress({ lastStep: step, dismissedAt: new Date().toISOString() }); onClose() }

  return <div className="tour-layer" role="presentation">
    <div className="tour-scrim" aria-hidden="true" />
    {rect && <div className="tour-spotlight" style={{ top: rect.top - 8, left: rect.left - 8, width: rect.width + 16, height: rect.height + 16 }} />}
    <section ref={cardRef} tabIndex={-1} className={`tour-card ${cardPosition || targetMissing ? '' : 'is-unpositioned'}`} style={cardPosition ? { top: cardPosition.top, left: cardPosition.left } : undefined} role="dialog" aria-modal="true" aria-labelledby="product-guide-title">
      <div className="getting-started-progress" style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }} aria-label={`第 ${step + 1} 步，共 ${steps.length} 步`}>{steps.map((item, index) => <span key={item.id} className={index <= step ? 'active' : ''} />)}</div>
      <div className="tour-card-heading"><span className="tour-step-index">{step + 1}</span><div><span className="eyebrow">{chapterDefinition.title} · {step + 1}/{steps.length}</span><h2 id="product-guide-title">{current.title}</h2></div><button className="icon-button" type="button" onClick={dismiss} aria-label="关闭使用说明"><X size={16} /></button></div>
      <p>{current.detail}</p>
      {targetMissing && <p className="guide-status guide-status-warning">当前状态下没有这个控件。你可以跳过此步，或稍后从使用说明目录重新打开。</p>}
      <div className="command-row guide-tour-actions">
        <button className="ghost-button" type="button" onClick={dismiss}>稍后再说</button>
        {step > 0 && <button className="ghost-button" type="button" onClick={() => { const previous = step - 1; setStep(previous); onProgress({ lastStep: previous }) }}>上一步</button>}
        {chapter === 'initialization' && step === steps.length - 1 && <button className="ghost-button" type="button" onClick={() => { onProgress({ lastStep: 0, completedAt: new Date().toISOString() }); onContinueProviders() }}>继续了解服务商</button>}
        <button className="primary-button" type="button" onClick={advance}>{step < steps.length - 1 ? '下一步' : '完成并开始使用'}</button>
      </div>
    </section>
  </div>
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
  runAction: (label: OperationId, action: () => Promise<AppState>) => Promise<void>
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
  runAction: (label: OperationId, action: () => Promise<AppState>) => Promise<void>
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
  onOpenSetup,
}: {
  protection: ConfigurationProtection
  backups: BackupItem[]
  backupPolicy: AppState['backupPolicy']
  busy: string | null
  onRestoreRequested: (backup: BackupItem) => void
  onBackupRequested: (confirmation?: string) => void
  onOpenSetup: () => void
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
          <button className="danger-button" type="button" onClick={() => onRestoreRequested(backup)} disabled={busy !== null} title={backup.restoreDetail} data-guide-target="protection.restore"><RotateCcw size={16} />安全恢复</button>
        </div>
      ))}</div> : <p className="section-meta">暂时没有恢复点。</p>}
    </section>
  )
  return (
    <div className="workspace-stack">
      <section className="surface-panel protection-overview">
        <div className="protection-hero" data-guide-target="protection.baseline">
          <div>
            <span className="eyebrow">备份状态</span>
            <h3>{protection.baselineStatus === 'ready' ? '首次启动基线备份已就绪' : protection.baselineStatus === 'empty' ? '首次启动记录已建立' : '首次启动基线备份需要处理'}</h3>
            <p>{protection.baselineDetail}</p>
          </div>
          <ShieldCheck size={34} aria-hidden="true" />
        </div>
        <div className="reprepare-environment-row" data-guide-target="protection.reprepare">
          <div><strong>连接环境</strong><span>重新扫描配置层并创建恢复点，只准备 Signalman 管理的连接设置。</span></div>
          <button className="ghost-button" type="button" onClick={onOpenSetup} disabled={busy !== null}><RefreshCcw size={16} />重新准备连接环境</button>
        </div>
        <div className="protection-scope" data-guide-target="protection.scope">
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
          <div className="recovery-actions" data-guide-target="protection.manual-backup">
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
        <div data-guide-target="protection.groups"><RecoveryGroup title="首次基线" note="首次运行前的原始状态，只保留一份。" items={baselineBackups} permanent />
        <RecoveryGroup title="自动保护" note="每天首次打开、切换前和恢复前自动保存。" items={automaticBackups} />
        <RecoveryGroup title="手动保存" note="由你主动保存当前可用状态。" items={manualBackups} /></div>
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
  updateProgress,
  updateError,
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
  updateProgress: UpdateInstallProgress | null
  updateError: string | null
  updateSupported: boolean
  storeManaged: boolean
  onClose: () => void
  onToggle: (enabled: boolean) => void
  onBackupPolicyChange: (automaticLimit: number, manualLimit: number) => void
  onUpdate: () => void
}) {
  const disabled = !desktopAvailable || busy !== null
  const updateStatus = updateBusy
    ? updateProgressLabel(updateProgress) || '正在检查更新…'
    : !updateSupported
      ? desktopAvailable ? '当前版本不检查公开更新' : '本地预览不检查公开更新'
      : storeManaged
        ? '在 Microsoft Store 获取更新'
        : updateInfo?.available
          ? `发现新版本 v${updateInfo.latestVersion}`
          : updateInfo
            ? `当前已是最新版${updateCheckTime(updateInfo.checkedAt) ? ` · 检查于 ${updateCheckTime(updateInfo.checkedAt)}` : ''}`
            : '尚未检查更新'
  const updateAction = storeManaged
    ? '前往 Microsoft Store'
    : updateInfo?.available
      ? updateBusy ? '正在下载' : `下载并安装 v${updateInfo.latestVersion}`
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
              {updateError && <small className="settings-update-error" role="alert">{updateError}</small>}
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
  const availabilityPassed = preflight.availabilityStatus === 'verified'
  const availabilityAttempted = !['not_checked', 'missing_key', 'invalid_profile'].includes(preflight.availabilityStatus)
  return (
    <ModalDialog className="switch-confirm-dialog" labelledBy="switch-dialog-title" onClose={onCancel}>
      <div className="confirm-dialog-icon"><GitCompareArrows size={20} /></div>
      <div>
        <span className="eyebrow">切换影响确认</span>
        <h2 id="switch-dialog-title">确认切换到 {preflight.targetName}？</h2>
        <p>{availabilityPassed ? '切换前已重新完成可用性测试。确认时会再次核对当前配置没有变化，再创建新的恢复点；不会显示访问密钥或完整配置内容。' : '切换前已执行可用性测试，但本次没有确认目标服务商可用。确认时会再次核对当前配置没有变化；继续切换需要你明确承担使用风险。'}</p>
        <dl className="switch-confirm-facts">
          <div><dt>目标模型</dt><dd>{preflight.targetModel}</dd></div>
          <div><dt>恢复点</dt><dd>{preflight.backupDetail}</dd></div>
          <div><dt>保护检查</dt><dd>{preflight.protectedDetail}</dd></div>
          <div className={availabilityPassed ? 'preflight-availability passed' : 'preflight-availability warning'}>
            <dt>本次可用性测试</dt>
            <dd><strong>{availabilityPassed ? '已通过' : availabilityAttempted ? '已执行但未确认' : '未能发起'}</strong><span>{preflight.availabilityDetail}</span><small>检查时间：{preflight.availabilityCheckedAt}</small></dd>
          </div>
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
      <section className="surface-panel" data-guide-target="timeline.list">
        <div className="activity-list">
          {state.activity.map((item) => (
            <div className={`activity-item ${item.tone}`} key={item.id} data-guide-target="timeline.item">
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
  onOpenGuide,
}: {
  state: AppState
  selectedProfile: ProviderProfile | undefined
  busy: string | null
  runAction: (label: OperationId, action: () => Promise<AppState>) => Promise<void>
  onOpenGuide: () => void
}) {
  const [labProviderId, setLabProviderId] = useState(selectedProfile?.id ?? state.currentProfileId)
  const [fundingMode, setFundingMode] = useState<CostCalibration['fundingMode']>('prepaid')
  const [paidCny, setPaidCny] = useState('')
  const [consumableCredit, setConsumableCredit] = useState('')
  const [debitCredit, setDebitCredit] = useState('')
  const [historyProviderId, setHistoryProviderId] = useState<string | null>(null)
  const profile = state.profiles.find((item) => item.id === labProviderId) ?? selectedProfile ?? state.profiles.find((item) => item.active)
  const [benchmarkModel, setBenchmarkModel] = useState('gpt-5.6-terra')
  const latestProbe = (state.responseProbes ?? []).find((item) => (
    item.providerId === profile?.id && item.model === benchmarkModel && item.probeVersion === 'cost-calibration-v2'
  ))
  const completedCalibrations = (state.costCalibrations ?? []).filter((item) => item.state === 'completed' && item.resultCny !== '0')
  const comparableRecords = completedCalibrations.filter((item) => (
    item.model === benchmarkModel && item.probeVersion === 'cost-calibration-v2'
  ))
  const ranking = Array.from(new Map(state.profiles.map((item) => [item.id, item])).values()).flatMap((provider) => {
    const samples = comparableRecords.filter((item) => item.providerId === provider.id)
    if (samples.length === 0) return []
    const median = medianScaled(samples.map((item) => decimalToScaled(item.resultCny)))
    const officialCosts = samples.map((sample) => estimateOfficialCny(
      (state.responseProbes ?? []).find((probe) => probe.id === sample.probeId),
      benchmarkModel,
    )).filter((cost): cost is bigint => cost !== null)
    return [{ provider, samples, median, officialMedian: officialCosts.length > 0 ? medianScaled(officialCosts) : null }]
  }).toSorted((left, right) => left.median < right.median ? -1 : left.median > right.median ? 1 : 0)
  const lowestCost = ranking[0]?.median ?? null
  const displayMultiplier = lowestCost && Number(scaledToDecimal(lowestCost)) * 1000 < 0.01 ? 10_000 : 1_000
  const scoreFor = (median: bigint) => {
    if (!lowestCost || ranking.length < 2 || median <= 0n) return null
    return Math.max(1, Math.min(100, Number((lowestCost * 100n) / median)))
  }
  const costSourceLabel: Record<NonNullable<CostCalibration['costSource']>, string> = {
    response_inline: '响应费用',
    response_usage: '用量费用',
    response_header: '响应头费用',
    billing_log_manual: '平台日志',
    balance_difference: '余额差额',
  }

  useEffect(() => {
    if (latestProbe?.status === 'final_cost_inline' && latestProbe.costCandidate) {
      setDebitCredit(latestProbe.costCandidate)
    }
  }, [latestProbe?.costCandidate, latestProbe?.status])

  async function runCostTest() {
    if (!profile || !benchmarkModel) return
    await runAction('run-cost-probe', () => runResponseProbe(profile.id, benchmarkModel))
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
      creditUnitLabel: '同一平台额度',
      model: benchmarkModel || '未设置模型',
      probeVersion: 'cost-calibration-v2',
      costSource: latestProbe?.costCandidate ? latestProbe.costSource ?? 'response_inline' : 'billing_log_manual',
      probeId: latestProbe?.id,
      sampleKind: 'cold',
    }))
    setDebitCredit('')
  }

  async function removeCalibration(calibration: CostCalibration) {
    if (!window.confirm(`删除 ${calibration.providerName} 在 ${calibration.updatedAt} 保存的这条费用记录？此操作不可恢复。`)) return
    await runAction('delete-cost-calibration', () => deleteCostCalibration(calibration.id))
  }

  return (
    <div className="workspace-stack lab-workspace">
      <section className="lab-intro">
        <FlaskConical size={22} aria-hidden="true" />
        <div>
          <h3>性价比中心</h3>
          <p>用同一条固定测试的人民币成本，比较服务商。</p>
        </div>
        <button className="icon-button workspace-guide-button" type="button" onClick={onOpenGuide} aria-label="查看实验室使用说明" title="查看实验室使用说明" data-guide-target="lab.page-help"><CircleHelp size={16} /></button>
      </section>
      <section className="surface-panel lab-ranking" aria-labelledby="lab-ranking-title" data-guide-target="lab.ranking">
        <div className="section-heading-row">
          <div>
            <h3 id="lab-ranking-title">{ranking.length >= 2 ? '服务商对比' : '本次成本结果'}</h3>
            <p className="section-description">{ranking.length >= 2 ? '只比较同一个固定测试模型。多次记录时取中位数；样本少于 3 次会明确提示，但不会阻止比较。' : '保存一条样本后立即显示结果。再添加一个服务商，即可查看横向对比。'}</p>
          </div>
        </div>
        <div className="lab-benchmark-control" data-guide-target="lab.model">
          <label><span className="field-label">固定测试模型 <FieldHint text="排名只比较同一模型下、同一固定测试请求的结果；切换模型后会显示该模型自己的排名。" /></span><select value={benchmarkModel} onChange={(event) => { setBenchmarkModel(event.target.value); setDebitCredit('') }}>
            {BENCHMARK_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select></label>
        </div>
        {ranking.length === 0 ? <p className="lab-empty">先运行固定测试并保存第一条费用样本。保存后，这里会马上显示本次人民币成本。</p> : (
          <div className="lab-ranking-list" role="table" aria-label="性价比排名">
            {ranking.length >= 2 && <div className="lab-ranking-head ranking-grid" role="row">
              <span className="ranking-cell ranking-cell--position">排名</span>
              <span className="ranking-cell ranking-cell--provider">服务商</span>
              <span className="ranking-cell ranking-cell--cost">估算成本 <FieldHint text={`按“每 ${displayMultiplier.toLocaleString()} 次”固定测试估算的人民币成本。`} /></span>
              <span className="ranking-cell ranking-cell--official">官方对照 <FieldHint text={`这是该服务商成本占同一测试按官方 API 标准价格估算成本的百分比；1% 表示约为官方成本的 1/100。固定参考汇率：1 USD = ¥${OFFICIAL_USD_TO_CNY}。`} /></span>
              <span className="ranking-cell ranking-cell--score">评分 <FieldHint text="本表中成本最低的服务商为 100 分；其余服务商按成本比例折算，分数越高代表本次比较越划算。" /></span>
              <span className="ranking-cell ranking-cell--samples">样本 <FieldHint text="参与中位数计算的已保存冷启动样本数量。" /></span>
              <span className="ranking-cell ranking-cell--manage">管理</span>
            </div>}
            {ranking.map((item, index) => {
              const medianCny = scaledToDecimal(item.median)
              const officialRatio = item.officialMedian && item.officialMedian > 0n ? Number((item.median * 1000n) / item.officialMedian) / 10 : null
              const providerHistoryOpen = historyProviderId === item.provider.id
              return <div className="lab-ranking-group" key={item.provider.id}>
              <div className="lab-ranking-row ranking-grid" role="row">
                <span className="ranking-cell ranking-cell--position ranking-position">{ranking.length >= 2 ? index + 1 : <Activity size={14} />}</span>
                <div className="ranking-cell ranking-cell--provider"><strong>{item.provider.name}</strong><small>{benchmarkModelLabel(benchmarkModel)} · 最近 {item.samples[0]?.updatedAt}</small></div>
                <div className="ranking-cell ranking-cell--cost ranking-cost"><strong>{formatCny((Number(medianCny) * displayMultiplier).toString())}</strong><small>单次 {formatCny(medianCny, 8)}</small></div>
                <div className="ranking-cell ranking-cell--official ranking-official">{officialRatio === null ? <span>—</span> : <strong>{officialRatio}%</strong>}</div>
                <div className="ranking-cell ranking-cell--score ranking-score"><strong>{ranking.length >= 2 ? `${scoreFor(item.median) ?? '—'}${scoreFor(item.median) ? ' 分' : ''}` : '初步结果'}</strong><span>{item.samples.length >= 3 ? '推荐样本数已满足' : `已测 ${item.samples.length}/3 次`}</span></div>
                <span className="ranking-cell ranking-cell--samples ranking-samples">{item.samples.length} 次</span>
                <button className="ghost-button ranking-cell ranking-cell--manage ranking-manage" type="button" onClick={() => setHistoryProviderId(providerHistoryOpen ? null : item.provider.id)}>{providerHistoryOpen ? '收起' : '管理'}</button>
              </div>
              {providerHistoryOpen && <div className="lab-history-list">
                <strong>本服务商的原始样本</strong>
                {item.samples.map((sample) => <div className="lab-history-row" key={sample.id}>
                  <span>{sample.updatedAt} · {costSourceLabel[sample.costSource ?? 'billing_log_manual']}</span>
                  <strong>单次 {formatCny(sample.resultCny, 8)}</strong>
                  <button className="danger-text-button" type="button" disabled={busy !== null} onClick={() => void removeCalibration(sample)}><Trash2 size={14} />删除</button>
                </div>)}
              </div>}
              </div>
            })}
          </div>
        )}
      </section>
      <section className="surface-panel lab-record-cost">
        <div className="section-heading-row">
          <div>
            <h3>新增测试样本</h3>
            <p className="section-description">充值金额填写人民币。平台实际额度和测试额度只要来自同一个平台余额体系即可，不需要换算成美元，也不需要和其他服务商统一。人民币成本 = 充值金额 × 测试额度 ÷ 平台实际额度。</p>
          </div>
        </div>
        <div className="lab-selected-provider" data-guide-target="lab.provider">
          <label>
            服务商
            <select value={profile?.id ?? ''} onChange={(event) => { setLabProviderId(event.target.value); setDebitCredit('') }}>
              {state.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <span>固定模型：{benchmarkModelLabel(benchmarkModel || '未选择模型')}</span>
        </div>
        <div className={`lab-probe-status ${latestProbe ? latestProbe.status : 'idle'}`} data-guide-target="lab.probe">
          <div>
            <strong>{latestProbe?.status === 'final_cost_inline' ? '已读取测试额度' : latestProbe ? '需要从平台日志补充测试额度' : '尚未运行测试'}</strong>
            <span>{latestProbe?.status === 'final_cost_inline'
              ? `已通过${latestProbe.costSource === 'response_header' ? '响应头' : latestProbe.costSource === 'response_usage' ? '用量字段' : '响应字段'}读取费用。请确认它与平台余额单位一致。`
              : latestProbe ? latestProbe.detail : '运行后会发出一条极短请求，不会切换服务商或改写 Codex 配置。'}</span>
          </div>
          <button className="primary-button" type="button" disabled={!profile || busy !== null} onClick={() => void runCostTest()}>
            <Activity size={15} />运行固定测试
          </button>
        </div>
        <div className="lab-form" data-guide-target="lab.cost-fields">
          <label>
            <span className="field-label">计费方式 <FieldHint text="充值：按实际付款换得平台余额。订阅固定：填写本账期的实际付款和可用总额度。" /></span>
            <select aria-label="计费方式" value={fundingMode} onChange={(event) => setFundingMode(event.target.value as CostCalibration['fundingMode'])}><option value="prepaid">充值</option><option value="subscription">订阅固定</option></select>
          </label>
          <label><span className="field-label">充值金额 <FieldHint text="购买这笔平台额度实际支付的人民币金额。" /></span><input aria-label="充值金额" type="text" inputMode="decimal" value={paidCny} onChange={(event) => setPaidCny(event.target.value)} placeholder="例如 10" /></label>
          <label><span className="field-label">平台实际额度 <FieldHint text="付款后可用于调用的总额度，含赠送和折扣，按平台后台余额填写。" /></span><input aria-label="平台实际额度" type="text" inputMode="decimal" value={consumableCredit} onChange={(event) => setConsumableCredit(event.target.value)} placeholder={fundingMode === 'subscription' ? '本账期可用总额度' : '充值后到账总额'} /></label>
          <label><span className="field-label">测试额度 <FieldHint text="固定测试被平台扣掉的额度。系统能读到时会自动填入；否则从平台使用日志复制。" /></span><input aria-label="测试额度" type="text" inputMode="decimal" value={debitCredit} onChange={(event) => setDebitCredit(event.target.value)} placeholder="运行测试后自动填写，或从日志复制" /></label>
        </div>
        <div className="lab-module-actions" data-guide-target="lab.save"><button className="primary-button" type="button" disabled={!profile || !benchmarkModel || busy !== null || !paidCny || !consumableCredit || !debitCredit} onClick={() => void saveCalibration()}><Save size={15} />计算并保存</button><span>官方对照按标准短上下文价与固定参考汇率 1 USD = ¥{OFFICIAL_USD_TO_CNY} 自动估算。</span></div>
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
