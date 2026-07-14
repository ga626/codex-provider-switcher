# CodeX Provider Switcher 结构

## 根目录

- `src/`：React 前端
- `src-tauri/`：Tauri + Rust 原生层
- `scripts/`：预览、验收、发布脚本
- `docs/`：产品文档、迁移说明、发布说明
- `project_status/`：当前状态、决策、问题、交接包、新对话提示词
- `archive/`：历史材料、旧版证据、废弃方案
- `release/`：发布说明、安装包清单、校验信息

## 保留原则

- 保留源码、文档、状态、脚本、原生资源。
- 不保留 `dist/`、`node_modules/`、`logs/`、`src-tauri/target/`、`src-tauri/gen/`。
- 旧版 `D:\AI Studio\CodeX\Codex Switcher` 只作为历史参考，不作为主仓库。
