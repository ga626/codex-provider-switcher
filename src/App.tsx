import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Activity,
  FlaskConical,
  GitCompareArrows,
  LayoutDashboard,
  RefreshCcw,
  Settings,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import './styles/first-run.css'
import './styles/workbench.css'
import {
  checkForUpdate,
  completeOnboarding,
  createManualBackup,
  isGitHubReleaseBuild,
  isStoreManagedBuild,
  loadState,
  openUpdate,
  prepareConnectionEnvironment,
  initializeConnectionEnvironment,
  prepareSwitch,
  previewModels,
  refreshModels,
  revealProfileApiKey,
  reorderProfiles,
  runResponseProbe,
  restoreBackup,
  saveProfile,
  saveCodexModelSelection,
  syncCurrentConfiguration,
  switchProfile,
  setBackupPolicy,
  toggleAutoStart,
  verifyProfile,
  isDevelopmentBuild,
  resetQaScenario,
  clearQaLiveValidationCopy,
  createQaLiveValidationSnapshot,
  getQaLiveValidationStatus,
  importQaLiveValidationSnapshot,
  openQaLiveValidationWindow,
  leaveQaLiveValidation,
  minimizeToTray,
  quitApplication,
} from './adapter'
import type { OperationEventHandler } from './adapter'
import type { AppState, BackupItem, EditableProfile, ModelCatalog, ProviderProfile, SwitchPreflight, UpdateInfo } from './types'
import type { UpdateInstallProgress } from './adapter'
import { operationElapsedLabel, operationStatusLabel, startOperationEvent, type ActiveOperation, type OperationEventV1, type OperationId } from './operations'
import {
  ApplicationSettingsDialog,
  ConnectionEnvironmentDialog,
  FeedbackDialog,
  ManualModelConfirmDialog,
  RestartCodexNoticeDialog,
  RestoreConfirmDialog,
  SwitchConfirmDialog,
  SyncCurrentConfigurationDialog,
} from './shared/dialogs'
import { ModalDialog } from './shared/components'
import { ProviderWorkspace } from './features/providers/ProviderWorkspace'
import { ConnectionDock as ConnectionDockFeature } from './features/providers/ConnectionDock'
import { providerModelLabel } from './features/providers/model-utils'
import { ProviderSidebar } from './features/providers/ProviderSidebar'
import { ConnectionSourceDialog, type NewConnectionKind } from './features/providers/ConnectionSourceDialog'
import {
  draftMatchesProfile,
  providerConnectionKind,
  profileConfigurationChecks,
  providerAvailabilityChecks,
  requiresManualModelConfirmation,
} from './features/providers/provider-utils'
import { TimelineWorkspace } from './features/timeline/TimelineWorkspace'
import { SafetyWorkspace as SafetyWorkspaceFeature } from './features/safety/SafetyWorkspace'
import { ConfigurationProtectionWorkspace as ConfigurationProtectionWorkspaceFeature } from './features/safety/ConfigurationProtectionWorkspace'
import { LabWorkspace as LabWorkspaceFeature } from './features/lab/LabWorkspace'
import { FirstRunShell, FIRST_RUN_STEP_COUNT, FIRST_RUN_STEP_INTERVAL_MS, type FirstRunPhase } from './features/first-run/FirstRunShell'
import { advancePreparation, missingPreparationResults } from './features/first-run/progress'
import { firstRunResultPreview, type FirstRunResultPreview } from './features/first-run/result-preview'
import type { InitializationReport, InitializationStep } from './types'
import { QaControlRail } from './features/qa/QaScenarioConsole'
import type { DailyQaScenarioId, QaScenarioId } from './features/qa/scenarios'
import type { QaLiveValidationStatus } from './adapter'
import { WorkspaceHeader } from './features/workspace/WorkspaceHeader'
import type { ViewId } from './shared/view-types'
import {
  GUIDE_PROGRESS_KEY,
  GuideHubDialog,
  ProductGuideTour,
  guideChapterForView,
  readGuideProgress,
  type GuideChapterId,
  type GuideProgress,
} from './features/guide/GuideWorkspace'

