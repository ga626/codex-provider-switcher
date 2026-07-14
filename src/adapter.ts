import { invoke } from '@tauri-apps/api/core'
import { initialState } from './mockData'
import type { AppState, EditableProfile, ModelCatalog } from './types'

const isTauri = '__TAURI_INTERNALS__' in window

let mockState: AppState = structuredClone(initialState)
let webBackendAvailable: boolean | null = null

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
  const nextProfile = {
    id,
    name: profile.name.trim(),
    baseUrl: profile.baseUrl.trim(),
    model: profile.model.trim(),
    reasoningEffort: existingIndex >= 0 ? mockState.profiles[existingIndex].reasoningEffort : 'high',
    note: profile.note.trim(),
    verified: false,
    isDefault: existingIndex >= 0 ? mockState.profiles[existingIndex].isDefault : false,
    active: mockState.currentProfileId === id,
    hasApiKey: profile.apiKey.trim().length > 0 || (existingIndex >= 0 && mockState.profiles[existingIndex].hasApiKey),
    lastVerifiedAt: '编辑后尚未验证',
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
    statusDetail: '浏览器预览假数据：已返回 6 个样例模型；真实列表只来自本机后端调用 /v1/models。',
    models: [
      {
        id: 'gpt-5.6-sol',
        aliases: ['gpt-5.6'],
        source: 'mock',
        tags: ['reasoning', 'responses-candidate'],
        verifiedForResponses: 'unknown',
      },
      {
        id: 'gpt-5.6-mini',
        aliases: [],
        source: 'mock',
        tags: ['fast', 'responses-candidate'],
        verifiedForResponses: 'unknown',
      },
      {
        id: 'gpt-5.5',
        aliases: [],
        source: 'mock',
        tags: ['reasoning'],
        verifiedForResponses: 'unknown',
      },
      {
        id: 'gpt-5.5-mini',
        aliases: [],
        source: 'mock',
        tags: ['fast'],
        verifiedForResponses: 'unknown',
      },
      {
        id: 'gpt-4.1',
        aliases: [],
        source: 'mock',
        tags: ['chat'],
        verifiedForResponses: 'unknown',
      },
      {
        id: 'text-embedding-3-large',
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
    title: catalog.status === 'ok' ? '预览模型目录已刷新' : '模型目录刷新失败',
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

export async function switchProfile(profileId: string): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('switch_profile', { profileId })
  }
  const webState = await tryWebBackend<AppState>('/api/profiles/switch', apiPost({ profileId }))
  if (webState) {
    return webState
  }
  await mockDelay()
  const target = mockState.profiles.find((profile) => profile.id === profileId)
  if (!target) throw new Error('未找到服务商配置。')
  mockState.currentProfileId = profileId
  mockState.profiles = mockState.profiles.map((profile) => ({
    ...profile,
    active: profile.id === profileId,
    lastSwitchedAt: profile.id === profileId ? nowLabel() : profile.lastSwitchedAt,
  }))
  mockState.backups.unshift({
    id: crypto.randomUUID(),
    time: nowLabel(),
    label: `before-${new Date().toISOString().slice(0, 19).replace(/\D/g, '')}`,
    files: 2,
  })
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: `已切换到 ${target.name}`,
    detail: '浏览器预览假数据已更新当前服务商，并生成一条内存备份记录。',
    tone: 'success',
  })
  return structuredClone(mockState)
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
  const requiredChecksOk = mockState.checks.every((check) => check.ok || check.severity !== 'required')
  const profileReady = Boolean(
    target &&
      target.hasApiKey &&
      target.model.trim().length > 0 &&
      /^https?:\/\/\S+/i.test(target.baseUrl)
  )
  const verified = requiredChecksOk && profileReady
  mockState.profiles = mockState.profiles.map((profile) => (
    profile.id === profileId
      ? { ...profile, verified, lastVerifiedAt: nowLabel() }
      : profile
  ))
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: verified ? '验证完成' : '验证未通过',
    detail: verified
      ? `${target?.name ?? '服务商'} 的本地配置和必填项已通过。`
      : `${target?.name ?? '服务商'} 缺少接口地址、模型、API 密钥，或 Codex 当前配置存在阻断项。`,
    tone: verified ? 'success' : 'warning',
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

export async function toggleAutoStart(enabled: boolean): Promise<AppState> {
  if (isTauri) {
    return invoke<AppState>('toggle_auto_start', { enabled })
  }
  const webState = await tryWebBackend<AppState>('/api/auto-start', apiPost({ enabled }))
  if (webState) {
    return webState
  }
  await mockDelay()
  mockState.autoStart = enabled
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: enabled ? '已请求开机启动' : '已关闭开机启动',
    detail: '浏览器预览假数据只改变界面状态；真实后端需要核验 Windows 启动项。',
    tone: enabled ? 'warning' : 'info',
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
  if (mockState.backups.length === 0) {
    throw new Error('当前没有可恢复的备份。')
  }
  mockState.activity.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    title: '已恢复最近备份',
    detail: '浏览器预览假数据已触发恢复动作，并记录本次恢复请求。',
    tone: 'success',
  })
  return structuredClone(mockState)
}
