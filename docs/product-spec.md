# CodeX Provider Switcher 产品规格

状态：`0.1.0-alpha` 产品化基线
目标：Windows 优先的本地 Web 控制台
日期：2026-07-14

## 产品形态

`CodeX Provider Switcher` 是一个本地优先的 Codex provider 切换控制台。它的主交付形态应当轻：用户双击启动入口，后台静默启动本地服务，浏览器打开 `127.0.0.1` 控制台。

Tauri/Rust 保留为原生能力来源和未来安装包路线。当前不把 Tauri 桌面壳作为唯一主路线。

产品要解决的问题：

- 管理 Codex provider profiles。
- 读取并展示当前 Codex provider/model 状态。
- 按 provider 刷新模型列表并缓存。
- 在写入前验证配置和模型选择。
- 写入前自动备份。
- 支持恢复和回滚。
- 记录 activity timeline。
- 帮助从旧版 `CodeX-Switcher.exe` 受控迁移。

## 非目标

Alpha 阶段不做：

- 不做网络代理。
- 不做云同步。
- 不做多账号云端系统。
- 不自动读取 provider 账号数据库。
- 不替用户判断 provider 余额或权益。
- 不在未完成签名和发布复验前承诺自动更新。
- 不直接废弃旧版工具。
- 不让当前 Codex 会话直接执行最终 provider cutover。

## 信息架构

正式 Web 控制台应分为六个区域：

| 区域 | 作用 |
|---|---|
| 顶部状态栏 | 当前 provider、模型、Codex 配置路径、最后验证时间 |
| Provider 列表 | 管理 OWL、A6、DasuAPI 等 profile |
| 模型目录 | 刷新、选择、推荐、验证模型 |
| 切换面板 | dry-run、写入、验证、回滚 |
| 安全中心 | 备份、恢复、时间线、旧工具导入 |
| 更新中心 | 当前版本、检查更新、下载/替换后端、release notes |

首页就是工具本体，不做营销 landing page。

## 核心流程

### 编辑 provider

用户选择 provider，编辑名称、接口地址、模型、密钥和备注。

规则：

- API 密钥保存后不明文显示。
- 编辑时密钥留空表示保留旧密钥。
- 编辑后该 provider 变为未验证。
- 推理强度不作为本工具的主要写入项，除非后续确认 Codex 官方配置语义需要。

### 模型发现

模型不能继续固定为 `gpt-5.5`。每个 provider 应有自己的模型目录：

- 使用用户保存的 provider key 调 `/v1/models`。
- 缓存中转站实际返回的模型列表。
- 按 provider 返回结果展示完整模型目录，不把某个版本号写成产品默认真理。
- 只能做轻量标签，例如 reasoning、embedding、vision、Responses 候选；是否适合 Codex 由后续验证和用户确认决定。
- 不自动把旧模型迁移到新模型。
- 如果模型未验证，写入前需要二次确认。

### 切换 provider

切换规则：

- 当前 provider 和默认 provider 有删除保护。
- 写入前创建备份。
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
- 所选 provider 的接口地址、模型和 API key 就绪状态。
- 当前模型是否在 provider 返回列表中。

### 备份和恢复

备份和恢复是核心安全功能，不是附属高级功能。

需要支持：

- 写入前自动备份。
- 展示最近备份。
- 恢复最近备份。
- 恢复指定备份。
- activity timeline 记录备份、写入、恢复和失败。

### 旧工具迁移

旧版路径：

```text
旧版工具本机目录
```

迁移规则：

- 只读检测旧工具。
- 导入旧 profiles。
- 标出来源和风险。
- 新版试运行成功前不删除旧工具。
- 最终 cutover 生成交接包，由新会话或另一个 agent 执行。

## 原生边界

本地后端负责：

- 只监听 `127.0.0.1`。
- 文件读写。
- profiles 持久化。
- Codex config/auth 读写。
- 备份、恢复、时间线。
- provider 模型刷新。
- 更新和替换流程。

React 负责：

- 状态可视化。
- provider 编辑。
- 模型目录。
- 切换流程。
- 备份恢复和活动记录。
- 更新中心。

Tauri/Rust 负责或保留：

- 原生文件/系统能力。
- 托盘和未来安装包。
- 未来开机启动和自动更新集成。

## 发布边界

用户入口不是源码树，也不是内部 `project_status/`。正式交付应来自 GitHub Release 资产：

```text
CodeXProviderSwitcher-windows-x64-<version>.zip
CodeXProviderSwitcher-windows-x64-<version>.zip.sha256
```

Release 包不得包含：

- `node_modules/`
- `dist/`
- `src-tauri/target/`
- `logs/`
- `release/`
- `archive/`
- `project_status/`
- 真实 `auth.json`
- 真实 `profiles.json`
- 真实 `config.toml`
- 备份目录和本机活动日志。

## 已知 alpha 缺口

- 静默本地后端已有开发态 API 入口；无可见 CMD 的产品化启动器尚未完成。
- 当前 preview 入口仍依赖 Node/npm。
- 模型发现已有只读 `/v1/models` 基础，Responses/Codex 实际兼容性验证尚未完成。
- API key 仍需迁移到 Windows Credential Manager、DPAPI 或 Tauri Stronghold。
- 代码签名、自动更新和正式安装包暂缓。
- UI 信息架构仍需按正式 Web 控制台重构。
