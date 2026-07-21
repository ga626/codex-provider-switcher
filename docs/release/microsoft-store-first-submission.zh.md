# Microsoft Store 认证提交材料

这份材料用于把 `v0.8.0-alpha` 的 Store MSIX 提交到 Partner Center。它把能由项目确定的内容写死，把商业、法律和最终发布动作单独留给产品所有者确认。

## 先分清两个系统

GitHub 和 Partner Center 是两条不同的交付链路。截图里的“未启动”表示 Partner Center 的某个提交模块还没有填写或上传，不表示 GitHub 代码缺失，也不会由合并 GitHub PR 自动填充。

| 内容 | 应放在哪里 | 是否进入 GitHub PR |
| --- | --- | --- |
| Store 清单、包身份、构建和校验脚本 | 源码仓库 | 是 |
| 隐私政策、支持入口、Store 文案和提交说明 | 源码仓库 | 是 |
| Store 截图 PNG、MSIX、哈希清单 | `release-assets/` 或 Actions artifact | 否；本地目录被忽略，MSIX 上传 Partner Center |
| Partner Center 草稿、价格、年龄分级、认证状态 | Microsoft 账号后台 | 否 |
| 最终提交认证和 Store 发布结果 | Microsoft Store | 否 |

Partner Center 的认证报告是拒绝原因的唯一依据。当前报告只列出 `10.1.1.1 Inaccurate Representation`：旧产品名称含有另一软件或服务的标题。`Signalman AI` 已在同一产品的“管理应用名称”页面预留；新提交必须使用该名称，并清理商店页面、MSIX 显示名和截图中的旧名称。

## 已确定的产品信息

| 字段 | 值 |
| --- | --- |
| 产品名称 | Signalman AI |
| 产品类型 | Windows 桌面应用 |
| Store ID | `9P7PGV62WKK6` |
| 包身份 | `ga626.CodexProviderSwitcher` |
| 当前候选版本 | `0.8.0.0`（产品版本 `0.8.0-alpha`） |
| 支持入口 | <https://github.com/ga626/codex-provider-switcher/issues> |
| 隐私政策 | <https://github.com/ga626/codex-provider-switcher/blob/main/docs/user/privacy-policy.zh.md> |
| 发布物 | GitHub Actions 的 `microsoft-store-msix-v0.8.0-alpha` artifact 中的 `.msix` |
| 发布方式 | 免费、公开可发现；不做预购、内购或广告 |

隐私政策链接要在本 PR 合并到 `main` 后再用于 Partner Center。当前候选 MSIX 的 SHA-256 记录在本机忽略目录的资产清单中，不把临时下载物提交进 Git。

## 中文 Store 一览

### 简短说明

在写入本机配置前验证 provider，并用备份与恢复点安全切换。

### 完整说明

Signalman AI 是 Windows 上的本地 provider 管理工具。

它把手工编辑本机 provider 配置的过程收进一个桌面窗口：保存多个 provider 配置，刷新服务商实际返回的模型目录，在切换前运行一次真实的短时可用性测试，确认后自动创建恢复点，再执行切换。

主要能力：

- 管理多个本地 provider 配置；
- 从服务商刷新可见模型并选择当前模型；
- 用一次短时、已认证的 Responses 请求检查地址、密钥、模型和协议是否能工作；
- 写入前备份 Codex 配置，支持查看活动记录和恢复最近备份；
- Store 安装版由 Microsoft Store 管理更新，不要求用户输入私钥、口令或发布配置。

应用不会替你决定第三方服务商是否值得信任，也不能用一次短请求替代长上下文、工具调用和真实工作验收。API key 由用户自行提供，只用于连接用户选择的 provider，并按 [隐私政策](../user/privacy-policy.zh.md) 处理。

### 功能要点

- provider 配置与切换
- 模型目录刷新
- 切换前可用性测试
- 配置备份与恢复
- 本地活动记录

### 搜索关键词

AI、provider、API、模型、配置切换、备份恢复、Windows、Responses

### 当前版本发行说明

Signalman AI 首次提供 Microsoft Store MSIX 交付准备。Store 安装版使用与 Partner Center 绑定的既有包身份，由 Microsoft Store 管理签名和更新；应用不要求用户输入私钥或口令。provider 配置、模型目录、切换前可用性测试、备份恢复和本地活动记录保持可用。

## Partner Center 页面值

以下是提交时的建议值。带“需要你确认”的项目不能由代码推断，不能由自动化脚本替你作法律或商业声明。

| 页面 | 建议值 | 状态 |
| --- | --- | --- |
| 定价和可用性 | 免费；全球所有市场；开放受众；在 Store 中可发现 | 需要你确认商业选择后保存 |
| 属性 | 类别选择“开发人员工具”；支持入口使用 GitHub Issues；隐私 URL 使用上表链接 | 类别可直接填写，最终保存仍由你确认 |
| 年龄分级 | 按实际内容问卷作答；本项目不包含游戏、赌博、成人内容或广告 | 必须由你完成问卷并确认 |
| 程序包 | 上传 tag workflow 产生的 unsigned MSIX | 可由 Codex 准备和校验 |
| Store 一览 | 中文（简体）：使用本页文案、至少 4 张桌面截图 | 可由 Codex 准备，提交前由你预览 |
| 提交选项 | 认证通过后按你的选择发布；首次提交不要在未检查页面时直接提交 | 必须由你最终确认 |

