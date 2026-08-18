const MAX_TEXT = 160
const MAX_CODE = 80

function optionalText(value, max = MAX_TEXT) {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

function optionalStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}

function rejectSecretLike(value) {
  return /(?:api[_-]?key|authorization|bearer\s+|password|cookie|auth\.json|config\.toml|[A-Za-z]:\\|\/Users\/|\/home\/)/i.test(value)
}

export function validateFeedbackPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: '请求内容必须是对象。' }
  if (input.schema !== 'signalman-compatibility-feedback/v1') return { ok: false, error: '不支持的反馈格式。' }
  const diagnosticId = optionalText(input.diagnosticId, MAX_CODE)
  const build = optionalText(input.build, MAX_CODE)
  const runtime = optionalText(input.runtime, MAX_CODE)
  const createdAt = optionalText(input.createdAt, 40)
  if (!diagnosticId || !build || !runtime || !createdAt) return { ok: false, error: '缺少反馈标识或运行信息。' }
  if (!input.provider || typeof input.provider !== 'object') return { ok: false, error: '缺少服务商诊断信息。' }
  const provider = {
    name: optionalText(input.provider.name),
    baseUrlHost: optionalText(input.provider.baseUrlHost),
    model: optionalText(input.provider.model),
    status: optionalText(input.provider.status, MAX_CODE),
    stage: optionalText(input.provider.stage, MAX_CODE),
    httpStatus: optionalStatus(input.provider.httpStatus),
    providerCode: optionalText(input.provider.providerCode, MAX_CODE),
  }
  if (!provider.name || !provider.baseUrlHost || !provider.model || !provider.status) return { ok: false, error: '服务商诊断信息不完整。' }
  const everyText = [diagnosticId, build, runtime, createdAt, ...Object.values(provider).filter((value) => typeof value === 'string')]
  if (everyText.some(rejectSecretLike)) return { ok: false, error: '反馈内容包含不允许的敏感信息。' }
  const catalog = input.catalog && typeof input.catalog === 'object' ? {
    status: optionalText(input.catalog.status, MAX_CODE),
    httpStatus: optionalStatus(input.catalog.httpStatus),
    providerCode: optionalText(input.catalog.providerCode, MAX_CODE),
    requestId: optionalText(input.catalog.requestId, MAX_CODE),
    retryAfterSeconds: Number.isInteger(input.catalog.retryAfterSeconds) && input.catalog.retryAfterSeconds >= 0 && input.catalog.retryAfterSeconds <= 86400 ? input.catalog.retryAfterSeconds : undefined,
  } : undefined
  const checks = Array.isArray(input.checks) ? input.checks.slice(0, 30).flatMap((check) => {
    if (!check || typeof check !== 'object') return []
    const id = optionalText(check.id, MAX_CODE)
    const severity = optionalText(check.severity, 16)
    return id && ['required', 'warning', 'info'].includes(severity) ? [{ id, severity }] : []
  }) : []
  return { ok: true, value: { schema: input.schema, diagnosticId, build, runtime, createdAt, provider, catalog, checks } }
}

export function renderIssueBody(payload) {
  const rows = [
    ['诊断编号', payload.diagnosticId], ['构建', payload.build], ['运行模式', payload.runtime], ['提交时间', payload.createdAt],
    ['服务商', payload.provider.name], ['接口域名', payload.provider.baseUrlHost], ['模型', payload.provider.model],
    ['可用性状态', payload.provider.status], ['阶段', payload.provider.stage], ['HTTP', payload.provider.httpStatus], ['服务商代码', payload.provider.providerCode],
    ['目录状态', payload.catalog?.status], ['目录 HTTP', payload.catalog?.httpStatus], ['目录代码', payload.catalog?.providerCode], ['请求编号', payload.catalog?.requestId], ['重试秒数', payload.catalog?.retryAfterSeconds],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '')
  const checks = payload.checks.length ? payload.checks.map((check) => `- ${check.id} (${check.severity})`).join('\n') : '- 无'
  return `${rows.map(([label, value]) => `- **${label}**：${value}`).join('\n')}\n\n## 失败检查\n${checks}\n\n---\n此 Issue 由 Signalman 的脱敏兼容性反馈生成；未包含访问密钥、配置正文、文件路径、响应正文、Cookie、日志或截图。`
}
