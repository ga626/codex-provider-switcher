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
    return {
      protocol: url.protocol.replace(':', ''),
      host: url.host,
      path: url.pathname.replace(/\/{2,}/g, '/').slice(0, 120) || '/',
    }
  } catch {
    return { protocol: 'invalid', host: 'invalid', path: '/' }
  }
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
      name: selectedProfile.name.slice(0, 80),
      endpoint: endpointSummary(selectedProfile.baseUrl),
      model: selectedProfile.model.slice(0, 120),
      hasApiKey: selectedProfile.hasApiKey,
      active: selectedProfile.active,
      isDefault: selectedProfile.isDefault,
      status: selectedProfile.verificationStatus,
      stage: selectedProfile.lastVerificationStage?.slice(0, 80),
      httpStatus: selectedProfile.lastVerificationHttpStatus,
      providerCode: selectedProfile.lastVerificationProviderCode?.slice(0, 80),
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
    recentActions: state.activity.slice(0, 8).map((item) => ({ title: item.title.slice(0, 100), tone: item.tone })),
  }
}