type NoticeTone = 'success' | 'warning' | 'danger' | 'info'
type NoticeState = { message: string; tone: NoticeTone }

const emptyProfile: EditableProfile = {
  id: '',
  name: '',
  baseUrl: '',
  endpointMode: 'auto',
  model: '',
  note: '',
  apiKey: '',
}

function toEditable(profile: ProviderProfile): EditableProfile {
  return {
    id: profile.id,
    connectionKind: providerConnectionKind(profile),
    name: profile.name,
    baseUrl: profile.baseUrl,
    endpointMode: profile.endpointMode ?? 'auto',
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

function WindowClosePrompt({ onMinimize, onQuit }: { onMinimize: () => void; onQuit: () => void }) {
  const development = __CODEX_RELEASE_CHANNEL__ === 'development'
  return (
    <ModalDialog className="window-close-dialog" labelledBy="window-close-title" onClose={onMinimize}>
      <div className="confirm-dialog-icon"><AlertTriangle size={20} /></div>
      <div>
        <span className="eyebrow">{development ? '开发版后台运行' : '后台运行'}</span>
        <h2 id="window-close-title">要怎么关闭 Signalman？</h2>
        <p>点右上角叉号不会自动结束程序。你可以把窗口收进通知区域继续运行，也可以直接退出并停止本应用启动的服务。</p>
      </div>
      <div className="command-row window-close-actions">
        <button className="ghost-button" type="button" onClick={onMinimize} data-dialog-initial-focus>留在后台</button>
        <button className="danger-button" type="button" onClick={onQuit}>直接退出</button>
      </div>
    </ModalDialog>
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
  const [qaLiveStatus, setQaLiveStatus] = useState<QaLiveValidationStatus | null>(null)
  const [qaDailyScenario, setQaDailyScenario] = useState<DailyQaScenarioId | null>(null)
  const [qaFeedbackPreview, setQaFeedbackPreview] = useState<string | null>(null)
  const [qaGeneration, setQaGeneration] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [guideHubOpen, setGuideHubOpen] = useState(false)
  const [guideChapter, setGuideChapter] = useState<GuideChapterId | null>(null)
  const [guideProgress, setGuideProgress] = useState<GuideProgress>(readGuideProgress)
  const [setupDialogOpen, setSetupDialogOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [connectionSourceOpen, setConnectionSourceOpen] = useState(false)
  const [closePromptOpen, setClosePromptOpen] = useState(false)
  const [windowVisible, setWindowVisible] = useState(true)
  const [newConnectionKind, setNewConnectionKind] = useState<NewConnectionKind | null>(null)
  const [firstRun, setFirstRun] = useState<boolean | null>(null)
  const [firstRunPhase, setFirstRunPhase] = useState<FirstRunPhase>('consent')
  const [firstRunTransitioning, setFirstRunTransitioning] = useState(false)
  const [firstRunError, setFirstRunError] = useState<string | null>(null)
  const [preparationStep, setPreparationStep] = useState(0)
  const [preparationResults, setPreparationResults] = useState<Array<InitializationStep | undefined>>([])
  const [initializationReport, setInitializationReport] = useState<InitializationReport | null>(null)
  const [qaFirstRunResultPreview, setQaFirstRunResultPreview] = useState<FirstRunResultPreview | null>(null)
  const preparationTimer = useRef<number | null>(null)
  const qaFeedbackTimer = useRef<number | null>(null)
  const workspaceScrollRef = useRef<HTMLDivElement>(null)
  const [paneWidths, setPaneWidths] = useState({ left: 276, right: 380 })
  const [resizingPane, setResizingPane] = useState<'left' | 'right' | null>(null)
  const resizeStart = useRef<{ x: number; left: number; right: number } | null>(null)
  const initialGuideHandled = useRef(false)
  const guideTriggerRef = useRef<HTMLElement | null>(null)
  const busy = activeOperation?.id ?? null

  function beginOperation(id: OperationId) {
    const startedAt = Date.now()
    setActiveOperation({ id, startedAt, event: startOperationEvent(id, 'workspace', startedAt) })
  }

  function finishOperation(id: OperationId) {
    setActiveOperation((current) => current?.id === id ? null : current)
  }

  const handleOperationEvent: OperationEventHandler = (event: OperationEventV1) => {
    setActiveOperation((current) => {
      if (!current) return current
      const matches = current.id === event.kind || (event.kind === 'verify-profile' && (current.id === 'verify' || current.id === 'verify-profile'))
      if (!matches) return current
      const startedAt = Date.parse(event.startedAt)
      return {
        ...current,
        startedAt: Number.isFinite(startedAt) ? startedAt : current.startedAt,
        event,
      }
    })
  }

  useEffect(() => {
    if (!activeOperation) return undefined
    let timer: number | undefined
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
    }
    const start = () => {
      stop()
      if (document.visibilityState === 'hidden' || !windowVisible) return
      setOperationNow(Date.now())
      timer = window.setInterval(() => setOperationNow(Date.now()), 1000)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop()
      else start()
    }
    document.addEventListener('visibilitychange', onVisibility)
    start()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [activeOperation, windowVisible])

  useEffect(() => {
    workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [activeView])

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
    if (!('__TAURI_INTERNALS__' in window)) return undefined
    let disposeClose: (() => void) | undefined
    let disposeVisibility: (() => void) | undefined
    void import('@tauri-apps/api/event').then(({ listen }) => Promise.all([
      listen('signalman-close-requested', () => setClosePromptOpen(true)),
      listen<boolean>('signalman-window-visibility', (event) => setWindowVisible(event.payload)),
    ])).then(([close, visibility]) => {
      disposeClose = close
      disposeVisibility = visibility
    }).catch(() => undefined)
    return () => {
      disposeClose?.()
      disposeVisibility?.()
    }
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
          : { ...current, right: current.right === 320 ? 380 : 320 }
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
    if (qaFeedbackPreview) return
    const timeout = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(timeout)
  }, [notice, qaFeedbackPreview])

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
      const catalog = await previewModels(draft, handleOperationEvent)
      setDraftModelCatalog(catalog)
      // The provider may expose its OpenAI-compatible routes with or without
      // `/v1`. Keep the successful base URL in the draft so saving it uses the
      // same route that returned the catalog.
      if ((draft.endpointMode ?? 'auto') !== 'full' && catalog.baseUrl && catalog.baseUrl.trim() && catalog.baseUrl.trim() !== draft.baseUrl.trim()) {
        setDraft((current) => ({ ...current, baseUrl: catalog.baseUrl }))
      }
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
    if (busy) return
    setQaFirstRunResultPreview(null)
    void layerId
    setFirstRunPhase('preparing')
    setFirstRunError(null)
    setPreparationStep(0)
    setPreparationResults([])
    setInitializationReport(null)
    beginOperation('prepare-connection-environment')
    const steps: Array<InitializationStep | undefined> = []
    let cursor = 0
    let shownAt = Date.now()
    let backendFinished = false
    const presentation = new Promise<void>((resolve) => {
      preparationTimer.current = window.setInterval(() => {
        const next = advancePreparation(cursor, shownAt, Date.now(), steps)
        if (next !== cursor) { cursor = next; shownAt = Date.now(); setPreparationStep(cursor) }
        if (backendFinished && cursor >= FIRST_RUN_STEP_COUNT) resolve()
      }, Math.min(80, FIRST_RUN_STEP_INTERVAL_MS))
    })
    const onStep = (step: InitializationStep) => {
      if (step.index < 0 || step.index >= FIRST_RUN_STEP_COUNT) return
      steps[step.index] = step
      setPreparationResults([...steps])
    }
    try {
      const report = await initializeConnectionEnvironment(onStep)
      // The final report is authoritative even if a transport dropped a progress event.
      report.steps.forEach(onStep)
      report.steps = missingPreparationResults(steps)
      // A model catalogue warning is a recoverable degradation. Configuration
      // safety and commit failures remain blocking conditions.
      report.canContinue = report.canContinue && report.steps.every(step => step.status === 'success' || (step.id === 'models' && step.status === 'warning'))
      report.steps.forEach(onStep)
      backendFinished = true
      await presentation
      setInitializationReport(report)
      const next = report.state
      if (next) setState(next)
      const selected = next?.profiles.find((profile) => profile.id === selectedId) ?? next?.profiles[0]
      if (selected) {
        setSelectedId(selected.id)
        setDraft(toEditable(selected))
      }
      setFirstRunPhase('review')
      setPreparationStep(FIRST_RUN_STEP_COUNT)
      if (report.canContinue) setNotice({ message: '连接环境已准备好', tone: 'success' })
      setError(null)
    } catch (err) {
      const incomplete = missingPreparationResults(steps)
      incomplete.forEach(onStep)
      backendFinished = true
      await presentation
      setInitializationReport({ steps: incomplete, state: null, canContinue: false })
      setFirstRunPhase('review')
      setFirstRunError(errorMessage(err, '初始化没有完成。请点“重新检查”；在确认全部通过前不能进入软件。'))
    } finally {
      if (preparationTimer.current !== null) window.clearInterval(preparationTimer.current)
      preparationTimer.current = null
      finishOperation('prepare-connection-environment')
    }
  }

  async function enterSignalman() {
    if (qaFirstRunResultPreview) {
      await applyQaScenario('daily-baseline')
      return
    }
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

  function stopQaFeedbackPreview() {
    if (qaFeedbackTimer.current !== null) window.clearTimeout(qaFeedbackTimer.current)
    qaFeedbackTimer.current = null
    setQaFeedbackPreview(null)
  }

  function playQaFeedbackPreview(kind: 'loading' | 'success' | 'error' | 'normal' = 'loading') {
    stopQaFeedbackPreview()
    setActiveOperation(null)
    setError(null)
    setNotice(null)
    if (kind === 'normal') return
    setQaFeedbackPreview(kind === 'loading' ? '正在查看加载状态；不会执行操作' : kind === 'success' ? '正在查看成功提示；没有真实执行' : '正在查看错误提示；没有真实失败')
    if (kind === 'loading') {
      const startedAt = Date.now()
      setActiveOperation({ id: 'refresh-models', startedAt, event: { ...startOperationEvent('refresh-models', 'workspace', startedAt), detail: 'QA 外观预览：刷新中，不会发起请求。' } })
    } else if (kind === 'success') setNotice({ message: 'QA 外观预览：操作成功提示，没有执行产品操作。', tone: 'success' })
    else setError('QA 外观预览：操作失败提示，没有发生真实错误。')
  }

  async function applyQaScenario(scenarioId: Exclude<QaScenarioId, 'controlled-live-validation'>) {
    if (!isDevelopmentBuild) return
    if (qaLiveStatus?.mode === 'live-copy' && !window.confirm('切回模拟检查会结束隔离 Codex 和未完成的登录，真实副本保留。继续？')) return
    stopQaFeedbackPreview()
    beginOperation('qa-reset-scenario')
    qaStatusGeneration.current += 1
    let loaded = false
    try {
      if (qaLiveStatus?.mode === 'live-copy') setQaLiveStatus(await leaveQaLiveValidation())
      const next = await resetQaScenario(scenarioId)
      setQaFirstRunResultPreview(null)
      window.localStorage.removeItem(GUIDE_PROGRESS_KEY)
      setGuideProgress(readGuideProgress())
      setGuideChapter(null)
      setGuideHubOpen(false)
      setSettingsOpen(false)
      setRestoreConfirm(null)
      setSwitchConfirm(null)
      setManualModelConfirm(null)
      setSyncConfirm(false)
      setFeedbackOpen(false)
      setConnectionSourceOpen(false)
      setSetupDialogOpen(false)
      setDraftModelCatalog(null)
      setNewConnectionKind(null)
      setError(null)
      setPaneWidths({ left: 276, right: 380 })
      initialGuideHandled.current = true
      setState(next)
      setQaGeneration(generation => generation + 1)
      setSelectedId(next.profiles[0]?.id ?? '')
      setDraft(next.profiles[0] ? toEditable(next.profiles[0]) : emptyProfile)
      if (scenarioId === 'first-run-review') {
        setQaDailyScenario(null)
        setFirstRun(true)
        setFirstRunPhase('consent')
        setPreparationStep(0)
        setPreparationResults([])
        setInitializationReport(null)
        setFirstRunError(null)
      } else {
        setQaDailyScenario(scenarioId)
        setFirstRun(false)
        setFirstRunError(null)
        const profile = next.profiles.find((item) => item.id === 'example-provider-a') ?? next.profiles[0]
        if (profile) {
          setSelectedId(profile.id)
          setDraft(toEditable(profile))
          setDraftModelCatalog(null)
          setNewConnectionKind(null)
        }
        setActiveView('providers')
      }
      loaded = true
      setNotice({ message: scenarioId === 'first-run-review' ? '已回到首次启动第 1 页' : scenarioId === 'daily-density' ? '已载入边界排版样本' : scenarioId === 'daily-operation-flow' ? '已载入状态反馈预览样本' : '已载入基准日常样本', tone: 'success' })
    } catch (err) {
      setError(errorMessage(err, '无法重置 QA 场景。'))
    } finally {
      finishOperation('qa-reset-scenario')
    }
    if (loaded && scenarioId === 'daily-operation-flow') playQaFeedbackPreview()
  }

  function moveQaFirstRun(direction: 'back' | 'next') {
    if (firstRun !== true || busy !== null) return
    if (direction === 'next' && firstRunPhase === 'review' && initializationReport && (!initializationReport.canContinue || initializationReport.steps.some(step => step.status !== 'success' && !(step.id === 'models' && step.status === 'warning')))) return
    if (direction === 'next' && firstRunPhase === 'consent') {
      void prepareFirstRun('user-config')
      return
    }
    const phases: FirstRunPhase[] = ['consent', 'preparing', 'review', 'ready']
    const current = phases.indexOf(firstRunPhase)
    const next = Math.max(0, Math.min(phases.length - 1, current + (direction === 'next' ? 1 : -1)))
    setFirstRunPhase(phases[next])
    setPreparationStep(phases[next] === 'preparing' ? 0 : phases[next] === 'review' || phases[next] === 'ready' ? FIRST_RUN_STEP_COUNT : 0)
    setFirstRunError(null)
  }

  const qaStatusGeneration = useRef(0)
  function previewQaFirstRun(kind: FirstRunResultPreview) {
    if (!isDevelopmentBuild || busy || qaLiveStatus?.mode === 'live-copy') return
    stopQaFeedbackPreview()
    setQaFirstRunResultPreview(kind)
    setInitializationReport(firstRunResultPreview(kind))
    setFirstRunError(null)
    setError(null)
    setNotice(null)
    setFirstRun(true)
    setFirstRunPhase('review')
    setQaDailyScenario(null)
  }
  async function refreshQaLiveStatus() {
    if (!isDevelopmentBuild) return
    const generation = qaStatusGeneration.current
    try { const status = await getQaLiveValidationStatus(); if (generation === qaStatusGeneration.current) setQaLiveStatus(status) } catch (err) { if (generation === qaStatusGeneration.current) setError(errorMessage(err, '无法读取真实验证状态。')) }
  }

  function showQaRuntime(next: AppState, live: boolean) {
    stopQaFeedbackPreview()
    setState(next)
    setQaGeneration(generation => generation + 1)
    const profile = next.profiles.find(item => item.id === next.currentProfileId) ?? next.profiles[0]
    setSelectedId(profile?.id ?? '')
    setDraft(profile ? toEditable(profile) : emptyProfile)
    setDraftModelCatalog(null)
    setNewConnectionKind(null)
    setFirstRun(false)
    setFirstRunError(null)
    setQaDailyScenario(live ? null : 'daily-baseline')
    setActiveView('providers')
    setGuideChapter(null)
    setGuideHubOpen(false)
    setSettingsOpen(false)
    setRestoreConfirm(null)
    setSwitchConfirm(null)
    setManualModelConfirm(null)
    setSyncConfirm(false)
    setFeedbackOpen(false)
    setConnectionSourceOpen(false)
    setSetupDialogOpen(false)
  }

  async function runQaLiveAction(action: 'snapshot' | 'import' | 'open' | 'clear' | 'enter' | 'leave') {
    if (!isDevelopmentBuild) return
    if (action === 'enter' && !window.confirm('创建真实验证副本：复制本机配置、文件认证和服务商资料。副本中的登录和请求会真实执行，可能产生费用。不会回写本机 Codex。继续？')) return
    if (action === 'leave' && !window.confirm('返回模拟检查会结束隔离 Codex 和未完成的登录，真实副本保留。当前窗口不关闭。继续？')) return
    stopQaFeedbackPreview()
    beginOperation('qa-reset-scenario')
    qaStatusGeneration.current += 1
    try {
      if (action === 'enter') {
        await createQaLiveValidationSnapshot()
        await importQaLiveValidationSnapshot()
        setQaLiveStatus(await openQaLiveValidationWindow())
        setState(null)
        showQaRuntime(await loadState(), true)
        setNotice({ message: '真实功能验证副本已就绪；后续操作仅作用于副本。', tone: 'success' })
        setError(null)
        return
      }
      const next = action === 'leave' ? await leaveQaLiveValidation() : action === 'snapshot' ? await createQaLiveValidationSnapshot() : action === 'import' ? await importQaLiveValidationSnapshot() : action === 'open' ? await openQaLiveValidationWindow() : await clearQaLiveValidationCopy()
      setQaLiveStatus(next)
      if (action === 'open' || action === 'leave') {
        // Never leave the previous runtime's editable data visible if reloading fails.
        setState(null)
        showQaRuntime(await loadState(), action === 'open')
      }
      setNotice({ message: next.detail, tone: 'success' })
      setError(null)
    } catch (err) { setError(errorMessage(err, '真实验证操作未完成。')) } finally { finishOperation('qa-reset-scenario') }
  }

  useEffect(() => {
    void refreshQaLiveStatus()
    if (!isDevelopmentBuild) return undefined
    let timer: number | undefined
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
    }
    const start = () => {
      stop()
      if (document.visibilityState === 'hidden' || !windowVisible) return
      timer = window.setInterval(() => {
        if (document.visibilityState !== 'hidden' && windowVisible) void refreshQaLiveStatus()
      }, 5000)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop()
      else start()
    }
    document.addEventListener('visibilitychange', onVisibility)
    start()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [windowVisible])

  useEffect(() => {
    if (!isDevelopmentBuild || !('__TAURI_INTERNALS__' in window)) return
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(`Signalman AI · ${qaLiveStatus?.mode === 'live-copy' ? '真实验证副本' : '开发版 · 模拟资料'} · ${__CODEX_BUILD_SHA__}`)).catch(() => undefined)
  }, [qaLiveStatus?.mode, qaLiveStatus?.inUse])

  useEffect(() => () => {
    if (qaFeedbackTimer.current !== null) window.clearTimeout(qaFeedbackTimer.current)
  }, [])

  const qaControlRail = isDevelopmentBuild ? <QaControlRail
    busy={busy !== null}
    firstRunActive={firstRun === true}
    liveStatus={qaLiveStatus}
    dailyScenario={qaDailyScenario}
    operationPreview={qaFeedbackPreview}
    onPreview={playQaFeedbackPreview}
    onOpenOfficial={selectOfficialAccount}
    onOpenProviders={() => setActiveView('providers')}
    onOpenLab={() => setActiveView('lab')}
    currentView={activeView}
    onStartFirstRun={() => void applyQaScenario('first-run-review')}
    onMoveFirstRun={moveQaFirstRun}
    firstRunBlocked={firstRunPhase === 'review' && Boolean(initializationReport && (!initializationReport.canContinue || initializationReport.steps.some(step => step.status !== 'success')))}
    resultPreview={qaFirstRunResultPreview}
    onPreviewFirstRun={previewQaFirstRun}
    onLoadDaily={(scenario) => void applyQaScenario(scenario)}
    onCreateLiveSnapshot={() => void runQaLiveAction('enter')}
    onImportLiveSnapshot={() => void runQaLiveAction('import')}
    onOpenLiveValidation={() => void runQaLiveAction('open')}
    onLeaveLiveValidation={() => void runQaLiveAction('leave')}
    onClearLiveCopy={() => void runQaLiveAction('clear')}
  /> : null

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
    await saveEditableProfile({ ...draft, connectionKind: newConnectionKind ?? (selectedProfile ? providerConnectionKind(selectedProfile) : 'relay') }, 'save')
  }

  function selectProfile(profile: ProviderProfile) {
    setSelectedId(profile.id)
    setDraft(toEditable(profile))
    setDraftModelCatalog(null)
    setNewConnectionKind(null)
  }

  function startNewProfile(kind: NewConnectionKind) {
    setSelectedId('')
    setDraft(kind === 'official-api'
      ? { ...emptyProfile, name: 'DeepSeek 官方 API', baseUrl: 'https://api.deepseek.com/v1' }
      : emptyProfile)
    setDraftModelCatalog(null)
    setNewConnectionKind(kind)
    setConnectionSourceOpen(false)
    setActiveView('providers')
  }

  function selectOfficialAccount() {
    setSelectedId('chatgpt-official-account')
    setDraft(emptyProfile)
    setDraftModelCatalog(null)
    setNewConnectionKind('chatgpt-account')
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
    setNewConnectionKind(null)
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
      const preflight = await prepareSwitch(selectedProfile.id, handleOperationEvent)
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

  const handleMinimizeToTray = () => {
    setClosePromptOpen(false)
    void minimizeToTray()
  }
  const handleQuitApplication = () => {
    setClosePromptOpen(false)
    void quitApplication()
  }

  if (firstRun === true) {
    return <div className={isDevelopmentBuild ? 'development-qa-frame' : 'development-product-frame'}>
      {qaControlRail}
      <div className="development-product-surface">
      <FirstRunShell
      environment={state.connectionEnvironment}
      phase={firstRunPhase}
      activeStep={preparationStep}
      taskResults={preparationResults}
      report={initializationReport}
      checks={state.checks}
      error={firstRunError}
      busy={busy !== null}
      previewOnly={state.runtimeMode === 'browser_preview_mock' && !qaFirstRunResultPreview}
      resultPreview={qaFirstRunResultPreview}
      onPrepare={() => qaFirstRunResultPreview ? previewQaFirstRun(qaFirstRunResultPreview) : void prepareFirstRun('user-config')}
      onContinue={() => { if (!initializationReport || (initializationReport.canContinue && initializationReport.steps.every(step => step.status === 'success' || (step.id === 'models' && step.status === 'warning')))) setFirstRunPhase('ready') }}
      onBack={(target) => setFirstRunPhase(target === 'setup' ? 'consent' : 'review')}
      onEnter={enterSignalman}
    />
      {closePromptOpen && <WindowClosePrompt onMinimize={handleMinimizeToTray} onQuit={handleQuitApplication} />}
      </div>
    </div>
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
    <div className={isDevelopmentBuild ? 'development-qa-frame' : 'development-product-frame'}>
      {qaControlRail}
      <div className="development-product-surface">
    <main key={qaGeneration} className={`app-shell${firstRunTransitioning ? ' first-run-transitioning' : ''}`} data-view={activeView}>
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
            <strong title={currentFileProfile?.name}>{currentFileProfile?.name ?? '未识别'}</strong>
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

      {closePromptOpen && <WindowClosePrompt onMinimize={handleMinimizeToTray} onQuit={handleQuitApplication} />}

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

      {connectionSourceOpen && <ConnectionSourceDialog busy={busy !== null} onClose={() => setConnectionSourceOpen(false)} onSelect={startNewProfile} />}

      <section className={`workbench ${['providers', 'models', 'switch-check'].includes(activeView) ? `provider-workbench ${activeView === 'providers' ? 'has-provider-dock' : ''}` : ''}`} style={{ '--provider-left': `${paneWidths.left}px`, '--provider-right': `${paneWidths.right}px` } as React.CSSProperties}>
        {['providers', 'models', 'switch-check'].includes(activeView) && <ProviderSidebar
          profiles={state.profiles}
          selectedId={selectedId}
          busy={busy !== null}
          onSelect={selectProfile}
          onSelectOfficial={selectOfficialAccount}
          onAdd={() => setConnectionSourceOpen(true)}
          onMove={moveProvider}
        />}
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
          <div className="workspace-scroll" ref={workspaceScrollRef}>
            {activeView === 'providers' && (
              <ProviderWorkspace
                draft={draft}
                selectedProfile={selectedProfile}
                activeProviderName={state.profiles.find((profile) => profile.active && providerConnectionKind(profile) !== 'chatgpt-account')?.name}
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
                    void runAction('refresh-models', () => refreshModels(selectedProfile.id, handleOperationEvent))
                  }
                }}
                onVerify={() => selectedProfile && void runAction('verify-profile', () => verifyProfile(selectedProfile.id, handleOperationEvent))}
                onToggleCodexSelection={(model, enabled) => selectedProfile
                  ? runAction('save-model', () => saveCodexModelSelection(selectedProfile.id, model.id, enabled))
                  : Promise.resolve()}
                environment={state.connectionEnvironment}
                onOpenSetup={() => setSetupDialogOpen(true)}
                onOpenFeedback={() => setFeedbackOpen(true)}
                feedbackAvailable={Boolean(selectedProfile && (error || !selectedProfile.verified && selectedProfile.verificationStatus !== 'not_checked' || selectedModelCatalog?.status && !['ok', 'not_fetched'].includes(selectedModelCatalog.status) || availabilityChecks.some((check) => !check.ok)))}
                newConnectionKind={newConnectionKind}
              />
            )}
            {activeView === 'switch-check' && (
              <SafetyWorkspaceFeature
                availabilityChecks={availabilityChecks}
                profileConfigChecks={profileConfigChecks}
                configChecks={state.checks}
                selectedProfile={selectedProfile}
                busy={busy}
                hasUnsavedChanges={hasUnsavedChanges}
                onVerify={() => selectedProfile && void runAction('verify', () => verifyProfile(selectedProfile.id, handleOperationEvent))}
              />
            )}
            {activeView === 'protection' && (
              <ConfigurationProtectionWorkspaceFeature
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
            {activeView === 'lab' && <LabWorkspaceFeature state={state} selectedProfile={selectedProfile} busy={busy} runAction={runAction} onRunCostTest={(profileId, benchmarkModel) => runAction('run-cost-probe', () => runResponseProbe(profileId, benchmarkModel, handleOperationEvent))} onOpenGuide={() => openGuideChapter('lab')} />}
          </div>
        </section>
        {activeView === 'providers' && <>
        <div className="pane-resizer pane-resizer-right" role="separator" aria-orientation="vertical" aria-label="调整连接与切换栏宽度" aria-controls="connection-dock" aria-valuemin={320} aria-valuemax={460} aria-valuenow={paneWidths.right} tabIndex={0} onPointerDown={(event) => beginResize('right', event)} onKeyDown={(event) => resizePaneWithKeyboard('right', event)} />
        <ConnectionDockFeature
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
              void runAction('refresh-models', () => refreshModels(selectedProfile.id, handleOperationEvent))
            }
          }}
          onVerify={() => selectedProfile && void runAction('verify-profile', () => verifyProfile(selectedProfile.id, handleOperationEvent))}
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
            {activeOperation?.event.detail ?? operationStatusLabel(busy)}
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
          desktopAvailable={state.runtimeMode === 'tauri_native' && !isDevelopmentBuild}
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
      </div>
    </div>
  )
}

export default App
