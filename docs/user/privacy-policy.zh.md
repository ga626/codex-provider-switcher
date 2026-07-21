# 隐私政策

**生效日期：2026 年 7 月 19 日**

Signalman AI 是一个面向 Windows 的本地工具。本政策说明应用处理哪些信息、为什么处理，以及用户如何控制这些信息。

## 应用处理的信息

当你主动添加或修改 provider 时，应用会在当前 Windows 用户的本地应用数据目录保存 provider 名称、接口地址、模型名称、备注和用于连接服务商的 API 密钥状态。API 密钥在 Windows 上使用当前用户的 DPAPI 保护；应用不会把密钥写入本项目仓库，也不会把它显示在普通界面或活动记录中。

当你主动执行切换时，应用会读取并更新 Codex 的 `config.toml` 和 `auth.json`，并在写入前创建本地恢复点。恢复点、活动记录和 provider 目录保留在本机应用数据目录中。卸载应用不会自动删除这些数据，以便重新安装后恢复；你可以在确认不再需要后自行删除该目录。

## 网络请求

网络请求只在相应功能被使用时发生：

- 刷新模型目录时，请求你填写的 provider 接口；
- 运行“服务商可用性测试”时，向你填写的 provider 发起一次短时、低 token 的已认证 Responses 请求；
- GitHub 安装版检查更新时，访问本项目的 GitHub Release 接口；
- Microsoft Store 安装版的更新由 Microsoft Store 管理，应用内入口只打开本产品的 Store 页面。

请求的目标地址由用户配置或项目发布配置决定。第三方 provider 可能按照自己的隐私政策、日志策略和计费规则处理请求内容，使用前请确认你信任该服务商。

## 不收集的内容

当前版本没有独立的账号系统、广告 SDK、分析 SDK 或项目自建遥测服务。应用不会为了产品统计主动上传 provider 配置、API 密钥、Codex 配置、备份或活动记录。操作系统、Microsoft Store、GitHub 和你选择的 provider 仍可能按照各自政策记录其服务运行所需的技术日志。

## 数据控制

你可以通过应用内的编辑、恢复和删除操作管理 provider 与恢复点，也可以关闭应用或删除本地应用数据目录。删除数据前请先确认不再需要恢复点。向 GitHub 提交问题时，只提交版本、步骤和脱敏错误摘要，不要上传本地配置或凭据。

## 政策变化与联系

如果数据处理方式发生实质变化，我们会在新的版本说明和本页面更新生效日期。问题反馈和隐私相关咨询请通过 [GitHub Issues](https://github.com/ga626/codex-provider-switcher/issues) 提交；安全漏洞请按 [SECURITY.md](../../SECURITY.md) 的私密路径报告。

本政策仅适用于 Signalman AI 项目代码本身，不替代 Microsoft、GitHub 或第三方 provider 的隐私政策。
