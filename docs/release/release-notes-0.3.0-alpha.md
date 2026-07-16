# CodeX Provider Switcher 0.3.0-alpha 发布说明

`0.3.0-alpha` 把桌面 GUI 基线推进到可稳定安装和可持续发布的产品化边界。

## 主要变化

- 固定三种运行状态：源码树开发版、本地候选版、GitHub Release 稳定版。
- 本地发布资产统一输出到仓库根目录的 `release-assets/`，该目录只用于构建和验收，不进入 Git。
- 稳定安装 QA 默认使用 `D:\Software\CodeX Provider Switcher`；该路径是本机约定，不是公开产品硬编码。
- 程序文件与 `%LOCALAPPDATA%\CodeX Provider Switcher` 中的 profiles、备份、活动记录和更新缓存分离。
- 接入 Tauri updater。正式构建要求签名私钥由本机或 CI secret 提供，生成 `latest.json`、签名 setup 更新包和 `.sig` 文件。
- 发布脚本不再使用 `--clobber`，旧版本 Release 和 tag 不覆盖；每次正式发布必须创建新版本和新 tag。
- 保留 fallback Web zip，供排障和本地 Web 诊断使用。

## 下载建议

优先下载：

```text
CodeXProviderSwitcher-windows-x64-0.3.0-alpha-setup.exe
CodeXProviderSwitcher-windows-x64-0.3.0-alpha-setup.exe.sha256
```

更新通道资产：

```text
latest.json
CodeXProviderSwitcher-windows-x64-0.3.0-alpha-setup.exe.sig
```

备用入口：

```text
CodeXProviderSwitcher-windows-x64-0.3.0-alpha.zip
CodeXProviderSwitcher-windows-x64-0.3.0-alpha.zip.sha256
```

## Alpha 边界

- 这是可用 Alpha，不代表已经替换旧版 `CodeX-Switcher.exe`。
- 更新必须来自签名 GitHub Release；开发版不会自动跟随稳定通道。
- provider 最终 cutover 仍需新会话或另一个 agent 按交接包执行。
- Windows Authenticode 代码签名和旧工具最终退役仍是后续发布决策。
