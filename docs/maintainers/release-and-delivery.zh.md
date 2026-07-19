# 发布与交付手册

这份手册面向拥有 GitHub 发布权限的维护者。它回答的不是“CI 绿了吗”，而是“普通用户能否安全拿到新版本”。

## 发布前先看状态

运行：

```powershell
npm run release:readiness
```

该命令只读取版本、GitHub 仓库状态、Secret 名称和 Dependabot 告警，不读取 Secret 值，也不创建 tag 或 Release。它是发布影响 PR 的人工交付门槛：结果要写入 PR 描述和合并后的收口记录。它会明确区分：

- **可继续准备**：代码和发布条件没有已知阻断。
- **代码可合并，产品不可交付**：例如缺 Windows 代码签名 Secret 或有未处理的中高风险依赖告警。
- **停止**：版本、GitHub 可达性、发布资产状态或签名条件异常。

## 交付状态机

| 状态 | 必须具备 |
| --- | --- |
| PR 就绪 | 本地验证、文档同步、开发版验收、PR 描述中的发布计划 |
| 代码已合并 | PR 合并，最新 `main` CI 正常 |
| 可以发版 | 版本/tag 一致、四个签名 Secret 名称齐全、无发布级 Dependabot 告警 |
| 产品已交付 | 新 tag、不可变 GitHub Release、远端下载、安装、启动、升级/回滚验收均完成 |

不能跳过最后一行。没有实际 Release 与普通用户路径验收时，任何“发布完成”都应改写为“代码已合并，产品未交付”。GitHub 的 `validate` 只验证代码，不能读取或证明发布证书存在；不要把 CI 绿当成发布许可。

## 正式发布步骤

1. 合并发布影响 PR 后，切到最新 `main`，确认 main CI 正常。
2. 运行 `npm run release:readiness`；有阻断就停止，不创建 tag。
3. 确认 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 版本一致。
4. 写用户能看懂的 `docs/release/release-notes-<version>.md`。
5. 创建新 `v<version>` tag 并推送。不要覆盖旧 tag 或旧 Release。
6. 等待 Release workflow 生成 setup、校验文件、更新签名、`latest.json` 与 fallback zip。
7. 从 GitHub Release 下载资产，按普通用户路径安装、启动，并验证更新、数据保留与回滚边界。
8. 运行远端资产复验，确认 Release immutable，然后才标记“产品已交付”。若这次要替换旧工具，继续在新的 Codex 会话按 [旧工具替换手册](legacy-cutover.zh.md) 完成受控交接。

## 签名凭据

正式 Windows Release 同时需要四个 GitHub Actions Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `WINDOWS_CERTIFICATE`
- `WINDOWS_CERTIFICATE_PASSWORD`

前两项为 updater 包签名，后两项为 Windows Authenticode 代码签名。它们的用途不同，不能互相代替。普通用户和日常 PR 不需要私钥、PFX 或口令。

没有受信任的 Windows 代码签名证书时，不得生成自签名 PFX 来冒充交付。先完成受控证书采购、Secret 配置和 readiness 检查，再创建 release tag。

## 旧工具与最终替换

发布成功后，才由新的 Codex 会话运行 `npm run qa:cutover-preflight` 做只读确认。用户确认后再进行真实 provider 切换、旧工具停用与重启复查。当前开发会话不得执行这些动作；旧目录保留作回滚参考。完整步骤见 [旧工具替换手册](legacy-cutover.zh.md)。
