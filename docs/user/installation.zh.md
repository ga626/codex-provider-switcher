# 安装与启动

`CodeX Provider Switcher` 当前是 alpha 项目。正式产品路线是轻量本地 Web 控制台：启动器静默启动本地后端，浏览器打开控制台页面。

当前 `0.1.0-alpha` 提供 Windows zip 包：解压后双击启动脚本，脚本会静默启动本地后端并打开浏览器控制台。它还不是正式安装器，也不会自动替换旧版工具。

## Release 包启动

1. 打开 GitHub Release 页面：

```text
https://github.com/ga626/codex-provider-switcher/releases/tag/v0.1.0-alpha
```

2. 下载 `CodeXProviderSwitcher-windows-x64-0.1.0-alpha.zip` 和对应 `.sha256`。
3. 解压 zip 到一个普通目录。
4. 进入解压出的 `CodeXProviderSwitcher-windows-x64-0.1.0-alpha` 目录。
5. 双击 `CodeXProviderSwitcher.cmd`。
6. 浏览器会打开：

```text
http://127.0.0.1:47832/
```

停止本地后端：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\CodeXProviderSwitcher.ps1 -Stop
```

## 开发预览

开发预览使用浏览器 UI-only 假数据，不会连接真实本地后端，也不会代表最终产品体验。

安装依赖：

```powershell
npm install
```

启动并打开本地预览：

```powershell
npm run preview:start
```

停止预览：

```powershell
npm run preview:stop
```

## 源码树便捷启动

如果你是从 GitHub 源码仓库运行，而不是从 Release zip 运行，可以双击根目录的 `setup.cmd`，或执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Apply
```

这个入口会在需要时安装依赖、构建前端、构建本地后端，然后启动真实本地 Web 控制台。它不会使用 UI-only mock 预览。

## 真实本地 Web 后端开发入口

该入口会服务 `dist/` 前端，并通过同源 `/api/*` 调用本机真实后端。开发入口和 Release 包使用同一套本地后端能力。

先构建前端和后端：

```powershell
npm run build
npm run backend:build
```

启动真实本地 Web 后端：

```powershell
npm run backend:dev -- --port 47832
```

打开：

```text
http://127.0.0.1:47832/
```

只读验证：

```powershell
npm run backend:smoke
npm run backend:ui-smoke
```

## Release 包预期

Windows Release 包提供：

- 双击启动入口。
- 静默本地后端。
- 浏览器本地控制台。
- 基础备份、恢复、验证和回滚入口。
- 版本说明和校验文件。

它仍是 alpha，不应把新版工具声明为已经替换旧版 `CodeX-Switcher.exe`。
