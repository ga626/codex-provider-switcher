# 依赖与安全治理

## 日常节奏

`.github/dependabot.yml` 每周检查 npm 与 Cargo 依赖。Dependabot PR 不自动合并：维护者先看变更范围、CI、桌面运行边界与发布风险，再决定是否合并。

## 收到告警时

1. 记录告警编号、严重度、受影响依赖、可用安全版本和依赖来源。
2. 判断能否在不破坏产品的情况下升级；不能只改 lockfile 来让告警消失。
3. 若依赖来自 Tauri 图形链，先确认兼容的 Tauri 版本和完整依赖图，再在独立 PR 中执行 Rust、桌面和发布包验证。
4. 发布前的 `release:readiness` 会阻断未关闭的高、严重告警。中等风险必须有仍在有效期内的平台影响登记；没有登记同样阻断。PR 可以继续讨论和修复，但不得把带阻断的状态写成产品已交付。
5. 仅当安全版本已被锁定、验证通过且 Dependabot alert 在 GitHub 中关闭，才可声明漏洞已修复。

## 当前已知事项

Dependabot #1 涉及 `glib` 的中等风险告警。当前锁定依赖图由 Tauri 的非 Windows GTK 分支带来；`cargo tree --target x86_64-pc-windows-msvc -i glib` 没有输出，说明它不链接到当前 Windows 发布目标。它没有被标记为“已修复”：`.github/security-risk-register.json` 记录了适用范围、证据、复核日期和受控升级动作。登记过期、依赖图变化或发布目标变化后，必须重新评估；升级仍应在单独的 Tauri/GTK 兼容 PR 中完成。

## 机密与文档

不要把 PFX、私钥、口令、真实 API key 或完整本机配置写进 Dependabot PR、Issue、日志或 release notes。安全政策见 [根 SECURITY.md](../../SECURITY.md)。
