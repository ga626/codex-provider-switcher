import { Channel, invoke } from '@tauri-apps/api/core'
import { initialState } from './mockData'
import type { DownloadEvent } from '@tauri-apps/plugin-updater'
import type { AppState, CostCalibration, EditableProfile, ModelCatalog, ProviderProfile, ResponseProbeObservation, SwitchPreflight, UpdateInfo } from './types'
import type { OperationEventV1 } from './operations'

export type OperationEventHandler = (event: OperationEventV1) => void

function operationChannel(onEvent?: OperationEventHandler) {
  return new Channel<OperationEventV1>(onEvent ?? (() => undefined))
}

const isTauri = '__TAURI_INTERNALS__' in window
const allowBrowserMock = import.meta.env.VITE_CODEX_PROVIDER_SWITCHER_ALLOW_MOCK === 'true'
const storeProductId = '9P7PGV62WKK6'
const storeProductUrl = `https://apps.microsoft.com/detail/${storeProductId}`
const storeLaunchUrl = `ms-windows-store://pdp/?productid=${storeProductId}`

export const isStoreManagedBuild = __CODEX_RELEASE_CHANNEL__ === 'store'
export const isGitHubReleaseBuild = __CODEX_RELEASE_CHANNEL__ === 'stable'

let mockState: AppState = structuredClone(initialState)
let webBackendAvailable: boolean | null = null
let pendingTauriUpdate: { version: string; date?: string | null; downloadAndInstall: (onEvent?: (event: DownloadEvent) => void) => Promise<void> } | null = null

export type UpdateInstallProgress = {
  phase: 'downloading' | 'installing'
  downloadedBytes: number
  totalBytes?: number
}

function isTrustedProjectReleaseUrl(value: string) {
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'github.com' &&
      (parsed.pathname === '/ga626/codex-provider-switcher/releases' ||
        parsed.pathname.startsWith('/ga626/codex-provider-switcher/releases/'))
    )
  } catch {
    return false
  }
}

function isTrustedStoreUrl(value: string) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'https:') {
      return parsed.hostname === 'apps.microsoft.com' && parsed.pathname === `/detail/${storeProductId}`
    }
    return parsed.protocol === 'ms-windows-store:' && parsed.hostname === 'pdp' && parsed.searchParams.get('productid') === storeProductId
  } catch {
    return false
  }
}

function backendUnavailableMessage() {
  return '应用的连接服务未能启动。请重新打开 Signalman AI；如果问题持续，请查看故障排查。'
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new Error('本地 Web 后端未返回 JSON。')
  }
  const payload = await response.json()
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `本地 Web 后端请求失败：${response.status}`)
  }
  return payload as T
}

async function tryWebBackend<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (webBackendAvailable === false) {
    if (!allowBrowserMock) {
      throw new Error(backendUnavailableMessage())
    }
    return null
  }
  try {
    const payload = await apiRequest<T>(path, init)
    webBackendAvailable = true
    return payload
  } catch (err) {
    if (webBackendAvailable === true) {
      throw err
    }
    webBackendAvailable = false
    if (!allowBrowserMock) {
      throw new Error(backendUnavailableMessage())
    }
    return null
  }
}

function apiPost(body?: unknown): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  }
}

function nowLabel() {
  return new Date().toLocaleString('sv-SE').replace('T', ' ')
}

function normalizeId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function mockDelay() {
  await new Promise((resolve) => window.setTimeout(resolve, 160))
}

export async function loadState(): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('load_state')
  }
  const webState = await tryWebBackend<AppState>('/api/state')
  if (webState) {
    return webState
  }
  await mockDelay()
  return structuredClone(mockState)
}

export async function toggleAutoStart(enabled: boolean): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('toggle_auto_start', { enabled })
  }
  throw new Error('开机启动只在 Signalman AI 桌面应用中提供。')
}

export async function createManualBackup(confirmation?: string): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('create_manual_backup', { confirmation })
  }
  const webState = await tryWebBackend<AppState>('/api/backup/create', apiPost({ confirmation }))
  if (webState) {
    return webState
  }
  await mockDelay()
  const createdAt = new Date()
  mockState.backups.unshift({
    id: `manual-${createdAt.getTime()}`,
    label: `manual-${createdAt.getTime()}`,
    time: createdAt.toLocaleString('en-GB', { hour12: false }),
    files: 3,
    fileCategories: ['Codex 设置', '本机登录信息', '恢复说明'],
    kind: 'manual',
    retentionManaged: true,
    restoreReady: true,
    restoreDetail: '需输入“恢复”确认；开发预览不会写入真实 Codex 配置。',
  })
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: createdAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: '已创建手动恢复点',
    detail: '开发预览已模拟保存当前状态。',
    tone: 'success',
  })
  return structuredClone(mockState)
}

