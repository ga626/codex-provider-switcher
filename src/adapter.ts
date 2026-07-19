import { invoke } from '@tauri-apps/api/core'
import { initialState } from './mockData'
import type { AppState, EditableProfile, ModelCatalog, ProviderProfile, UpdateInfo } from './types'

const isTauri = '__TAURI_INTERNALS__' in window
const allowBrowserMock = import.meta.env.VITE_CODEX_PROVIDER_SWITCHER_ALLOW_MOCK === 'true'
const storeProductId = '9P7PGV62WKK6'
const storeProductUrl = `https://apps.microsoft.com/detail/${storeProductId}`
const storeLaunchUrl = `ms-windows-store://pdp/?productid=${storeProductId}`

export const isStoreManagedBuild = __CODEX_RELEASE_CHANNEL__ === 'store'

let mockState: AppState = structuredClone(initialState)
let webBackendAvailable: boolean | null = null
let pendingTauriUpdate: { version: string; date?: string | null; downloadAndInstall: () => Promise<void> } | null = null

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
  return '应用的连接服务未能启动。请重新打开 CodeX Provider Switcher；如果问题持续，请查看故障排查。'
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

export async function checkForUpdate(): Promise<UpdateInfo> {
  if (isTauri) {
    if (isStoreManagedBuild) {
      pendingTauriUpdate = null
      return {
        currentVersion: __APP_VERSION__,
        latestVersion: __APP_VERSION__,
        available: false,
        releaseUrl: storeProductUrl,
      }
    }
    if (__CODEX_RELEASE_CHANNEL__ !== 'stable') {
      pendingTauriUpdate = null
      return {
        currentVersion: __APP_VERSION__,
        latestVersion: __APP_VERSION__,
        available: false,
        releaseUrl: 'https://github.com/ga626/codex-provider-switcher/releases',
      }
    }
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) {
      pendingTauriUpdate = null
      return {
        currentVersion: __APP_VERSION__,
        latestVersion: __APP_VERSION__,
        available: false,
        releaseUrl: 'https://github.com/ga626/codex-provider-switcher/releases',
      }
    }
    pendingTauriUpdate = update
    return {
      currentVersion: __APP_VERSION__,
      latestVersion: update.version,
      available: true,
      releaseUrl: 'https://github.com/ga626/codex-provider-switcher/releases',
      publishedAt: update.date ?? undefined,
    }
  }
  const webResult = await tryWebBackend<UpdateInfo>('/api/update/check')
  if (webResult) {
    return webResult
  }
  await mockDelay()
  return {
    currentVersion: __APP_VERSION__,
    latestVersion: __APP_VERSION__,
    available: false,
    releaseUrl: 'https://github.com/ga626/codex-provider-switcher/releases',
  }
}

export async function openUpdate(url: string): Promise<void> {
  if (isTauri && pendingTauriUpdate) {
    await pendingTauriUpdate.downloadAndInstall()
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
    detail: '服务商信息已更新；保存后不会明文显示 API 密钥。',
    tone: 'info',
  })
  return structuredClone(mockState)
}

function mockModelCatalog(profileId: string): ModelCatalog {
  const profile = mockState.profiles.find((item) => item.id === profileId)
  if (!profile) {
    throw new Error('未找到服务商配置。')
  }
  if (!profile.hasApiKey) {
    return {
      providerId: profileId,
      baseUrl: profile.baseUrl,
      fetchedAt: nowLabel(),
      status: 'missing_key',
      statusDetail: '缺少 API 密钥，无法刷新模型目录。',
      models: [],
    }
  }

  return {
    providerId: profileId,
    baseUrl: profile.baseUrl,
    fetchedAt: nowLabel(),
    status: 'ok',
    statusDetail: '已返回 6 个示例模型。',
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

export async function refreshModels(profileId: string): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('refresh_models', { profileId })
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

export async function switchProfile(profileId: string): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('switch_profile', { profileId })
  }
  const webState = await tryWebBackend<AppState>('/api/profiles/switch', apiPost({ profileId }))
  if (webState) {
    return webState
  }
  throw new Error('开发预览不执行服务商切换。请使用桌面开发版或本机后端进行真实验证。')
}

export async function verifyProfile(profileId: string): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('verify_profile', { profileId })
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
