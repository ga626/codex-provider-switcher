# 贡献说明

`CodeX Provider Switcher` 当前处于产品化早期阶段，优先保证本地配置安全、可恢复和可发布。

## 开发流程

1. 从最新主线创建 `codex/<topic>` 分支。
2. 保持每个 PR 只解决一个清晰主题。
3. 涉及 Codex 配置、provider、API key、备份恢复、旧工具迁移的改动，必须在 PR 中说明用户影响和回滚方式。
4. 不要把旧版工具目录当成可写工作区；它只能作为参考源。
5. 不要提交本机私有状态、真实密钥、日志、截图或构建产物。

## 本地验证

基础验证：

```powershell
npm ci
npm run lint
npm run build
git diff --check
```

涉及 Rust/Tauri：

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

涉及界面流程：

```powershell
npm run preview:start -- --NoOpen
npm run qa:smoke
npm run preview:stop
```

## PR 要求

PR 描述必须包含：

- 改动范围。
- 已运行的验证命令。
- 是否影响用户实际入口。
- 是否会读写 `config.toml`、`auth.json`、profiles、backups。
- 失败或回滚路径。

合并后如果影响用户实际下载或启动入口，必须从最新主线重新构建 Release 资产，并按普通用户路径复验。