### 受限能力说明

这个 MSIX 是完整桌面程序，因此保留 `runFullTrust`。它不是包验证失败的原因，而是 Partner Center 可能要求补充说明的审核项。若“提交选项”出现该字段，填入以下内容：

> Signalman AI is a packaged desktop application. It needs full-trust desktop access only to read and update the current Windows user's selected local provider configuration and credential files, protect provider credentials with Windows DPAPI, and create or restore user-requested local backups. These actions occur only after the user invokes them in the app. The app does not install drivers or services, request elevation, or access files outside the user's selected local provider data.

不要为了消除警告删除此能力。删除后，应用无法按产品承诺读写本地 Codex 配置、保护凭据和执行备份恢复。

截图中显示的状态可以这样理解：

- “属性：未启动”：尚未填写类别、支持 URL、隐私 URL 等属性；不是 GitHub PR 状态。
- “包：未启动”：还没有把 MSIX 上传到这个提交；使用 tag workflow 产生的 `.msix`，不要上传源码目录或本地开发构建。
- “Store 一览：未启动”：还没有创建中文（简体）商店页面；使用本页文案和截图。
- “年龄分级”：必须完成 Microsoft 的内容问卷；这属于账号持有人的法律/内容声明，不能由代码推断。
- “定价和可用性”：此前页面的红色提示说明免费产品也必须创建价格计划；选择免费并保存价格计划后，才能消除该阻断。
- “提交选项”：是认证说明和发布日期等可选设置，不是 GitHub 提交按钮。

不要直接点击“提交进行认证”来试错。先让所有必填模块完成，再预览整页；按钮能点击不代表包、年龄分级和 Store 一览已经通过校验。

## 截图

运行以下命令生成安全示例截图：

```powershell
npm run store:listing-assets
```

输出目录为被 `.gitignore` 忽略的 `release-assets/store-listing/<version>/`，包含：

- `01-providers.png`：provider 配置管理；
- `02-models.png`：模型目录；
- `03-safety.png`：安全检查和恢复边界；
- `04-activity.png`：活动记录；
- `manifest.json`：尺寸、SHA-256、生成模式和敏感内容检查结果。

这些图片使用仓库内的示例数据，不连接真实服务商，不包含真实 API key、本机用户名、私有路径或用户截图。它们是 Store 展示材料，不代表已对真实 provider 完成可用性验收。

## 发布前不可跳过的验证

1. 先运行 Windows App Certification Kit，并保存技术检查结果；它不能替代商店内容审核。
2. 在 GitHub Actions 下载与 tag 对应的 MSIX，并运行 `npm run store:verify-package` 校验身份、架构、版本、入口文件和包内的 `runFullTrust` 声明。包内 `Identity Version` 的最后一段必须为 `0`；新包必须高于此前已提交的 Store 版本。
3. 在 Partner Center 预览产品名称、说明、截图、隐私和支持链接，确认所有商店可见材料使用 Signalman AI，没有把开发命令展示给普通用户。
4. 提交认证后等待 Microsoft Store 完成认证；MSIX 的正式签名由 Store 完成，不需要购买证书或配置 PFX。
5. 认证通过后，从 Microsoft Store 产品页安装，而不是从源码目录或 Actions 临时 artifact 安装。
6. 启动、关闭、检查更新、provider 读取、模型刷新、可用性测试和备份恢复各验收一次；确认没有 CMD 窗口或后台常驻进程。
7. 只有普通用户路径验收通过，状态才可以写成“产品已交付”。

## 仍需用户完成的动作

### Codex 可以完成

- 审计源码、工作流、包身份和版本映射；
- 写入并维护隐私政策、支持入口、Store 文案和提交手册；
- 生成无敏感信息的 Store 截图；
- 构建、下载、校验 MSIX，记录 SHA-256，并整理上传材料；
- 在 PR 创建后检查 CI、冲突、评审意见和包 artifact；
- 在你打开 Partner Center 后，按页面逐项解释该填什么，并复核你填入的值。

### 必须由你完成

- 登录并操作 Partner Center 账号；
- 确认免费、全球市场、公开可发现和发布日期；
- 对年龄分级问卷作出真实声明；
- 预览隐私政策、支持入口、文案和截图；
- 点击“提交进行认证”，处理 Microsoft 认证反馈；
- 认证通过后从 Microsoft Store 安装并确认最终用户体验。

Codex 不能替账号持有人作法律、商业或内容声明，也不能在没有明确授权和可用的已登录 Partner Center 操作通道时代点最终认证。即使技术上可以协助填写页面，也必须在最终提交按钮前停下，由你确认后提交。
