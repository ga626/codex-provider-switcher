# CodeX Provider Switcher 产品规格

状态：`0.5.0-alpha` 候选，修复签名更新动作并完成真实服务商验证边界
目标：Windows 优先的轻量桌面 GUI
日期：2026-07-15

## 产品形态

`CodeX Provider Switcher` 是一个本地优先的 Codex provider 切换控制台。它的主交付形态应当轻：用户从桌面图标或开始菜单启动，一个正常桌面窗口打开；默认不弹常驻 CMD、不打开外部浏览器、不要求用户理解 `127.0.0.1`。

Tauri/Rust 是桌面 GUI 和本地能力主路线。本地 Web 控制台保留为开发、诊断和 fallback 路线。

产品要解决的问题：

- 管理 Codex provider profiles。
- 读取并展示当前 Codex provider/model 状态。
- 按 provider 刷新模型列表并缓存。
- 在写入前验证配置和模型选择。
- 写入前自动备份。
- 支持恢复和回滚。
- 记录 activity timeline。

## 非目标

Alpha 阶段不做：

- 不做网络代理。
- 不做云同步。
- 不做多账号云端系统。
- 不自动读取 provider 账号数据库。
- 不替用户判断 provider 余额或权益。
- 不在签名私钥、更新 manifest 和远端下载复验齐全前宣称产品已交付。
- 不直接废弃旧版工具。
- 不让当前 Codex 会话直接执行最终 provider cutover。

## 信息架构

正式桌面控制台应分为六个区域：

| 区域 | 作用 |
|---|---|
| 顶部状态栏 | 当前 provider、模型和最后验证状态 |
| Provider 列表 | 管理 OWL、A6、DasuAPI 等 profile |
| 模型目录 | 刷新、搜索、选择模型，并展示服务商目录与当前模型的正向探测证据 |
| 切换面板 | 本地安全门禁、服务商可用性测试、写入、回滚 |
| 安全中心 | 备份、恢复、时间线和配置门禁 |
| 更新中心 | 当前版本、检查更新、下载/替换后端、release notes |

首页就是工具本体，不做营销 landing page。

## 核心流程

### 编辑 provider

用户选择 provider，编辑名称、接口地址、模型、密钥和备注。

规则：

- API 密钥保存后不明文显示。
- 编辑时密钥留空表示保留旧密钥。
- 编辑后清除旧的服务商可用性测试记录；这不会否定用户的实际 Codex 使用结果。
- 推理强度不作为本工具的主要写入项，除非后续确认 Codex 官方配置语义需要。

### 模型发现

模型不能继续固定为 `gpt-5.5`。每个 provider 应有自己的模型目录：

- 使用用户保存的 provider key 调 `/v1/models`。
- 缓存中转站实际返回的模型列表。
- 按 provider 返回结果展示完整模型目录，不把某个版本号写成产品默认真理。
- 只能做轻量标签，例如 reasoning、embedding、vision、Responses 候选；`/models` 只能证明目录可读，不能证明 Responses 或 Codex 可用。
- 不自动把旧模型迁移到新模型。
- 手动输入且不在最近目录中的模型，保存前必须二次确认。目录内模型可直接作为切换配置，服务商可用性测试仅提供补充证据。

### 切换 provider

切换规则：

- 当前 provider 和默认 provider 有删除保护。
- 写入前创建备份。
- 切换只以本地安全条件为门禁：接口地址、模型、API key、Codex 配置不变量和未保存更改。
- 切换不自动发送远端可用性测试，避免把第三方中转对通用请求的差异误判为不可用。
- 只写 provider/model/auth 相关字段。
- 保留 Codex 其他配置块。
- 写入后记录 activity。
- 失败时显示恢复路径。

### 验证

验证至少检查：

- TOML 语法。
- 根配置 `model`。
- `model_provider = "custom"`。
- `[model_providers.custom]`。
- `wire_api = "responses"`。
- `disable_response_storage = true`。
- 当前 custom provider `base_url`。
- 当前 custom provider key 存在状态。
- 所选 provider 的接口地址和 API key 就绪状态。
- 模型目录刷新使用已认证的 `/v1/models`；它只读取并缓存目录，不验证模型调用能力，也不写入 Codex 配置。
- 服务商可用性测试由用户显式触发，以当前模型发送短时、低 token、已认证的 `POST /v1/responses` 请求。标准 Responses 结果和包含可识别输出的兼容结果都会为当前模型记录正向证据。
- 测试把“模型可调用”和“标准 Responses 形状”分别记录。`HTTP 2xx` JSON 但没有可识别输出时显示“服务端已响应，结果待确认”；这不是服务商不能被 Codex 使用的结论。
- 测试不写入 Codex 配置或凭据；超时、限流或远端错误只表示本次没有得到正向证据。结果可展示鉴权、额度、限流、接口或模型、响应外形、服务端、超时和网络/传输诊断；它们不是切换门禁。
- 当前模型是否在 provider 返回列表中是提示而非成功证明；目录外模型可以保存，但必须先二次确认。