export async function restoreBackup(backupId: string, confirmation: string): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('restore_backup', { backupId, confirmation })
  }
  const webState = await tryWebBackend<AppState>('/api/backup/restore', apiPost({ backupId, confirmation }))
  if (webState) {
    return webState
  }
  await mockDelay()
  if (confirmation.trim() !== '恢复') {
    throw new Error('请在恢复确认窗口中输入“恢复”后再继续。')
  }
  const backup = mockState.backups.find((item) => item.id === backupId)
  if (!backup) {
    throw new Error('未找到恢复点。')
  }
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: backup.kind === 'initial_install' ? '已恢复首次启动基线备份' : '已恢复配置备份',
    detail: '开发预览不会写入真实 Codex 配置。',
    tone: 'success',
  })
  return structuredClone(mockState)
}

export async function setBackupPolicy(automaticLimit: number, manualLimit: number): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('set_backup_policy', { automaticLimit, manualLimit })
  }
  const webState = await tryWebBackend<AppState>('/api/backup/policy', apiPost({ automaticLimit, manualLimit }))
  if (webState) {
    return webState
  }
  await mockDelay()
  mockState.backupPolicy = {
    automaticLimit: Math.min(10, Math.max(1, automaticLimit)),
    manualLimit: Math.min(10, Math.max(1, manualLimit)),
  }
  return structuredClone(mockState)
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  if (isTauri) {
    if (isStoreManagedBuild) {
      pendingTauriUpdate = null
      return {
        currentVersion: __APP_VERSION__,
        latestVersion: __APP_VERSION__,
        available: false,
        releaseUrl: storeProductUrl,
        checkedAt: new Date().toISOString(),
      }
    }
    if (!isGitHubReleaseBuild) {
      pendingTauriUpdate = null
      return {
        currentVersion: __APP_VERSION__,
        latestVersion: __APP_VERSION__,
        available: false,
        releaseUrl: 'https://github.com/ga626/codex-provider-switcher/releases',
        checkedAt: new Date().toISOString(),
      }
    }
    const { check } = await import('@tauri-apps/plugin-updater')
    const transport = await invoke<{ proxy?: string; timeoutMs: number }>('update_transport_options')
    const update = await check({
      timeout: transport.timeoutMs,
      ...(transport.proxy ? { proxy: transport.proxy } : {}),
    })
    if (!update) {
      pendingTauriUpdate = null
      return {
        currentVersion: __APP_VERSION__,
        latestVersion: __APP_VERSION__,
        available: false,
        releaseUrl: 'https://github.com/ga626/codex-provider-switcher/releases',
        checkedAt: new Date().toISOString(),
      }
    }
    pendingTauriUpdate = update
    return {
      currentVersion: __APP_VERSION__,
      latestVersion: update.version,
      available: true,
      releaseUrl: 'https://github.com/ga626/codex-provider-switcher/releases',
      publishedAt: update.date ?? undefined,
      checkedAt: new Date().toISOString(),
    }
  }
  const webResult = await tryWebBackend<UpdateInfo>('/api/update/check')
  if (webResult) return { ...webResult, checkedAt: new Date().toISOString() }
  await mockDelay()
  return {
    currentVersion: __APP_VERSION__,
    latestVersion: __APP_VERSION__,
    available: false,
    releaseUrl: 'https://github.com/ga626/codex-provider-switcher/releases',
    checkedAt: new Date().toISOString(),
  }
}

