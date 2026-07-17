# Changelog

## Unreleased

## 0.4.1-alpha - 2026-07-18

- Fixed the Tauri updater action so a verified pending update is installed directly instead of being rejected by the manual Release-page URL guard.
- Kept the manual download fallback restricted to the canonical project Release page and its child URLs.
- Documented the one-time manual upgrade required for installations of 0.3.2-alpha and 0.4.0-alpha before future automatic updates can be used.

## 0.4.0-alpha - 2026-07-18

- Added a recovery center that shows the newest application-created restore point and requires explicit confirmation before restoration.
- Added a credential-free backup manifest that records the backup time, reason, and file names for each pre-switch backup.
- Removed legacy-tool-specific detection, environment variables, and automatic profile import from the product runtime and UI.
- Avoided duplicate full validation for feature-branch pushes while retaining local preflight and PR CI coverage.
- Fixed the artifact-backed Release publisher so an expected GitHub 404 for a new tag reaches the explicit create-Release path instead of becoming a PowerShell native-command exception.

## 0.3.2-alpha - 2026-07-17

- Added Rust/Tauri build caching, explicit GitHub Actions timeouts, and phase timing for Release builds.
- Split the Release workflow into tag preflight, signed asset build, and artifact-backed publishing jobs.
- Added upload-set validation for checksums and updater metadata before a GitHub Release is created.
- Added idempotent handling for an existing complete Release and an explicit failure path for incomplete assets.
- Kept signing Secrets in the build job only; the publish job receives verified public artifacts and no signing key.

## 0.3.1-alpha - 2026-07-16

- Hotfix release: the Windows setup now starts the Tauri desktop GUI.
- The local Web backend remains a separate fallback binary and is not used as the installed desktop entrypoint.
- Fixed the Tauri release entrypoint so the NSIS installer bundles the desktop GUI binary instead of the local Web backend binary.
- Added a smoke guard for the Tauri CLI binary-selection syntax.
- Hidden the Windows `tasklist.exe` probe so normal feature actions do not open a child console window.
- Localized the NSIS installer to Simplified Chinese and added branded header/sidebar artwork.
- Removed stale updater signatures before each release build.

## 0.3.0-alpha - 2026-07-16

- Promoted the next alpha line to `0.3.0-alpha` for the stable install and release-governance baseline.
- Fixed local release assets under `release-assets/` and removed release upload overwrite behavior.
- Added the signed Tauri updater integration boundary; release signing remains CI-secret gated.
- Documented the three-state workflow: development desktop, local release candidate, and stable installed release.
- Removed default Tauri tray/autostart wiring so the app opens as one normal window and exits on close.
- Added `tauri:desktop-boundary:smoke` to guard against accidental tray/autostart/mock regressions.
- Extended release scripts to build and publish a desktop setup asset alongside the fallback Web zip.
- Updated public docs, installation, troubleshooting, product spec, release checklist, and CI for the desktop-first shape.

## 0.2.0-alpha - 2026-07-15

- Lightweight desktop GUI baseline.
- Tauri app now reports `tauri_native`, keeps a single normal window, and does not install a default tray icon.
- Default autostart plugin wiring is removed; auto start remains a future explicit advanced option.
- Release output now includes Windows setup exe, fallback Web zip, and SHA256 files.
- Local Web console remains available as a fallback and diagnostic path.

## 0.1.1-alpha - 2026-07-15

- Aligned root `setup.cmd` / `setup.ps1` with the real local Web backend instead of the UI-only preview path.
- Fixed GitHub Release asset verification for zip files that contain a top-level package directory.
- Updated public README, installation, troubleshooting, structure, and PR template wording to match the released local Web Alpha shape.
- Aligned package metadata versions with `0.1.0-alpha`.

## 0.1.0-alpha - 2026-07-14

Initial public Alpha release.

- React/Vite UI for managing Codex provider profiles.
- Tauri/Rust local file, profile, backup, validation, and restore foundation.
- Provider model catalog state, read-only `/models` refresh, full returned-list display, light model tags, and manual model selection.
- Removed `gpt-5.5` as an application default in source and mock state; existing imported user profiles are not auto-migrated.
- Local Web backend binary that serves `dist/` on `127.0.0.1` and exposes real `/api/*` endpoints backed by Rust state/actions.
- Runnable Windows alpha zip with `CodeXProviderSwitcher.cmd`, `CodeXProviderSwitcher.ps1`, `bin/local_backend.exe`, frontend assets, user docs, and SHA256.
- Browser UI-only mock adapter and Playwright smoke script for UI validation.
- Early Codex config/auth switching logic with backup and validation safeguards.
- Legacy profile import/status direction for the old `CodeX-Switcher.exe` tool.
- Public repository structure, project rules, contribution guidance, security policy, GitHub issue/PR templates, CI, release runbook, and release gate checklist.

Known alpha boundaries:

- Current delivery is a runnable alpha zip, not a formal installer or auto-updater.
- Provider compatibility, stable cutover, and UI information architecture still need later hardening.
- Final Codex provider cutover must be handled by a new session or another agent with a handoff package.
