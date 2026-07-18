# CodeX Provider Switcher 0.6.0-alpha 发布说明

## 摘要

本版本收紧本地凭据、恢复副本和桌面发布的安全边界，并补齐旧工具最终替换前的只读检查。它是可发布的 alpha 候选，但不在本版本的开发会话中直接停用旧工具或切换当前 Codex 会话。

## 主要改动

- provider API key 和本应用创建的 `config.toml`、`auth.json` 恢复副本改用当前 Windows 用户的 DPAPI 保护；首次成功加载时自动迁移旧明文数据。
- 安全检查可识别当前 Codex 模型与本地 provider 目录的差异。用户确认后只能更新本地目录，不写 Codex 配置、不写认证文件，也不会请求服务商。
- 桌面 Release 同时要求 Tauri updater 签名和 Windows Authenticode 签名。GitHub Actions 缺少任一签名凭据时会停止正式发布。
- 增加只读 cutover preflight，用于发布后的新会话确认新安装版、旧工具进程/端口和启动入口状态。
- 限制桌面 WebView CSP，并将预览 smoke 编排为单个命令。

## 用户影响

已安装 `0.5.0-alpha` 的用户可作为本版本的真实应用内升级基线。发布后必须从已安装 `0.5.0-alpha` 执行一次检查更新、下载、重启、版本变化和用户数据保留验收。

DPAPI 保护绑定当前 Windows 用户。不要直接把 `%LOCALAPPDATA%\CodeX Provider Switcher` 复制给其他 Windows 账号；需要迁移时按发布说明完成受控手动升级。

## 发布后验收

1. 从 GitHub Release 下载 `0.6.0-alpha` setup，校验 SHA256 和 Authenticode 状态后安装到稳定目录。
2. 从已安装 `0.5.0-alpha` 运行应用内检查更新，确认签名下载、重启、版本变化与用户数据保留。
3. 运行 `npm run qa:cutover-preflight`，在新的 Codex 会话中根据结果完成真实 provider 验收、旧工具停用和重启后复查。
4. 旧工具目录保留作回滚参考，不删除或覆盖。
