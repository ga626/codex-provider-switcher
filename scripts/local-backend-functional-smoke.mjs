import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { connect } from 'node:net'
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
const recoveryExePath = join(
  process.cwd(),
  'src-tauri',
  'target',
  'debug',
  process.platform === 'win32' ? 'profile_recovery.exe' : 'profile_recovery'
)
const packageMetadata = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'))
const versionMatch = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(packageMetadata.version)
if (!versionMatch) throw new Error(`Unsupported package version for update fixture: ${packageMetadata.version}`)
const fixtureLatestVersion = `${versionMatch[1]}.${versionMatch[2]}.${Number(versionMatch[3]) + 1}${versionMatch[4] ?? ''}`
const fixtureRoot = await mkdtemp(join(tmpdir(), 'codex-switcher-functional-'))
const userHome = join(fixtureRoot, 'user')
const localAppData = join(fixtureRoot, 'local-app-data')
const codexDir = join(userHome, '.codex')
const configPath = join(codexDir, 'config.toml')
const authPath = join(codexDir, 'auth.json')
const profilesPath = join(localAppData, 'CodeX Provider Switcher', 'profiles.json')
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

async function prepareSwitch(profileId) {
  return api('/api/profiles/prepare-switch', { profileId })
}

async function confirmSwitch(profileId, operationId) {
  return api('/api/profiles/switch', { profileId, operationId })
}

