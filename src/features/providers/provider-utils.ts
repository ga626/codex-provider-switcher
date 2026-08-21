import type { EditableProfile, ModelCatalog, ProviderProfile, ValidationCheck } from '../../types'
import { providerModelLabel } from './model-utils'

export function profileConfigurationChecks(
  profile: ProviderProfile | undefined,
  draft: EditableProfile,
): ValidationCheck[] {
  if (!profile && !draft.name && !draft.baseUrl) {
    return []
  }

  const name = draft.name.trim()
  const baseUrl = draft.baseUrl.trim()
  const model = draft.model.trim()
  const hasKey = draft.apiKey.trim().length > 0 || Boolean(profile?.hasApiKey)

  return [
    {
      id: 'profile-name',
      label: '服务商名称',
      ok: name.length > 0,
      detail: name.length > 0 ? `当前选择：${name}` : '需要填写服务商名称。',
      severity: 'required',
    },
    {
      id: 'profile-base-url',
      label: '接口地址',
      ok: /^https?:\/\/\S+/i.test(baseUrl),
      detail: /^https?:\/\/\S+/i.test(baseUrl) ? baseUrl : '需要填写 http 或 https 开头的接口地址。',
      severity: 'required',
    },
    {
      id: 'profile-model',
      label: '模型名称',
      ok: model.length > 0,
      detail: model.length > 0
        ? providerModelLabel(model) === model ? model : `${providerModelLabel(model)}（模型标识：${model}）`
        : '需要填写 Codex 使用的模型名称。',
      severity: 'required',
    },
    {
      id: 'profile-api-key',
      label: '切换器访问密钥',
      ok: hasKey,
      detail: hasKey ? '已保存，可运行切换器的真实连接测试。' : '未保存；仍可安全切换，但本工具无法代替 Codex 验证服务商可用性。',
      severity: 'warning',
    },
  ]
}

export function providerAvailabilityChecks(
  profile: ProviderProfile | undefined,
  modelCatalog: ModelCatalog | undefined,
): ValidationCheck[] {
  if (!profile) return []

  const checks: ValidationCheck[] = [{
    id: 'provider-inference-probe',
    label: '服务商可用性测试',
    ok: profile.verified && profile.verificationStatus === 'verified',
    detail: verificationDetail(profile),
    severity: 'warning',
  }]

  if (profile.model.length > 0 && modelCatalogCanBeUsed(modelCatalog)) {
    const modelIds = new Set(modelCatalog.models.map((item) => item.id))
    checks.push({
      id: 'profile-model-catalog',
      label: '模型目录匹配',
      ok: modelIds.has(profile.model),
      detail: modelIds.has(profile.model)
        ? '当前模型存在于最近一次服务商模型目录。'
        : '当前模型不在最近一次服务商模型目录中；这只影响模型选择提示，不代表模型不能调用。',
      severity: 'info',
    })
  }

  return checks
}

export function verificationDetail(profile: ProviderProfile | undefined) {
  if (!profile?.lastVerificationDetail) {
    return '尚未运行连接测试。'
  }

  return profile.verified && profile.verificationStatus === 'verified'
    ? '最近一次连接测试通过。'
    : profile.lastVerificationDetail
}

export function modelCatalogCanBeUsed(catalog: ModelCatalog | undefined): catalog is ModelCatalog {
  return catalog?.status === 'ok' || catalog?.status === 'stale'
}

export function requiresManualModelConfirmation(
  draft: EditableProfile,
  profile: ProviderProfile | undefined,
  catalog: ModelCatalog | undefined,
) {
  const model = draft.model.trim()
  if (!model || model === profile?.model) return false
  return !modelCatalogCanBeUsed(catalog) || !catalog?.models.some((item) => item.id.toLocaleLowerCase() === model.toLocaleLowerCase())
}

export function draftMatchesProfile(draft: EditableProfile, profile: ProviderProfile | undefined) {
  if (!profile) return !draft.name && !draft.baseUrl && !draft.model && !draft.note && !draft.apiKey
  return (
    draft.name.trim() === profile.name &&
    draft.baseUrl.trim() === profile.baseUrl &&
    draft.model.trim() === profile.model &&
    draft.note.trim() === profile.note &&
    draft.apiKey.trim().length === 0
  )
}
