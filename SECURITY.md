# Security Policy

`CodeX Provider Switcher` operates on local Codex provider configuration. Treat configuration writes and provider credentials as sensitive.

## 不应提交的内容

- API keys, tokens, cookies, Personal Access Tokens, provider account files.
- `C:\Users\<user>\.codex\auth.json` or real `config.toml`.
- Local `profiles.json`, backups, activity logs, screenshots, or machine-specific evidence.
- Release artifacts that contain local state or user credentials.

## 本地凭据与备份

- provider 目录中的 API key 与本应用创建的 `config.toml`、`auth.json` 恢复副本，使用当前 Windows 用户的 DPAPI 保护。
- 旧明文 profile 和恢复副本会在首次成功加载时迁移；不要把 `%LOCALAPPDATA%\CodeX Provider Switcher` 直接复制到其他 Windows 用户。
- Tauri updater 私钥和 Windows Authenticode 证书分别是两套发布凭据，只允许放入 GitHub Actions Secrets，不进入仓库、安装包或普通日志。

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
