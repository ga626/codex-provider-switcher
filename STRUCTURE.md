# CodeX Provider Switcher 结构

## 根目录

- `src/`：React 前端
- `src-tauri/`：Tauri + Rust 原生层
- `scripts/`：预览、验收、发布脚本
- `docs/`：产品文档、迁移说明、发布说明
- `.github/`：CI、Issue 模板、PR 模板
- `public/`：前端静态资源
- `CodeXProviderSwitcher.cmd` / `CodeXProviderSwitcher.ps1`：Release 包和源码树共用的真实本地 Web 后端启动入口
- `setup.cmd` / `setup.ps1`：源码树便捷启动入口，会构建前端和本地后端后调用真实启动器

## 本地生成目录

以下目录可能存在于开发机，但不属于公开仓库和 Release 包：

- `dist/`：前端构建产物
- `logs/`：本地预览和后端日志
- `.codex-provider-switcher/`：release 构建、解压和远端验收输出
- `project_status/`：本地阶段状态、决策和交接材料
- `archive/`：历史材料、旧版证据、废弃方案
- `release/`：旧式本地发布草稿；当前正式发布资料在 `docs/release/`

## 保留原则

- 保留源码、文档、状态、脚本、原生资源。
- 不保留 `dist/`、`node_modules/`、`logs/`、`src-tauri/target/`、`.codex-provider-switcher/`。
- 旧版 `D:\AI Studio\CodeX\Codex Switcher` 只作为历史参考，不作为主仓库。
