export type ProviderProfile = {
  id: string
  name: string
  baseUrl: string
  model: string
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high'
  note: string
  verified: boolean
  verificationStatus:
    | 'not_checked'
    | 'verified'
    | 'missing_key'
    | 'invalid_profile'
    | 'unauthorized'
    | 'billing_unavailable'
    | 'rate_limited'
    | 'model_unavailable'
    | 'endpoint_or_model_unavailable'
    | 'request_incompatible'
    | 'protocol_incompatible'
    | 'response_shape_unconfirmed'
    | 'response_unparseable'
    | 'service_error'
    | 'timeout'
    | 'network_error'
    | 'transport_error'
    | 'provider_error'
  isDefault: boolean
  active: boolean
  hasApiKey: boolean
  lastSwitchedAt?: string
  lastVerifiedAt?: string
  lastVerificationDetail?: string
  lastVerificationStage?: string
  lastVerificationHttpStatus?: number
  lastVerificationProviderCode?: string
  verificationResponseShape?: 'standard_responses' | 'compatible_response'
}

export type ProviderModel = {
  id: string
  aliases: string[]
  source: 'provider_models_api' | 'mock' | 'manual'
  tags: string[]
  verifiedForResponses: 'unknown' | 'verified' | 'failed'
}

export type ModelCatalog = {
  providerId: string
  baseUrl: string
  fetchedAt?: string
  lastSuccessfulAt?: string
  status:
    | 'not_fetched'
    | 'ok'
    | 'stale'
    | 'missing_key'
    | 'unauthorized'
    | 'rate_limited'
    | 'service_error'
    | 'network_error'
    | 'provider_error'
    | 'empty_models'
  statusDetail: string
  httpStatus?: number
  providerCode?: string
  requestId?: string
  retryAfterSeconds?: number
  models: ProviderModel[]
}

export type ValidationCheck = {
  id: string
  label: string
  ok: boolean
  detail: string
  severity: 'required' | 'warning' | 'info'
}

export type ActivityItem = {
  id: string
  time: string
  title: string
  detail: string
  tone: 'success' | 'warning' | 'danger' | 'info'
}

export type CostCalibration = {
  id: string
  providerId: string
  providerName: string
  fundingMode: 'prepaid' | 'subscription'
  paidCny: string
  consumableCredit: string
  debitCredit: string
  creditUnitLabel: string
  model: string
  probeVersion: string
  costSource?: 'response_inline' | 'response_usage' | 'response_header' | 'billing_log_manual' | 'balance_difference'
  probeId?: string
  sampleKind?: 'cold' | 'warm'
  officialCny?: string
  resultCny: string
  state: 'completed' | 'incomparable' | 'stale'
  createdAt: string
  updatedAt: string
  note?: string
}

export type ResponseProbeObservation = {
  id: string
  providerId: string
  providerName: string
  model: string
  probeVersion: string
  observedAt: string
  status: 'preview' | 'usage_only' | 'correlation_only' | 'final_cost_inline' | 'no_signal' | 'failed'
  httpStatus?: number
  requestId?: string
  responseId?: string
  actualModel?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
  costCandidate?: string
  costSource?: 'response_inline' | 'response_usage' | 'response_header'
  detail: string
}

export type BackupItem = {
  id: string
  time: string
  label: string
  files: number
  fileCategories: string[]
  kind: 'initial_install' | 'daily' | 'manual' | 'before_switch' | 'before_restore' | 'legacy_backup' | 'invalid_backup'
  retentionManaged: boolean
  restoreReady?: boolean
  restoreDetail?: string
}

export type BackupPolicy = {
  automaticLimit: number
  manualLimit: number
}

export type ConfigurationProtectionItem = {
  id: string
  label: string
  count?: number
  state: 'protected' | 'not_configured' | 'outside_write_scope'
  detail: string
}

export type ConfigurationProtection = {
  baselineReady: boolean
  baselineDetail: string
  items: ConfigurationProtectionItem[]
  restoreDetail: string
}

export type ConnectionEnvironmentLayer = {
  id: string
  label: string
  detail: string
  selected: boolean
}

export type ConnectionEnvironment = {
  status: 'needs_setup' | 'ready' | 'needs_selection' | 'error'
  selectedLayerId?: string
  onboardingCompleted: boolean
  detail: string
  layers: ConnectionEnvironmentLayer[]
}

export type UpdateInfo = {
  currentVersion: string
  latestVersion: string
  available: boolean
  releaseUrl: string
  downloadUrl?: string
  publishedAt?: string
  checkedAt?: string
  notes?: string
}

export type AppState = {
  runtimeMode: 'tauri_native' | 'local_web_backend' | 'browser_preview_mock'
  currentProfileId: string
  configPath: string
  authPath: string
  autoStart: boolean
  backupPolicy: BackupPolicy
  startupNotice?: {
    code: string
    detail: string
  }
  configurationDrift?: ConfigurationDrift
  profiles: ProviderProfile[]
  modelCatalogs: ModelCatalog[]
  checks: ValidationCheck[]
  activity: ActivityItem[]
  costCalibrations: CostCalibration[]
  responseProbes: ResponseProbeObservation[]
  backups: BackupItem[]
  configurationProtection: ConfigurationProtection
  connectionEnvironment: ConnectionEnvironment
}

export type SwitchPreflight = {
  operationId: string
  profileId: string
  targetName: string
  targetModel: string
  backupDetail: string
  protectedDetail: string
  availabilityStatus: string
  availabilityDetail: string
  availabilityCheckedAt: string
  riskDetail?: string
  expiresAt: string
}

export type ConfigurationDrift = {
  profileId: string
  profileName: string
  currentModel: string
  savedModel: string
  detail: string
}

export type EditableProfile = {
  id: string
  name: string
  baseUrl: string
  model: string
  note: string
  apiKey: string
}
