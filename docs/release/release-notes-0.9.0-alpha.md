# Signalman AI 0.9.0-alpha 发布说明

## 这次更新

`0.9.0-alpha` 将交付方式整理为两条明确路径：

- **GitHub Releases**：日常公开小版本和应用内签名更新。安装包没有 Windows Authenticode 时，首次下载可能出现 SmartScreen 提示；请只从官方 Release 下载并核对同版本 SHA256 文件。
- **Microsoft Store**：低频稳定大版本。Store 版由 Microsoft Store 管理签名和更新，版本可能晚于 GitHub。

这不是两个不同的软件。两条路径来自同一份已验证源码，但不要在同一台电脑把 GitHub、Store、开发版和维护者候选版混作日常入口。

## 用户能看到的变化

- README 和安装说明现在先说明 GitHub 最新版与 Store 稳定版的差异。
- GitHub 安装版的应用内更新明确使用 GitHub Release；Store 安装版只打开 Store 更新入口。
- 已知的 Windows SmartScreen 边界已写入安装与排错说明，不再承诺 GitHub 直装无提示。

## 维护者变化

- GitHub Release workflow 在新 `v0.9.0-alpha` tag 上构建 `stable` 更新通道，只要求 Tauri updater 签名 Secret，不要求 Windows PFX。
- Store MSIX 仅由维护者手动选择已经完成 GitHub 验收的 tag 构建，不再随每个 PR 或 tag 自动产生待上传包。
- 维护者本机 GitHub 稳定安装目录为 `D:\Software\Signalman AI`，候选目录为 `D:\Software\Signalman AI Candidate`。候选刷新只处理自身入口和卸载登记。

## 发布边界

本说明属于发布准备，不代表 `0.9.0-alpha` 已经在 GitHub 或 Microsoft Store 交付。只有对应渠道完成普通用户下载、安装、启动和更新验收后，才能标记为已交付。
