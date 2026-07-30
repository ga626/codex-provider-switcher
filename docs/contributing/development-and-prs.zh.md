# 开发、验证与 PR

这份指南面向准备进入 GitHub 的贡献者。目标是让每个 PR 在合并前知道改动会影响谁、需要什么验证，以及合并后是否真的需要发布。纯本地探索、调试和原型不需要 PR 标题、PR 正文、GitHub CI、隔离候选 artifact 或 `HEAD`/SHA 回执；它们仍要按风险运行必要的最小检查。

## 先判定改动类型

明确准备提交、推送或创建 PR 时，先写清四项：改动类型、用户验收、本地验证等级和发布结论。它们分别回答“改了什么”“用户需不需要看”“本机跑到什么程度”“是否需要发版”，不能互相替代。

| 类型 | 例子 | 最低要求 |
| --- | --- | --- |
| 文档或内部维护 | 文案、导航、非运行逻辑 | `npm run verify:doctor`、相关检查、`git diff --check` |
| 普通功能 PR | 本地后端、模型目录、配置流程 | doctor、lint、build、受影响的前端/Rust/后端/fixture 检查；需要时开发版验收 |
| 用户可见流程 | 桌面窗口、交互、切换或错误提示 | 功能级检查、开发版桌面验收或截图/功能验收 |
| 发布影响 PR | 用户入口、桌面壳、安装器、更新、版本、Release 资产、改变用户实际下载/安装/升级/卸载/启动步骤的说明 | 完整验证链、开发版验收、release readiness、发布计划 |
| 紧急修复 | 安全、数据丢失、无法启动 | 先缩小影响，保留回滚路径，再按受影响边界验证 |

安全说明、历史事实、更正性文字和维护记录不因提到安装而自动成为发布影响 PR。

从最新 `main` 创建 `codex/<topic>` 分支。不要提交真实配置、凭据、日志、截图、构建物或本机状态。

## 临时 worktree

普通 Codex worktree 只能由 `npm run worktree:manage -- -Action Create -Name <topic> -Apply` 创建在 `.codex/worktrees/<topic>`；禁止写到项目父目录或其他项目。Codex Desktop 的受管目录与 Codex Praetor 的 `.codex-praetor/worktrees` 不由本脚本管理。

提交前运行 `npm run worktree:manage -- -Action Audit`。退役前必须无进程、干净且已合并或已有 `archive/*` 引用；使用 `-Action Retire -WorktreePath <绝对路径> -Apply`，不得手删或使用 `--force`。

## 本地验证

所有本地验证都在准备进入 GitHub 后执行，并须记录实际结果。文档或内部维护按表中最小验证执行；普通功能按受影响边界补检查；用户可见流程还要安排开发版验收。`npm run qa:dev-desktop` 只打开当前源码，不会安装、卸载或升级稳定版。

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
npm run release:readiness:smoke
npm run qa:preview-smoke
npm run store:verify-package
npm run release:readiness -- -Mode Maintainer -Channel github -ReportOnly
git diff --check
```

开发版验收使用：

```powershell
npm run qa:dev-desktop
```

它只打开当前源码，不会安装、卸载或升级稳定版。预览和 smoke 是自动证据，不能代替用户看桌面窗口。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| 本地候选已验证 | 已完成该类型要求的本地命令、文档同步和必要的用户验收；工作区仍可有待提交改动。 |
| 可提交/可推送 | 提交后的 `HEAD` 有对应验证证据，目标分支已更新，工作区干净，中文 PR 标题和正文已准备。 |
| PR 远端验证中 | PR 已创建，等待一次 `pull_request` CI 与评审。 |
| PR 可合并 | 必需远端检查、冲突和评审状态满足仓库规则。 |
| 非发布 PR 已收口 | 已明确为非发布影响，`main` CI 已通过；本次无新版本、tag 或渠道交付义务，既有已交付版本保持有效。 |
| 发布影响 PR：代码已合并，产品未交付 | 已明确为发布影响，但计划渠道尚未完成实际交付；必须注明暂缓原因或 `release incident`。 |
| 发布影响 PR：产品已交付 | 新 tag、不可变 Release 和对应渠道的普通用户验收均已完成。 |

## PR、发布与 Store 的关系

1. PR 材料必须按模板记录：类型、用户验收、本地验证等级、发布结论、实际本地命令和结果、风险边界及后续动作。未运行的检查必须写“未运行 + 原因”。
2. 普通 PR 创建后，`pull_request` CI 是该分支的权威云端验证；不要等待重复的分支 push CI。
3. 非发布影响 PR 合并不自动创建 GitHub Release，也不自动构建 Store 上传包；这些动作在合并回执中写为“不适用”，不是“未执行”。
4. 用户可见 GitHub 版本在合并后、main CI 通过且维护者门禁通过后创建新 tag，由 `GitHub Release` workflow 交付；它需要 Tauri updater Secret，不需要 Windows PFX。workflow 只运行 runner-safe 检查，不能代替维护者门禁。
5. Store 只在稳定大版本时，由维护者手动选择已经完成 GitHub 验收的 tag 构建 MSIX 并提交 Partner Center。
6. 只有已分类为发布影响的 PR 才负有渠道交付义务。该义务尚未完成时，才写“代码已合并，产品未交付”；非发布影响 PR 必须写“非发布 PR 已收口”，同时说明既有已交付版本保持有效。

## 文档同步责任

| 改动 | 同步更新 |
| --- | --- |
| 用户入口、启动、端口、安装或卸载 | README、安装、排错、发布手册 |
| provider、模型、配置写入、备份或恢复 | 产品规格、排错、风险边界、验证说明 |
| GitHub/Store、更新、版本或 Release | 发布手册、release notes、脚本索引、PR 发布计划 |
| CI、测试、脚本或依赖 | 脚本索引、维护手册、PR 验证段 |
| worktree 或本机治理 | 本节、`.gitignore`、维护脚本、PR 验证段 |

依赖兼容、CodeQL、Dependabot 与 GitHub Actions 固定策略见[依赖与安全治理](../maintainers/dependency-security.zh.md)。这类工程化 PR 不改变产品功能、版本、安装或 Store 路径时，不自动进入发布流程；但必须完整记录本地依赖和扫描验证结果。

## 本机候选安装

候选版不是公开产品，也不会在每次合并后自动刷新。只有维护者明确要验收已合并但尚未发布的版本时，才在干净 `main` 运行：

```powershell
npm run qa:refresh-local-candidate -- -Apply
```

候选版目录、GitHub 稳定安装目录和 Store 安装版必须分开。真实迁移、旧候选清理和旧工具停用只能在发布后新的 Codex 会话进行。
