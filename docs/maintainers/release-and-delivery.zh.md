# 发布与交付手册

这份手册面向维护者。它回答的不是“CI 绿了吗”，而是“用户从哪条路径拿到了哪个版本，以及它是否真的能运行”。

## 两条交付路径

| 路径 | 责任 | 节奏 | 必须具备 |
| --- | --- | --- | --- |
| GitHub Release | 日常公开小版本与应用内更新 | 只在决定发布用户可见版本时创建新 tag | Tauri updater 私钥、不可变 Release、SHA256、`.sig`、`latest.json`、远端下载和安装验收 |
| Microsoft Store | 低频稳定大版本 | 只在选定已经验证的 GitHub tag 后手动构建与提交 | 同一 tag 的 MSIX、Partner Center 认证、Store 安装和更新验收 |

不购买 Windows Authenticode/Artifact Signing 是本项目已确认的策略。GitHub `setup.exe` 因此可能出现 SmartScreen 提示；不要把 Store 的微软签名说成 GitHub 安装包的签名，也不要生成自签名 PFX 冒充可信发布。

## 两种发布检查

维护者在创建 tag 前运行：

```powershell
npm run release:readiness -- -Mode Maintainer -Channel github
```

默认是 `Maintainer` 模式。它检查版本、GitHub 状态、Dependabot 告警、immutable Release 设置和两个 Tauri updater Secret 名称；不读取 Secret 值，也不创建 tag 或 Release。这个检查必须在维护者本机、使用具有仓库治理读取权限的登录态运行。

GitHub Actions 使用 `RunnerSafe` 模式。它只检查 tag、源码版本和既有 Release 状态，不枚举 Secret 名称，不读取 Dependabot 告警，也不要求个人 PAT。构建 job 对实际注入的 updater Secret 做非空校验。

Store 大版本准备前运行：

```powershell
npm run release:readiness -- -Channel store
```

任何命令只给出“可发布条件”判断，不能代替实际渠道安装验收。

## 交付状态机

| 状态 | 必须具备 |
| --- | --- |
| PR 就绪 | 本地验证、文档同步、开发版验收、PR 描述中的发布计划 |
| 代码已合并 | PR 合并，最新 `main` CI 正常 |
| GitHub 已交付 | 新 tag、不可变 GitHub Release、远端下载、安装、启动和更新验收完成 |
| Store 已交付 | 已验证 GitHub tag 的 MSIX、Partner Center 认证、从 Store 安装、启动和更新验收完成 |

普通 PR 合并不等于发布。没有完成对应渠道的实际安装验收，只能写“代码已合并，产品未交付”。

## GitHub 发布步骤

1. 合并用户可见版本的 PR 后，切到干净的最新 `main`，确认 main CI 成功。
2. 确认 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的版本一致，准备用户可读的 `docs/release/release-notes-<version>.md`。
3. 运行 GitHub release readiness；有阻断就停止。
4. 创建并推送新 `v<version>` tag。`GitHub Release` workflow 自动构建同一 tag 的 GitHub 安装包；不要覆盖旧 tag 或旧 Release。
5. workflow 必须生成 setup、SHA256、updater `.sig` 与 `latest.json`。Tauri updater 私钥只存在 GitHub Actions Secret 中，普通用户不需要也看不到它。
6. 从 GitHub Release 按普通用户路径下载、核对 SHA256、安装、启动并检查更新。未购买 Windows 代码签名时，记录 SmartScreen 行为，但不要把“无提示”作为 GitHub 交付门槛。
7. 完成后才写“GitHub 已交付”。

### 发布事故处理

如果 tag 已创建但 workflow 在资产生成前失败，状态必须写为“代码已合并，产品未交付（release incident）”，并暂停新的发布影响 PR。不能删除或重打同一个 tag，也不能手工补传资产。

只允许创建一个修复发布控制逻辑的 PR。该 PR 合并并通过 main CI 后，从默认分支手动运行 `GitHub Release` workflow，输入原 tag。workflow 会先 checkout 修复后的控制逻辑，用 Git 读取原 tag 的版本元数据；只有身份检查完成后才 checkout 原 tag 构建，因此最终资产仍来自原 SHA。完成远端下载、安装、启动和更新验收前，事故不能关闭。

## Microsoft Store 大版本步骤

1. 只选择已经完成 GitHub 发布验收的 tag；Store 不跟随每个 GitHub 小版本。
2. 运行 Store readiness，确认 MSIX 版本高于已提交 Store 版本，第四段 revision 固定为 `0`。
3. 从 Actions 手动运行 `Microsoft Store candidate package`，输入该 GitHub tag。这个 workflow 只构建 MSIX artifact，不创建 Partner Center 提交。
4. 下载 artifact，在 Partner Center 上传、补齐必须资料并提交认证。Store 在提交后负责包签名；不需要 PFX、Tauri 私钥或口令。
5. 认证通过后，从 [Microsoft Store 产品页](https://apps.microsoft.com/detail/9P7PGV62WKK6) 按普通用户路径安装、启动并检查更新。
6. 完成后才写“Store 已交付”。

## 本机安装与候选版

| 类型 | 目录或来源 | 用途 |
| --- | --- | --- |
| 开发版 | 源码目录直接启动 | 当前分支的开发验收，不安装 |
| GitHub 稳定安装 | `D:\Software\Signalman AI`（维护者约定） | 已发布 GitHub tag 的本机安装验收与日常 GitHub 使用 |
| 维护者候选 | `D:\Software\Signalman AI Candidate` | 显式、短期的合并后候选验收，不是公开入口 |
| Store 安装 | Windows Store 管理的位置 | Store 用户的稳定入口 |

候选版只在维护者明确需要时运行：

```powershell
npm run qa:refresh-local-candidate -- -Apply
```

它只停止和清理指向候选目录的进程、快捷方式和卸载登记，不能触碰 Store 或 GitHub 稳定安装。候选刷新不是每次合并后的默认动作。

本机资料保持在 `%LOCALAPPDATA%\CodeX Provider Switcher`，迁移或卸载程序文件时不得删除、导出或覆盖它。真实清理旧候选入口前，先运行只读预检：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/qa/prepare-local-install-migration.ps1
```

只有 GitHub 稳定安装已实际 smoke 通过后，才由新的 Codex 会话执行后续本机清理或旧工具交接。

## 旧工具与最终替换

发布成功后，由新的 Codex 会话运行 `npm run qa:cutover-preflight` 做只读确认。用户确认后再进行真实 provider 切换、旧工具停用与重启复查。当前开发会话不得执行这些动作；旧目录保留作回滚参考。完整步骤见 [旧工具替换手册](legacy-cutover.zh.md)。
