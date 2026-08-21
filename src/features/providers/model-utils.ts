import type { ModelCatalog } from '../../types'

export function providerModelLabel(model: string) {
  const mockLabels: Record<string, string> = {
    'reasoning-current': '当前推理模型',
    'reasoning-preview': '推理模型（预览）',
    'reasoning-verified': '推理模型（已验证）',
    'provider-reasoning-current': '默认推理模型',
    'provider-reasoning-stable': '稳定推理模型',
    'provider-fast-current': '默认快速模型',
    'provider-fast-stable': '稳定快速模型',
    'provider-chat-compatible': '兼容对话模型',
    'provider-embedding-large': '向量模型',
  }
  return mockLabels[model] ?? model
}

export function isClearlyIncompatibleModel(model: ModelCatalog['models'][number]) {
  return model.tags.some((tag) => tag === 'embedding' || tag === 'audio')
}

export function modelSelectionRank(model: ModelCatalog['models'][number]) {
  if (isClearlyIncompatibleModel(model)) return 3
  if (model.verifiedForResponses === 'verified') return 0
  if (model.tags.includes('responses-candidate')) return 1
  return 2
}
