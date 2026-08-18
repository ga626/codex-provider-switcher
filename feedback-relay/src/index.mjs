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

function base64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(value)
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function pemToBytes(pem) {
  const normalized = pem.replace(/\\n/g, '\n').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')
  const binary = atob(normalized)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function githubAppJwt(env) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new Error('GitHub App 尚未配置。')
  const now = Math.floor(Date.now() / 1000)
  const encodedHeader = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const encodedPayload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }))
  const key = await crypto.subtle.importKey('pkcs8', pemToBytes(env.GITHUB_APP_PRIVATE_KEY), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`))
  return `${encodedHeader}.${encodedPayload}.${base64Url(new Uint8Array(signature))}`
}

async function installationToken(env) {
  if (!env.GITHUB_INSTALLATION_ID) throw new Error('GitHub App installation 尚未配置。')
  const jwt = await githubAppJwt(env)
  const result = await fetch(`https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`, {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'signalman-feedback-relay' },
  })
  if (!result.ok) throw new Error(`GitHub App 认证失败：${result.status}`)
  const body = await result.json()
  if (!body.token || typeof body.token !== 'string') throw new Error('GitHub App 未返回 installation token。')
  return body.token
}

async function verifyTurnstile(payload, request, env) {
  if (!env.TURNSTILE_SECRET) return true
  const token = request.headers.get('X-Turnstile-Token')
  if (!token) return false
  const form = new FormData()
  form.set('secret', env.TURNSTILE_SECRET)
  form.set('response', token)
  const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
  if (!result.ok) return false
  const body = await result.json()
  return body.success === true
}

async function createPrivateIssue(payload, env) {
  if (!env.GITHUB_FEEDBACK_REPOSITORY) throw new Error('反馈收件箱尚未配置。')
  const token = await installationToken(env)
  const result = await fetch(`https://api.github.com/repos/${env.GITHUB_FEEDBACK_REPOSITORY}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'signalman-feedback-relay' },
    body: JSON.stringify({ title: `[compat] ${payload.provider.status} · ${payload.provider.name} · ${payload.diagnosticId}`, body: renderIssueBody(payload), labels: ['compatibility-feedback'] }),
  })
  if (!result.ok) throw new Error(`反馈收件箱暂时不可用：${result.status}`)
}

export async function handleFeedbackRequest(request, env) {
  const origin = allowedOrigin(request, env)
  if (request.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type, X-Turnstile-Token', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' } : {} })
  if (!origin) return response({ error: '来源不被允许。' }, 403)
  if (request.method !== 'POST') return response({ error: '只支持 POST。' }, 405, origin)
  const length = Number(request.headers.get('Content-Length') ?? 0)
  if (length > MAX_BODY_BYTES) return response({ error: '反馈内容过大。' }, 413, origin)
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return response({ error: '反馈内容过大。' }, 413, origin)
  let input
  try { input = JSON.parse(raw) } catch { return response({ error: '反馈格式无效。' }, 400, origin) }
  const validated = validateFeedbackPayload(input)
  if (!validated.ok) return response({ error: validated.error }, 400, origin)
  if (!await verifyTurnstile(validated.value, request, env)) return response({ error: '人机验证未通过。' }, 403, origin)
  try {
    await createPrivateIssue(validated.value, env)
    return response({ receiptId: validated.value.diagnosticId, receivedAt: new Date().toISOString() }, 202, origin)
  } catch {
    // Never log the diagnostic payload: the deployer can inspect only aggregate Worker metrics.
    return response({ error: '维护者收件箱暂时不可用。' }, 503, origin)
  }
}

export default { fetch: (request, env) => handleFeedbackRequest(request, env) }
