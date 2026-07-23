# 变更记录

这里记录已合并版本线的用户可见变化。是否已经可下载安装，以对应版本的发布说明和实际用户渠道为准。

## 0.9.0-alpha - 未发布

- 确立 GitHub 日常发布和 Microsoft Store 稳定大版本的双渠道交付。GitHub 安装包保留 Tauri updater 签名，不再因缺少 Windows PFX 阻断；Microsoft Store 包改为从已验证 GitHub tag 手动构建。
- GitHub Release 构建显式启用 stable 更新通道；Store 与维护者候选构建分别隔离为 store 和 candidate 通道。
- 维护者本机 GitHub 稳定安装与候选安装目录分别固定为 `D:\Software\Signalman AI` 和 `D:\Software\Signalman AI Candidate`；候选脚本只清理自身入口，不触碰 Store 或用户资料。
- README、安装、排错、开发与发布文档改为分别说明 GitHub 最新版与 Store 稳定版，并明确未购买 Windows 代码签名时的 SmartScreen 边界。
## 0.8.0-alpha

- 产品显示名称改为 Signalman AI；桌面窗口、安装器、MSIX 显示名、商店文案、截图和发布资产同步更新。
- 保留既有 Store ID、MSIX Identity、可执行文件名、GitHub 仓库地址与本机数据目录，确保已安装用户仍可升级并读取 DPAPI 保护的资料。
- 修复候选安装刷新时桌面进程占用导致的安装阻断。
- 仓库与文档产品化：使用者、贡献者、发布维护者和历史资料分层；新增发布就绪检查和依赖风险登记。
- 服务商可用性测试成为切换门槛：只有当前地址、模型和密钥通过真实短请求，才会写入 Codex 配置；同步模型或保存配置会使旧测试失效。
- 新增旧工具替换手册与更完整的只读交接预检，公开 README 改为面向使用者的产品首页，并使用无敏感示例截图。
- 新增 Microsoft Store MSIX 打包、身份校验和 tag 触发的构建 artifact；Store 安装版不加载 GitHub updater，更新由 Store 管理。
- GitHub setup 改为受控直装备用渠道；它不再因 Store 发布 tag 自动触发，仍要求 updater 和 Windows Authenticode 双签名。

## 0.6.0-alpha - 2026-07-18

- provider API key 与应用创建的敏感恢复副本改用当前 Windows 用户的 DPAPI 保护，并兼容迁移旧明文资料。
- 安全检查能识别当前 Codex 模型与本地目录差异；确认后只同步本地目录，不改写 Codex 配置。
- 正式 Release 同时要求更新包签名与 Windows 代码签名，并增加旧工具替换前的只读检查。

## 0.5.0-alpha - 2026-07-18

- 修正服务商可用性测试的结果分类，区分可调用、标准 Responses 形状与待确认响应。
- 将界面中的检查名称统一为“服务商可用性测试”，它不会替代真实 Codex 使用结果。

## 0.4.1-alpha - 2026-07-18

- 修复已验证更新包的安装路径，并保留受限的手动下载 fallback。
- 明确旧安装版升级到新更新基线时的一次性手动升级要求。

## 0.4.0-alpha - 2026-07-18

- 增加恢复中心、无凭据备份 manifest 和恢复确认。
- 移除旧工具特定的运行时自动导入与展示逻辑。

## 0.3.2-alpha - 2026-07-17

- 增加 Rust/Tauri 构建缓存、阶段耗时与分阶段 Release 工作流。
- 发布资产先验证再发布，已存在 Release 不会被自动覆盖。

## 0.3.1-alpha - 2026-07-16

- 修复 Windows setup 启动桌面 GUI 的入口。
- 本地 Web 后端继续作为 fallback 和诊断能力，不再作为安装后的桌面入口。

## 0.3.0-alpha - 2026-07-16

- 建立桌面安装包、签名更新、稳定安装版与本地候选包的基础流程。
- 默认保持单窗口、无托盘、无开机自启。

## 0.2.0-alpha - 2026-07-15

- 建立轻量 Tauri 桌面 GUI、provider 目录、备份与恢复基础。

## 0.1.0-alpha - 2026-07-14

- 首个公开 alpha：React/Vite 界面、Tauri/Rust 本地能力、模型目录与安全切换基础。
