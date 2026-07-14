# Release Gate Checklist

日期：2026-07-14
项目：`CodeX Provider Switcher`

## 1. 仓库层

- [ ] `AGENTS.md`、`CONTRIBUTING.md`、`SECURITY.md` 已更新。
- [ ] `.github/pull_request_template.md` 已覆盖验证、安全和用户影响。
- [ ] GitHub CI 包含 lint、build、Rust check 和 Rust tests。
- [ ] `.gitignore` 排除日志、构建产物、Release 输出、本机配置和密钥。
- [ ] `git diff --check` 通过。
- [ ] 敏感信息扫描无真实密钥。

## 2. 产品层

- [ ] README 写清当前主路线是本地 Web 控制台。
- [ ] Tauri 被描述为可选原生外壳/未来安装包路线。
- [ ] 旧版工具只作为参考源和回滚源。
- [ ] 不承诺自动替换旧工具。
- [ ] 不把 `gpt-5.5` 或任何单一模型写成永久默认。

## 3. 验证层

基础验证：

```powershell
npm run lint
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

界面流程验证：

```powershell
npm run preview:start -- --NoOpen
npm run qa:smoke
npm run preview:stop
```

说明：`qa:smoke` 是浏览器 UI-only mock 验证，不能替代真实本地后端或 Tauri/Rust 路径验收。

真实能力验证：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
```

在静默本地 Web 后端完成前，不能把浏览器预览结果声明为产品真实后端已可用。

## 4. Release 包层

Release 包应包含：

- 启动器或启动脚本。
- 静默本地后端。
- 前端静态资源。
- README。
- Release notes。
- checksums。

Release 包必须排除：

- `node_modules/`
- `dist/`
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

- [ ] 解压 Release 包。
- [ ] 双击启动入口。
- [ ] 没有可见 CMD 窗口常驻。
- [ ] 浏览器打开本地 Web 控制台。
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
