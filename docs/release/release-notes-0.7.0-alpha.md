# CodeX Provider Switcher 0.7.0-alpha 发布说明

## 摘要

本版本建立 Microsoft Store 优先的 Windows 交付链路。它会把同一份桌面应用打成带 Partner Center 身份的 MSIX，并让 Store 安装版由 Microsoft Store 负责签名和更新；GitHub setup 保留为具备完整双签名条件时的受控备用渠道。

## 主要改动

- 新增 Store MSIX 清单，绑定 Partner Center 已分配的应用身份、发布者和 Store ID。
- 产品 SemVer 会映射为四段 MSIX 版本；无法映射或版本来源不一致时停止构建。
- 新增 tag 触发的 `Microsoft Store package` workflow，构建 MSIX 并作为 Actions artifact 交给维护者上传 Partner Center；它不会自行创建提交或发布商店版本。
- Store 渠道编译时不初始化 GitHub updater，应用中的更新入口会打开对应的 Microsoft Store 页面。
- GitHub 直装 workflow 改为手动运行，继续要求 updater 签名和 Windows Authenticode 签名，避免没有商业证书时阻塞 Store 发布。
- README、安装、排错、贡献和维护文档统一了“当前交付状态”和“Store 认证后状态”，不提前把未认证的 Store 页面写成下载入口。

## 用户影响

在 Store 认证完成前，当前已发布的 GitHub alpha 安装版仍是实际下载入口。本版本合并和打 tag 后会先生成 Partner Center 上传包；只有认证通过、Store 页面出现新版本并完成普通用户安装验收后，Microsoft Store 才成为正式安装入口。

Store 安装版不要求用户输入私钥、口令或发布配置。Store 将管理更新；GitHub setup 仅在维护者明确提供受控直装方案时使用。

## 发布后验收

1. 创建并推送 `v0.7.0-alpha` tag，等待 `Microsoft Store package` workflow 生成 MSIX artifact。
2. 下载 artifact，在 Partner Center 为 Store ID `9P7PGV62WKK6` 创建提交并上传 MSIX，完成必需的商店资料后提交认证。
3. 认证通过后，从 Microsoft Store 安装 `0.7.0-alpha`，确认只有一个桌面窗口、没有 CMD 常驻，并在应用中打开“在 Store 检查更新”。
4. 确认 provider 配置、用户数据和恢复点保持正常；最终 provider cutover 仍必须在新的 Codex 会话中按只读交接预检执行。
