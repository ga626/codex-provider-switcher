# Release Gate Checklist

日期：2026-07-14
项目：`CodeX Provider Switcher`

## 1. 仓库层

- [ ] `CONTRIBUTING.md`、`SECURITY.md` 和用户可见文档已更新。
- [ ] `AGENTS.md`、`.agents/`、`.codex/`、`project_status/` 等本机开发/Agent 状态未进入 Git 跟踪。
- [ ] `.github/pull_request_template.md` 已覆盖验证、安全和用户影响。
- [ ] GitHub CI 包含 lint、build、Rust check、Rust tests、本地 Web 后端 build 和 smoke。
- [ ] `.gitignore` 排除日志、构建产物、Release 输出、本机配置和密钥。
- [ ] `git diff --check` 通过。
- [ ] 敏感信息扫描无真实密钥。

## 2. 产品层

- [ ] README 写清当前主路线是轻量桌面 GUI。
- [ ] 本地 Web 控制台被描述为开发、诊断和 fallback 路线。
- [ ] 旧版工具只作为参考源和回滚源。
- [ ] 不承诺自动替换旧工具。
- [ ] 不把 `gpt-5.5` 或任何单一模型写成永久默认。

## 3. 验证层

变更影响面检查：

| 改动类型 | 必须同步检查 |
| --- | --- |
| 用户入口、端口、启动器、后端运行方式 | README、安装文档、故障排查、release checklist、PR 用户影响 |
| mock、真实后端、模型刷新、配置写入边界 | README、产品规格、故障排查、验证命令、PR 风险边界 |
| Release 包内容或发布命令 | release checklist、GitHub 发布 Runbook、release notes、verify-local 脚本 |
| CI、smoke、构建或验证命令 | README、release checklist、PR 验证段、GitHub Actions |
| 旧工具 cutover、备份、恢复、回滚 | 产品规格、用户文档、release checklist、PR 风险边界 |

基础验证：

```powershell
npm run lint
npm run build
npm run runtime-boundary:smoke
npm run tauri:desktop-boundary:smoke
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run backend:build
npm run backend:smoke
npm run backend:ui-smoke
git diff --check
```

界面流程验证：

```powershell
npm run preview:start -- --NoOpen
npm run qa:smoke
npm run preview:stop
```

说明：`qa:smoke` 是浏览器 UI-only mock 验证，不能替代真实本地后端或 Tauri/Rust 路径验收。`runtime-boundary:smoke` 用于确认生产构建在缺少本地后端时显示明确错误，而不是展示假 provider 或假模型。

真实能力验证：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
npm run backend:build
npm run backend:smoke
```

可下载 alpha 包必须额外通过解压启动验收：

```powershell
npm run release:build -- -Apply
npm run release:verify-local
```

## 4. Release 包层

Release 包应包含：

- 桌面 setup exe。
- fallback 启动器或启动脚本。
- fallback 静默本地后端。
- fallback 前端静态资源。
- README。
- Release notes。
- checksums。

Release 包必须排除：

- `AGENTS.md`
- `.agents/`
- `.codex/`
- `project_status/`
- `node_modules/`
- 源码根目录和开发脚本。
- `src-tauri/target/`
- `logs/`
- `release/`
- `archive/`
- `.env*`
- 真实 `auth.json`
- 真实 `profiles.json`
- 真实 `config.toml`
- 备份目录和本机活动日志。

## 5. 用户路径

发布前必须按普通用户路径确认：

- [ ] 下载桌面 setup exe。
- [ ] 启动 `CodeX Provider Switcher` 桌面应用。
- [ ] 没有可见 CMD 窗口常驻。
- [ ] 不自动打开外部浏览器。
- [ ] 关闭窗口后进程退出。
- [ ] fallback zip 可解压并双击 `CodeXProviderSwitcher.cmd`。
- [ ] fallback 浏览器打开本地 Web 控制台。
- [ ] 当前 Codex 配置摘要脱敏显示。
- [ ] provider 和模型状态能看懂。
- [ ] 写入前能看到备份/恢复路径。
- [ ] dry-run 不修改真实配置。

## 6. 停止条件

出现以下情况时停止发布：

- 发现真实密钥、auth、profiles、备份或本机私有日志进入仓库或 Release 包。
- CI 失败且原因未解释。
- 本地 Web 控制台无法启动。
- 写入配置前没有备份。
- 无法恢复到切换前状态。
- 最终 cutover 需要当前 Codex 会话修改自身 provider 配置。
