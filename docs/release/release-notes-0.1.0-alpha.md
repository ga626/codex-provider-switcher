# CodeX Provider Switcher 0.1.0-alpha 发布说明

发布时间：2026-07-14

这是公开仓库基线版本，用于把本地 alpha 项目整理为可持续开发的 GitHub 项目。它不是旧版工具的最终替换版本。

## 包含内容

- React/Vite 前端。
- Tauri/Rust 本地能力基础。
- provider profiles、activity、backups、config/auth 写入基础。
- 浏览器 mock adapter 和 Playwright smoke 测试。
- GitHub CI、PR/Issue 模板、项目规则、贡献说明、安全策略。
- Release runbook、release checklist、发布包构建和远端复验脚本。

## 已知边界

- 当前主要交付仍是开发预览，不是最终静默后端。
- 模型发现、GPT-5.6 适配、更新器、稳定 cutover 和 UI 信息架构重构在后续阶段完成。
- 旧版 `D:\AI Studio\CodeX\Codex Switcher` 仍作为参考源和回滚源，不在本版本中退役。

## 验证建议

```powershell
npm run lint
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify\doctor-codex-provider-switcher.ps1 -PublicRelease
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\release\build-codex-provider-switcher-release.ps1
```
