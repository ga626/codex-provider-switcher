# GitHub 发布 Runbook

日期：2026-07-14
项目：`CodeX Provider Switcher`
建议仓库名：`codex-provider-switcher`

本文记录把本地项目发布到 GitHub 的安全流程。它区分“代码已推送”“PR 就绪”“代码已合并”“产品已交付”四种状态。

## 硬规则

- 不把 GitHub Personal Access Token 粘贴到 Codex、文档、日志、Issue 或 PR。
- 优先使用 GitHub CLI 的浏览器/设备码登录。
- 第一次公开 push、tag 或 Release 前，必须确认没有真实 API key、auth 文件、profiles、备份、截图或本机私有日志。
- Codex 可以创建分支、提交、推送和准备 PR；用户负责 GitHub 上的合并、账号权限和发布审批。
- 影响真实用户入口的合并，必须更新 Release 资产并从下载包复验。

## 前置检查

```powershell
git status --short
git branch --show-current
git remote -v
gh --version
gh auth status
npm run lint
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

## 创建或连接远程

如果仓库不存在：

```powershell
gh repo create ga626/codex-provider-switcher --public --source . --remote origin --description "Local Codex provider switcher with validation, backups, and recovery." --disable-wiki
```

如果仓库已经存在：

```powershell
git remote add origin https://github.com/ga626/codex-provider-switcher.git
```

## 首次推送

首次推送前应完成敏感信息扫描和本地验证：

```powershell
rg -n "ghp_|sk-[A-Za-z0-9]|Authorization: Bearer [A-Za-z0-9]" --glob "!node_modules/**" --glob "!dist/**" --glob "!src-tauri/target/**" .
git add .
git commit -m "Bootstrap GitHub release workflow"
git push -u origin codex/bootstrap-github-release-flow
```

如果这是仓库首个提交，也可以在 GitHub 上把默认分支设置为 `main`，再通过 PR 合并后统一主线名称。

## PR 合并前检查

- PR 模板中的验证项全部有结果。
- GitHub CI 通过。
- 没有真实密钥或本机私有状态进入 diff。
- README、产品规格和 release checklist 与当前产品形态一致。
- 如果改动会影响用户启动入口，Release 复验计划已写清楚。

## Release 资产

早期建议发布 zip，不急于发布安装包：

```text
CodeXProviderSwitcher-windows-x64.zip
checksums.txt
release-notes.md
```

zip 应包含启动器、静默后端、前端静态资源、必要文档和版本信息。不要包含 `logs/`、`release/`、`archive/`、`node_modules/`、`dist/`、`src-tauri/target/`、真实 profiles、auth、config 或备份。

## 交付复验

用户合并影响真实入口的 PR 后，按普通用户路径复验：

1. 切回最新主线并拉取。
2. 重新构建 Release 资产。
3. 从 GitHub Release 下载 zip。
4. 解压到干净目录。
5. 双击启动入口。
6. 打开本地 Web 控制台。
7. 读取当前 Codex 配置摘要。
8. 做一次 dry-run 验证。
9. 确认备份和恢复入口可见。

只有完成这条路径，才能说产品已交付。
