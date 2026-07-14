# CodeX Provider Switcher

`CodeX Provider Switcher` is a local-first tool for managing Codex provider profiles, validating configuration, and switching safely with backups and recovery.

当前主路线是轻量本地 Web 控制台：双击启动器，静默启动本地后端，只监听 `127.0.0.1`，浏览器打开控制台页面。Tauri/Rust 保留为原生能力和未来安装包路线，但不再把“重桌面壳”作为当前唯一交付形态。

## 当前状态

这是 `0.1.0-alpha` 仓库基线：

- React/Vite 前端。
- Tauri/Rust 本地文件、profiles、backup、validation、restore 基础。
- Provider 模型目录缓存和只读 `/models` 刷新入口。
- 浏览器 UI-only mock adapter，仅用于不启动后端时检查界面；它不是产品真实运行态。
- Playwright UI smoke flow。
- GitHub CI、PR/Issue 模板、项目规则、安全策略和发布脚本。

尚未完成：

- 静默本地 Web 后端。
- 双击启动后无可见 CMD 的最终产品入口。
- Codex/Responses 与中转站模型名的完整兼容验证策略。
- Responses API 兼容性验证。
- 自动更新、备份、恢复、回滚的正式用户闭环。
- 旧版工具最终 cutover。
- UI 信息架构重构。

## 旧版工具边界

旧版工具仍然是参考源和回滚源：

```text
D:\AI Studio\CodeX\Codex Switcher
```

本仓库不会直接覆盖旧版 `CodeX-Switcher.exe`。只有当新版完成启动、验证、备份、恢复、回滚、模型发现和最终交接包之后，才进入受控替换阶段。

## 开发命令

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
$env:QA_OUTPUT_DIR="D:\Projects\CodeXProviderSwitcher\release\qa-smoke"
npm run qa:smoke
```

UI smoke 默认运行在浏览器预览假数据上，只证明界面流程没有明显断裂。真实本地能力必须通过 Tauri/Rust 路径、后端测试或后续静默本地 Web 后端验收。

Rust/Tauri 检查：

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Tauri 开发和打包仍可用，但不是当前主路线：

```powershell
npm run tauri:dev
npm run tauri:build
```

## Release 脚本

预览 Release 包计划：

```powershell
npm run release:build
```

实际构建本地 zip 和 SHA256：

```powershell
npm run release:build -- -Apply
```

发布后的远端资产复验：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\release\verify-github-release-asset.ps1
```

## 数据位置

Alpha 应用状态：

```text
%LOCALAPPDATA%\CodeX Provider Switcher\profiles.json
%LOCALAPPDATA%\CodeX Provider Switcher\backups\
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
