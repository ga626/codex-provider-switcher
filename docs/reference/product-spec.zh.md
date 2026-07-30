# 产品规格

## 产品定位

`Signalman AI` 是一个本地优先的 Windows 本地 provider 管理工具。最终用户入口是轻量 Tauri 桌面 GUI；本地 Web 控制台只保留为开发、诊断和 fallback。

## 用户可预期的行为

- 从桌面图标启动一个正常窗口，不常驻 CMD，不自动打开浏览器，不要求理解端口。
- 首次启动只读创建受保护的基线备份；读取、验证、备份和恢复 Codex provider 配置；写入前显示影响范围并要求确认。
- 从服务商读取模型目录，并在写配置前提供必经的短时真实可用性测试。
- 保存不含凭据内容的时间线与恢复点。
- 关闭窗口即退出；不做 24 小时常驻 daemon 或默认开机自启。

## 安全不变量

- 写 `config.toml` 或 `auth.json` 前先备份。
- 首次启动的基线备份只覆盖本工具可能写入的 `config.toml` 与 `auth.json`；不会把 Codex 会话历史、插件缓存或其他用户目录当作切换器数据改写。
- 保留 `model_provider = "custom"`、Responses wire API、response storage 设置及用户既有 Codex 功能配置。
- 切换先生成短时预览、确认时再次校验未漂移，只更新 provider 所需字段并保留其他 TOML section 和 `[model_providers.custom]` 内未知字段；恢复前再次创建恢复点，只回退本工具拥有字段。
- 两文件写入有本地事务回执；异常中断后，下次启动先恢复未完成操作的切换前状态，避免继续使用半完成的 config/auth 组合。
- 切换器 profile 中保存的 API key 与应用创建的敏感恢复副本使用 DPAPI 保护；执行切换时，Codex 所需的 custom provider `api_key` 与认证状态按其文件格式写入 `config.toml` 和 `auth.json`，不应被误称为切换器的 DPAPI 加密副本。
- 模型目录表示服务商列出模型，不等于模型已被 Codex 完整验证。
- 只有当前保存的地址、模型和密钥已通过一次已认证的 Responses 请求，才允许写入 Codex 配置。
- 修改 provider 或从 Codex 同步新的模型后，旧测试结果立即失效，必须重新测试。
- 当前运行中的 Codex 会话不执行最终 provider cutover。
- 删除切换器或其本机资料不会自动撤销已写入的 Codex 配置；回退必须先恢复确认过的恢复点。

## 发布边界

GitHub Release 是日常公开小版本的主路径；Microsoft Store 是低频稳定大版本路径。两条路径都必须从同一已验证 tag 构建，但不要求每个 GitHub 版本同步提交 Store。Store 版本由 Microsoft Store 签名和更新；GitHub 直装版使用 Tauri updater 签名确认更新完整性，但在未购买 Windows 代码签名时可能出现 SmartScreen 提示。发布必须使用新版本/tag，不覆盖既有不可变 Release；GitHub 与 Store 的交付状态分别记录，不能互相替代。

实现和验证细节见 [开发与 PR 指南](../contributing/development-and-prs.zh.md)、[发布与交付手册](../maintainers/release-and-delivery.zh.md) 与 [旧工具替换手册](../maintainers/legacy-cutover.zh.md)。