async function assertMissingFile(path, message) {
  try {
    await readFile(path)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  throw new Error(message)
}

async function requestStatus(path, body) {
  const response = await fetch(`${backendUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return response.status
}

async function oversizedRequestStatus() {
  return new Promise((resolve, reject) => {
    const socket = connect(backendPort, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk) => { response += chunk })
    socket.on('close', () => {
      const match = /^HTTP\/1\.1\s+(\d+)/.exec(response)
      if (!match) reject(new Error(`oversized request did not receive an HTTP response: ${response}`))
      else resolve(Number(match[1]))
    })
    socket.on('connect', () => {
      socket.write('POST /api/profiles/save HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 262145\r\n\r\n')
    })
  })
}

async function runProfileRecovery(source, environment) {
  const child = spawn(recoveryExePath, [source], {
    cwd: process.cwd(),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (code !== 0) {
    throw new Error(`profile recovery failed: ${stderr || stdout}`)
  }
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
  '# This user-owned custom field must survive provider switching.',
  'user_owned_extension = "keep-me"',
  '',
  '[features]',
  'fixture_marker = true',
  '',
  '[projects."D:\\\\Fixture Workspace"]',
  'trust_level = "trusted"',
  '',
  '[mcp_servers.fixture_server]',
  'command = "fixture-mcp.exe"',
  '',
  '[plugins."fixture-plugin@marketplace"]',
  'enabled = true',
  '',
  '[hooks.state]',
  'fixture_hook = "trusted"',
  '',
  '[desktop]',
  'notification_mode = "always"',
  '',
  '[memories]',
  'enabled = true',
  '',
  '[marketplaces.fixture_marketplace]',
  'source = "https://example.invalid/marketplace"',
  '',
  '[windows]',
  'sandbox = "unelevated"',
].join('\r\n')
const protectedConfigFragments = [
  '[features]\r\nfixture_marker = true',
  '[projects."D:\\\\Fixture Workspace"]\r\ntrust_level = "trusted"',
  '[mcp_servers.fixture_server]\r\ncommand = "fixture-mcp.exe"',
  '[plugins."fixture-plugin@marketplace"]\r\nenabled = true',
  '[hooks.state]\r\nfixture_hook = "trusted"',
  '[desktop]\r\nnotification_mode = "always"',
  '[memories]\r\nenabled = true',
  '[marketplaces.fixture_marketplace]\r\nsource = "https://example.invalid/marketplace"',
  '[windows]\r\nsandbox = "unelevated"',
]
const originalAuth = JSON.stringify({ OPENAI_API_KEY: 'baseline-key', preserved: 'yes' }, null, 2)
await writeFile(configPath, originalConfig, 'utf8')
await writeFile(authPath, originalAuth, 'utf8')
const legacyProfilesPath = join(fixtureRoot, 'legacy-profiles.json')
await writeFile(legacyProfilesPath, JSON.stringify({
  profiles: {
    owl: {
      name: 'OWL',
      base_url: 'https://api.owlai.tech/v1',
      api_key: 'legacy-fixture-key',
      model: 'reasoning-current',
      default: true,
    },
  },
}, null, 2), 'utf8')
const runtimeEnv = {
  ...process.env,
  HOME: userHome,
  USERPROFILE: userHome,
  LOCALAPPDATA: localAppData,
  CODEX_PROVIDER_SWITCHER_CODEX_HOME: codexDir,
  CODEX_PROVIDER_SWITCHER_APP_DATA_DIR: join(localAppData, 'CodeX Provider Switcher'),
  CODEX_PROVIDER_SWITCHER_RELEASES_API: `http://127.0.0.1:${providerPort}/releases`,
}

const providerServer = createServer((request, response) => {
  if (request.url === '/releases') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify([
      {
        tag_name: `v${fixtureLatestVersion}`,
        html_url: `https://github.com/ga626/codex-provider-switcher/releases/tag/v${fixtureLatestVersion}`,
        draft: false,
        published_at: '2026-07-16T00:00:00Z',
        assets: [
          {
            name: `SignalmanAI-windows-x64-${fixtureLatestVersion}-setup.exe`,
            browser_download_url: `https://github.com/ga626/codex-provider-switcher/releases/download/v${fixtureLatestVersion}/SignalmanAI-windows-x64-${fixtureLatestVersion}-setup.exe`,
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
      if (authorization === 'Bearer fixture-compatible-response') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: null, object: 'response', output_text: 'OK' }))
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
  env: runtimeEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

try {
  await waitForBackend()
  assert(await requestStatus('/C:/Windows/win.ini') === 400, 'local fallback accepted a drive-qualified static path')
  assert(await oversizedRequestStatus() === 413, 'local fallback did not reject an oversized request body')
  const initial = await api('/api/state')
  const initialActivityCount = initial.activity.length
  assert(initial.profiles.length === 0, 'a new product install must not include a preconfigured provider')
  const initialBackup = initial.backups.find((item) => item.kind === 'initial_install')
  assert(initialBackup, 'first application launch did not create an installation baseline backup')
  assert(initialBackup.files >= 3, 'installation baseline backup did not include manifest and protected files')
  const dailyBackup = initial.backups.find((item) => item.kind === 'daily')
  assert(!dailyBackup, 'first application launch must not duplicate the baseline with a daily backup')

  await runProfileRecovery(legacyProfilesPath, runtimeEnv)
  const recovered = await api('/api/state')
  assert(recovered.profiles.find((item) => item.id === 'owl')?.hasApiKey, 'legacy credential recovery did not expose an available credential')
  const recoveredProfiles = JSON.parse(await readFile(profilesPath, 'utf8'))
  assert(recoveredProfiles.profiles.owl.api_key === '', 'legacy recovery persisted a plaintext API key field')
  assert(
    typeof recoveredProfiles.profiles.owl.api_key_protected === 'string' && recoveredProfiles.profiles.owl.api_key_protected.length > 20,
    'legacy recovery did not protect the imported credential at rest'
  )
  const recoveryBackups = await readdir(join(localAppData, 'CodeX Provider Switcher', 'legacy-profile-imports'))
  assert(recoveryBackups.some((name) => name.endsWith('.json.dpapi')), 'legacy recovery did not create a protected pre-import backup')
  const protectedCredential = recoveredProfiles.profiles.owl.api_key_protected
  await writeFile(legacyProfilesPath, JSON.stringify({
    profiles: {
      owl: {
        name: 'OWL',
        base_url: 'https://api.owlai.tech/v1',
        api_key: 'replacement-fixture-key',
      },
    },
  }, null, 2), 'utf8')
  await runProfileRecovery(legacyProfilesPath, runtimeEnv)
  const repeatedProfiles = JSON.parse(await readFile(profilesPath, 'utf8'))
  assert(repeatedProfiles.profiles.owl.api_key_protected === protectedCredential, 'legacy recovery overwrote an existing protected credential')

  const update = await api('/api/update/check')
  assert(update.available, 'update check did not detect a newer semantic version')
  assert(update.latestVersion === fixtureLatestVersion, 'update check returned the wrong latest version')
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
  const persistedProfiles = await readFile(profilesPath, 'utf8')
  const persistedProfile = JSON.parse(persistedProfiles).profiles[profile.id]
  assert(persistedProfile.api_key === '', 'profile store persisted a non-empty API key field')
  assert(typeof persistedProfile.api_key_protected === 'string' && persistedProfile.api_key_protected.length > 20, 'profile store did not use protected credential storage')

  const refreshed = await api('/api/models/refresh', { profileId: profile.id })
  const catalog = refreshed.modelCatalogs.find((item) => item.providerId === profile.id)
  assert(catalog?.status === 'ok', 'model refresh did not report ok')
  assert(catalog.models.length === 2, 'model refresh did not deduplicate provider results')
  assert(refreshed.activity[0]?.title === '模型目录已刷新', 'model refresh did not update activity')

  const verified = await api('/api/profiles/verify', { profileId: profile.id })
  const verifiedProfile = verified.profiles.find((item) => item.id === profile.id)
  assert(verifiedProfile?.verified, 'real authenticated server probe did not pass')
  assert(verifiedProfile?.verificationStatus === 'verified', 'verification did not record the verified status')
  assert(verifiedProfile?.verificationResponseShape === 'standard_responses', 'verification did not record the standard Responses shape')
  assert(verifiedProfile?.lastVerificationStage === 'inference', 'verification did not record the inference stage')
  assert(verifiedProfile?.lastVerificationHttpStatus === 200, 'verification did not record the HTTP status')
  assert(
    verified.modelCatalogs
      .find((item) => item.providerId === profile.id)
      ?.models.find((item) => item.id === profile.model)
      ?.verifiedForResponses === 'verified',
    'successful Responses verification did not mark the catalog model as verified'
  )
  assert(verified.activity[0]?.title === '服务商可用性测试通过', 'provider availability test did not update activity')
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
  const reorderedIds = [...defaulted.profiles].map((item) => item.id).reverse()
  const reordered = await api('/api/profiles/reorder', { profileIds: reorderedIds })
  assert(JSON.stringify(reordered.profiles.map((item) => item.id)) === JSON.stringify(reorderedIds), 'provider order did not persist')

  const responsesBeforeSwitch = responsesProbeRequestCount
  const driftPreflight = await prepareSwitch(profile.id)
  const externallyChangedConfig = originalConfig.replace('model = "baseline-model"', 'model = "external-drift-model"')
  await writeFile(configPath, externallyChangedConfig, 'utf8')
  const driftMessage = await expectApiFailure('/api/profiles/switch', {
    profileId: profile.id,
    operationId: driftPreflight.operationId,
  })
  assert(driftMessage.includes('发生变化'), 'switch confirmation did not reject configuration drift')
  assert(await readFile(configPath, 'utf8') === externallyChangedConfig, 'rejected switch changed externally edited config.toml')
  await writeFile(configPath, originalConfig, 'utf8')
  const switchPreflight = await prepareSwitch(profile.id)
  assert(switchPreflight.profileId === profile.id && switchPreflight.operationId, 'switch preflight did not return a usable confirmation token')
  assert(switchPreflight.targetModel === profile.model, 'switch preflight did not return the target model')
  const switched = await confirmSwitch(profile.id, switchPreflight.operationId)
  const switchedConfig = await readFile(configPath, 'utf8')
  const switchedAuth = JSON.parse(await readFile(authPath, 'utf8'))
  assert(switched.currentProfileId === profile.id, 'switch did not update current provider')
  assert(switchedConfig.includes('model = "reasoning-current"'), 'switch did not update model')
  assert(switchedConfig.includes(`base_url = "${providerUrl}"`), 'switch did not update provider URL')
  assert(switchedConfig.includes('wire_api = "responses"'), 'switch did not preserve Responses API')
  for (const fragment of protectedConfigFragments) {
    assert(switchedConfig.includes(fragment), `switch removed or changed protected configuration: ${fragment}`)
  }
  assert(switchedConfig.includes('user_owned_extension = "keep-me"'), 'switch removed an unknown custom-provider field')
  assert(switchedAuth.OPENAI_API_KEY === 'sk-fixture', 'switch did not update auth key')
  assert(switchedAuth.preserved === 'yes', 'switch removed unrelated auth data')
  const switchBackup = switched.backups.find((item) => item.kind === 'before_switch')
  assert(switched.backups.length === 3, 'switch did not retain the installation and daily backups while creating one switch backup')
  assert(switchBackup?.files >= 3, 'switch backup did not include a manifest')
  assert(
    switchBackup?.fileCategories?.includes('Codex 设置') && switchBackup?.fileCategories?.includes('本机登录信息'),
    'switch backup did not expose the expected redacted file categories'
  )
  const manifest = JSON.parse(await readFile(join(localAppData, 'CodeX Provider Switcher', 'backups', switchBackup.id, 'manifest.json'), 'utf8'))
  assert(manifest.reason === 'before_switch', 'backup manifest did not record its reason')
  assert(
    Array.isArray(manifest.files) && manifest.files.includes('config.toml.dpapi') && manifest.files.includes('auth.json.dpapi'),
    'backup manifest did not list protected files'
  )
  const backupFiles = await readdir(join(localAppData, 'CodeX Provider Switcher', 'backups', switchBackup.id))
  assert(!backupFiles.includes('config.toml') && !backupFiles.includes('auth.json'), 'backup retained plaintext credential files')

  const manualBackupState = await api('/api/backup/create', {})
  const manualBackup = manualBackupState.backups.find((item) => item.kind === 'manual')
  assert(manualBackup, 'manual backup did not create a recovery point')
  assert(manualBackup.restoreReady, 'manual backup was not marked restorable')
  assert(manualBackupState.activity[0]?.title === '已创建手动恢复点', 'manual backup did not update activity')
  const manualManifest = JSON.parse(await readFile(join(localAppData, 'CodeX Provider Switcher', 'backups', manualBackup.id, 'manifest.json'), 'utf8'))
  assert(manualManifest.reason === 'manual', 'manual backup manifest did not record its reason')

  const driftedConfig = switchedConfig.replace('model = "reasoning-current"', 'model = "reasoning-current-drift"')
  const authBeforeSync = await readFile(authPath, 'utf8')
  await writeFile(configPath, driftedConfig, 'utf8')
  const synced = await api('/api/config/sync-current', {})
  assert(synced.profiles.find((item) => item.id === profile.id)?.model === 'reasoning-current-drift', 'current configuration sync did not update the profile model')
  assert(await readFile(configPath, 'utf8') === driftedConfig, 'current configuration sync wrote config.toml')
  assert(await readFile(authPath, 'utf8') === authBeforeSync, 'current configuration sync wrote auth.json')
  const syncedProfile = synced.profiles.find((item) => item.id === profile.id)
  assert(!syncedProfile?.verified, 'current configuration sync retained a verification result for the previous model')
  assert(syncedProfile?.verificationStatus === 'not_checked', 'current configuration sync did not invalidate the old verification status')
  assert(switched.activity[0]?.title === '已切换到 Fixture Provider', 'switch did not update activity')
  assert(modelsProbeRequestCount >= 1, 'model refresh did not issue an authenticated /models request')
  assert(responsesProbeRequestCount === responsesBeforeSwitch, 'switch unexpectedly sent a remote compatibility probe')

  const restoreWithoutConfirmation = await expectApiFailure('/api/backup/restore', { backupId: manualBackup.id })
  assert(restoreWithoutConfirmation.includes('缺少恢复确认'), 'restore without confirmation was not rejected')
  const restoreWithWrongConfirmation = await expectApiFailure('/api/backup/restore', { backupId: manualBackup.id, confirmation: '取消' })
  assert(restoreWithWrongConfirmation.includes('输入“恢复”'), 'restore with the wrong confirmation was not rejected')
  assert(await readFile(configPath, 'utf8') === driftedConfig, 'rejected restore changed config.toml')

  const userMcpAfterSwitch = `${driftedConfig}\r\n[mcp_servers.after_switch]\r\ncommand = "fixture-after-switch"\r\n`
  await writeFile(configPath, userMcpAfterSwitch, 'utf8')
  await writeFile(authPath, JSON.stringify({ ...switchedAuth, added_after_switch: 'keep-me' }), 'utf8')
  const restoreConflict = await expectApiFailure('/api/backup/restore', { backupId: manualBackup.id, confirmation: '恢复' })
  assert(restoreConflict.includes('已停止自动恢复'), 'restore did not refuse a provider-field conflict')
  assert(await readFile(configPath, 'utf8') === userMcpAfterSwitch, 'conflict refusal changed config.toml')
  await writeFile(configPath, userMcpAfterSwitch.replace('model = "reasoning-current-drift"', 'model = "reasoning-current"'), 'utf8')
  const manualRestored = await api('/api/backup/restore', { backupId: manualBackup.id, confirmation: '恢复' })
  const manualRestoredConfig = await readFile(configPath, 'utf8')
  const manualRestoredAuth = JSON.parse(await readFile(authPath, 'utf8'))
  assert(manualRestoredConfig.includes('[mcp_servers.after_switch]'), 'manual restore removed an MCP server added after the backup')
  assert(manualRestoredConfig.includes('model = "reasoning-current"'), 'manual restore did not restore the saved provider model')
  assert(manualRestoredAuth.OPENAI_API_KEY === 'sk-fixture', 'manual restore did not restore the saved provider credential')
  assert(manualRestoredAuth.added_after_switch === 'keep-me', 'manual restore removed unrelated auth data')
  assert(manualRestored.activity[0]?.title === '已恢复配置备份', 'manual restore did not update activity')

  const restored = await api('/api/backup/restore', { backupId: switchBackup.id, confirmation: '恢复' })
  const restoredConfig = await readFile(configPath, 'utf8')
  const restoredAuth = JSON.parse(await readFile(authPath, 'utf8'))
  assert(restoredConfig.includes('[mcp_servers.after_switch]'), 'safe restore removed an MCP server added after the switch')
  assert(restoredConfig.includes('model = "baseline-model"'), 'safe restore did not restore the previous provider model')
  assert(restoredAuth.OPENAI_API_KEY === JSON.parse(originalAuth).OPENAI_API_KEY, 'safe restore did not restore the previous provider credential')
  assert(restoredAuth.added_after_switch === 'keep-me', 'safe restore removed unrelated auth data')
  assert(restored.activity[0]?.title === '已恢复配置备份', 'restore did not update activity')
  assert(restored.activity.length >= initialActivityCount + 8, 'timeline did not retain action history')

  const pendingTransactionPath = join(localAppData, 'CodeX Provider Switcher', 'pending-config-transaction.json')
  await writeFile(configPath, switchedConfig.replace('model = "reasoning-current"', 'model = "interrupted-write"'), 'utf8')
  await writeFile(authPath, JSON.stringify({ OPENAI_API_KEY: 'interrupted-write' }), 'utf8')
  await writeFile(pendingTransactionPath, JSON.stringify({ backup_id: initialBackup.id, reason: 'test-interruption' }), 'utf8')
  await api('/api/state')
  assert(await readFile(configPath, 'utf8') === originalConfig, 'startup did not recover an interrupted config write')
  assert(JSON.parse(await readFile(authPath, 'utf8')).OPENAI_API_KEY === JSON.parse(originalAuth).OPENAI_API_KEY, 'startup did not recover the interrupted provider credential')
  await assertMissingFile(pendingTransactionPath, 'startup recovery did not remove the completed transaction marker')

  await api('/api/profiles/save', { profile })
  await api('/api/profiles/verify', { profileId: profile.id })
  await writeFile(authPath, '{not valid json', 'utf8')
  const authWriteFailure = await expectApiFailure('/api/profiles/prepare-switch', { profileId: profile.id })
  assert(authWriteFailure.includes('JSON'), 'invalid auth.json did not fail the auth write path')
  assert(await readFile(configPath, 'utf8') === originalConfig, 'auth write failure left config.toml half-switched')
  assert(await readFile(authPath, 'utf8') === '{not valid json', 'auth write failure changed auth.json unexpectedly')
  await writeFile(authPath, originalAuth, 'utf8')

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
  const responsesBeforeBlockedSwitch = responsesProbeRequestCount
  const blockedSwitchMessage = await expectApiFailure('/api/profiles/prepare-switch', { profileId: noCredit.id })
  assert(blockedSwitchMessage.includes('服务商可用性测试'), 'billing failure did not explain the switch gate')
  assert(responsesProbeRequestCount === responsesBeforeBlockedSwitch, 'switch retried a remote compatibility probe')
  assert(await readFile(configPath, 'utf8') === originalConfig, 'blocked DasuAPI switch changed config.toml')
  assert(await readFile(authPath, 'utf8') === originalAuth, 'blocked DasuAPI switch changed auth.json')

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
  assert(!protocolProfile?.verified, 'unconfirmed response shape was incorrectly marked as callable')
  assert(protocolProfile?.verificationStatus === 'response_shape_unconfirmed', 'successful JSON without model output was not classified as response shape unconfirmed')
  assert(protocolProfile?.lastVerificationStage === 'response_shape', 'unconfirmed response shape did not retain its diagnostic stage')

  const compatibleResponse = { ...profile, id: 'compatible-response', name: 'Compatible response', apiKey: 'fixture-compatible-response' }
  await api('/api/profiles/save', { profile: compatibleResponse })
  const compatibleVerification = await api('/api/profiles/verify', { profileId: compatibleResponse.id })
  const compatibleProfile = compatibleVerification.profiles.find((item) => item.id === compatibleResponse.id)
  assert(compatibleProfile?.verified, 'recognized compatible response was not marked callable')
  assert(compatibleProfile?.verificationStatus === 'verified', 'recognized compatible response did not record a successful inference result')
  assert(compatibleProfile?.verificationResponseShape === 'compatible_response', 'compatible response shape was not preserved')

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
      'new product state starts with no provider, while the maintainer-only recovery binary fills only empty profiles, creates a protected pre-import backup, and never overwrites a protected credential',
      'profile keys and backup credential copies are DPAPI-protected at rest',
      'local fallback rejects drive-qualified static paths and oversized request bodies',
      'update check compared semantic versions and selected the Windows installer',
      'model refresh called /v1/models and deduplicated results',
      'authenticated /v1/responses probes distinguish standard, compatible, and unconfirmed response shapes',
      'verified Responses probes are required before switching and insufficient-credit probes block config writes',
      'verification diagnostics classify endpoint, response shape, billing, and service errors without changing Codex config/auth',
      'default selection persisted',
      'provider list order persisted without changing the active Codex configuration',
      'first launch created one protected baseline without a duplicate daily backup; switching preserved unrelated and unknown custom-provider data',
      'same-address profiles retain the selected current-provider identity after a safe switch',
      'switch preflight rejects drift, while restore points require confirmation, reject provider-field conflicts, and preserve later MCP/auth additions',
      'startup automatically recovered an interrupted two-file write from its transaction backup',
      'a post-config auth write failure automatically rolled config.toml back instead of leaving a half-switch',
      'current configuration sync updates only the local profile directory and invalidates the previous model verification',
      'delete removed a non-current non-default provider',
    ],
  }, null, 2))
} finally {
  backend.kill()
  await new Promise((resolve) => providerServer.close(resolve))
  await rm(fixtureRoot, { recursive: true, force: true })
}
