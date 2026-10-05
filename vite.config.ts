import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile } from 'node:fs/promises'
import type { Connect } from 'vite'

function qaSummary(middlewares: Connect.Server) {
  middlewares.use('/__qa/summary', async (request, response) => {
    if ((process.env.CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL ?? 'development') !== 'development' || request.method !== 'GET') { response.statusCode = 404; response.end(); return }
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store')
    try {
      const value = JSON.parse(await readFile('.codex/runtime/qa-receipts/latest-qa-quick.json', 'utf8'))
      response.end(JSON.stringify(value.kind !== 'qa-quick/v2' ? { result: 'legacy' } : Object.fromEntries(['result','runId','sourceRevision','sourceFingerprint','fixtureFingerprint','finishedAt','checks','skipped'].map(key => [key,value[key]]))))
    } catch { response.end(JSON.stringify({ result: 'not-run' })) }
  })
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), { name: 'local-qa-summary', configureServer: server => qaSummary(server.middlewares), configurePreviewServer: server => qaSummary(server.middlewares) }],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0-dev'),
    // A source-tree build must never impersonate a published stable build.
    // Release, Store, and maintenance-candidate scripts set their channels explicitly.
    __CODEX_RELEASE_CHANNEL__: JSON.stringify(process.env.CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL ?? 'development'),
    __CODEX_BUILD_SHA__: JSON.stringify(process.env.CODEX_PROVIDER_SWITCHER_BUILD_SHA ?? 'local'),
  },
  build: {
    minify: 'esbuild',
  },
})
