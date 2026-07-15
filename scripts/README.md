# Scripts

| Path | Purpose |
|---|---|
| `setup.ps1` / root `setup.cmd` | Source-tree convenience launcher that builds frontend/backend and starts the real local Web backend |
| `CodeXProviderSwitcher.ps1` / root `CodeXProviderSwitcher.cmd` | Release/source launcher for the real local Web backend on `127.0.0.1` |
| `scripts/start-preview.ps1` | Build and start a local preview server on `127.0.0.1` |
| `scripts/stop-preview.ps1` | Stop the preview server recorded in `logs/preview-state.json` |
| `scripts/qa-smoke.mjs` | Playwright UI smoke flow |
| `scripts/qa/start-dev-desktop.ps1` | Launch the current source-tree desktop app for dev validation without installing |
| `scripts/qa/prepare-install-release-qa.ps1` | Locate or collect release setup assets for install/release validation |
| `scripts/local-backend-smoke.mjs` | Start the real local Web backend and verify `/api/health` plus `/api/state` |
| `scripts/local-backend-ui-smoke.mjs` | Open the real local Web backend UI and assert it renders as `本机 Web 后端` without write actions |
| `scripts/tauri-desktop-boundary-smoke.mjs` | Assert the desktop app keeps one window, no default tray/autostart, and `tauri_native` runtime state |
| `scripts/verify/doctor-codex-provider-switcher.ps1` | Repository and release-readiness checks |
| `scripts/release/build-codex-provider-switcher-release.ps1` | Build desktop installer assets, fallback zip, and checksums |
| `scripts/release/verify-local-release-package.ps1` | Unpack and smoke-test the runnable local release zip |
| `scripts/release/publish-github-release-asset.ps1` | Upload and verify GitHub Release assets |
| `scripts/release/verify-github-release-asset.ps1` | Download and compare GitHub Release assets |
