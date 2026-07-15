# 排错指南

## 桌面应用打不开

如果你安装了桌面版，先从开始菜单或桌面图标启动 `CodeX Provider Switcher`。预期行为是打开一个正常桌面窗口，不需要浏览器和端口。

如果你是在开发中看当前 PR 或本地改动，先不要重新安装。运行：

```powershell
npm run qa:dev-desktop
```

这会打开当前源码树的桌面应用，用于开发版验收。只有安装器、Release 包、版本号、启动入口、升级/卸载路径变化时，才需要重新构建并运行 setup exe。

如果窗口没有出现：

- 确认下载的是 `CodeXProviderSwitcher-windows-x64-0.2.0-alpha-setup.exe`。
- 确认 Windows WebView2 Runtime 可用。多数 Windows 11/新版 Windows 10 已内置；缺失时需要安装 Microsoft Edge WebView2 Evergreen Runtime。
- 如果安装器被拦截，改用 fallback zip。

## fallback Web 页面打不开

如果你是从 fallback zip 启动，先确认是在解压出的 `CodeXProviderSwitcher-windows-x64-0.2.0-alpha` 目录里双击 `CodeXProviderSwitcher.cmd`。

固定入口是：

```text
http://127.0.0.1:47832/
```

如果页面没有自动打开，可以手动访问上面的地址。也可以先停止再启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\CodeXProviderSwitcher.ps1 -Stop
powershell -NoProfile -ExecutionPolicy Bypass -File .\CodeXProviderSwitcher.ps1
```

如果你是从源码树启动，优先使用真实本地 Web 后端入口：

```powershell
.\setup.cmd
```

如果只是检查 UI mock，再确认本地预览是否启动：

```powershell
npm run preview:start
```

这不是桌面产品验收，只用于浏览器 mock 调试。

如果端口被占用，脚本会尝试 `5173`、`5174`、`5175`、`5180`、`3000`、`3001`。

也可以手动构建并启动真实本地 Web 后端：

```powershell
npm run build
npm run backend:build
npm run backend:dev -- --port 47832
```

然后打开：

```text
http://127.0.0.1:47832/
```

## 看到“真实本地后端不可用”

这表示当前页面不是通过真实本地后端正常加载。产品入口不会回落到浏览器假数据。

优先使用以下入口：

```powershell
.\CodeXProviderSwitcher.cmd
```

或源码树入口：

```powershell
.\setup.cmd
```

开发预览中的 UI-only 假数据只用于界面检查，不代表真实产品运行态。

## 构建失败

重新安装依赖并构建：

```powershell
npm ci
npm run build
```

## Tauri/Rust 检查失败

确认 Rust 工具链可用：

```powershell
cargo --version
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri:desktop-boundary:smoke
```

## provider 切换失败

不要直接手工覆盖 `config.toml` 或 `auth.json`。先确认是否已有备份和恢复路径。涉及真实 Codex provider 切换时，应使用新会话或另一个 agent 执行最终 cutover。

## 不要提交的信息

不要把真实 API key、`auth.json`、真实 `profiles.json`、备份目录、截图或本机私有日志贴到 Issue、PR 或公开文档里。
