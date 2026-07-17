# CodeX Provider Switcher 0.3.2-alpha 发布说明

## 摘要

本版本不改变 provider 切换的产品流程，重点是让 Windows Release 的构建、签名、发布和重试可观察、可复核。

## 主要改动

- GitHub Actions 为 Rust/Tauri 构建加入 cache 和明确的 job 超时。
- Release workflow 改为 preflight、签名构建、artifact 发布三个隔离 job。
- 签名私钥只在 build job 可见；publish job 只处理已校验的公开资产。
- 新增候选资产校验：检查 setup、zip、SHA256、签名和 updater manifest 是否一致。
- 已有完整 Release 只验证，不覆盖；已有不完整 Release 会停止并提示人工处理。

## 用户影响

- 安装入口仍是 Windows setup exe，fallback zip 仍用于排障和本地 Web 诊断。
- 用户不需要提供签名私钥或口令。
- 正式 Release 仍须是 GitHub Latest，不能标为 Pre-release，才能被应用内更新检查读取。

## 发布资产

~~~text
CodeXProviderSwitcher-windows-x64-0.3.2-alpha-setup.exe
CodeXProviderSwitcher-windows-x64-0.3.2-alpha-setup.exe.sha256
CodeXProviderSwitcher-windows-x64-0.3.2-alpha-setup.exe.sig
CodeXProviderSwitcher-windows-x64-0.3.2-alpha.zip
CodeXProviderSwitcher-windows-x64-0.3.2-alpha.zip.sha256
latest.json
~~~

## 升级和边界

- 从 0.3.1-alpha 升级到本版本时，应从 GitHub Release 下载新 setup 并按普通用户路径安装。
- 本版本是后续真实跨版本自动更新验收的前置版本；合并和发布后仍要验证下载、签名校验、替换、重启和用户数据保留。
- 不覆盖旧 tag 或旧 Release；发现已有不完整 Release 时停止，不自动替换资产。
