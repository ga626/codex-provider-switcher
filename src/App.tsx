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
import {
  checkForUpdate,
  completeOnboarding,
  createManualBackup,
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
  syncCurrentConfiguration,
  switchProfile,
  setBackupPolicy,
  toggleAutoStart,
  verifyProfile,
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
import { ProviderWorkspace } from './features/providers/ProviderWorkspace'
import { ConnectionDock as ConnectionDockFeature } from './features/providers/ConnectionDock'
import { providerModelLabel } from './features/providers/model-utils'
import { ProviderSidebar } from './features/providers/ProviderSidebar'
import {
  draftMatchesProfile,
  profileConfigurationChecks,
  providerAvailabilityChecks,
  requiresManualModelConfirmation,
} from './features/providers/provider-utils'
import { ModelsWorkspace } from './features/providers/ModelsWorkspace'
import { TimelineWorkspace } from './features/timeline/TimelineWorkspace'
import { SafetyWorkspace as SafetyWorkspaceFeature } from './features/safety/SafetyWorkspace'
import { ConfigurationProtectionWorkspace as ConfigurationProtectionWorkspaceFeature } from './features/safety/ConfigurationProtectionWorkspace'
import { LabWorkspace as LabWorkspaceFeature } from './features/lab/LabWorkspace'
import { FirstRunShell, FIRST_RUN_STEP_COUNT, type FirstRunPhase } from './features/first-run/FirstRunShell'
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
      const catalog = await previewModels(draft, handleOperationEvent)
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
      phase = Math.min(FIRST_RUN_STEP_COUNT, phase + 1)
      setPreparationStep(phase)
    }, 600)
    try {
      // The backend operation is real; the visible feed gives it enough time
      // to be understood instead of flashing straight to the result screen.
      const [next] = await Promise.all([
        prepareConnectionEnvironment(layerId, true),
        new Promise((resolve) => window.setTimeout(resolve, FIRST_RUN_STEP_COUNT * 600 + 450)),
      ])
      setState(next)
      const selected = next.profiles.find((profile) => profile.id === selectedId) ?? next.profiles[0]
      if (selected) {
        setSelectedId(selected.id)
        setDraft(toEditable(selected))
      }
      setFirstRunPhase('review')
      setPreparationStep(FIRST_RUN_STEP_COUNT)
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
        {['providers', 'models', 'switch-check'].includes(activeView) && <ProviderSidebar
          profiles={state.profiles}
          selectedId={selectedId}
          busy={busy !== null}
          onSelect={selectProfile}
          onAdd={startNewProfile}
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
                    void runAction('refresh-models', () => refreshModels(selectedProfile.id, handleOperationEvent))
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
                onRefreshModels={() => selectedProfile && void runAction('refresh-models', () => refreshModels(selectedProfile.id, handleOperationEvent))}
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
            {activeView === 'lab' && <LabWorkspaceFeature state={state} selectedProfile={selectedProfile} busy={busy} runAction={runAction} onRunCostTest={(profileId, benchmarkModel) => void runAction('run-cost-probe', () => runResponseProbe(profileId, benchmarkModel, handleOperationEvent))} onOpenGuide={() => openGuideChapter('lab')} />}
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

export default App
