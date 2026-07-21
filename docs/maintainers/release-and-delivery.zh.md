# 发布与交付手册

这份手册面向维护者。它回答的不是“CI 绿了吗”，而是“普通用户能否安全拿到新版本”。正式安装版优先通过 Microsoft Store 交付；GitHub setup 只是具备完整签名条件时才启用的直装备用渠道。

## 发布前先看状态

运行：

```powershell
npm run release:readiness
```

默认命令检查 Store 交付前提，只读取版本、GitHub 仓库状态和 Dependabot 告警，不读取 Secret 值，也不创建 tag、Release 或 Partner Center 提交。GitHub 直装备用渠道另用 `npm run release:readiness -- -Channel github-direct`，才会检查四个签名 Secret 名称。结果要写入 PR 描述和合并后的收口记录。它会明确区分：

- **可继续准备**：代码和发布条件没有已知阻断。
- **代码可合并，产品不可交付**：例如缺 Windows 代码签名 Secret 或有未处理的中高风险依赖告警。
- **停止**：版本、GitHub 可达性、发布资产状态或签名条件异常。

## 交付状态机

| 状态 | 必须具备 |
| --- | --- |
| PR 就绪 | 本地验证、文档同步、开发版验收、PR 描述中的发布计划 |
| 代码已合并 | PR 合并，最新 `main` CI 正常 |
| 可以提交 Store | 版本/tag 一致、MSIX 清单身份正确、无发布级 Dependabot 告警 |
| Store 产品已交付 | 新 tag、MSIX 构建产物、Partner Center 认证通过、从 Microsoft Store 安装、启动和更新验收均完成 |
| GitHub 直装可用 | 四个直装签名 Secret 名称齐全、不可变 GitHub Release、远端下载与 setup 验收均完成 |

不能跳过最后两行。没有实际渠道发布与普通用户路径验收时，任何“发布完成”都应改写为“代码已合并，产品未交付”。GitHub 的 `validate` 只验证代码，不能读取或证明发布凭据、Store 认证结果存在；不要把 CI 绿当成发布许可。

## Store 正式发布步骤

1. 合并发布影响 PR 后，切到最新 `main`，确认 main CI 正常。
2. 运行 `npm run release:readiness`；有阻断就停止，不创建 tag。
3. 确认 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 版本一致。
4. 写用户能看懂的 `docs/release/release-notes-<version>.md`。
5. 创建新 `v<version>` tag 并推送。不要覆盖旧 tag。
6. PR 阶段的 `Microsoft Store package` 已先构建临时 MSIX artifact；tag 后再等待同一 workflow 生成用于 Partner Center 的 MSIX artifact。它只打包，不会替你创建提交、上传或发布。
7. 从 workflow artifact 下载 MSIX，在 Partner Center 对 Store ID `9P7PGV62WKK6` 创建提交并上传。Microsoft Store 会在提交后签名，不需要把 PFX、私钥或口令放入本机或仓库。
8. 填完 Store 必需的商店资料，提交认证。认证通过后，从 [Microsoft Store 产品页](https://apps.microsoft.com/detail/9P7PGV62WKK6) 按普通用户路径安装、启动，并在应用中打开“在 Store 检查更新”。
9. 确认新版本和数据保留后，才标记“产品已交付”。若这次要替换旧工具，继续在新的 Codex 会话按 [旧工具替换手册](legacy-cutover.zh.md) 完成受控交接。

## Store 等待期的本机候选更新

Store 审核可能需要数小时到数个工作日，但这不应让维护者固定桌面入口停留在已知有缺陷的旧版本。对于已经合并、主线 CI 成功且尚未发布到 Store 的发布影响修复，可以刷新本机候选安装：

```powershell
npm run qa:refresh-local-candidate -- -Apply
```

首个迁移如需从旧工具带回已有 profile，可在同一命令中加：

```powershell
npm run qa:refresh-local-candidate -- -Apply -LegacyProfilesPath "<旧工具 profiles.json 的本机路径>"
```

该命令只允许在干净 `main` 运行，写入候选安装目录的 `candidate-install-state.json` 记录版本和 commit，且不会创建 tag、GitHub Release、Store 包或 Partner Center 提交。它只更新程序文件，保留已有本机用户资料。若本机存在旧工具 profile，恢复操作必须先备份并使用 DPAPI 保护导入结果；不得要求用户逐条重填密钥，也不得覆盖已保存的凭据。

本机候选安装只用于维护者本人继续使用与验收，不能作为对外下载入口或“产品已交付”的证据。Store 发布后必须从 Store 安装并验收，再退役候选安装。

## GitHub 直装备用渠道

GitHub setup 不是正式安装版的默认入口。只有确有受控排错或企业直装需要时，才从 Actions 页面手动运行 `GitHub direct-install fallback` workflow。该渠道同时需要四个 GitHub Actions Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `WINDOWS_CERTIFICATE`
- `WINDOWS_CERTIFICATE_PASSWORD`

前两项为 updater 包签名，后两项为 Windows Authenticode 代码签名。它们的用途不同，不能互相代替。普通用户和日常 PR 不需要私钥、PFX 或口令。

没有受信任的 Windows 代码签名证书时，不得生成自签名 PFX 来冒充交付。此时只走 Store MSIX；不要让 GitHub fallback workflow 自动在 tag 上失败。若未来申请 SignPath 等受管签名服务，先评估其资格、审批、可用性和 GitHub Actions 集成，再把它配置为 `WINDOWS_CERTIFICATE` 的替代实现。

## 旧工具与最终替换

发布成功后，才由新的 Codex 会话运行 `npm run qa:cutover-preflight` 做只读确认。用户确认后再进行真实 provider 切换、旧工具停用与重启复查。当前开发会话不得执行这些动作；旧目录保留作回滚参考。完整步骤见 [旧工具替换手册](legacy-cutover.zh.md)。
