# 产品规格

## 产品定位

`Signalman AI` 是一个本地优先的 Windows 本地 provider 管理工具。最终用户入口是轻量 Tauri 桌面 GUI；本地 Web 控制台只保留为开发、诊断和 fallback。

## 用户可预期的行为

- 从桌面图标启动一个正常窗口，不常驻 CMD，不自动打开浏览器，不要求理解端口。
- 首次启动先显示独立的连接环境准备流程：用户阅读知情说明并选择要管理的 Codex 配置层后，应用创建受保护的基线备份并统一仅限服务商/Responses 的必需设置；失败时保留原有文件、显示可解释状态并保持所有写入操作受保护。
- 从服务商读取模型目录，并在写配置前提供必经的短时真实可用性测试。
- 在“实验室 > 性价比中心”以同一条固定测试记录充值金额、平台实际额度和测试额度，换算同一模型的人民币成本与排名；只在服务商响应明确返回费用时自动预填，其余情况要求用户从平台日志复制。
- 保存不含凭据内容的时间线与恢复点。
- 在服务商兼容异常时生成本地脱敏反馈预览；只有用户明确同意且维护者已部署反馈中继时才提交，不把密钥、配置正文、路径、响应原文、Cookie、日志、备份或截图发送出去。
- 关闭窗口即退出；不做 24 小时常驻 daemon 或默认开机自启。用户可在应用设置中主动开启开机启动，安装、升级和首次打开均保持关闭。

## 安全不变量

- 写受管的 Codex 配置前先备份；当前“无需认证” custom provider 不读写 `auth.json`。
- 自动备份失败必须清理未完成 staging 并写入不含配置内容或凭据的启动诊断；首次基线备份未完成时，不允许进入配置写入路径。
- 首次启动的基线备份只覆盖本工具可能写入的 `config.toml` 与 `auth.json`；不会把 Codex 会话历史、插件缓存或其他用户目录当作切换器数据改写。
- 多个 Codex 配置层必须由用户选择；不能自动合并或猜测写入目标。准备连接环境只触及本工具拥有的 provider/Responses 字段，并在写入后回读。
- 保留 `model_provider = "custom"`、Responses wire API、response storage 设置及用户既有 Codex 功能配置。
- 切换先生成短时预览、确认时再次校验未漂移，只更新 provider 所需字段并保留其他 TOML section 和 `[model_providers.custom]` 内未知字段；`requires_openai_auth` 只在已有配置中保留其值，不能凭空新增；未声明认证方式时不得写入 `api_key` 或 `auth.json`，登录/环境变量认证未经隔离 runtime 验证时停止自动切换；恢复前再次创建恢复点，只回退本工具拥有字段。
- 受管配置写入有本地事务回执；异常中断后，下次启动先恢复未完成操作的切换前状态，避免继续使用半完成的 provider 配置。
- 切换器 profile 中保存的 API key 与应用创建的敏感恢复副本使用 DPAPI 保护；API key 仅用于服务商目录与真实可用性测试，不会被写回未声明认证方式的 Codex custom provider 配置。
- 模型目录表示服务商列出模型，不等于模型已被 Codex 完整验证。
- 费用比较仅用于同一模型、同一固定测试下的相对成本判断；不读取平台账单、不推断未知倍率、不自动充值，且不会触发 provider 切换或修改 Codex 配置。
- 只有当前保存的地址、模型和密钥已通过一次已认证的 Responses 请求，才允许写入 Codex 配置。
- 修改 provider 或从 Codex 同步新的模型后，旧测试结果立即失效，必须重新测试。
- 当前运行中的 Codex 会话不执行最终 provider cutover。
- 删除切换器或其本机资料不会自动撤销已写入的 Codex 配置；回退必须先恢复确认过的恢复点。

## 发布边界

GitHub Release 是日常公开小版本的主路径；Microsoft Store 是低频稳定大版本路径。两条路径都必须从同一已验证 tag 构建，但不要求每个 GitHub 版本同步提交 Store。Store 版本由 Microsoft Store 签名和更新；GitHub 直装版使用 Tauri updater 签名确认更新完整性，但在未购买 Windows 代码签名时可能出现 SmartScreen 提示。发布必须使用新版本/tag，不覆盖既有不可变 Release；GitHub 与 Store 的交付状态分别记录，不能互相替代。

实现和验证细节见 [开发与 PR 指南](../contributing/development-and-prs.zh.md)、[发布与交付手册](../maintainers/release-and-delivery.zh.md) 与 [旧工具替换手册](../maintainers/legacy-cutover.zh.md)。
