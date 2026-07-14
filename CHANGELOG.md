# Changelog

## Unreleased

- Added provider model catalog state, read-only `/models` refresh, full returned-list display, light model tags, and manual model selection.
- Removed `gpt-5.5` as an application default in source and mock state; existing imported user profiles are not auto-migrated.
- Marked browser preview state as UI-only mock data and added Rust tests for model-list parsing.
- Bootstrapped the public repository structure for `CodeX Provider Switcher`.
- Added project rules, contribution guidance, security policy, GitHub issue/PR templates, CI, release runbook, and release gate checklist.
- Documented the product direction as a lightweight local Web console with a quiet backend and optional native shell.

## 0.1.0-alpha - 2026-07-14

Initial repository baseline.

- React/Vite UI for managing Codex provider profiles.
- Tauri/Rust local file, profile, backup, validation, and restore foundation.
- Browser UI-only mock adapter and Playwright smoke script for UI validation.
- Early Codex config/auth switching logic with backup and validation safeguards.
- Legacy profile import/status direction for the old `CodeX-Switcher.exe` tool.

Known alpha boundaries:

- The current primary implementation still contains Tauri-first assumptions that will be reduced in the local Web console phase.
- Model discovery is not yet dynamic; GPT-5.6 and provider-returned model lists are planned for the next phase.
- Final Codex provider cutover must be handled by a new session or another agent with a handoff package.
