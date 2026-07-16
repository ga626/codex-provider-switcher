# 安装与启动

`CodeX Provider Switcher` 当前是 alpha 项目。正式产品路线是 Windows-first 轻量桌面 GUI：桌面安装包启动一个正常应用窗口，默认不弹常驻 CMD、不打开外部浏览器、不要求用户理解端口。

当前 `0.3.1-alpha` 提供 Windows setup exe、签名更新资产和 fallback zip。桌面安装包是推荐入口；fallback zip 保留给排障、开发和本地 Web 诊断。它不会自动替换旧版工具。

项目固定区分三种状态：开发版随源码变化，候选版只在仓库 `release-assets/` 中用于验收，稳定版安装在 `D:\Software\CodeX Provider Switcher`，只随合并后的新 GitHub Release 更新。

## 开发中怎么看当前版本

如果你参与开发，通常不需要每个 PR 都下载安装包。普通功能、UI、布局和文案验收应直接打开当前源码树里的桌面应用：

```powershell
npm run qa:dev-desktop
```

这个状态叫“开发版验收”：它不安装、不卸载、不升级，也不会使用 GitHub Release 包。预期行为仍然是打开一个 `CodeX Provider Switcher` 桌面窗口，不弹常驻 CMD，不自动打开外部浏览器。

只有安装器、Release 包、版本号、启动入口、升级/卸载路径或用户下载入口变化时，才进入“安装发布验收”。

## 桌面安装包启动

1. 打开 GitHub Release 页面：

```text
https://github.com/ga626/codex-provider-switcher/releases/tag/v0.3.1-alpha
```

2. 优先下载 `CodeXProviderSwitcher-windows-x64-0.3.1-alpha-setup.exe` 和对应 `.sha256`。
3. 安装后从开始菜单或桌面图标打开 `CodeX Provider Switcher`。
4. 预期行为：打开一个桌面窗口，不弹常驻 CMD，不自动打开外部浏览器。

## fallback zip 启动

fallback zip 用于排障和本地 Web 诊断，不是推荐入口。

1. 下载 `CodeXProviderSwitcher-windows-x64-0.3.1-alpha.zip` 和对应 `.sha256`。
2. 解压 zip 到一个普通目录。
3. 进入解压出的 `CodeXProviderSwitcher-windows-x64-0.3.1-alpha` 目录。
4. 双击 `CodeXProviderSwitcher.cmd`。
5. 浏览器会打开：

```text
http://127.0.0.1:47832/
```

停止本地后端：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\CodeXProviderSwitcher.ps1 -Stop
```

## 开发预览

开发预览使用浏览器 UI-only 假数据，不会连接真实本地后端，也不会代表最终产品体验。它只用于界面 smoke 或调试，不能替代开发版桌面验收。

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

- 桌面 setup exe。
- 单窗口桌面 GUI。
- fallback Web zip、启动脚本和静默本地后端。
- 基础备份、恢复、验证和回滚入口。
- 版本说明和校验文件。

## 稳定版升级和卸载

稳定版安装后，应用内的“检查更新”只连接项目 GitHub Release 的签名更新 manifest。发现新版本时，应用下载并校验签名，完成安装后重启；它不会从开发目录读取资产，也不会把开发版变成稳定版。

升级不会删除以下用户数据：

```text
%LOCALAPPDATA%\CodeX Provider Switcher\profiles.json
%LOCALAPPDATA%\CodeX Provider Switcher\backups\
%LOCALAPPDATA%\CodeX Provider Switcher\activity.json
```

卸载只移除程序目录和快捷方式。重新安装同一应用仍应看到原有用户数据；如果要清理用户数据，必须由用户单独删除上述目录，并先确认备份已经导出。

它仍是 alpha，不应把新版工具声明为已经替换旧版 `CodeX-Switcher.exe`。
