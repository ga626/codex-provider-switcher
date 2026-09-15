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
  return model.tags.some((tag) => tag === 'embedding' || tag === 'audio')
}

export function codexCompatibility(model: ModelCatalog['models'][number]): CodexCompatibility {
  const tokens = lowerTokens(model)
  const hasResponses = model.verifiedForResponses === 'verified' || model.tags.includes('responses-verified')
  const hasTools = model.tags.includes('tools-verified') || model.tags.includes('codex-tools')
  const incompatible = isClearlyIncompatibleModel(model) || model.tags.includes('protocol-incompatible')

  if (incompatible || model.verifiedForResponses === 'failed') {
    return {
      level: 'unsupported',
      label: '暂不适配',
      summary: '当前证据不足以安全用于 Codex',
      detail: isClearlyIncompatibleModel(model)
        ? '这是向量、音频或其他非 Codex 推理模型，不能作为当前默认模型。'
        : '该模型的协议、认证或响应格式没有通过 Codex 检查。',
      capabilities: [],
      missing: ['Codex Responses', '工具调用', '真实切换验收'],
    }
  }

  if (hasResponses && hasTools) {
    return {
      level: 'verified',
      label: 'Codex 已验证',
      summary: 'Responses、流式与工具调用已有验证证据',
      detail: '适合置顶展示；仍需在切换后的新 Codex 会话确认实际服务商。',
      capabilities: ['Responses', '流式输出', '工具调用'],
      missing: [],
    }
  }

  const vendor = tokens.includes('deepseek') ? 'DeepSeek' : tokens.includes('kimi') || tokens.includes('moonshot') ? 'Kimi' : tokens.includes('glm') ? 'GLM' : tokens.includes('gemini') ? 'Gemini' : tokens.includes('grok') ? 'Grok' : tokens.includes('mimo') ? 'MIMO' : '该模型'
  return {
    level: 'partial',
    label: '部分适配',
    summary: hasResponses ? 'Responses 可用，工具能力仍待确认' : '已发现模型，但完整 Codex 合同尚未验证',
    detail: `${vendor}可以保留在目录中，但选择前应说明它与 OpenAI Codex 原生模型的能力差异。`,
    capabilities: hasResponses ? ['Responses'] : model.tags.includes('chat-compatible') ? ['文本对话', '流式输出'] : ['模型目录可见'],
    missing: hasTools ? [] : ['工具调用未验证', '插件/连接器能力不继承'],
  }
}

export function modelSelectionRank(model: ModelCatalog['models'][number]) {
  const compatibility = codexCompatibility(model)
  if (compatibility.level === 'verified') return 0
  if (compatibility.level === 'partial') return 1
  return 2
}