export async function openUpdate(url: string, onProgress?: (progress: UpdateInstallProgress) => void): Promise<void> {
  if (isTauri && pendingTauriUpdate) {
    let downloadedBytes = 0
    let totalBytes: number | undefined
    await pendingTauriUpdate.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        totalBytes = event.data.contentLength
        onProgress?.({ phase: 'downloading', downloadedBytes, totalBytes })
      } else if (event.event === 'Progress') {
        downloadedBytes += event.data.chunkLength
        onProgress?.({ phase: 'downloading', downloadedBytes, totalBytes })
      } else {
        onProgress?.({ phase: 'installing', downloadedBytes, totalBytes })
      }
    })
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
    return
  }
  const trustedStoreUrl = isTrustedStoreUrl(url)
  if (!isTrustedProjectReleaseUrl(url) && !trustedStoreUrl) {
    throw new Error('更新地址不是受信任的项目发布地址。')
  }
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(trustedStoreUrl ? storeLaunchUrl : url)
    return
  }
  if (trustedStoreUrl) {
    throw new Error('Microsoft Store 更新入口只能在已安装的桌面应用中打开。')
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (!opened) {
    throw new Error('浏览器阻止了更新下载窗口。')
  }
}

export async function saveProfile(profile: EditableProfile): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('save_profile', { profile })
  }
  const webState = await tryWebBackend<AppState>('/api/profiles/save', apiPost({ profile }))
  if (webState) {
    return webState
  }
  await mockDelay()
  const id = profile.id || normalizeId(profile.name)
  const existingIndex = mockState.profiles.findIndex((item) => item.id === id)
  const nextProfile: ProviderProfile = {
    id,
    name: profile.name.trim(),
    baseUrl: profile.baseUrl.trim(),
    model: profile.model.trim(),
    reasoningEffort: existingIndex >= 0 ? mockState.profiles[existingIndex].reasoningEffort : 'high',
    note: profile.note.trim(),
    verified: false,
    verificationStatus: 'not_checked',
    isDefault: existingIndex >= 0 ? mockState.profiles[existingIndex].isDefault : false,
    active: mockState.currentProfileId === id,
    hasApiKey: profile.apiKey.trim().length > 0 || (existingIndex >= 0 && mockState.profiles[existingIndex].hasApiKey),
    lastVerifiedAt: '编辑后尚未验证',
    lastVerificationDetail: '开发预览不会连接真实服务商。',
    lastSwitchedAt: existingIndex >= 0 ? mockState.profiles[existingIndex].lastSwitchedAt : undefined,
  }
  if (existingIndex >= 0) {
    mockState.profiles[existingIndex] = nextProfile
  } else {
    mockState.profiles.push(nextProfile)
  }
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: `${nextProfile.name} 已保存`,
    detail: '服务商信息已更新；访问密钥默认隐藏，可点击眼睛查看。',
    tone: 'info',
  })
  return structuredClone(mockState)
}

export async function revealProfileApiKey(profileId: string): Promise<string> {
  if (isTauri) {
    return invoke<string>('reveal_profile_api_key', { profileId })
  }
  const webValue = await tryWebBackend<{ apiKey: string }>('/api/profiles/reveal-key', apiPost({ profileId }))
  if (webValue?.apiKey) {
    return webValue.apiKey
  }
  await mockDelay()
  const profile = mockState.profiles.find((item) => item.id === profileId)
  if (!profile?.hasApiKey) {
    throw new Error('该服务商没有已保存的访问密钥。')
  }
  return `sk-preview-${profileId}-not-real`
}

function mockModelCatalog(profileId: string): ModelCatalog {
  const profile = mockState.profiles.find((item) => item.id === profileId)
  if (!profile) {
    throw new Error('未找到服务商配置。')
  }
  return mockModelCatalogFromProfile(profile)
}

function mockModelCatalogFromProfile(profile: ProviderProfile): ModelCatalog {
  if (!profile.hasApiKey) {
    return {
      providerId: profile.id,
      baseUrl: profile.baseUrl,
      fetchedAt: nowLabel(),
      status: 'missing_key',
      statusDetail: '缺少 API 密钥，无法刷新模型目录。',
      models: [],
    }
  }

  return {
    providerId: profile.id,
    baseUrl: profile.baseUrl,
    fetchedAt: nowLabel(),
    status: 'ok',
    statusDetail: '已返回 6 个模型。',
    models: [
      {
        id: 'provider-reasoning-current',
        aliases: ['current-reasoning'],
        source: 'mock',
        tags: ['reasoning', 'responses-candidate'],
        verifiedForResponses: 'unknown',
      },
      {
        id: 'provider-fast-current',
        aliases: [],
        source: 'mock',
        tags: ['fast', 'responses-candidate'],
        verifiedForResponses: 'unknown',
      },
      {
        id: 'provider-reasoning-stable',
        aliases: [],
        source: 'mock',
        tags: ['reasoning'],
        verifiedForResponses: 'unknown',
      },
      {
        id: 'provider-fast-stable',
        aliases: [],
        source: 'mock',
        tags: ['fast'],
        verifiedForResponses: 'unknown',
      },
      {
        id: 'provider-chat-compatible',
        aliases: [],
        source: 'mock',
        tags: ['chat'],
        verifiedForResponses: 'unknown',
      },
      {
        id: 'provider-embedding-large',
        aliases: [],
        source: 'mock',
        tags: ['embedding'],
        verifiedForResponses: 'unknown',
      },
    ],
  }
}

