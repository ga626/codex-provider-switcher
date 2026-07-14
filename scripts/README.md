# Scripts

| Path | Purpose |
|---|---|
| `scripts/start-preview.ps1` | Build and start a local preview server on `127.0.0.1` |
| `scripts/stop-preview.ps1` | Stop the preview server recorded in `logs/preview-state.json` |
| `scripts/qa-smoke.mjs` | Playwright UI smoke flow |
| `scripts/verify/doctor-codex-provider-switcher.ps1` | Repository and release-readiness checks |
| `scripts/release/build-codex-provider-switcher-release.ps1` | Build the local release zip and checksum |
| `scripts/release/publish-github-release-asset.ps1` | Upload and verify GitHub Release assets |
| `scripts/release/verify-github-release-asset.ps1` | Download and compare GitHub Release assets |
