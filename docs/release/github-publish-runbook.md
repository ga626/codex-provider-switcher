# GitHub 发布 Runbook

日期：2026-07-14
项目：`CodeX Provider Switcher`
建议仓库名：`codex-provider-switcher`

本文记录把本地项目发布到 GitHub 的安全流程。它区分“代码已推送”“PR 就绪”“代码已合并”“产品已交付”四种状态。

## 硬规则

- 不把 GitHub Personal Access Token 粘贴到 Codex、文档、日志、Issue 或 PR。
- 优先使用 GitHub CLI 的浏览器/设备码登录。
- 第一次公开 push、tag 或 Release 前，必须确认没有真实 API key、auth 文件、profiles、备份、截图、本机私有日志、`AGENTS.md`、`.agents/`、`.codex/` 或 `project_status/`。
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

空仓库没有可作为 PR base 的真实主线，因此第一笔 root commit 可以直接创建 `main`。这一步只用于建立仓库主线，不能作为后续开发模式。

`main` 创建并推送成功后，所有后续修改都必须按正常开发流程执行：

```powershell
git switch main
git pull --ff-only
git switch -c codex/<topic>
```

分支完成验证后推送到 GitHub，再创建 PR 合回 `main`。

首次推送前应完成敏感信息扫描和本地验证：

```powershell
rg -n "ghp_|sk-[A-Za-z0-9]|Authorization: Bearer [A-Za-z0-9]" --glob "!node_modules/**" --glob "!dist/**" --glob "!src-tauri/target/**" .
npm run verify:doctor
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

用户看当前开发成果时默认走开发版验收：

```powershell
npm run qa:dev-desktop
```

只有安装器、Release 包、版本号、启动入口、升级/卸载路径或用户下载入口变化时，才进入安装发布验收：

```powershell
npm run release:build -- -Apply
npm run qa:install-release -- -Collect
```

## Release 资产

桌面 GUI 版本优先发布桌面安装资产，同时保留 fallback zip：

```text
CodeXProviderSwitcher-windows-x64-<version>-setup.exe
CodeXProviderSwitcher-windows-x64-<version>-setup.exe.sha256
CodeXProviderSwitcher-windows-x64-<version>.zip
CodeXProviderSwitcher-windows-x64-<version>.zip.sha256
```

fallback zip 应包含 `CodeXProviderSwitcher.cmd`、`CodeXProviderSwitcher.ps1`、`bin/local_backend.exe`、`dist/` 前端静态资源、必要用户文档、发布说明和版本信息。不要包含源码树、开发脚本、`AGENTS.md`、`.agents/`、`.codex/`、`project_status/`、`logs/`、`release/`、`archive/`、`node_modules/`、`src-tauri/target/`、真实 profiles、auth、config 或备份。

## 交付复验

用户合并影响真实入口的 PR 后，按普通用户路径复验：

1. 切回最新主线并拉取。
2. 重新构建 Release 资产。
3. 从 GitHub Release 下载 setup exe。
4. 校验 SHA256。
5. 安装并从开始菜单或桌面图标启动。
6. 确认打开桌面窗口，不弹常驻 CMD，不打开外部浏览器。
7. 关闭窗口后确认进程退出。
8. 下载 fallback zip，解压到干净目录。
9. 双击 fallback 启动入口。
10. 确认本地 Web 控制台、端口、后端、UI 和文档一致。

只有完成这条路径，才能说产品已交付。

如果在 PR 合并前只需要确认当前 GitHub Release 资产仍可下载、校验文件匹配远端 zip、包内结构正确，可以使用结构验证模式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\release\verify-github-release-asset.ps1 -RemoteStructureOnly
```

合并并重新发布资产后，必须去掉 `-RemoteStructureOnly`，执行完整一致性复验。
