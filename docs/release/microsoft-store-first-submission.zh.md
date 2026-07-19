# Microsoft Store 首次提交材料

这份材料用于把 `v0.7.0-alpha` 的 Store MSIX 提交到 Partner Center。它把能由项目确定的内容写死，把商业、法律和最终发布动作单独留给产品所有者确认。

## 已确定的产品信息

| 字段 | 值 |
| --- | --- |
| 产品名称 | CodeX Provider Switcher |
| 产品类型 | Windows 桌面应用 |
| Store ID | `9P7PGV62WKK6` |
| 包身份 | `ga626.CodexProviderSwitcher` |
| 当前候选版本 | `0.7.0.100`（产品版本 `0.7.0-alpha`） |
| 支持入口 | <https://github.com/ga626/codex-provider-switcher/issues> |
| 隐私政策 | <https://github.com/ga626/codex-provider-switcher/blob/main/docs/user/privacy-policy.zh.md> |
| 发布物 | GitHub Actions 的 `microsoft-store-msix-v0.7.0-alpha` artifact 中的 `.msix` |
| 发布方式 | 免费、公开可发现；不做预购、内购或广告 |

隐私政策链接要在本 PR 合并到 `main` 后再用于 Partner Center。当前候选 MSIX 的 SHA-256 记录在本机忽略目录的资产清单中，不把临时下载物提交进 Git。

## 中文 Store 一览

### 简短说明

在写入 Codex 配置前验证 provider，并用备份与恢复点安全切换。

### 完整说明

CodeX Provider Switcher 是给 Windows 上 Codex 用户使用的本地 provider 管理工具。

它把手工编辑 `config.toml` 和 `auth.json` 的过程收进一个桌面窗口：保存多个 provider 配置，刷新服务商实际返回的模型目录，在切换前运行一次真实的短时可用性测试，确认后自动创建恢复点，再执行切换。

主要能力：

- 管理多个 Codex provider 配置；
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

Codex、provider、API、模型、配置切换、备份恢复、Windows、Responses

### 当前版本发行说明

首次提供 Microsoft Store MSIX 交付准备。Store 安装版使用与 Partner Center 绑定的包身份，由 Microsoft Store 管理签名和更新；应用不要求用户输入私钥或口令。provider 配置、模型目录、切换前可用性测试、备份恢复和本地活动记录保持可用。

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

1. 先在 GitHub Actions 下载与 tag 对应的 MSIX，并运行 `npm run store:verify-package` 校验身份、架构、版本和入口文件。
2. 在 Partner Center 预览产品名称、说明、截图、隐私和支持链接，确认没有把开发命令展示给普通用户。
3. 提交认证后等待 Microsoft Store 完成认证；MSIX 的正式签名由 Store 完成，不需要购买证书或配置 PFX。
4. 认证通过后，从 Microsoft Store 产品页安装，而不是从源码目录或 Actions 临时 artifact 安装。
5. 启动、关闭、检查更新、provider 读取、模型刷新、可用性测试和备份恢复各验收一次；确认没有 CMD 窗口或后台常驻进程。
6. 只有普通用户路径验收通过，状态才可以写成“产品已交付”。

## 仍需用户完成的动作

用户只需要确认免费/全球/公开发布、隐私文案和支持入口，并在 Partner Center 完成年龄分级问卷、页面预览和最终提交认证。Codex 可以准备代码、文案、截图、MSIX 校验和填写所需的材料，但不能代替账号持有人作法律声明、商业定价选择或最终发布批准。
