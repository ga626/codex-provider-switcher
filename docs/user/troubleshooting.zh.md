# 排错指南

先确认你正在使用的是什么：从 GitHub Release 安装的发布版，还是开发者打开的源码树开发版。首个 Microsoft Store 版本认证后，安装来源会显示为 Microsoft Store。不同来源的启动和更新方式不同。

## 安装后窗口没有打开

1. 从开始菜单或桌面图标启动 `CodeX Provider Switcher`，不要直接运行源码脚本。
2. 确认下载的是 Release 中带 `setup.exe` 的安装包，而不是源码 zip。
3. 确认 Windows WebView2 Runtime 可用。多数新版 Windows 已内置；缺失时安装 Microsoft Edge WebView2 Evergreen Runtime。
4. 若安装器被拦截，记录 Windows 显示的提示和版本号，不要下载来源不明的替代安装包。

正常产品入口不应打开浏览器，也不应留下 CMD 窗口。若出现这些现象，请在 Issue 中提供版本、启动方式和脱敏错误摘要。

## 检查更新失败

开发版不会使用稳定更新通道，这是预期行为。当前 GitHub 安装版更新失败时：

1. 确认网络可以访问 GitHub Release。
2. 在 Release 页面确认该版本同时有 setup、`.sha256`、`.sig` 和 `latest.json`。
3. 不要手工替换安装目录；保留当前稳定版，必要时从新的 Release setup 受控升级。

签名校验失败表示更新包不能被信任，应停止更新并报告问题。Store 版本认证后，遇到 Store 更新错误时再改为记录 Store 错误码、应用版本和发生时间。

## provider 或模型测试不通过

“刷新模型目录”只说明服务商的 `/v1/models` 可读取，不代表每个模型都能被 Codex 使用。“服务商可用性测试”会用当前模型发送一次短时、已认证的真实请求。测试通过是切换前提，但仍不能替代你在新 Codex 会话中的实际使用。

- 认证被拒绝：检查 provider 地址和凭据。
- 额度或配额不足：先处理账户余额或配额，再重试。
- 路径、模型或请求不被接受：确认服务商兼容的接口与模型。
- 超时、网络不可达或限流：稍后重试，并检查网络。
- 服务端已响应但应用无法解释：当前版本不能把它当作可安全切换。保留脱敏响应摘要后报告；在结果被识别前，不要写入该 provider。

不要为排错而直接覆盖 `config.toml` 或 `auth.json`。先使用应用的恢复入口；最终切换在新的 Codex 会话中完成。

## 升级后服务商或 API 密钥缺失

正常升级会保留当前 Windows 用户的本机资料；新安装则从空服务商列表开始，这是预期行为。若你确认自己是在同一台电脑、同一 Windows 用户下升级，却发现原有服务商或 API 密钥缺失，不要在产品界面寻找“旧版导入”功能，也不要手工编辑数据目录。保留应用版本、安装来源和脱敏错误摘要后报告问题；维护者会在受控迁移流程中恢复本机资料，产品安装包不会携带任何人的 provider 或密钥。

## fallback 诊断入口

Release 附带的 fallback zip 只用于排错和本地 Web 诊断，不是推荐的日常入口。解压后双击 `CodeXProviderSwitcher.cmd`，再访问：

```text
http://127.0.0.1:47832/
```

停止 fallback 后端：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\CodeXProviderSwitcher.ps1 -Stop
```

## 报告问题时请提供

- 应用版本和安装来源。
- 你点击了什么、看到了什么。
- 脱敏后的错误摘要和发生时间。

不要贴 API key、完整 `auth.json`、真实 `profiles.json`、备份、截图或本机私有路径。安全问题按 [安全说明](https://github.com/ga626/codex-provider-switcher/blob/main/SECURITY.md) 私下报告。
