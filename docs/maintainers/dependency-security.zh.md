# 依赖与安全治理

## 日常节奏

`.github/dependabot.yml` 每周检查 npm 与 Cargo 依赖。Dependabot 保留版本和安全告警，但不自动创建版本更新 PR；维护者先按告警将有关联验证范围的更新编入一个计划维护 PR，再审阅变更范围、CI、桌面运行边界与发布风险。

同一配置也每周检查 GitHub Actions。所有 workflow action 必须固定到完整 commit SHA，并在行尾保留原始 tag 或通道注释，便于审阅和 Dependabot 告警提供可追溯更新候选。不得把固定 SHA 改回浮动 tag，也不得手动猜测 SHA；更新必须来自上游 tag 或通道的已核验提交。

能通过现有 CI 的小范围更新可独立评审。涉及 Vite、TypeScript、React 插件或 Tauri 图形链的大版本升级必须进入兼容性 PR：先解决 peer dependency 或编译错误，再做完整桌面与发布验证。不得使用 `--force` 或 `--legacy-peer-deps` 把无法解析的依赖树强行并入发布事故修复。

## 收到告警时

1. 记录告警编号、严重度、受影响依赖、可用安全版本和依赖来源。
2. 判断能否在不破坏产品的情况下升级；不能只改 lockfile 来让告警消失。
3. 若依赖来自 Tauri 图形链，先确认兼容的 Tauri 版本和完整依赖图，再在独立 PR 中执行 Rust、桌面和发布包验证。
4. 发布前的 `release:readiness` 会阻断未关闭的高、严重告警。中等风险必须有仍在有效期内的平台影响登记；没有登记同样阻断。PR 可以继续讨论和修复，但不得把带阻断的状态写成产品已交付。
5. 仅当安全版本已被锁定、验证通过且 Dependabot alert 在 GitHub 中关闭，才可声明漏洞已修复。

## 当前已知事项

Dependabot #1 涉及 `glib` 的中等风险告警。当前锁定依赖图由 Tauri 的非 Windows GTK 分支带来；`cargo tree --target x86_64-pc-windows-msvc -i glib` 没有输出，说明它不链接到当前 Windows 发布目标。它没有被标记为“已修复”：`.github/security-risk-register.json` 记录了适用范围、证据、复核日期和受控升级动作。维护者必须在 `2026-08-16` 前复核，或在目标/依赖图变化时提前复核；升级仍应在单独的 Tauri/GTK 兼容 PR 中完成。

## CodeQL 与仓库政策

`.github/workflows/codeql.yml` 在 Windows runner 上扫描 Rust 与 TypeScript，并以真实构建产出分析结果。CodeQL 首先建立分析基线；新增告警按严重度、可达性和修复路径分流，不能把“没有历史分析”或“没有告警”写成“零风险”。

`main` 必须同时要求 `validate`、`Analyze JavaScript and TypeScript` 与 `Analyze Rust` 三项成功检查，并要求解决全部会话；管理员也受保护规则约束。当前仓库是单维护者模式，不启用 required review，维护者可在检查通过后合并自己创建的 PR。若以后增加独立维护者并决定启用审批，必须作为单独的仓库治理变更，不能让单人仓库陷入无法合规合并的状态。检查名以 workflow job 显示名为准，改名时必须先同步 branch protection，不能保留失效或不存在的 required check。

仓库应启用合并后自动删除已合并分支，并要求 GitHub Actions 使用完整 SHA 固定 action；后者保留 `allowed_actions=all`，不额外收紧已审核 action 的使用范围。分支保护、审批、签名提交和线性历史属于仓库政策。本仓库只在维护者明确确认后修改这些设置；依赖、安全扫描或 action pin PR 不得静默改变它们。

## 机密与文档

不要把 PFX、私钥、口令、真实 API key 或完整本机配置写进 Dependabot PR、Issue、日志或 release notes。安全政策见 [根 SECURITY.md](../../SECURITY.md)。
