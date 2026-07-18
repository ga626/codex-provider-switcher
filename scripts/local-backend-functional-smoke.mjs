import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const backendPort = Number(process.env.BACKEND_FUNCTIONAL_SMOKE_PORT ?? 47842)
const providerPort = Number(process.env.PROVIDER_FIXTURE_PORT ?? 47843)
const backendUrl = `http://127.0.0.1:${backendPort}`
const providerUrl = `http://127.0.0.1:${providerPort}/v1`
const exePath = join(
  process.cwd(),
  'src-tauri',
  'target',
  'debug',
  process.platform === 'win32' ? 'local_backend.exe' : 'local_backend'
)
const fixtureRoot = await mkdtemp(join(tmpdir(), 'codex-switcher-functional-'))
const userHome = join(fixtureRoot, 'user')
const localAppData = join(fixtureRoot, 'local-app-data')
const codexDir = join(userHome, '.codex')
const configPath = join(codexDir, 'config.toml')
const authPath = join(codexDir, 'auth.json')
let modelsProbeRequestCount = 0
let responsesProbeRequestCount = 0

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitForBackend() {
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < 15000) {
    try {
      const response = await fetch(`${backendUrl}/api/health`)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`local backend did not become ready: ${lastError}`)
}

async function api(path, body) {
  const response = await fetch(`${backendUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error ?? `${path} failed: ${response.status}`)
  return payload
}

async function expectApiFailure(path, body) {
  try {
    await api(path, body)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(`${path} unexpectedly succeeded`)
}

await mkdir(codexDir, { recursive: true })
await mkdir(localAppData, { recursive: true })

const originalConfig = [
  'model = "baseline-model"',
  'model_provider = "custom"',
  'disable_response_storage = true',
  '',
  '[model_providers.custom]',
  'name = "Baseline"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'base_url = "https://baseline.example/v1"',
  'api_key = "baseline-key"',
  '',
  '[features]',
  'fixture_marker = true',
].join('\r\n')
const originalAuth = JSON.stringify({ OPENAI_API_KEY: 'baseline-key', preserved: 'yes' }, null, 2)
await writeFile(configPath, originalConfig, 'utf8')
await writeFile(authPath, originalAuth, 'utf8')

const providerServer = createServer((request, response) => {
  if (request.url === '/releases') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify([
      {
        tag_name: 'v0.5.1-alpha',
        html_url: 'https://github.com/ga626/codex-provider-switcher/releases/tag/v0.5.1-alpha',
        draft: false,
        published_at: '2026-07-16T00:00:00Z',
        assets: [
          {
            name: 'CodeXProviderSwitcher-windows-x64-0.5.1-alpha-setup.exe',
            browser_download_url: 'https://github.com/ga626/codex-provider-switcher/releases/download/v0.5.1-alpha/CodeXProviderSwitcher-windows-x64-0.5.1-alpha-setup.exe',
          },
        ],
      },
    ]))
    return
  }
  if (request.url === '/v1/models') {
    modelsProbeRequestCount += 1
    const authorization = request.headers.authorization
    if (authorization === 'Bearer sk-fixture') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        data: [
          { id: 'reasoning-current', object: 'model' },
          { id: 'reasoning-current', object: 'model' },
          { id: 'fast-current', object: 'model' },
        ],
      }))
      return
    }
    if (authorization === 'Bearer sk-no-credit') {
      response.writeHead(402, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'insufficient balance' } }))
      return
    }
    if (authorization === 'Bearer sk-endpoint-mismatch') {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'not_found', message: 'model route unavailable' } }))
      return
    }
    if (authorization === 'Bearer sk-protocol-mismatch') {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end('not-json')
      return
    }
    if (authorization === 'Bearer sk-service-error') {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'service_unavailable', message: 'upstream unavailable' } }))
      return
    }
    response.writeHead(401, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'unauthorized' } }))
    return
  }
  if (request.url === '/v1/responses') {
    responsesProbeRequestCount += 1
    request.resume()
    request.on('end', () => {
      const authorization = request.headers.authorization
      if (authorization === 'Bearer sk-fixture') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ id: 'resp_fixture', object: 'response' }))
        return
      }
      if (authorization === 'Bearer sk-no-credit') {
        response.writeHead(402, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'insufficient balance' } }))
        return
      }
      if (authorization === 'Bearer sk-endpoint-mismatch') {
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'not_found', message: 'responses route unavailable' } }))
        return
      }
      if (authorization === 'Bearer sk-protocol-mismatch') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ object: 'response' }))
        return
      }
      if (authorization === 'Bearer sk-service-error') {
        response.writeHead(503, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'service_unavailable', message: 'upstream unavailable' } }))
        return
      }
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'unauthorized' } }))
    })
    return
  }
  response.writeHead(401, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ error: 'unauthorized' }))
})
await new Promise((resolve, reject) => {
  providerServer.once('error', reject)
  providerServer.listen(providerPort, '127.0.0.1', resolve)
})

const backend = spawn(exePath, ['--port', String(backendPort)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    LOCALAPPDATA: localAppData,
    CODEX_PROVIDER_SWITCHER_CODEX_HOME: codexDir,
    CODEX_PROVIDER_SWITCHER_APP_DATA_DIR: join(localAppData, 'CodeX Provider Switcher'),
    CODEX_PROVIDER_SWITCHER_RELEASES_API: `http://127.0.0.1:${providerPort}/releases`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

try {
  await waitForBackend()
  const initial = await api('/api/state')
  const initialActivityCount = initial.activity.length

  const update = await api('/api/update/check')
  assert(update.available, 'update check did not detect a newer semantic version')
  assert(update.latestVersion === '0.5.1-alpha', 'update check returned the wrong latest version')
  assert(update.downloadUrl?.endsWith('-setup.exe'), 'update check did not select the Windows setup asset')

  const profile = {
    id: 'fixture-provider',
    name: 'Fixture Provider',
    baseUrl: providerUrl,
    model: 'reasoning-current',
    note: 'isolated functional smoke',
    apiKey: 'sk-fixture',
  }
  const saved = await api('/api/profiles/save', { profile })
  assert(saved.profiles.some((item) => item.id === profile.id), 'save did not persist the provider')
  assert(saved.activity[0]?.title.includes('已保存'), 'save did not update activity')

  const refreshed = await api('/api/models/refresh', { profileId: profile.id })
  const catalog = refreshed.modelCatalogs.find((item) => item.providerId === profile.id)
  assert(catalog?.status === 'ok', 'model refresh did not report ok')
  assert(catalog.models.length === 2, 'model refresh did not deduplicate provider results')
  assert(refreshed.activity[0]?.title === '模型目录已刷新', 'model refresh did not update activity')

  const verified = await api('/api/profiles/verify', { profileId: profile.id })
  const verifiedProfile = verified.profiles.find((item) => item.id === profile.id)
  assert(verifiedProfile?.verified, 'real authenticated server probe did not pass')
  assert(verifiedProfile?.verificationStatus === 'verified', 'verification did not record the verified status')
  assert(verifiedProfile?.lastVerificationStage === 'authenticated_response_probe', 'verification did not record the verification stage')
  assert(verifiedProfile?.lastVerificationHttpStatus === 200, 'verification did not record the HTTP status')
  assert(
    verified.modelCatalogs
      .find((item) => item.providerId === profile.id)
      ?.models.find((item) => item.id === profile.model)
      ?.verifiedForResponses === 'verified',
    'successful Responses verification did not mark the catalog model as verified'
  )
  assert(verified.activity[0]?.title === '兼容性探测通过', 'compatibility probe did not update activity')
  assert(await readFile(configPath, 'utf8') === originalConfig, 'verification changed config.toml')
  assert(await readFile(authPath, 'utf8') === originalAuth, 'verification changed auth.json')

  const refreshedAfterVerification = await api('/api/models/refresh', { profileId: profile.id })
  assert(
    refreshedAfterVerification.modelCatalogs
      .find((item) => item.providerId === profile.id)
      ?.models.find((item) => item.id === profile.model)
      ?.verifiedForResponses === 'verified',
    'refresh discarded the verified status for an unchanged catalog model'
  )

  const modelless = { ...profile, id: 'model-less', name: 'Model-less Probe', model: '' }
  await api('/api/profiles/save', { profile: modelless })
  const modelLessVerification = await api('/api/profiles/verify', { profileId: modelless.id })
  const modelLessProfile = modelLessVerification.profiles.find((item) => item.id === modelless.id)
  assert(!modelLessProfile?.verified, 'real Responses probe incorrectly accepted a missing model')
  assert(modelLessProfile?.verificationStatus === 'invalid_profile', 'model-less probe did not report an incomplete profile')

  const defaulted = await api('/api/profiles/default', { profileId: profile.id })
  assert(defaulted.profiles.find((item) => item.id === profile.id)?.isDefault, 'default provider was not updated')

  const responsesBeforeSwitch = responsesProbeRequestCount
  const switched = await api('/api/profiles/switch', { profileId: profile.id })
  const switchedConfig = await readFile(configPath, 'utf8')
  const switchedAuth = JSON.parse(await readFile(authPath, 'utf8'))
  assert(switched.currentProfileId === profile.id, 'switch did not update current provider')
  assert(switchedConfig.includes('model = "reasoning-current"'), 'switch did not update model')
  assert(switchedConfig.includes(`base_url = "${providerUrl}"`), 'switch did not update provider URL')
  assert(switchedConfig.includes('wire_api = "responses"'), 'switch did not preserve Responses API')
  assert(switchedConfig.includes('fixture_marker = true'), 'switch removed an unrelated config section')
  assert(switchedAuth.OPENAI_API_KEY === 'sk-fixture', 'switch did not update auth key')
  assert(switchedAuth.preserved === 'yes', 'switch removed unrelated auth data')
  assert(switched.backups.length === 1, 'switch did not create exactly one backup')
  assert(switched.backups[0].files >= 3, 'switch backup did not include a manifest')
  const backupLabels = await readdir(join(localAppData, 'CodeX Provider Switcher', 'backups'))
  const manifest = JSON.parse(await readFile(join(localAppData, 'CodeX Provider Switcher', 'backups', backupLabels[0], 'manifest.json'), 'utf8'))
  assert(manifest.reason === 'before_switch', 'backup manifest did not record its reason')
  assert(Array.isArray(manifest.files) && manifest.files.includes('config.toml') && manifest.files.includes('auth.json'), 'backup manifest did not list protected files')
  assert(switched.activity[0]?.title === '已切换到 Fixture Provider', 'switch did not update activity')
  assert(modelsProbeRequestCount >= 1, 'model refresh did not issue an authenticated /models request')
  assert(responsesProbeRequestCount === responsesBeforeSwitch, 'switch unexpectedly sent a remote compatibility probe')

  await writeFile(configPath, 'model = "corrupted"', 'utf8')
  await writeFile(authPath, JSON.stringify({ OPENAI_API_KEY: 'corrupted' }), 'utf8')
  const restored = await api('/api/backup/restore-latest', {})
  assert(await readFile(configPath, 'utf8') === originalConfig, 'restore did not restore config.toml')
  assert(await readFile(authPath, 'utf8') === originalAuth, 'restore did not restore auth.json')
  assert(restored.activity[0]?.title === '已恢复最近备份', 'restore did not update activity')
  assert(restored.activity.length >= initialActivityCount + 6, 'timeline did not retain action history')

  const noCredit = {
    ...profile,
    id: 'no-credit',
    name: 'DasuAPI',
    model: 'reasoning-current',
    apiKey: 'sk-no-credit',
  }
  await api('/api/profiles/save', { profile: noCredit })
  const failedVerification = await api('/api/profiles/verify', { profileId: noCredit.id })
  const failedProfile = failedVerification.profiles.find((item) => item.id === noCredit.id)
  assert(!failedProfile?.verified, 'insufficient-credit provider was incorrectly verified')
  assert(failedProfile?.verificationStatus === 'billing_unavailable', 'insufficient-credit status was not classified')
  assert(failedProfile?.lastVerificationStage === 'billing', 'insufficient-credit provider did not record the diagnostic stage')
  assert(failedProfile?.lastVerificationProviderCode === 'insufficient_quota', 'insufficient-credit provider did not record the provider code')
  assert(responsesProbeRequestCount >= 1, 'DasuAPI quota verification did not issue the real request probe')
  const responsesBeforeInconclusiveSwitch = responsesProbeRequestCount
  const switchedAfterInconclusiveProbe = await api('/api/profiles/switch', { profileId: noCredit.id })
  assert(switchedAfterInconclusiveProbe.currentProfileId === noCredit.id, 'an inconclusive probe blocked a safe local switch')
  assert(responsesProbeRequestCount === responsesBeforeInconclusiveSwitch, 'switch retried a remote compatibility probe')
  const restoredAfterInconclusiveSwitch = await api('/api/backup/restore-latest', {})
  assert(await readFile(configPath, 'utf8') === originalConfig, 'restore did not recover the config after an inconclusive probe switch')
  assert(restoredAfterInconclusiveSwitch.activity[0]?.title === '已恢复最近备份', 'restore after inconclusive switch was not recorded')

  const endpointMismatch = { ...profile, id: 'endpoint-mismatch', name: 'Endpoint mismatch', apiKey: 'sk-endpoint-mismatch' }
  await api('/api/profiles/save', { profile: endpointMismatch })
  const endpointVerification = await api('/api/profiles/verify', { profileId: endpointMismatch.id })
  const endpointProfile = endpointVerification.profiles.find((item) => item.id === endpointMismatch.id)
  assert(endpointProfile?.verificationStatus === 'endpoint_or_model_unavailable', '404 was not classified as endpoint or model unavailable')
  assert(endpointProfile?.lastVerificationHttpStatus === 404, '404 diagnostic did not retain the HTTP status')

  const protocolMismatch = { ...profile, id: 'protocol-mismatch', name: 'Protocol mismatch', apiKey: 'sk-protocol-mismatch' }
  await api('/api/profiles/save', { profile: protocolMismatch })
  const protocolVerification = await api('/api/profiles/verify', { profileId: protocolMismatch.id })
  const protocolProfile = protocolVerification.profiles.find((item) => item.id === protocolMismatch.id)
  assert(protocolProfile?.verificationStatus === 'protocol_incompatible', 'invalid successful response was not classified as protocol incompatible')

  const serviceError = { ...profile, id: 'service-error', name: 'Service error', apiKey: 'sk-service-error' }
  await api('/api/profiles/save', { profile: serviceError })
  const serviceVerification = await api('/api/profiles/verify', { profileId: serviceError.id })
  const serviceProfile = serviceVerification.profiles.find((item) => item.id === serviceError.id)
  assert(serviceProfile?.verificationStatus === 'service_error', '5xx response was not classified as service error')
  assert(await readFile(configPath, 'utf8') === originalConfig, 'failed verifications changed config.toml')
  assert(await readFile(authPath, 'utf8') === originalAuth, 'failed verifications changed auth.json')

  const disposable = { ...profile, id: 'delete-me', name: 'Delete Me' }
  await api('/api/profiles/save', { profile: disposable })
  const deleted = await api('/api/profiles/delete', { profileId: disposable.id })
  assert(!deleted.profiles.some((item) => item.id === disposable.id), 'delete did not remove the provider')
  await expectApiFailure('/api/profiles/default', { profileId: 'missing-provider' })
  await expectApiFailure('/api/profiles/delete', { profileId: 'missing-provider' })

  console.log(JSON.stringify({
    ok: true,
    isolationRoot: fixtureRoot,
    assertions: [
      'save persisted provider and activity',
      'update check compared semantic versions and selected the Windows installer',
      'model refresh called /v1/models and deduplicated results',
      'explicit authenticated /v1/responses probes record compatibility for the selected model',
      'inconclusive quota probes do not block local safe switching or trigger a second remote probe',
      'verification diagnostics classify endpoint, protocol, billing, and service errors without changing Codex config/auth',
      'default selection persisted',
      'switch wrote config/auth, preserved unrelated data, and created a manifest-backed backup',
      'same-address profiles retain the selected current-provider identity after a safe switch',
      'restore recovered both files and updated timeline',
      'delete removed a non-current non-default provider',
    ],
  }, null, 2))
} finally {
  backend.kill()
  await new Promise((resolve) => providerServer.close(resolve))
  await rm(fixtureRoot, { recursive: true, force: true })
}
