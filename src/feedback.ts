import type { AppState, ModelCatalog, ProviderProfile } from './types'

export type CompatibilityFeedback = {
  schema: 'signalman-compatibility-feedback/v2'
  diagnosticId: string
  app: 'Signalman AI'
  build: string
  runtime: AppState['runtimeMode']
  createdAt: string
  provider: {
    name: string
    endpoint: { protocol: string; host: string; path: string }
    model: string
    hasApiKey: boolean
    active: boolean
    isDefault: boolean
    status: string
    stage?: string
    httpStatus?: number
    providerCode?: string
    responseShape?: string
  }
  catalog?: {
    status: string
    httpStatus?: number
    providerCode?: string
    retryAfterSeconds?: number
    modelCount: number
    selectedModelListed: boolean
    responseCompatibleModels: number
  }
  environment: {
    status: string
    onboardingCompleted: boolean
    selectedLayerConfigured: boolean
  }
  checks: Array<{ id: string; ok: boolean; severity: string }>
  recentActions: Array<{ title: string; tone: string }>
}

function endpointSummary(baseUrl: string) {
  try {
    const url = new URL(baseUrl)
    const host = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '::1' || /^127\./.test(url.hostname) || /^10\./.test(url.hostname) || /^192\.168\./.test(url.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname) ? 'private_endpoint' : url.host
    return {
      protocol: url.protocol.replace(':', ''),
      host: host.slice(0, 120),
      path: url.pathname.replace(/\/{2,}/g, '/').slice(0, 120) || '/',
    }
  } catch {
    return { protocol: 'invalid', host: 'invalid', path: '/' }
  }
}

function safeText(value: string, limit: number) {
  const printable = Array.from(value).filter((character) => {
    const code = character.charCodeAt(0)
    return code >= 32 && code !== 127
  }).join('')
  return printable.replace(/(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]').slice(0, limit)
}

function safeActionTitle(value: string) {
  const known = ['运行服务商可用性测试', '刷新模型目录', '切换服务商', '模型目录已刷新', '模型目录刷新失败']
  return known.includes(value) ? value : '其他诊断操作'
}

function catalogSummary(catalog: ModelCatalog | undefined, selectedModel: string): CompatibilityFeedback['catalog'] {
  if (!catalog) return undefined
  return {
    status: catalog.status,
    httpStatus: catalog.httpStatus,
    providerCode: catalog.providerCode,
    retryAfterSeconds: catalog.retryAfterSeconds,
    modelCount: catalog.models.length,
    selectedModelListed: catalog.models.some((model) => model.id === selectedModel || model.aliases.includes(selectedModel)),
    responseCompatibleModels: catalog.models.filter((model) => model.verifiedForResponses === 'verified').length,
  }
}

export function createCompatibilityFeedback(state: AppState, selectedProfile: ProviderProfile | undefined, diagnosticId: string, createdAt = new Date().toISOString()): CompatibilityFeedback | null {
  if (!selectedProfile) return null
  const catalog = state.modelCatalogs.find((item) => item.providerId === selectedProfile.id)
  return {
    schema: 'signalman-compatibility-feedback/v2',
    diagnosticId,
    app: 'Signalman AI',
    build: __CODEX_BUILD_SHA__,
    runtime: state.runtimeMode,
    createdAt,
    provider: {
      name: safeText(selectedProfile.name, 80),
      endpoint: endpointSummary(selectedProfile.baseUrl),
      model: safeText(selectedProfile.model, 96),
      hasApiKey: selectedProfile.hasApiKey,
      active: selectedProfile.active,
      isDefault: selectedProfile.isDefault,
      status: selectedProfile.verificationStatus,
      stage: selectedProfile.lastVerificationStage ? safeText(selectedProfile.lastVerificationStage, 80) : undefined,
      httpStatus: selectedProfile.lastVerificationHttpStatus,
      providerCode: selectedProfile.lastVerificationProviderCode ? safeText(selectedProfile.lastVerificationProviderCode, 80) : undefined,
      responseShape: selectedProfile.verificationResponseShape,
    },
    catalog: catalogSummary(catalog, selectedProfile.model),
    environment: {
      status: state.connectionEnvironment.status,
      onboardingCompleted: state.connectionEnvironment.onboardingCompleted,
      selectedLayerConfigured: Boolean(state.connectionEnvironment.selectedLayerId),
    },
    checks: state.checks.slice(0, 30).map((check) => ({ id: check.id, ok: check.ok, severity: check.severity })),
    // Titles and tones show the operation sequence without sending free-form activity details.
    recentActions: state.activity.slice(0, 8).map((item) => ({ title: safeActionTitle(item.title), tone: ['success', 'info', 'warning', 'danger'].includes(item.tone) ? item.tone : 'info' })),
  }
}
