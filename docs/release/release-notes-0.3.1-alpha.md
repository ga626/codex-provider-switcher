# CodeX Provider Switcher 0.3.1-alpha 发布说明

这是 `0.3.0-alpha` 安装入口的紧急修复版本。

## 修复内容

- 修正 Tauri CLI 的二进制选择参数。
- Windows setup 现在安装并启动真正的桌面 GUI，不再把 `local_backend` 当作桌面入口。
- 本地 Web 后端仍作为 fallback 单独构建，不会进入桌面安装器的主 exe。
- 增加 smoke 检查，防止 `--bin` 再次被错误传入应用参数。
- 修复桌面功能检查调用 `tasklist.exe` 时弹出黑色子窗口的问题。
- NSIS 安装器固定使用简体中文，并加入 CodeX Provider Switcher 品牌页眉和侧栏视觉。
- 发布构建会清理旧的 updater 签名残留，避免错误复用过期签名。

## 下载建议

优先下载：

```text
CodeXProviderSwitcher-windows-x64-0.3.1-alpha-setup.exe
CodeXProviderSwitcher-windows-x64-0.3.1-alpha-setup.exe.sha256
```

更新通道资产：

```text
latest.json
CodeXProviderSwitcher-windows-x64-0.3.1-alpha-setup.exe.sig
```

旧的 `v0.3.0-alpha` 安装包存在入口错误，不应继续安装或作为稳定版使用；本版本使用新 tag 发布，不覆盖旧 Release。
