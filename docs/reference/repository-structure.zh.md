# 仓库结构与文件责任

这份说明给开发者和维护者使用。普通用户只需要从 [根 README](../../README.md) 下载并安装。

| 路径 | 责任 |
| --- | --- |
| `src/` | React 桌面界面 |
| `src-tauri/` | Tauri/Rust 原生层、本地能力与桌面打包配置 |
| `public/` | 前端静态资源 |
| `scripts/` | 开发、验证、发布与验收脚本；入口见 [脚本索引](../../scripts/README.md) |
| `docs/user/` | 给安装用户的说明 |
| `docs/contributing/` | 给贡献者的环境、验证与 PR 规则 |
| `docs/maintainers/` | 给发布维护者的交付与安全治理规则 |
| `docs/reference/` | 产品规格、仓库结构和历史索引 |
| `docs/release/` | 各版本发布说明与保留历史材料 |
| `.github/` | CI、Release、Dependabot、Issue/PR 模板 |

以下目录只属于本机，必须保持忽略：`node_modules/`、`dist/`、`src-tauri/target/`、`logs/`、`release/`、`release-assets/`、`archive/`、`project_status/`、`.codex-provider-switcher/`、`.agents/`、`.codex/`、`.codex-praetor/`。

程序文件与可变用户数据分开：安装包由用户选择位置，用户数据默认在 `%LOCALAPPDATA%\CodeX Provider Switcher`。旧版 `D:\AI Studio\CodeX\Codex Switcher` 仅作参考和回滚源，不属于本仓库。
