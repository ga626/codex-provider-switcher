const MAX_TEXT = 160
const MAX_CODE = 80

function optionalText(value, max = MAX_TEXT) {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

function optionalStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}

function rejectSecretLike(value) {
  return /(?:api[_-]?key|authorization|bearer\s+|password|cookie|auth\.json|config\.toml|[A-Za-z]:\\|\/Users\/|\/home\/|[?&](?:key|token|secret|sig)=)/i.test(value)
}

function safeText(value, max = MAX_TEXT) {
  const text = optionalText(value, max)
  return text && !rejectSecretLike(text) ? text : undefined
}

function safeBoolean(value) {
  return typeof value === 'boolean' ? value : undefined
}

function containsRejectedText(value) {
  if (typeof value === 'string') return rejectSecretLike(value)
  if (!value || typeof value !== 'object') return false
  return Object.values(value).some(containsRejectedText)
}

export function validateFeedbackPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: '请求内容必须是对象。' }
  if (input.schema !== 'signalman-compatibility-feedback/v2') return { ok: false, error: '不支持的反馈格式。' }
  if (containsRejectedText({ provider: input.provider, catalog: input.catalog, environment: input.environment, checks: input.checks, recentActions: input.recentActions })) return { ok: false, error: '反馈内容包含不允许的敏感信息。' }
  const diagnosticId = safeText(input.diagnosticId, MAX_CODE)
  const build = safeText(input.build, MAX_CODE)
  const runtime = safeText(input.runtime, MAX_CODE)
  const createdAt = safeText(input.createdAt, 40)
  if (!diagnosticId || !build || !runtime || !createdAt) return { ok: false, error: '缺少反馈标识或运行信息。' }
  if (!input.provider || typeof input.provider !== 'object' || !input.provider.endpoint || typeof input.provider.endpoint !== 'object') return { ok: false, error: '缺少服务商诊断信息。' }

  const provider = {
    name: safeText(input.provider.name),
    endpoint: {
      protocol: safeText(input.provider.endpoint.protocol, 12),
      host: safeText(input.provider.endpoint.host),
      path: safeText(input.provider.endpoint.path, 120),
    },
    model: safeText(input.provider.model),
    hasApiKey: safeBoolean(input.provider.hasApiKey),
    active: safeBoolean(input.provider.active),
    isDefault: safeBoolean(input.provider.isDefault),
    status: safeText(input.provider.status, MAX_CODE),
    stage: safeText(input.provider.stage, MAX_CODE),
    httpStatus: optionalStatus(input.provider.httpStatus),
    providerCode: safeText(input.provider.providerCode, MAX_CODE),
    responseShape: safeText(input.provider.responseShape, MAX_CODE),
  }
  if (!provider.name || !provider.endpoint.protocol || !provider.endpoint.host || !provider.endpoint.path || !provider.model || !provider.status || provider.hasApiKey === undefined || provider.active === undefined || provider.isDefault === undefined) return { ok: false, error: '服务商诊断信息不完整。' }

  const catalog = input.catalog && typeof input.catalog === 'object' ? {
    status: safeText(input.catalog.status, MAX_CODE),
    httpStatus: optionalStatus(input.catalog.httpStatus),
    providerCode: safeText(input.catalog.providerCode, MAX_CODE),
    retryAfterSeconds: Number.isInteger(input.catalog.retryAfterSeconds) && input.catalog.retryAfterSeconds >= 0 && input.catalog.retryAfterSeconds <= 86400 ? input.catalog.retryAfterSeconds : undefined,
    modelCount: Number.isInteger(input.catalog.modelCount) && input.catalog.modelCount >= 0 && input.catalog.modelCount <= 10000 ? input.catalog.modelCount : undefined,
    selectedModelListed: safeBoolean(input.catalog.selectedModelListed),
    responseCompatibleModels: Number.isInteger(input.catalog.responseCompatibleModels) && input.catalog.responseCompatibleModels >= 0 && input.catalog.responseCompatibleModels <= 10000 ? input.catalog.responseCompatibleModels : undefined,
  } : undefined
  if (catalog && (!catalog.status || catalog.modelCount === undefined || catalog.selectedModelListed === undefined || catalog.responseCompatibleModels === undefined)) return { ok: false, error: '模型目录诊断信息不完整。' }

  const environment = input.environment && typeof input.environment === 'object' ? {
    status: safeText(input.environment.status, MAX_CODE),
    onboardingCompleted: safeBoolean(input.environment.onboardingCompleted),
    selectedLayerConfigured: safeBoolean(input.environment.selectedLayerConfigured),
  } : undefined
  if (!environment?.status || environment.onboardingCompleted === undefined || environment.selectedLayerConfigured === undefined) return { ok: false, error: '连接环境诊断信息不完整。' }

  const checks = Array.isArray(input.checks) ? input.checks.slice(0, 30).flatMap((check) => {
    if (!check || typeof check !== 'object') return []
    const id = safeText(check.id, MAX_CODE)
    const severity = safeText(check.severity, 16)
    return id && typeof check.ok === 'boolean' && ['required', 'warning', 'info'].includes(severity) ? [{ id, ok: check.ok, severity }] : []
  }) : []
  const recentActions = Array.isArray(input.recentActions) ? input.recentActions.slice(0, 8).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const title = safeText(item.title, 100)
    const tone = safeText(item.tone, 16)
    return title && ['success', 'warning', 'danger', 'info'].includes(tone) ? [{ title, tone }] : []
  }) : []
  return { ok: true, value: { schema: input.schema, diagnosticId, build, runtime, createdAt, provider, catalog, environment, checks, recentActions } }
}

