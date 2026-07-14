export type ProviderProfile = {
  id: string
  name: string
  baseUrl: string
  model: string
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high'
  note: string
  verified: boolean
  isDefault: boolean
  active: boolean
  hasApiKey: boolean
  lastSwitchedAt?: string
  lastVerifiedAt?: string
}

export type ProviderModel = {
  id: string
  aliases: string[]
  source: 'provider_models_api' | 'mock' | 'manual'
  recommendedForCodex: boolean
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

export type LegacySwitcherStatus = {
  profilePath: string
  profileExists: boolean
  processRunning: boolean
  port: number
  portInUse: boolean
  imported: boolean
  importedFrom?: string
  importedAt?: string
  appProfilePath: string
}

export type AppState = {
  currentProfileId: string
  configPath: string
  authPath: string
  autoStart: boolean
  trayEnabled: boolean
  safeMode: boolean
  profiles: ProviderProfile[]
  modelCatalogs: ModelCatalog[]
  checks: ValidationCheck[]
  activity: ActivityItem[]
  backups: BackupItem[]
  legacySwitcher: LegacySwitcherStatus
}

export type EditableProfile = {
  id: string
  name: string
  baseUrl: string
  model: string
  note: string
  apiKey: string
}
