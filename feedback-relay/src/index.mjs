import { renderIssueBody, validateFeedbackPayload } from './schema.mjs'

const MAX_BODY_BYTES = 12 * 1024

function response(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    },
  })
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin')
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  return origin && allowed.includes(origin) ? origin : null
}

async function requestFingerprint(request) {
  const source = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return Array.from(new Uint8Array(digest)).slice(0, 12).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function consumeRateLimit(request, env) {
  if (!env.RATE_LIMIT) return true
  const key = `feedback:${await requestFingerprint(request)}:${Math.floor(Date.now() / 300000)}`
  if (await env.RATE_LIMIT.get(key)) return false
  await env.RATE_LIMIT.put(key, '1', { expirationTtl: 360 })
  return true
}

async function createPrivateIssue(payload, env) {
  if (!env.GITHUB_FEEDBACK_REPOSITORY || !env.GITHUB_TOKEN) throw new Error('反馈收件箱尚未配置。')
  const result = await fetch(`https://api.github.com/repos/${env.GITHUB_FEEDBACK_REPOSITORY}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'signalman-feedback-relay' },
    body: JSON.stringify({ title: `[compat] ${payload.provider.status} · ${payload.provider.name} · ${payload.diagnosticId}`, body: renderIssueBody(payload), labels: ['compatibility-feedback'] }),
  })
  if (!result.ok) throw new Error(`反馈收件箱暂时不可用：${result.status}`)
  const body = await result.json()
  return body.number
}

export async function handleFeedbackRequest(request, env) {
  const origin = allowedOrigin(request, env)
  if (request.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' } : {} })
  if (request.headers.get('Origin') && !origin) return response({ error: '来源不被允许。' }, 403)
  if (request.method !== 'POST') return response({ error: '只支持 POST。' }, 405, origin)
  const length = Number(request.headers.get('Content-Length') ?? 0)
  if (length > MAX_BODY_BYTES) return response({ error: '反馈内容过大。' }, 413, origin)
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return response({ error: '反馈内容过大。' }, 413, origin)
  let input
  try { input = JSON.parse(raw) } catch { return response({ error: '反馈格式无效。' }, 400, origin) }
  const validated = validateFeedbackPayload(input)
  if (!validated.ok) return response({ error: validated.error }, 400, origin)
  if (!await consumeRateLimit(request, env)) return response({ error: '提交过于频繁，请稍后再试。' }, 429, origin)
  try {
    const issueNumber = await createPrivateIssue(validated.value, env)
    return response({ receiptId: `SM-${issueNumber ?? validated.value.diagnosticId}`, receivedAt: new Date().toISOString() }, 202, origin)
  } catch {
    // Never log the diagnostic payload: the deployer can inspect only aggregate Worker metrics.
    return response({ error: '维护者收件箱暂时不可用。' }, 503, origin)
  }
}

export default { fetch: (request, env) => handleFeedbackRequest(request, env) }
