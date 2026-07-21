# 产品规格

## 产品定位

`Signalman AI` 是一个本地优先的 Windows 本地 provider 管理工具。最终用户入口是轻量 Tauri 桌面 GUI；本地 Web 控制台只保留为开发、诊断和 fallback。

## 用户可预期的行为

- 从桌面图标启动一个正常窗口，不常驻 CMD，不自动打开浏览器，不要求理解端口。
- 读取、验证、备份和恢复 Codex provider 配置；写入前显示影响范围并要求确认。
- 从服务商读取模型目录，并在写配置前提供必经的短时真实可用性测试。
- 保存不含凭据内容的时间线与恢复点。
- 关闭窗口即退出；不做 24 小时常驻 daemon 或默认开机自启。

## 安全不变量

- 写 `config.toml` 或 `auth.json` 前先备份。
- 保留 `model_provider = "custom"`、Responses wire API、response storage 设置及用户既有 Codex 功能配置。
- API key 与应用创建的敏感恢复副本使用 DPAPI 保护。
- 模型目录表示服务商列出模型，不等于模型已被 Codex 完整验证。
- 只有当前保存的地址、模型和密钥已通过一次已认证的 Responses 请求，才允许写入 Codex 配置。
- 修改 provider 或从 Codex 同步新的模型后，旧测试结果立即失效，必须重新测试。
- 当前运行中的 Codex 会话不执行最终 provider cutover。

## 发布边界

发布包的目标优先级是经 Microsoft Store 认证的 MSIX、受控 GitHub 直装 setup、fallback Web zip、开发预览。首个 Store 版本认证前，当前交付仍是 GitHub setup，文档不得提前把 Store 页面写成可下载入口。Store 版本由 Microsoft Store 签名和更新，GitHub 直装版的 updater 签名与 Windows Authenticode 是另一条独立边界。发布必须使用新版本/tag，不覆盖既有不可变 Release；只有 Store 认证完成并从 Store 安装、启动和检查更新后，才能称为 Store 产品已交付。

实现和验证细节见 [开发与 PR 指南](../contributing/development-and-prs.zh.md)、[发布与交付手册](../maintainers/release-and-delivery.zh.md) 与 [旧工具替换手册](../maintainers/legacy-cutover.zh.md)。
