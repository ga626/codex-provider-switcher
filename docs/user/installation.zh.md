# 安装与启动

`CodeX Provider Switcher` 当前是 alpha 项目。正式产品路线是 Windows-first 轻量桌面 GUI：桌面安装包启动一个正常应用窗口，默认不弹常驻 CMD、不打开外部浏览器、不要求用户理解端口。

当前已发布版本以 GitHub Releases 的 Latest 标记为准。桌面 setup 是推荐入口；fallback zip 只保留给排障和本地 Web 诊断。源码树不会自动替换旧工具。

`0.3.2-alpha` 和 `0.4.0-alpha` 已安装用户需要先从 `0.5.0-alpha` Release 手动安装一次。`0.6.0-alpha` 发布时，应从已安装的 `0.5.0-alpha` 完成一次真实应用内升级验收，包括下载、签名校验、重启、版本变化和用户数据保留。

项目固定区分三种状态：开发版随源码变化，候选版只在仓库 `release-assets/` 中用于验收，稳定版安装在 `D:\Software\CodeX Provider Switcher`，只随合并后的新 GitHub Release 更新。

## 开发中怎么看当前版本

如果你参与开发，通常不需要每个 PR 都下载安装包。普通功能、UI、布局和文案验收应直接打开当前源码树里的桌面应用：

```powershell
npm run qa:dev-desktop
```

这个状态叫“开发版验收”：它不安装、不卸载、不升级，也不会使用 GitHub Release 包。预期行为仍然是打开一个 `CodeX Provider Switcher` 桌面窗口，不弹常驻 CMD，不自动打开外部浏览器。

只有安装器、Release 包、版本号、启动入口、升级/卸载路径或用户下载入口变化时，才进入“安装发布验收”。

## 桌面安装包启动

1. 打开 GitHub Latest Release 页面：

```text
https://github.com/ga626/codex-provider-switcher/releases/latest
```

2. 优先下载名称中带当前版本的 `CodeXProviderSwitcher-windows-x64-<version>-setup.exe` 和对应 `.sha256`。
3. 安装后从开始菜单或桌面图标打开 `CodeX Provider Switcher`。
4. 预期行为：打开一个桌面窗口，不弹常驻 CMD，不自动打开外部浏览器。

## fallback zip 启动

fallback zip 用于排障和本地 Web 诊断，不是推荐入口。

1. 下载名称中带当前版本的 `CodeXProviderSwitcher-windows-x64-<version>.zip` 和对应 `.sha256`。
2. 解压 zip 到一个普通目录。
3. 进入解压出的 `CodeXProviderSwitcher-windows-x64-<version>` 目录。
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

provider 密钥和应用创建的恢复副本使用当前 Windows 用户的 DPAPI 保护。不要把该目录复制到其他 Windows 账号后直接使用；需要迁移时应在原账号按发布说明完成受控迁移。

卸载只移除程序目录和快捷方式。重新安装同一应用仍应看到原有用户数据；如果要清理用户数据，必须由用户单独删除上述目录，并先确认备份已经导出。

它仍是 alpha。本机替换属于发布后的独立验收，不是应用内页面或自动迁移功能。

## 恢复最近备份

“安全检查”会显示最近恢复点。恢复前会要求确认，恢复的是该应用在切换前创建的 Codex 配置和凭据备份。

恢复完成后，可按需运行目标服务商的可用性测试。恢复操作、模型目录或单次测试都不是 provider 实际可用性的唯一证明，应以独立会话中的实际 Codex 使用完成最终判断。
