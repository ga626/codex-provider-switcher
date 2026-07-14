# Security Policy

`CodeX Provider Switcher` operates on local Codex provider configuration. Treat configuration writes and provider credentials as sensitive.

## 不应提交的内容

- API keys, tokens, cookies, Personal Access Tokens, provider account files.
- `C:\Users\<user>\.codex\auth.json` or real `config.toml`.
- Local `profiles.json`, backups, activity logs, screenshots, or machine-specific evidence.
- Release artifacts that contain local state or user credentials.

## 本地 HTTP 边界

The planned local Web backend must bind to `127.0.0.1` only. Write APIs that modify Codex config, auth, profiles, backups, or update files must be treated as privileged local operations and should include explicit confirmation and audit records.

## 配置写入规则

Before writing Codex config or auth files:

1. Create a backup.
2. Show the target provider/model and affected files.
3. Preserve unrelated Codex settings.
4. Record the action in the local timeline.
5. Provide a restore path.

## 报告问题

For now, report security issues privately to the repository owner. Do not open public issues containing credentials, local paths with private context, screenshots, or full config/auth files.
