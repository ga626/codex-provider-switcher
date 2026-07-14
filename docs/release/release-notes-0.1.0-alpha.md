# CodeX Provider Switcher 0.1.0-alpha 发布说明

发布时间：2026-07-14

这是公开仓库基线版本，用于把本地 alpha 项目整理为可持续开发的 GitHub 项目。它不是旧版工具的最终替换版本。

## 包含内容

- React/Vite 前端。
- Tauri/Rust 本地能力基础。
- provider profiles、activity、backups、config/auth 写入基础。
- 可下载 Windows alpha zip，包含 `CodeXProviderSwitcher.cmd`、静默本地 Web 后端和 `dist/` 前端资源。
- 本地 Web 后端服务同源 `/api/*`，只绑定 `127.0.0.1`，并拒绝非本机 API Origin。
- 浏览器 UI-only mock adapter 和 Playwright smoke 测试；该路径只用于界面验证，不代表真实后端。
- GitHub CI、PR/Issue 模板、项目规则、贡献说明、安全策略。
- Release runbook、release checklist、发布包构建、本地解压验收和远端复验脚本。

## 已知边界

- 当前交付是可运行 alpha zip，不是正式安装器，也没有自动更新器。
- 模型目录已有 Tauri/Rust 只读 `/models` 解析基础，但真实 provider 兼容性验证、更新器、稳定 cutover 和 UI 信息架构重构仍在后续阶段完成。
- 旧版工具仍作为参考源和回滚源，不在本版本中退役。

## 验证建议

```powershell
npm run lint
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify\doctor-codex-provider-switcher.ps1 -PublicRelease
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\release\build-codex-provider-switcher-release.ps1 -Apply
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\release\verify-local-release-package.ps1
```
