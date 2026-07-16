# Scripts

| Path | Purpose |
|---|---|
| `setup.ps1` / root `setup.cmd` | Source-tree convenience launcher that builds frontend/backend and starts the real local Web backend |
| `CodeXProviderSwitcher.ps1` / root `CodeXProviderSwitcher.cmd` | Release/source launcher for the real local Web backend on `127.0.0.1` |
| `scripts/start-preview.ps1` | Build and start the preview server on fixed port `127.0.0.1:47832` |
| `scripts/stop-preview.ps1` | Stop the managed preview process tree and the matching listener on port `47832` |
| `scripts/qa-smoke.mjs` | Playwright visual/UI smoke for the explicitly marked browser preview; it must not simulate a real switch |
| `scripts/qa/start-dev-desktop.ps1` | Launch the current source-tree desktop app for dev validation without installing |
| `scripts/qa/prepare-install-release-qa.ps1` | Locate or collect release setup assets for install/release validation |
| `scripts/qa/stable-install.ps1` | Explain, install, upgrade, or uninstall the local stable release at the fixed QA path |
| `scripts/local-backend-smoke.mjs` | Start the real local Web backend and verify `/api/health` plus `/api/state` |
| `scripts/local-backend-functional-smoke.mjs` | Exercise real backend writes against an isolated Codex home, including `/responses` verification and the insufficient-balance switch block |
| `scripts/local-backend-ui-smoke.mjs` | Open the real local Web backend UI and assert it renders as `本机 Web 后端` without write actions |
| `scripts/tauri-desktop-boundary-smoke.mjs` | Assert the desktop app keeps one window, no default tray/autostart, and `tauri_native` runtime state |
| `scripts/verify/doctor-codex-provider-switcher.ps1` | Repository and release-readiness checks |
| `scripts/release/build-codex-provider-switcher-release.ps1` | Build desktop installer assets, signed updater artifacts, fallback zip, and checksums into `release-assets/` |
| `scripts/release/verify-local-release-package.ps1` | Unpack and smoke-test the runnable local release zip |
| `scripts/release/publish-github-release-asset.ps1` | Upload and verify GitHub Release assets |
| `scripts/release/verify-github-release-asset.ps1` | Download and compare GitHub Release assets |