export function renderIssueBody(payload) {
  const rows = [
    ['诊断编号', payload.diagnosticId], ['构建', payload.build], ['运行模式', payload.runtime], ['提交时间', payload.createdAt],
    ['服务商', payload.provider.name], ['接口协议', payload.provider.endpoint.protocol], ['接口域名', payload.provider.endpoint.host], ['接口路径', payload.provider.endpoint.path], ['模型', payload.provider.model],
    ['已填写访问密钥', payload.provider.hasApiKey ? '是（不包含密钥内容）' : '否'], ['当前启用', payload.provider.active ? '是' : '否'], ['默认服务商', payload.provider.isDefault ? '是' : '否'],
    ['可用性状态', payload.provider.status], ['失败阶段', payload.provider.stage], ['HTTP', payload.provider.httpStatus], ['服务商代码', payload.provider.providerCode], ['响应形态', payload.provider.responseShape],
    ['目录状态', payload.catalog?.status], ['目录 HTTP', payload.catalog?.httpStatus], ['目录代码', payload.catalog?.providerCode], ['重试秒数', payload.catalog?.retryAfterSeconds], ['目录模型数', payload.catalog?.modelCount], ['已选模型在目录中', payload.catalog?.selectedModelListed === undefined ? undefined : payload.catalog.selectedModelListed ? '是' : '否'], ['已验证 Responses 模型数', payload.catalog?.responseCompatibleModels],
    ['连接环境', payload.environment.status], ['已完成首次准备', payload.environment.onboardingCompleted ? '是' : '否'], ['已选择配置层', payload.environment.selectedLayerConfigured ? '是' : '否'],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '')
  const checks = payload.checks.length ? payload.checks.map((check) => `- ${check.ok ? '通过' : '失败'}：${check.id} (${check.severity})`).join('\n') : '- 无'
  const actions = payload.recentActions.length ? payload.recentActions.map((item) => `- ${item.title} (${item.tone})`).join('\n') : '- 无'
  return `${rows.map(([label, value]) => `- **${label}**：${value}`).join('\n')}\n\n## 检查结果\n${checks}\n\n## 最近操作\n${actions}\n\n---\n此 Issue 由 Signalman 的脱敏兼容性反馈生成；未包含访问密钥、配置正文、文件路径、响应正文、Cookie、日志或截图。`
}
