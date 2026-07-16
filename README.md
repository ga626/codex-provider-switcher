# CodeX Provider Switcher

`CodeX Provider Switcher` is a local-first tool for managing Codex provider profiles, validating configuration, and switching safely with backups and recovery.

当前主路线是 Windows-first 轻量桌面 GUI：通过桌面安装包启动一个正常应用窗口，默认不弹常驻 CMD、不打开外部浏览器、不要求用户理解端口。原本的本地 Web 控制台继续保留为开发、诊断和 fallback 入口。

## 当前状态

这是 `0.3.1-alpha`：可稳定安装、可按 GitHub Release 更新的桌面 Alpha 基线：

- React/Vite 前端。
- Tauri/Rust 桌面窗口、本地文件、profiles、backup、validation、restore 基础。
- Provider 模型目录缓存和只读 `/models` 刷新入口。
- Windows 桌面安装资产：setup exe。
- Tauri 签名更新通道：正式 Release 生成 `latest.json`、签名 setup 更新包和 `.sig` 文件；没有发布私钥时不会生成可冒充正式版的更新资产。
- 正式发布由 GitHub Actions 在推送新 `v*` 标签后完成；用户不需要密钥或口令。Alpha 版本仍使用新版本号和新 tag，但 GitHub Release 必须保持 `Latest`，以便自动更新地址可用。
- fallback alpha zip：包含 `CodeXProviderSwitcher.cmd`、静默本地后端 `local_backend.exe` 和 `dist/` 前端资源。
- 浏览器 UI-only mock adapter，仅用于 `preview:start` 这种显式开发预览；Release 包和真实本地后端入口不会静默回落到假数据。
- Playwright UI smoke flow。
- GitHub CI、PR/Issue 模板、项目规则、安全策略和发布脚本。

