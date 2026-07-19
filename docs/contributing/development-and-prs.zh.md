# 开发、验证与 PR

这份指南面向贡献者。它的目标是让每个 PR 在合并前就知道：改动是否会影响用户、需要跑什么、还缺什么交付条件。

## 1. 先判定改动类型

| 类型 | 例子 | 最低要求 |
| --- | --- | --- |
| 文档或内部重构 | 文案、导航、非运行逻辑 | `npm run verify:doctor`、相关检查、`git diff --check` |
| 普通功能 PR | 本地后端、模型目录、配置流程 | 相关前端/Rust/后端测试；需要时开发版验收 |
| 发布影响 PR | 用户入口、桌面壳、安装器、更新、版本、Release 资产、用户下载说明 | 完整验证链、开发版验收、release readiness、发布计划 |
| 紧急修复 | 安全、数据丢失、无法启动 | 先缩小影响，保留回滚路径，再按受影响边界验证 |

## 2. 分支与敏感边界

从最新 `main` 创建 `codex/<topic>` 分支。不要在旧工具目录工作，也不要提交真实配置、凭据、日志、截图、构建物或本机状态。

涉及 `config.toml`、`auth.json`、profiles、备份或 provider 的改动，必须写清：是否写入、何时备份、如何恢复、为什么不在当前 Codex 会话执行最终切换。

## 3. 本地验证

小改动跑相关检查；发布影响或跨层改动跑完整链：

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
npm run qa:preview-smoke
npm run store:verify-package
npm run release:readiness -- -ReportOnly
git diff --check
```

`release:readiness` 默认按 Microsoft Store 渠道检查，不读取 Secret 值，也不会创建 Release 或 Store 提交。发布影响 PR 必须在 PR 描述的“发布计划/后续动作”中记录它的结论：Store 包构建完成不等于已交付，必须等 Partner Center 认证和 Store 安装验收。只有 GitHub 直装备用渠道才需要可信 Windows 代码签名凭据；用 `-Channel github-direct` 检查。

涉及 Store 打包文件时，创建 PR 后必须等待 `Microsoft Store package` 检查通过。该检查只构建临时 artifact，既不上传 Partner Center，也不发布给用户。

开发版验收会固定使用单任务 Cargo 构建当前源码的未安装桌面候选，再直接打开它；它不覆盖日常桌面入口，也不依赖页面文件敏感的热重编译。需要热重载时，开发者仍可手动运行 `npm run tauri:dev`：

```powershell
npm run qa:dev-desktop
```

## 4. 用户验收

用户只需要区分两种验收：

| 状态 | 何时使用 | 命令 |
| --- | --- | --- |
| 开发版验收 | UI、普通功能、文案、配置流程 | `npm run qa:dev-desktop` |
| 安装发布验收 | 安装器、版本、启动入口、更新、卸载、Release 资产 | Store 发布后按普通用户安装；GitHub 备用渠道才运行 setup |

预览和 smoke 是自动证据，不能代替用户看开发版窗口。安装发布验收只在真实 Release 生成后进行。

## 5. 文档同步责任

| 改动 | 同步更新 |
| --- | --- |
| 用户入口、启动、端口、安装或卸载 | README、安装、排错、发布手册 |
| provider、模型、配置写入、备份或恢复 | 产品规格、排错、风险边界、验证说明 |
| 桌面壳、Release、更新或版本 | 发布手册、release notes、checklist、PR 发布计划 |
| CI、测试、脚本或依赖 | 脚本索引、维护手册、PR 验证段 |

## 6. PR 前与合并后

PR 前应确认工作区干净、目标分支最新、文档已同步、无冲突标记、测试通过、用户会经过的路径可运行。创建 PR 后，GitHub 的 `validate` 是该分支的权威云端验证；不要额外等待重复的功能分支 push CI。

发布影响 PR 合并后仍不是交付完成。Store 路线必须在最新主线创建新 tag、生成 MSIX、完成 Partner Center 认证，再从 Store 安装、启动和验证；GitHub 直装备用路线才需要不可变 Release 与 setup 验收。任何一步被签名、版本、权限、认证或安全告警阻断时，只能写“代码已合并，产品未交付”。需要替换旧工具时，继续按 [旧工具替换手册](../maintainers/legacy-cutover.zh.md) 在新的 Codex 会话完成，不得在当前开发会话直接停用旧工具。

## 合并后的本机候选更新

当 Store 认证或正式发布尚未完成，但维护者固定桌面入口需要跟随已经合并、验证通过的修复时，使用本机候选安装。它不是公开发布，也不修改正在审核的 Store 包：

1. 等待 `main` CI 成功，切到干净的最新 `main`。
2. 运行 `npm run qa:refresh-local-candidate -- -Apply`；该脚本构建当前主线、替换 `D:\Software\CodeX Provider Switcher` 的程序文件，并写入不含凭据的 `candidate-install-state.json`。
3. 若需要从旧版恢复本机 profile，在同一受控操作中传入旧版文件路径：`npm run qa:refresh-local-candidate -- -Apply -LegacyProfilesPath "<旧工具 profiles.json 的本机路径>"`。恢复只填补空凭据、先保存 DPAPI 保护副本、不写回旧文件，并要求重新运行可用性测试。
4. 启动候选安装并确认版本、单窗口、无 CMD、用户资料保留和受影响功能。Store 发布后仍须从 Store 实际安装并再次验收，候选安装不能替代这一步。
