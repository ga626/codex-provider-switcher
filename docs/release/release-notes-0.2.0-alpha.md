# CodeX Provider Switcher 0.2.0-alpha 发布说明

`0.2.0-alpha` 是轻量桌面 GUI 基座版本。它把用户主入口从浏览器本地控制台收束为桌面应用窗口，同时保留本地 Web 控制台作为 fallback 和诊断入口。

## 主要变化

- 新增 Windows 桌面安装资产：setup exe。
- Tauri 桌面入口保持单窗口应用形态。
- 默认不安装托盘图标。
- 默认不接入开机自启动。
- 关闭窗口后应退出应用，不作为 24 小时后台 daemon。
- Tauri 状态继续通过原生命令返回 `tauri_native`。
- 本地 Web fallback zip 继续提供 `CodeXProviderSwitcher.cmd`、`local_backend.exe` 和 `dist/`。
- 发布脚本会同时生成桌面安装资产、fallback zip 和 SHA256。
- CI 增加桌面边界 smoke，防止默认 tray/autostart 回归。

## 下载建议

优先下载：

```text
CodeXProviderSwitcher-windows-x64-0.2.0-alpha-setup.exe
CodeXProviderSwitcher-windows-x64-0.2.0-alpha-setup.exe.sha256
```

fallback 和排障入口：

```text
CodeXProviderSwitcher-windows-x64-0.2.0-alpha.zip
CodeXProviderSwitcher-windows-x64-0.2.0-alpha.zip.sha256
```

## 仍然保留的边界

- 这是 alpha，不会自动替换旧版 `CodeX-Switcher.exe`。
- 自动更新器尚未接入；未来需要签名和更新包策略稳定后再开放。
- 模型发现、Responses/Codex 兼容验证和 UI 信息架构仍需后续 PR 打磨。
- 最终 provider cutover 不能由当前 Codex 会话直接执行，仍需要新会话或另一个 agent 根据交接包完成。
