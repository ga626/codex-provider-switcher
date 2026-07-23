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

程序文件与可变用户数据分开：安装包由用户选择位置；为保证升级后仍能读取现有资料，当前用户数据保留在历史兼容目录 `%LOCALAPPDATA%\CodeX Provider Switcher`。旧版 `D:\AI Studio\CodeX\Codex Switcher` 仅作参考和回滚源，不属于本仓库。

维护者本机约定的 GitHub 稳定安装目录是 `D:\Software\Signalman AI`，短期候选目录是 `D:\Software\Signalman AI Candidate`；它们不进入仓库，也不与 Microsoft Store 的 Windows 管理安装目录混用。目录职责和迁移边界见 [发布与交付手册](../maintainers/release-and-delivery.zh.md)。

产品显示名与技术兼容标识的完整边界见 [品牌与兼容性边界](brand-and-compatibility.zh.md)。