export async function refreshModels(profileId: string, onEvent?: OperationEventHandler): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('refresh_models', { profileId, onEvent: operationChannel(onEvent) })
  }
  const webState = await tryWebBackend<AppState>('/api/models/refresh', apiPost({ profileId }))
  if (webState) {
    return webState
  }
  await mockDelay()
  const catalog = mockModelCatalog(profileId)
  mockState.modelCatalogs = [
    catalog,
    ...mockState.modelCatalogs.filter((item) => item.providerId !== profileId),
  ]
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: catalog.status === 'ok' ? '模型目录已刷新' : '模型目录刷新失败',
    detail: catalog.statusDetail,
    tone: catalog.status === 'ok' ? 'success' : 'warning',
  })
  return structuredClone(mockState)
}

export async function previewModels(profile: EditableProfile, onEvent?: OperationEventHandler): Promise<ModelCatalog> {
  if (isTauri) {
    return invoke<ModelCatalog>('preview_models', { profile, onEvent: operationChannel(onEvent) })
  }
  const webCatalog = await tryWebBackend<ModelCatalog>('/api/models/preview', apiPost({ profile }))
  if (webCatalog) {
    return webCatalog
  }
  await mockDelay()
  if (!profile.baseUrl.trim()) {
    throw new Error('请先填写接口地址。')
  }
  return {
    ...mockModelCatalogFromProfile({
      id: profile.id || 'draft-provider',
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      reasoningEffort: 'high',
      note: '',
      verified: false,
      verificationStatus: 'not_checked',
      isDefault: false,
      active: false,
      hasApiKey: Boolean(profile.apiKey.trim()),
    }),
    statusDetail: '开发预览返回了示例模型；保存后才会写入本机服务商目录。',
  }
}

export async function deleteProfile(profileId: string): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('delete_profile', { profileId })
  }
  const webState = await tryWebBackend<AppState>('/api/profiles/delete', apiPost({ profileId }))
  if (webState) {
    return webState
  }
  await mockDelay()
  const target = mockState.profiles.find((profile) => profile.id === profileId)
  if (!target || target.active || target.isDefault) {
    throw new Error('默认或当前服务商不能删除。')
  }
  mockState.profiles = mockState.profiles.filter((profile) => profile.id !== profileId)
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: `${target.name} 已删除`,
    detail: '该服务商已从切换目录移除。',
    tone: 'warning',
  })
  return structuredClone(mockState)
}

export async function restoreLatestBackup(): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('restore_latest_backup')
  }
  const webState = await tryWebBackend<AppState>('/api/backup/restore-latest', apiPost())
  if (webState) {
    return webState
  }
  await mockDelay()
  const latest = mockState.backups[0]
  if (!latest) {
    throw new Error('当前没有可恢复的备份。')
  }
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: '预览已模拟恢复',
    detail: `${latest.label} 仅用于界面预览，未修改本机 Codex 配置或凭据。`,
    tone: 'warning',
  })
  return structuredClone(mockState)
}

export async function prepareSwitch(profileId: string): Promise<SwitchPreflight> {
  if (isTauri) {
    return invoke<SwitchPreflight>('prepare_switch', { profileId })
  }
  const preflight = await tryWebBackend<SwitchPreflight>('/api/profiles/prepare-switch', apiPost({ profileId }))
  if (preflight) {
    return preflight
  }
  throw new Error('开发预览不执行服务商切换。请使用桌面开发版或本机后端进行真实验证。')
}

export async function switchProfile(profileId: string, operationId: string, riskAcknowledged = false): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('switch_profile', { profileId, operationId, riskAcknowledged })
  }
  const webState = await tryWebBackend<AppState>('/api/profiles/switch', apiPost({ profileId, operationId, riskAcknowledged }))
  if (webState) {
    return webState
  }
  throw new Error('开发预览不执行服务商切换。请使用桌面开发版或本机后端进行真实验证。')
}

