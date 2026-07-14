# Changelog

## Unreleased

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
