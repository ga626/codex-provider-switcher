# 开发、验证与 PR

这份指南面向贡献者。目标是让每个 PR 在合并前知道改动会影响谁、需要什么验证，以及合并后是否真的需要发布。

## 先判定改动类型

| 类型 | 例子 | 最低要求 |
| --- | --- | --- |
| 文档或内部重构 | 文案、导航、非运行逻辑 | `npm run verify:doctor`、相关检查、`git diff --check` |
| 普通功能 PR | 本地后端、模型目录、配置流程 | 相关前端/Rust/后端测试；需要时开发版验收 |
| 发布影响 PR | 用户入口、桌面壳、安装器、更新、版本、Release 资产、用户下载说明 | 完整验证链、开发版验收、release readiness、发布计划 |
| 紧急修复 | 安全、数据丢失、无法启动 | 先缩小影响，保留回滚路径，再按受影响边界验证 |

从最新 `main` 创建 `codex/<topic>` 分支。不要提交真实配置、凭据、日志、截图、构建物或本机状态。

## 本地验证

发布影响或跨层改动至少运行：

```powershell
npm run verify:doctor
npm run lint
npm run build
cargo check --manifest-path src-tauri/Cargo.toml --jobs 1
cargo test --manifest-path src-tauri/Cargo.toml --jobs 1
npm run backend:build
npm run backend:smoke
npm run backend:functional-smoke
npm run backend:ui-smoke
npm run runtime-boundary:smoke
npm run tauri:desktop-boundary:smoke
npm run release:channel-smoke
npm run qa:preview-smoke
npm run store:verify-package
npm run release:readiness -- -Channel github -ReportOnly
git diff --check
```

开发版验收使用：

```powershell
npm run qa:dev-desktop
```

它只打开当前源码，不会安装、卸载或升级稳定版。预览和 smoke 是自动证据，不能代替用户看桌面窗口。

## PR、发布与 Store 的关系

1. 普通 PR 创建后，`pull_request` CI 是该分支的权威云端验证；不要等待重复的分支 push CI。
2. 普通 PR 合并不自动创建 GitHub Release，也不自动构建 Store 上传包。
3. 用户可见 GitHub 版本在合并后创建新 tag，由 `GitHub Release` workflow 交付；它需要 Tauri updater Secret，不需要 Windows PFX。
4. Store 只在稳定大版本时，由维护者手动选择已经完成 GitHub 验收的 tag 构建 MSIX 并提交 Partner Center。
5. GitHub 与 Store 都完成各自普通用户安装验收前，不能把“代码已合并”写成“产品已交付”。

## 文档同步责任

| 改动 | 同步更新 |
| --- | --- |
| 用户入口、启动、端口、安装或卸载 | README、安装、排错、发布手册 |
| provider、模型、配置写入、备份或恢复 | 产品规格、排错、风险边界、验证说明 |
| GitHub/Store、更新、版本或 Release | 发布手册、release notes、脚本索引、PR 发布计划 |
| CI、测试、脚本或依赖 | 脚本索引、维护手册、PR 验证段 |

## 本机候选安装

候选版不是公开产品，也不会在每次合并后自动刷新。只有维护者明确要验收已合并但尚未发布的版本时，才在干净 `main` 运行：

```powershell
npm run qa:refresh-local-candidate -- -Apply
```

候选版目录、GitHub 稳定安装目录和 Store 安装版必须分开。真实迁移、旧候选清理和旧工具停用只能在发布后新的 Codex 会话进行。
