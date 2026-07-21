# 贡献说明

感谢参与 `Signalman AI`。这是会读写本地 Codex 配置的 Windows 桌面工具，任何改动都应优先保证配置安全、可恢复和可交付。

## 开始前

1. 从最新 `main` 创建 `codex/<topic>` 分支。
2. 先判断改动是否影响用户入口、桌面壳、安装包、更新、配置写入或 Release。影响其中任一项时，这是发布影响 PR。
3. 不要修改旧版工具目录；它只作为回滚参考。最终 provider 切换只能在发布后的新 Codex 会话中执行。
4. 不要提交 API key、token、真实 `auth.json`、`profiles.json`、备份、日志、截图或本机状态。

## 开发与验证

开发环境、按改动类型选择的验证命令、文档同步责任和 PR 前检查，见 [开发与 PR 指南](docs/contributing/development-and-prs.zh.md)。

涉及用户可见桌面界面或流程时，PR 前需要准备开发版窗口供人工验收；安装发布验收只在安装器、版本、启动入口、更新或 Release 资产改动时进行。

## 交付边界

代码通过 CI 并不自动表示用户已拿到新版本。发布影响 PR 的合并后仍要创建新版本/tag、发布不可变 Release，并按普通用户路径下载、安装、启动和验证。完整规则见 [发布与交付手册](docs/maintainers/release-and-delivery.zh.md)。
