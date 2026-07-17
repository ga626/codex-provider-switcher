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

## 自动更新签名密钥

最终用户点击应用内“检查更新”时不需要输入任何密钥或口令。应用只携带公钥，用它验证下载到的更新包；私钥只属于发布者。

正常职责边界如下：

| 阶段 | 私钥要求 |
| --- | --- |
| 日常开发、PR、开发版运行 | 不需要 |
| 本地候选包和功能验收 | 不需要，使用未签名候选或专门的安装验收流程 |
| 正式 GitHub Release | 需要，由 GitHub Actions Secrets 注入 |
| 用户安装、检查更新、自动升级 | 不需要 |

正式 Release 使用以下 GitHub Actions Secrets，不把值写入仓库：

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

正式发布通过 `.github/workflows/release.yml` 完成。它只响应已经推送到远端的 `v*` 标签，先校验标签、`package.json`、`tauri.conf.json` 和 Cargo 版本一致，再由 GitHub Actions 生成签名资产。workflow 会把新 Release 标记为 GitHub `Latest`，因为 updater 使用 `/releases/latest/download/latest.json`；标签可以继续使用 `0.3.2-alpha` 这样的版本号，但不能把 GitHub Release 标记为 `Pre-release`，否则该下载地址会返回 `404`。GitHub API 的 `isImmutable` 状态不应替代项目自己的不可覆盖策略：旧 tag 和旧资产仍不得被重跑静默覆盖。

首次启用或轮换密钥时，维护者只需要在仓库 Settings > Secrets and variables > Actions 中确认上述两个 Secrets 存在。后续日常开发、PR、开发版和本地未签名候选包都不读取私钥；只有推送新版本标签时才由 CI 使用它们。旧版本如果内置了旧公钥，不能直接验证轮换后的新公钥，因此密钥轮换必须伴随一次手动安装迁移，并在发布说明中写明。

密钥对只在首次建立发布信任根时生成一次，后续 Release 复用同一私钥。不能因为某次本地构建失败就重新生成密钥；如果私钥或口令丢失，必须先制定密钥轮换和一次性手动升级计划，再更新 `tauri.conf.json` 中的公钥。已经安装旧公钥的版本不能直接验证新公钥签名的更新。本项目的 `v0.3.0-alpha` 使用旧公钥且已有 Release 资产；切换到新公钥后，`v0.3.0-alpha` 用户必须先手动安装 `v0.3.1-alpha`，之后才能使用自动更新。

Tauri updater 签名只保证更新包的来源和完整性，不等同于 Windows Authenticode/MSIX 代码签名，也不是用户运行软件所需的登录凭据。

## Release workflow 结构

Release workflow 分为三个 job：

1. `preflight`：checkout 指定 tag，校验 tag、三份版本元数据、已有 Release 状态和资产完整性。
2. `build`：只在 Release 不存在时运行；它持有签名 Secrets，使用 Rust/Tauri cache 构建资产，输出阶段耗时，并把公开候选资产上传为 7 天保留的 workflow artifact。
3. `publish`：下载并复核 artifact，再创建 GitHub Release；它没有签名私钥。已有完整 Release 时只执行远端结构验证，不覆盖资产。

cache 只保存可重新生成的 Cargo/Tauri 依赖和中间产物；setup、zip、`.sig`、`latest.json`、sha256 和发布说明属于 artifact/Release 资产。构建 job 超过 60 分钟、CI 超过 45 分钟会自动失败；先读阶段耗时和 cache 命中情况，再决定下一步，不要用无限等待掩盖问题。

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
npm run release:verify-upload-assets
```

## Release 资产

桌面 GUI 版本优先发布桌面安装资产和签名 updater 资产，同时保留 fallback zip：

```text
CodeXProviderSwitcher-windows-x64-<version>-setup.exe
CodeXProviderSwitcher-windows-x64-<version>-setup.exe.sha256
CodeXProviderSwitcher-windows-x64-<version>.zip
CodeXProviderSwitcher-windows-x64-<version>.zip.sha256
latest.json
CodeXProviderSwitcher-windows-x64-<version>-setup.exe.sig
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
11. 在已安装程序中检查更新，确认新版本下载、签名校验、重启后版本变化，且 `%LOCALAPPDATA%\CodeX Provider Switcher` 数据仍在。

只有完成这条路径，才能说产品已交付。

如果在 PR 合并前只需要确认当前 GitHub Release 资产仍可下载、校验文件匹配远端 zip、包内结构正确，可以使用结构验证模式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\release\verify-github-release-asset.ps1 -RemoteStructureOnly
```

合并并重新发布资产后，必须去掉 `-RemoteStructureOnly`，执行完整一致性复验。
