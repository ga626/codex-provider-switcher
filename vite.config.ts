import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
