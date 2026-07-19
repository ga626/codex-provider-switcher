# 安全说明

`CodeX Provider Switcher` 会处理本地 Codex provider 配置。请把配置写入、凭据和恢复副本视为敏感资料。

## 请不要公开这些内容

- API key、token、cookie、Personal Access Token 或证书文件。
- 真实 `C:\Users\<user>\.codex\auth.json`、完整 `config.toml`、`profiles.json`、备份、活动日志或截图。
- 含有用户名、私有服务地址或真实 provider 信息的本机证据。

## 产品边界

- provider API key 与本工具创建的敏感恢复副本使用当前 Windows 用户的 DPAPI 保护。
- Microsoft Store MSIX 在 Partner Center 提交后由 Store 签名；Store 用户不接触发布凭据。GitHub 直装备用渠道的 Tauri updater 签名私钥和 Windows Authenticode 证书是两套不同的发布凭据，只能放在 GitHub Actions Secrets，不进入仓库、安装包或普通日志。
- 写入 Codex 配置前必须创建备份、显示影响范围、保留无凭据时间线并提供恢复入口。

## 报告问题

请不要为安全问题创建公开 Issue。通过仓库维护者的私下渠道报告，并只提供脱敏摘要、复现步骤和受影响版本。维护者会确认影响、安排修复版本，并在需要时给出受控升级或回滚说明。

维护者的漏洞依赖处理流程见 [依赖与安全治理](docs/maintainers/dependency-security.zh.md)。
