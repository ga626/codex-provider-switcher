import assert from 'node:assert/strict'
import test from 'node:test'
import { renderIssueBody, validateFeedbackPayload } from '../src/schema.mjs'

const valid = {
  schema: 'signalman-compatibility-feedback/v2', diagnosticId: 'diag-123', build: 'abcdef0', runtime: 'tauri_native', createdAt: '2026-08-18T12:00:00.000Z',
  provider: { name: 'Example Provider', endpoint: { protocol: 'https', host: 'api.example.com', path: '/v1' }, model: 'gpt-5.6-terra', hasApiKey: true, active: false, isDefault: false, status: 'timeout', stage: 'inference', httpStatus: 504, providerCode: 'gateway_timeout', responseShape: 'compatible_response' },
  catalog: { status: 'stale', httpStatus: 429, providerCode: 'rate_limit', retryAfterSeconds: 30, modelCount: 14, selectedModelListed: true, responseCompatibleModels: 4 },
  environment: { status: 'ready', onboardingCompleted: true, selectedLayerConfigured: true },
  checks: [{ id: 'availability', ok: false, severity: 'warning' }],
  recentActions: [{ title: '运行服务商可用性测试', tone: 'danger' }],
}

test('accepts the whitelisted compatibility payload', () => {
  const result = validateFeedbackPayload(valid)
  assert.equal(result.ok, true)
  assert.match(renderIssueBody(result.value), /api\.example\.com/)
})

test('rejects secret and local-path looking content', () => {
  const leaked = structuredClone(valid)
  leaked.provider.providerCode = 'Authorization: Bearer secret'
  assert.equal(validateFeedbackPayload(leaked).ok, false)
  const localPath = structuredClone(valid)
  localPath.provider.endpoint.host = 'C:\\Users\\name'
  assert.equal(validateFeedbackPayload(localPath).ok, false)
})

test('strips unknown fields and renders the reproduction context', () => {
  const input = structuredClone(valid)
  input.unexpected = 'not persisted'
  const result = validateFeedbackPayload(input)
  assert.equal(result.ok, true)
  assert.equal('unexpected' in result.value, false)
  assert.match(renderIssueBody(result.value), /接口路径.*\/v1/)
  assert.match(renderIssueBody(result.value), /最近操作/)
})