export async function verifyProfile(profileId: string, onEvent?: OperationEventHandler): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('verify_profile', { profileId, onEvent: operationChannel(onEvent) })
  }
  const webState = await tryWebBackend<AppState>('/api/profiles/verify', apiPost({ profileId }))
  if (webState) {
    return webState
  }
  await mockDelay()
  const target = mockState.profiles.find((profile) => profile.id === profileId)
  mockState.profiles = mockState.profiles.map((profile) => (
    profile.id === profileId
      ? {
          ...profile,
          verified: false,
          verificationStatus: 'not_checked',
          lastVerifiedAt: nowLabel(),
          lastVerificationDetail: '开发预览不会发送真实服务商请求。',
        }
      : profile
  ))
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: '预览未执行验证',
    detail: `${target?.name ?? '服务商'} 没有连接远端服务商；请使用桌面开发版执行真实检查。`,
    tone: 'warning',
  })
  return structuredClone(mockState)
}

export async function runResponseProbe(profileId: string, benchmarkModel: string, onEvent?: OperationEventHandler): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('run_response_probe', { profileId, benchmarkModel, onEvent: operationChannel(onEvent) })
  }
  const webState = await tryWebBackend<AppState>('/api/lab/response-probe', apiPost({ profileId, benchmarkModel }))
  if (webState) {
    return webState
  }
  await mockDelay()
  const profile = mockState.profiles.find((item) => item.id === profileId)
  if (!profile) throw new Error('未找到服务商配置。')
  const observedAt = nowLabel()
  const observation: ResponseProbeObservation = {
    id: crypto.randomUUID(),
    providerId: profile.id,
    providerName: profile.name,
    model: benchmarkModel || profile.model || '未设置模型',
    probeVersion: 'cost-calibration-v2',
    observedAt,
    status: 'final_cost_inline',
    httpStatus: 200,
    requestId: `preview-${Date.now().toString(36)}`,
    usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedTokens: 0, reasoningTokens: 0 },
    costCandidate: '0.000524',
    costSource: 'response_usage',
    detail: '预览模拟：已从 usage.cost 读取费用候选值。真实桌面应用会发送一次短请求，并只保存非敏感观察字段。',
  }
  mockState.responseProbes.unshift(observation)
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: '预览已模拟返回能力探针',
    detail: `${profile.name} 未连接远端；未读取或发送真实密钥。`,
    tone: 'info',
  })
  return structuredClone(mockState)
}

export async function saveCostCalibration(input: Omit<CostCalibration, 'id' | 'createdAt' | 'updatedAt' | 'resultCny' | 'state'>): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('save_cost_calibration', { input })
  }
  const webState = await tryWebBackend<AppState>('/api/lab/cost-calibration', apiPost({ input }))
  if (webState) {
    return webState
  }
  await mockDelay()
  const scale = 1_000_000_000_000n
  function parseFixed(value: string, label: string) {
    const trimmed = value.trim()
    const match = /^(\d+)(?:\.(\d{1,12}))?$/.exec(trimmed)
    if (!match) throw new Error(`${label} 必须是最多 12 位小数的正十进制数。`)
    const whole = BigInt(match[1])
    const fraction = BigInt((match[2] ?? '').padEnd(12, '0') || '0')
    const scaled = whole * scale + fraction
    if (scaled <= 0n) throw new Error(`${label} 必须大于 0。`)
    return scaled
  }
  function formatFixed(value: bigint) {
    const whole = value / scale
    const fraction = (value % scale).toString().padStart(12, '0').replace(/0+$/, '')
    return fraction ? `${whole}.${fraction}` : whole.toString()
  }
  const paid = parseFixed(input.paidCny, '实付金额')
  const credit = parseFixed(input.consumableCredit, '可消费额度')
  const debit = parseFixed(input.debitCredit, '后台最终扣费')
  if (input.officialCny?.trim()) parseFixed(input.officialCny, '官方同次成本')
  const calculated = (paid * debit) / credit
  if (calculated <= 0n) throw new Error('计算结果过小，无法在当前精度下保存。')
  const now = nowLabel()
  const record: CostCalibration = {
    ...input,
    id: crypto.randomUUID(),
    resultCny: formatFixed(calculated),
    state: 'completed',
    createdAt: now,
    updatedAt: now,
  }
  mockState.costCalibrations.unshift(record)
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: '费用校准已保存',
    detail: `${record.providerName} 的固定探针成本为 ¥${record.resultCny}。`,
    tone: 'success',
  })
  return structuredClone(mockState)
}

