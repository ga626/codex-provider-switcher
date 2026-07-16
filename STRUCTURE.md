# CodeX Provider Switcher 结构

## 根目录

- `src/`：React 前端
- `src-tauri/`：Tauri + Rust 原生层
- `scripts/`：预览、验收、发布脚本
- `release-assets/`：本地固定发布资产目录，只保存当前版本构建产物和校验文件，不进入 Git
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
- `AGENTS.md`、`.agents/`、`.codex/`：本机 Codex/Agent 开发规则和工具状态
- `archive/`：历史材料、旧版证据、废弃方案
- `release/`：历史 QA 截图和旧式本地发布草稿；不再作为正式资产入口

## 保留原则

- 保留产品源码、用户文档、发布脚本、CI、原生资源和公开协作文件。
- 稳定安装程序固定由用户选择安装到独立的稳定目录；本机标准验收路径为 `D:\Software\CodeX Provider Switcher`。该路径不写入公开产品配置。
- 程序文件与可变用户数据分离：profiles、备份、日志和更新状态位于 `%LOCALAPPDATA%\CodeX Provider Switcher`，升级或卸载程序文件不应删除这些数据。
- 不保留 `AGENTS.md`、`.agents/`、`.codex/`、`project_status/`、`dist/`、`node_modules/`、`logs/`、`src-tauri/target/`、`.codex-provider-switcher/`。
- 旧版 `D:\AI Studio\CodeX\Codex Switcher` 只作为历史参考，不作为主仓库。
