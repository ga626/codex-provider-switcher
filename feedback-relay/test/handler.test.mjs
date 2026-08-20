import assert from 'node:assert/strict'
import test from 'node:test'
import { handleFeedbackRequest } from '../src/index.mjs'

const payload = {
  schema: 'signalman-compatibility-feedback/v2', diagnosticId: 'diag-handler', build: 'abcdef0', runtime: 'tauri_native', createdAt: '2026-08-19T12:00:00.000Z',
  provider: { name: 'Example Provider', endpoint: { protocol: 'https', host: 'api.example.com', path: '/v1' }, model: 'gpt-5.6-terra', hasApiKey: true, active: true, isDefault: true, status: 'rate_limited', stage: 'availability', httpStatus: 429, providerCode: 'rate_limit' },
  catalog: { status: 'rate_limited', httpStatus: 429, providerCode: 'rate_limit', retryAfterSeconds: 30, modelCount: 0, selectedModelListed: false, responseCompatibleModels: 0 },
  environment: { status: 'ready', onboardingCompleted: true, selectedLayerConfigured: true },
  checks: [{ id: 'availability', ok: false, severity: 'warning' }],
  recentActions: [{ title: '运行服务商可用性测试', tone: 'danger' }],
}

test('writes a private-inbox issue and returns its receipt', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify({ number: 123 }), { status: 201, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const request = new Request('https://relay.example.test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    const response = await handleFeedbackRequest(request, { GITHUB_TOKEN: 'test-token', GITHUB_FEEDBACK_REPOSITORY: 'owner/private-feedback-inbox' })
    assert.equal(response.status, 202)
    assert.equal((await response.json()).receiptId, 'SM-123')
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /owner\/private-feedback-inbox\/issues$/)
    assert.match(calls[0].options.body, /接口路径/)
    assert.doesNotMatch(calls[0].options.body, /test-token/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('refuses a browser request from an unconfigured origin', async () => {
  const request = new Request('https://relay.example.test', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  const response = await handleFeedbackRequest(request, { ALLOWED_ORIGINS: 'https://trusted.example' })
  assert.equal(response.status, 403)
})
