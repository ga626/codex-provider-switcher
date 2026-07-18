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
  status:
    | 'not_fetched'
    | 'ok'
    | 'missing_key'
    | 'unauthorized'
    | 'network_error'
    | 'provider_error'
    | 'empty_models'
  statusDetail: string
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

export type BackupItem = {
  id: string
  time: string
  label: string
  files: number
}

export type UpdateInfo = {
  currentVersion: string
  latestVersion: string
  available: boolean
  releaseUrl: string
  downloadUrl?: string
  publishedAt?: string
}

export type AppState = {
  runtimeMode: 'tauri_native' | 'local_web_backend' | 'browser_preview_mock'
  currentProfileId: string
  configPath: string
  authPath: string
  autoStart: boolean
  trayEnabled: boolean
  safeMode: boolean
  configurationDrift?: ConfigurationDrift
  profiles: ProviderProfile[]
  modelCatalogs: ModelCatalog[]
  checks: ValidationCheck[]
  activity: ActivityItem[]
  backups: BackupItem[]
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