### 备份和恢复

备份和恢复是核心安全功能，不是附属高级功能。

需要支持：

- 写入前自动备份。
- 展示最近备份。
- 恢复最近备份。
- 恢复指定备份。
- activity timeline 记录备份、写入、恢复和失败。

### 恢复中心

恢复中心只管理本应用创建的备份：

- 展示最近恢复点的时间、标签和文件数量。
- 恢复前要求二次确认。
- 恢复操作写入 activity timeline，并要求用户重新检查服务商状态。
- 备份 manifest 仅记录时间、原因和文件名，不记录配置内容或凭据。

## 原生边界

本地后端负责：

- 只监听 `127.0.0.1`。
- 文件读写。
- profiles 持久化。
- Codex config/auth 读写。
- 备份、恢复、时间线。
- provider 模型刷新。
- 更新检查和替换流程。

React 负责：

- 状态可视化。
- provider 编辑。
- 模型目录。
- 切换流程。
- 备份恢复和活动记录。
- 更新中心。

Tauri/Rust 负责或保留：

- 原生文件/系统能力。
- 桌面窗口、安装包和系统 WebView 边界。
- 自动更新集成。

当前桌面 GUI 不默认启用托盘或开机自启动。关闭窗口应退出应用。

## 发布边界

用户入口不是源码树，也不是内部 `project_status/`。正式交付应来自 GitHub Release 资产：

```text
CodeXProviderSwitcher-windows-x64-<version>.zip
CodeXProviderSwitcher-windows-x64-<version>.zip.sha256
CodeXProviderSwitcher-windows-x64-<version>-setup.exe
CodeXProviderSwitcher-windows-x64-<version>-setup.exe.sha256
```

Release 包不得包含：

- `node_modules/`
- `src-tauri/target/`
- `logs/`
- `release/`
- `archive/`
- `project_status/`
- 真实 `auth.json`
- 真实 `profiles.json`
- 真实 `config.toml`
- 备份目录和本机活动日志。

稳定安装目录和更新边界：

- 本机标准稳定安装 QA 目录为 `D:\Software\CodeX Provider Switcher`，公开安装器仍保持 `currentUser` 和 NSIS 可选路径，不把本机路径编译为产品硬编码。
- 程序文件与用户可变数据分离。profiles、备份、活动记录和更新缓存位于 `%LOCALAPPDATA%\CodeX Provider Switcher`。
- 稳定版只从 GitHub Release 的签名 `latest.json` 检查更新；更新下载、签名校验、退出后替换和重启由 Tauri updater 处理。
- updater endpoint 使用 GitHub `/releases/latest/download/latest.json`，因此公开发布的 Release 必须标记为 `Latest`，不能标记为 `Pre-release`；版本标签仍可使用 `-alpha` 后缀。
- 发布资产必须使用新版本和新 tag；禁止用旧 tag 或 `--clobber` 覆盖已发布资产。

更新签名职责边界：

- 最终用户检查更新、下载更新和安装更新时不需要密钥或口令；应用只内置公钥验证更新包。
- 日常开发、PR 验证和本地运行不依赖 Tauri updater 私钥。
- 正式 Release 由 CI 使用 `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Secrets 生成签名资产。
- `.github/workflows/release.yml` 只响应新 `v*` 标签，并校验标签与三份版本元数据一致；旧 tag 和旧 Release 不得覆盖。
- 密钥对只在建立发布信任根时生成一次并复用；丢失或轮换时必须记录旧版本迁移和一次性手动升级路径。

## 已知 alpha 缺口

- 当前交付开始提供桌面安装资产，但仍是 alpha。
- 源码树 `setup.cmd` 仍依赖 Node/npm/Rust 构建环境；Release 包用户入口不依赖这些开发工具。
- `0.3.2-alpha` 与 `0.4.0-alpha` 不能通过自身自动升级，用户须手动安装一次 `0.5.0-alpha`；下一版本才从 `0.5.0-alpha` 验证真实自动升级。
- 服务商可用性测试只能提供单一短时 Responses 请求的正向证据，不能代替实际 Codex 使用或最终 cutover 的端到端验证。
- API key 仍需迁移到 Windows Credential Manager、DPAPI 或 Tauri Stronghold。
- 代码签名仍不是本版本承诺的 Windows Authenticode 能力；Tauri 更新签名私钥必须留在本机/CI secret。
