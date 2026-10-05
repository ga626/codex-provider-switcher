import type { ModelCatalog } from '../../types'

export type CodexCompatibilityLevel = 'verified' | 'partial' | 'unsupported'

export type CodexCompatibility = {
  level: CodexCompatibilityLevel
  label: string
  summary: string
  detail: string
  capabilities: string[]
  missing: string[]
}

const lowerTokens = (model: ModelCatalog['models'][number]) => [model.id, ...model.aliases, ...model.tags].join(' ').toLocaleLowerCase()

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
  const id = model.id.toLocaleLowerCase()
  return model.tags.some((tag) => tag === 'embedding' || tag === 'audio') ||
    ['embedding', 'embed', 'rerank', 'moderation', 'whisper', 'transcribe', 'text-to-speech', 'speech-to-text'].some((marker) => id.includes(marker))
}

export function codexCompatibility(model: ModelCatalog['models'][number], protocol?: string): CodexCompatibility {
  const tokens = lowerTokens(model)
  const hasResponses = model.verifiedForResponses === 'verified' || model.tags.includes('responses-verified')
  const incompatible = isClearlyIncompatibleModel(model) || model.tags.includes('protocol-incompatible')
  const nativeCodex = model.tags.includes('codex')

  if (incompatible) {
    return {
      level: 'unsupported',
      label: '暂不支持',
      summary: '这类模型不能作为 Codex 推理模型',
      detail: isClearlyIncompatibleModel(model)
        ? '这是向量、音频或其他非 Codex 推理模型，不能作为当前默认模型。'
        : '该模型被服务商标记为不兼容当前 Codex 请求协议。',
      capabilities: [],
      missing: [],
    }
  }

  if (nativeCodex) {
    return {
      level: 'verified',
      label: 'Codex 原生',
      summary: 'Codex 内置模型',
      detail: '这是 Codex 自带的模型类型。',
      capabilities: ['Codex 内置'],
      missing: [],
    }
  }

  if (protocol === 'chat_completions') {
    return {
      level: 'partial',
      label: '自动转换',
      summary: '将通过本机转换接入 Codex',
      detail: 'Codex 的请求会由 Signalman 转成此服务商支持的普通聊天格式。基础对话可用，工具、多模态或特殊能力需结合实际结果判断。',
      capabilities: ['本机协议转换'],
      missing: [],
    }
  }

  if (hasResponses) {
    return {
      level: 'verified',
      label: '请求已验证',
      summary: '此服务商已成功完成 Responses 请求',
      detail: '这证明当前服务商和模型可以完成基础 Codex 请求；并不代表所有工具或扩展能力都经过验证。',
      capabilities: ['Responses 请求'],
      missing: [],
    }
  }

  const vendor = tokens.includes('deepseek') ? 'DeepSeek' : tokens.includes('kimi') || tokens.includes('moonshot') ? 'Kimi' : tokens.includes('glm') ? 'GLM' : tokens.includes('gemini') ? 'Gemini' : tokens.includes('grok') ? 'Grok' : tokens.includes('mimo') ? 'MIMO' : '该模型'
  const lastFailed = model.verifiedForResponses === 'failed'
  return {
    level: 'partial',
    label: lastFailed ? '最近未通过' : '可接入',
    summary: lastFailed ? '上次请求没通过，可重新选择或重试' : '尚无该模型的实测结果',
    detail: lastFailed
      ? '上次失败可能来自模型权限、密钥、服务商或网络，不代表模型永久不可用。请结合可用性测试详情判断。'
      : `${vendor}模型会按当前服务商配置尝试接入。未测试不代表不可用；遇到问题时再依据实际请求结果判断。`,
    capabilities: ['可加入 Codex'],
    missing: [],
  }
}

export function modelSelectionRank(model: ModelCatalog['models'][number]) {
  const compatibility = codexCompatibility(model)
  if (compatibility.level === 'verified') return 0
  if (compatibility.level === 'partial') return 1
  return 2
}
