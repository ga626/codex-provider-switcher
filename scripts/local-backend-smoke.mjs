import { spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.env.BACKEND_SMOKE_PORT ?? 47839)
const baseUrl = `http://127.0.0.1:${port}`
const exePath = join(process.cwd(), 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'local_backend.exe' : 'local_backend')
const fixtureRoot = await mkdtemp(join(tmpdir(), 'codex-switcher-backend-smoke-'))

async function waitForBackend() {
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < 15000) {
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) {
        return response.json()
      }
      lastError = `HTTP ${response.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`local backend did not become ready: ${lastError}`)
}

await access(exePath).catch(() => {
  throw new Error(`local backend binary not found: ${exePath}. Run npm run backend:build first.`)
})

const child = spawn(exePath, ['--port', String(port)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CODEX_PROVIDER_SWITCHER_CODEX_HOME: join(fixtureRoot, '.codex'),
    CODEX_PROVIDER_SWITCHER_APP_DATA_DIR: join(fixtureRoot, 'app-data'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

const output = []
child.stdout.on('data', (chunk) => output.push(chunk.toString()))
child.stderr.on('data', (chunk) => output.push(chunk.toString()))

try {
  const health = await waitForBackend()
  if (health.runtimeMode !== 'local_web_backend') {
    throw new Error(`unexpected health runtimeMode: ${health.runtimeMode}`)
  }

  const stateResponse = await fetch(`${baseUrl}/api/state`)
  const state = await stateResponse.json()
  if (!stateResponse.ok) {
    throw new Error(state.error ?? `state request failed: ${stateResponse.status}`)
  }
  if (state.runtimeMode !== 'local_web_backend') {
    throw new Error(`unexpected state runtimeMode: ${state.runtimeMode}`)
  }
  if (!Array.isArray(state.profiles)) {
    throw new Error('state.profiles is not an array')
  }

  console.log(JSON.stringify({
    ok: true,
    url: baseUrl,
    runtimeMode: state.runtimeMode,
    profileCount: state.profiles.length,
  }, null, 2))
} finally {
  child.kill()
  setTimeout(() => {
    if (!child.killed) {
      child.kill('SIGKILL')
    }
  }, 500)
  await rm(fixtureRoot, { recursive: true, force: true })
}
