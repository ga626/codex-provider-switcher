# CodeX Provider Switcher

一个本地优先的 Windows 工具，用来管理 Codex provider、在写入前检查配置，并保留可恢复的备份。

它适合希望在多个兼容服务商之间切换、又不想手工改 `config.toml` 和 `auth.json` 的 Codex 用户。应用默认是一个普通桌面窗口：不常驻 CMD、不自动打开浏览器、不要求理解端口；关闭窗口即退出。

> 当前处于 alpha 阶段。请以 [GitHub Releases](https://github.com/ga626/codex-provider-switcher/releases/latest) 中的 Latest 为准。源码里的新功能不等于已经交付给安装用户。

## 开始使用

1. 打开 [最新发布版](https://github.com/ga626/codex-provider-switcher/releases/latest)。
2. 下载名称带有 `setup.exe` 的 Windows 安装包和对应的 `.sha256` 文件。
3. 安装后从开始菜单或桌面图标启动 `CodeX Provider Switcher`。

完整步骤、更新与卸载说明见 [安装与更新](docs/user/installation.zh.md)。遇到问题先看 [排错指南](docs/user/troubleshooting.zh.md)。

## 它会做什么

- 保存多个 provider 目录，并从服务商读取可见模型目录。
- 在写入 Codex 配置前显示影响范围，创建恢复点，并保留时间线。
- 让你主动运行短时可用性测试；测试结果不会替代你在 Codex 中的真实使用判断。
- 恢复本工具创建的最近备份，避免为了回滚手工覆盖配置。

## 数据与安全边界

- provider API key 和本工具创建的敏感恢复副本使用当前 Windows 用户的 DPAPI 保护。
- 不要把 `%LOCALAPPDATA%\CodeX Provider Switcher` 中的资料复制给其他 Windows 用户，也不要把真实 `auth.json`、`profiles.json`、备份或日志提交到公开仓库。
- 本工具写入前必须先创建备份；最终 provider 切换应在新的 Codex 会话中完成，不能在正在工作的会话里直接执行。
- 应用内“检查更新”只验证发布包，不会要求你输入发布密钥或口令。

## 版本状态

这里区分三件不同的事：

| 状态 | 含义 |
| --- | --- |
| 开发中 | 当前源码树正在变化，只用于开发验证 |
| 代码已合并 | 改动已进入 `main`，但可能还没有发布包 |
| 产品已交付 | 新 tag 和 GitHub Release 已创建，并完成下载、安装、启动与更新验收 |

只有第三种状态才表示安装用户可以获得更新。每个版本的用户变化可在 [变更记录](CHANGELOG.md) 和对应 Release 页面查看。

## 需要帮助或参与

- 使用问题：先看 [排错指南](docs/user/troubleshooting.zh.md)，再通过 [Issue](https://github.com/ga626/codex-provider-switcher/issues) 提供脱敏信息。
- 安全问题：见 [安全说明](https://github.com/ga626/codex-provider-switcher/blob/main/SECURITY.md)，不要在公开 Issue 中贴凭据或完整配置。
- 参与开发：见 [贡献说明](https://github.com/ga626/codex-provider-switcher/blob/main/CONTRIBUTING.md)。
- 全部文档：从 [文档导航](https://github.com/ga626/codex-provider-switcher/tree/main/docs) 开始。

## 开发者入口

仓库开发、验证、发布和脚本资料与使用说明分开维护。开发者请从 [贡献说明](https://github.com/ga626/codex-provider-switcher/blob/main/CONTRIBUTING.md) 开始；发布维护者请看 [发布与交付手册](https://github.com/ga626/codex-provider-switcher/blob/main/docs/maintainers/release-and-delivery.zh.md)。
