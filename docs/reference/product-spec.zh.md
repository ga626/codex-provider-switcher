# 产品规格

## 产品定位

`CodeX Provider Switcher` 是一个本地优先的 Windows Codex provider 管理工具。最终用户入口是轻量 Tauri 桌面 GUI；本地 Web 控制台只保留为开发、诊断和 fallback。

## 用户可预期的行为

- 从桌面图标启动一个正常窗口，不常驻 CMD，不自动打开浏览器，不要求理解端口。
- 读取、验证、备份和恢复 Codex provider 配置；写入前显示影响范围并要求确认。
- 从服务商读取模型目录，并提供显式、短时的可用性测试。
- 保存不含凭据内容的时间线与恢复点。
- 关闭窗口即退出；不做 24 小时常驻 daemon 或默认开机自启。

## 安全不变量

- 写 `config.toml` 或 `auth.json` 前先备份。
- 保留 `model_provider = "custom"`、Responses wire API、response storage 设置及用户既有 Codex 功能配置。
- API key 与应用创建的敏感恢复副本使用 DPAPI 保护。
- 模型目录表示服务商列出模型，不等于模型已被 Codex 完整验证。
- 当前运行中的 Codex 会话不执行最终 provider cutover。

## 发布边界

发布包优先级是桌面 setup、fallback Web zip、开发预览。自动更新的 updater 签名与 Windows Authenticode 是不同的安全边界。发布必须使用新版本/tag，不覆盖既有不可变 Release；只有 GitHub 下载、安装、启动和更新路径验证完成后，才能称为产品已交付。

实现和验证细节见 [开发与 PR 指南](../contributing/development-and-prs.zh.md) 与 [发布与交付手册](../maintainers/release-and-delivery.zh.md)。