export async function deleteCostCalibration(calibrationId: string): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('delete_cost_calibration', { calibrationId })
  }
  const webState = await tryWebBackend<AppState>('/api/lab/cost-calibration/delete', apiPost({ calibrationId }))
  if (webState) return webState
  await mockDelay()
  const index = mockState.costCalibrations.findIndex((item) => item.id === calibrationId)
  if (index < 0) throw new Error('未找到这条费用记录。')
  const [removed] = mockState.costCalibrations.splice(index, 1)
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: '已删除费用记录',
    detail: `${removed.providerName} 的一条基准测试记录已移除。`,
    tone: 'info',
  })
  return structuredClone(mockState)
}

export async function setDefaultProfile(profileId: string): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('set_default_profile', { profileId })
  }
  const webState = await tryWebBackend<AppState>('/api/profiles/default', apiPost({ profileId }))
  if (webState) {
    return webState
  }
  await mockDelay()
  const target = mockState.profiles.find((profile) => profile.id === profileId)
  mockState.profiles = mockState.profiles.map((profile) => ({
    ...profile,
    isDefault: profile.id === profileId,
  }))
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: `${target?.name ?? '服务商'} 已设为默认`,
    detail: '默认标记已更新；不会立即改写当前 Codex 服务商。',
    tone: 'info',
  })
  return structuredClone(mockState)
}

export async function reorderProfiles(profileIds: string[]): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('reorder_profiles', { profileIds })
  }
  const webState = await tryWebBackend<AppState>('/api/profiles/reorder', apiPost({ profileIds }))
  if (webState) {
    return webState
  }
  await mockDelay()
  const byId = new Map(mockState.profiles.map((profile) => [profile.id, profile]))
  if (profileIds.length !== mockState.profiles.length || profileIds.some((id) => !byId.has(id))) {
    throw new Error('服务商排序内容无效。')
  }
  mockState.profiles = profileIds.map((id) => byId.get(id)!)
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: '服务商顺序已更新',
    detail: '此顺序只影响列表显示，不会切换或改写 Codex 配置。',
    tone: 'info',
  })
  return structuredClone(mockState)
}

export async function syncCurrentConfiguration(): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('sync_current_configuration')
  }
  const webState = await tryWebBackend<AppState>('/api/config/sync-current', apiPost())
  if (webState) {
    return webState
  }
  await mockDelay()
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: '预览未同步当前配置',
    detail: '开发预览不会读取或改写本机 Codex 配置。',
    tone: 'warning',
  })
  return structuredClone(mockState)
}

export async function prepareConnectionEnvironment(layerId: string, onboarding = false): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('prepare_connection_environment', { layerId, onboarding })
  }
  const webState = await tryWebBackend<AppState>('/api/config/prepare-environment', apiPost({ layerId, onboarding }))
  if (webState) return webState
  await mockDelay()
  const layer = mockState.connectionEnvironment.layers.find((item) => item.id === layerId)
  if (!layer) throw new Error('选择的配置层不存在。')
  mockState.connectionEnvironment = {
    ...mockState.connectionEnvironment,
    status: 'ready',
    onboardingCompleted: onboarding ? false : mockState.connectionEnvironment.onboardingCompleted,
    selectedLayerId: layerId,
    detail: '连接环境已准备：已创建恢复点，并只统一 custom 服务商与 Responses 所需设置。',
    layers: mockState.connectionEnvironment.layers.map((item) => ({ ...item, selected: item.id === layerId })),
  }
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: '连接环境已准备',
    detail: '开发预览仅更新隔离 fixture，不会读取或改写本机 Codex 配置。',
    tone: 'success',
  })
  return structuredClone(mockState)
}

export async function completeOnboarding(): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('complete_onboarding')
  }
  const webState = await tryWebBackend<AppState>('/api/config/complete-onboarding', apiPost())
  if (webState) return webState
  await mockDelay()
  mockState.connectionEnvironment = {
    ...mockState.connectionEnvironment,
    onboardingCompleted: true,
  }
  return structuredClone(mockState)
}