[下载 0.3.1-alpha](https://github.com/ga626/codex-provider-switcher/releases/tag/v0.3.1-alpha) · [安装与启动](docs/user/installation.zh.md) · [排错指南](docs/user/troubleshooting.zh.md)

## 开发验收方式

本项目固定使用三种状态：

- 开发版：当前源码树里的桌面应用，不安装、不升级、不跟随 GitHub Release，普通功能和 UI 验收使用它。
- 候选版：`release-assets/` 下的本地构建产物，只用于 Codex 的结构、哈希和安装 QA，不是稳定产品入口。
- 稳定版：从 GitHub Release 下载并安装到本机固定目录 `D:\Software\CodeX Provider Switcher`；只有合并后的新版本 Release 才能更新它。

开发版验收命令：

```powershell
npm run qa:dev-desktop
```

安装发布验收准备命令：

```powershell
npm run release:build -- -Apply
npm run qa:install-release -- -Collect
npm run qa:stable-install -- -ExplainOnly
```

`.codex-provider-switcher\qa\latest\` 会放置本机临时验收资产，属于本地输出目录，不进入 Git。普通开发过程中不需要反复安装；当用户说“看一下状态”时，默认应打开开发版桌面窗口。

本版本明确保留的后续边界：

- Codex/Responses 与中转站模型名的完整行为兼容验证策略。
- 旧版工具最终 cutover。
- UI 信息架构重构。

## 旧版工具边界

旧版工具仍然是参考源和回滚源：

本仓库不会直接覆盖旧版 `CodeX-Switcher.exe` 或旧版本机目录。只有当新版完成启动、验证、备份、恢复、回滚、模型发现和最终交接包之后，才进入受控替换阶段。

## 开发命令

安装依赖：

```powershell
npm install
```

源码树一键启动真实本地 Web 后端：

```powershell
.\setup.cmd
```

该入口会在需要时构建前端和 `local_backend`，然后调用 `CodeXProviderSwitcher.ps1`，固定打开 `http://127.0.0.1:47832/`。它不是 UI-only mock 预览。

启动 Tauri 桌面应用：

```powershell
npm run qa:dev-desktop
```

该入口用于开发版验收：直接打开当前源码树的桌面窗口，不安装、不升级、不卸载。

打包桌面安装资产：

```powershell
npm run tauri:build
```

启动并打开本地预览：

```powershell
npm run preview:start
```

该入口只用于开发阶段检查 UI mock，不代表真实产品运行态。真实产品入口如果连不上本地后端，会显示明确错误，不会展示假 provider 或假模型。

停止预览：

```powershell
npm run preview:stop
```

启动前端开发服务：

```powershell
npm run dev -- --host 127.0.0.1 --port 5173
```

构建前端：

```powershell
npm run build
```

运行 lint：

```powershell
npm run lint
```

运行仓库 doctor：

```powershell
npm run verify:doctor
```

运行 UI smoke：

```powershell
npm run qa:smoke
```

UI smoke 默认运行在浏览器预览假数据上，只证明界面流程没有明显断裂；预览会明确标注它不会连接、验证或切换真实服务商。它不能替代开发版桌面验收；真实本地能力还要通过本地 Web 后端、Tauri/Rust 检查或 release 包验收。

验证生产构建不会在后端缺失时回落假数据：

```powershell
npm run runtime-boundary:smoke
```

构建并验证本地 Web 后端：

```powershell
npm run build
npm run backend:build
npm run backend:smoke
```

运行隔离的真实功能 smoke。它会调用测试服务商的已认证 `/models` 探针，并用 DasuAPI 类请求夹具验证额度不足时不会误判或写入 Codex 配置；A6/OWL 探针不依赖当前模型：

```powershell
npm run backend:functional-smoke
```

开发时启动真实本地 Web 后端：

```powershell
npm run backend:dev -- --port 47832
```

然后打开：

```text
http://127.0.0.1:47832/
```

该入口会服务 `dist/` 前端，并通过同源 `/api/*` 调用本机真实后端；它不同于 `preview:start` 的 UI-only 假数据。

Rust/Tauri 检查：

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri:desktop-boundary:smoke
```

桌面应用必须保持单窗口、默认无托盘、无开机自启动、关闭即退出。本地 Web 后端入口只作为开发、诊断和 fallback。

## Release 脚本

预览 Release 包计划：

```powershell
npm run release:build
```

实际构建桌面安装资产、签名更新资产、fallback zip 和 SHA256。该命令要求 `TAURI_SIGNING_PRIVATE_KEY_PATH` 或 `TAURI_SIGNING_PRIVATE_KEY` 已在本机/CI secret 中配置：

```powershell
npm run release:build -- -Apply
npm run qa:install-release -- -Collect
```

解压并按普通用户路径验证本地 zip：

```powershell
npm run release:verify-local
```

稳定安装 QA（默认只解释，不启动安装器）：

```powershell
npm run qa:stable-install -- -ExplainOnly
npm run qa:stable-install -- -Apply
```

升级时对同一安装目录再次执行同一版本的 setup 入口；卸载使用：

```powershell
npm run qa:stable-install -- -Uninstall -Apply
```

卸载脚本只验证程序目录移除，不删除 `%LOCALAPPDATA%\CodeX Provider Switcher` 中的 profiles、备份和活动数据。

发布后的远端资产复验：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\release\verify-github-release-asset.ps1
```

## 数据位置

Alpha 应用状态：

```text
%LOCALAPPDATA%\CodeX Provider Switcher\profiles.json
%LOCALAPPDATA%\CodeX Provider Switcher\backups\
%LOCALAPPDATA%\CodeX Provider Switcher\update-cache\
```

切换时会触碰的 Codex 文件：

```text
C:\Users\<user>\.codex\config.toml
C:\Users\<user>\.codex\auth.json
```

真实 `profiles.json`、`auth.json`、`config.toml`、备份、日志和本机截图都不应提交到仓库或发布包。

## 安全规则

切换必须保留：

- `model_provider = "custom"`
- `[model_providers.custom].wire_api = "responses"`
- `disable_response_storage = true`
- projects
- features
- desktop
- memories
- MCP servers
- plugins
- windows settings
- marketplaces

应用保存后不能明文显示已存 API 密钥。最终 provider cutover 不应由正在运行的同一个 Codex 会话直接执行，需要新会话或另一个 agent 根据交接包完成。

## 文档

- `docs/product-spec.md`
- `docs/user/installation.zh.md`
- `docs/user/troubleshooting.zh.md`
- `docs/release/github-publish-runbook.md`
- `docs/release/release-checklist.md`
- `release-assets/`：本地发布资产目录（被 Git 忽略）
