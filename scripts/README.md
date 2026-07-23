# 维护脚本索引

这些脚本面向贡献者和发布维护者，不是普通用户的安装入口。用户请使用根 README 和 `docs/user/`。

| 类别 | 入口 | 用途 |
| --- | --- | --- |
| 开发版桌面验收 | `npm run qa:dev-desktop` | 直接打开当前源码树桌面应用，不安装 |
| 基础质量 | `npm run verify:doctor`、`npm run lint`、`npm run build` | 检查仓库结构、静态质量和前端构建 |
| 真实本地能力 | `npm run backend:build`、`npm run backend:smoke`、`npm run backend:functional-smoke` | 验证本地后端与隔离配置流程 |
| UI/运行边界 | `npm run qa:preview-smoke`、`npm run runtime-boundary:smoke`、`npm run tauri:desktop-boundary:smoke` | 验证预览、真实运行边界和桌面壳约束 |
| 发布就绪 | `npm run release:readiness -- -Mode Maintainer -Channel github` | 维护者本机门禁：检查版本、updater Secret 名称、依赖告警和 immutable Release；不会读取 Secret 值 |
| 权限边界回归 | `npm run release:readiness:smoke` | 模拟 runner 被拒绝读取 Secret/Dependabot API，确认 runner-safe 发布预检仍可运行 |
| GitHub 发布包 | `npm run release:build -- -Apply`、`npm run release:verify-local` | 构建并验证 GitHub Release 资产；真正发布由新 tag 触发 workflow |
| 发布通道边界 | `npm run release:channel-smoke` | 验证 GitHub stable、Store 和候选构建不会混用更新路径 |
| 远端交付 | `npm run release:verify-remote` | 下载并检查已发布的 GitHub Release |
| cutover 准备 | `npm run qa:cutover-preflight` | 只读记录新安装版和旧工具状态；不执行真实切换 |
| 本机迁移预检 | `scripts/qa/prepare-local-install-migration.ps1` | 只读确认 GitHub 稳定、候选和旧候选目录；不清理任何内容 |

按改动类型选择命令、以及何时必须运行安装发布验收，见 [开发与 PR 指南](../docs/contributing/development-and-prs.zh.md)。
