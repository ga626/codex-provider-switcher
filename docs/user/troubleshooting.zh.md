# 排错指南

## 桌面应用打不开

如果你安装了桌面版，先从开始菜单或桌面图标启动 `CodeX Provider Switcher`。预期行为是打开一个正常桌面窗口，不需要浏览器和端口。

如果你是在开发中看当前 PR 或本地改动，先不要重新安装。运行：

```powershell
npm run qa:dev-desktop
```

这会打开当前源码树的桌面应用，用于开发版验收。只有安装器、Release 包、版本号、启动入口、升级/卸载路径变化时，才需要重新构建并运行 setup exe。

如果窗口没有出现：

- 确认下载的是当前 Release 对应的 `CodeXProviderSwitcher-windows-x64-<version>-setup.exe`。
- 确认 Windows WebView2 Runtime 可用。多数 Windows 11/新版 Windows 10 已内置；缺失时需要安装 Microsoft Edge WebView2 Evergreen Runtime。
- 如果安装器被拦截，改用 fallback zip。

## fallback Web 页面打不开

如果你是从 fallback zip 启动，先确认是在解压出的 `CodeXProviderSwitcher-windows-x64-<version>` 目录里双击 `CodeXProviderSwitcher.cmd`。

## 检查更新失败

开发版不会使用稳定更新通道，这是预期行为。稳定版如果提示更新失败，先确认网络可以访问 GitHub Release，并检查当前版本对应的 `latest.json`、setup exe 和 `*-setup.exe.sig` 仍在同一个 Release 中。签名校验失败时不要手动替换程序目录，回到上一版稳定安装并向项目报告 Release 资产问题。

## 卸载后数据还在

卸载程序文件不会删除 `%LOCALAPPDATA%\CodeX Provider Switcher`。这是设计好的恢复边界，便于重新安装和升级。如果确实需要清空用户数据，应先备份 `profiles.json` 和 `backups\`，再由用户手动删除该目录。

固定入口是：

```text
http://127.0.0.1:47832/
```

如果页面没有自动打开，可以手动访问上面的地址。也可以先停止再启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\CodeXProviderSwitcher.ps1 -Stop
powershell -NoProfile -ExecutionPolicy Bypass -File .\CodeXProviderSwitcher.ps1
```

如果你是从源码树启动，优先使用真实本地 Web 后端入口：

```powershell
.\setup.cmd
```

如果只是检查 UI mock，再确认本地预览是否启动：

```powershell
npm run preview:start
```

这不是桌面产品验收，只用于浏览器 mock 调试。

如果端口被占用，脚本会尝试 `5173`、`5174`、`5175`、`5180`、`3000`、`3001`。

也可以手动构建并启动真实本地 Web 后端：

```powershell
npm run build
npm run backend:build
npm run backend:dev -- --port 47832
```

然后打开：

```text
http://127.0.0.1:47832/
```

## 看到“真实本地后端不可用”

这表示当前页面不是通过真实本地后端正常加载。产品入口不会回落到浏览器假数据。

优先使用以下入口：

```powershell
.\CodeXProviderSwitcher.cmd
```

或源码树入口：

```powershell
.\setup.cmd
```

开发预览中的 UI-only 假数据只用于界面检查，不代表真实产品运行态。

## 构建失败

重新安装依赖并构建：

```powershell
npm ci
npm run build
```

## Tauri/Rust 检查失败

确认 Rust 工具链可用：

```powershell
cargo --version
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri:desktop-boundary:smoke
```

## GitHub Actions 构建过慢或超时

先看 Actions 中是哪一个阶段慢：前端、Tauri/NSIS、本地后端、候选资产校验，还是发布。Rust/Tauri cache 只会加速相同依赖和工具链下的后续构建；第一次冷构建仍可能较慢。

不要重新生成签名密钥，也不要重用旧 tag。若 build job 超时，记录 cache 命中和阶段耗时后修复；若已有完整 Release，使用受控的 workflow_dispatch 输入该 tag 做远端结构验证，不覆盖已有资产。

## provider 切换失败

不要直接手工覆盖 `config.toml` 或 `auth.json`。先确认是否已有备份和恢复路径。涉及真实 Codex provider 切换时，应使用新会话或另一个 agent 执行最终 cutover。

## 服务商可用性测试或模型选择提示未确认

“刷新模型目录”只调用服务商的 `/v1/models`，因此只代表目录可读，不代表模型已经可用于 Codex。运行“服务商可用性测试”会使用当前模型发送短时、低 token、已认证的 `/v1/responses` 请求；它会区分标准 Responses 结果、含可识别输出的兼容结果，以及服务端已响应但工具尚不能解释结果的情况。

- `服务端已响应，结果待确认` 或 `服务端已响应，无法解析`：这说明本工具收到了响应，但还不能从中确认模型输出。它不会阻止本地安全切换，也不代表当前服务商不能被 Codex 使用。
- `可调用（兼容响应）`：当前模型返回了可识别输出，但没有完整标准 Responses 外形；这是一条正向可用性证据，不代表已经验证全部 Codex 场景。
- `认证被拒绝`、`额度或配额不足`、`路径或模型不可用`、`请求不被接受`、`服务商正在限流`、`服务商异常`、`请求超时`或`网络不可达`：按提示检查凭据、账户、地址、模型或网络后，再手动重试测试。
- 手动输入的模型不在最近目录中时，保存前会要求二次确认；确认和测试都不替代实际 Codex 使用结果。

## 恢复最近备份

在“安全检查”的恢复中心选择“恢复最近备份”，确认后会恢复该应用创建的最近一份配置和凭据备份。恢复完成后重新检查当前服务商；恢复不会证明远端 provider 仍然可用。

## 不要提交的信息

不要把真实 API key、`auth.json`、真实 `profiles.json`、备份目录、截图或本机私有日志贴到 Issue、PR 或公开文档里。
