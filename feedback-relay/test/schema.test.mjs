import assert from 'node:assert/strict'
import test from 'node:test'
import { renderIssueBody, validateFeedbackPayload } from '../src/schema.mjs'

const valid = {
  schema: 'signalman-compatibility-feedback/v1', diagnosticId: 'diag-123', build: 'abcdef0', runtime: 'tauri_native', createdAt: '2026-08-18T12:00:00.000Z',
  provider: { name: 'Example Provider', baseUrlHost: 'api.example.com', model: 'gpt-5.6-terra', status: 'timeout', stage: 'inference', httpStatus: 504, providerCode: 'gateway_timeout' },
  catalog: { status: 'stale', httpStatus: 429, providerCode: 'rate_limit', requestId: 'req-1', retryAfterSeconds: 30 },
  checks: [{ id: 'availability', severity: 'warning' }],
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
  localPath.provider.baseUrlHost = 'C:\\Users\\name'
  assert.equal(validateFeedbackPayload(localPath).ok, false)
})
