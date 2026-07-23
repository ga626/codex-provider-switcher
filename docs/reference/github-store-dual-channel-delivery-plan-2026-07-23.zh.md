# GitHub 与 Microsoft Store 双渠道交付方案

> 日期：2026-07-23
> 状态：实施前事实快照；本方案已随 PR `重置 GitHub 与 Store 双渠道交付流程` 落地，等待合并。
> 本文保留调研、决定和实施前的基线证据；表中旧安装、旧 workflow 和旧目录描述是历史事实，不是合并后的运行要求。

## 先说结论

`Signalman AI` 以后采用两个清楚分开的下载与更新路径：

| 路径 | 面向谁 | 更新节奏 | 首次安装体验 | 本轮确定的取舍 |
| --- | --- | --- | --- | --- |
| GitHub Release | 想尽快拿到新功能的用户和维护者 | 需要发布时即可更新，通常对应已合并的用户可见小版本 | 未购买 Windows 代码签名时，Windows 可能提示“Windows 已保护你的电脑” | 接受该提示；不购买证书；只让用户从官方 Release 下载 |
| Microsoft Store | 想要无警告、由微软管理更新的普通用户 | 低频大版本或经过一段时间验证的稳定版本 | Microsoft Store 签名，正常情况下没有 SmartScreen 下载警告 | 不要求每个 GitHub 小版本都同步提交 Store |

这不是两套产品，也不是二选一的临时补丁。两条路径使用同一份已经验证的源码和产品版本，只是交付节奏不同：GitHub 是日常公开更新的主路径，Store 是低频、稳定、免去首次安装警告的路径。

此前把“Store 的微软签名”说得像能替 GitHub `setup.exe` 消除警告，是路径边界判断不够准确。它们是两条独立链路：Store 只为从 Store 安装的包签名和更新；GitHub 直装包不因 Store 上架而自动获得 Windows 信任。这个 PR 会把实现、文档和规则统一到已确认的双渠道决策上。

## 以后日常怎么用

### 普通用户

1. 想要最新功能：到 GitHub Releases 下载 `setup.exe`。首次出现 Windows 提示时，只在确认下载页是本仓库官方 Release、版本号和校验文件一致后继续。企业设备或 Smart App Control 可能不允许继续，不能承诺绕过。
2. 想要更省心的安装体验：从 Microsoft Store 安装。Store 版只在稳定大版本时更新，版本可能落后于 GitHub，这是公开且正常的节奏差异。
3. 一台电脑只选择一个日常入口。不要把 GitHub 安装版、Store 版和维护者候选版都当作日常桌面入口。

### 维护者

1. 日常开发在源码目录运行开发版，只用于当前分支验收，不安装、不覆盖日常软件。
2. 普通 PR 合并后不自动产生公开版本，也不自动提交 Store。
3. 需要向 GitHub 用户交付时，基于已合并、已验证的 commit 创建新版本 tag，并生成不可变 GitHub Release。GitHub 安装包必须保留 Tauri updater 签名、`.sig`、`latest.json` 和 SHA256 文件。
4. 准备 Store 大版本时，只从一个已经完成 GitHub 发布验收的 tag 构建同一 commit 的 MSIX，上传 Partner Center 并完成认证。Store 通过后再把这个版本标记为 Store 可用。

## 需要先分清的四种状态

“开发版”“候选版”“GitHub 安装版”“Store 安装版”不能再混用同一个桌面入口。

| 状态 | 作用 | 是否面向用户 | 位置或来源 | 能否自动变化 |
| --- | --- | --- | --- | --- |
| 源码开发版 | 当前功能和界面验收 | 否 | 当前仓库直接启动 | 随当前分支变化 |
| 维护者候选版 | 合并后、正式发布前的受控安装验收 | 否，仅维护者 | `D:\Software\Signalman AI Candidate` | 只能由维护者显式刷新 |
| GitHub 稳定安装版 | 日常公开小版本 | 是 | `D:\Software\Signalman AI` 或安装器用户选择的位置 | 仅通过 GitHub Release/updater 更新 |
| Store 安装版 | 低频稳定大版本 | 是 | Windows 的受保护 Store 安装位置 | 仅由 Microsoft Store 更新 |

应用资料继续保留在 `%LOCALAPPDATA%\CodeX Provider Switcher`。这是为了读取已经 DPAPI 保护的本机资料的兼容标识，不是对外产品名；不能因为品牌改名就删除、复制或强行改写它。

## 当前事实与真正问题

以下是 2026-07-23 对本机、仓库和远端的复核结果。

| 项目 | 已核对事实 | 影响 |
| --- | --- | --- |
| 仓库状态 | `main`，HEAD 为 `667c25e`，工作区干净 | 可以从确定基线开始规划；本报告不包含未提交运行态变更 |
| Store 安装 | 已安装 `ga626.CodexProviderSwitcher` `0.8.0.0` | Store 已经成为可用的稳定下载路径，不应再写“正在认证” |
| GitHub Release | Latest 仍是旧品牌 `CodeX Provider Switcher 0.5.0-alpha`；`0.6`、`0.7`、`0.8`没有相应公开 Release | README 与实际公开下载入口明显失配；GitHub 主路径尚未成立 |
| 本机候选 | `D:\Software\CodeX Provider Switcher` 仍是 `0.8.0-alpha`、commit `667c25e` | 路径、开始菜单、桌面快捷方式和卸载记录仍有旧名与重复项 |
| GitHub 发布 workflow | `.github/workflows/release.yml` 仍叫 `GitHub direct-install fallback`，且要求 Windows PFX Secret | 与“不购买证书、GitHub 是日常主路径”的决定冲突 |
| 更新通道 | `src/adapter.ts` 只在 `CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL=stable` 时启用 Tauri updater；Store 打包脚本明确设为 `store`，GitHub 发布链路没有明确设为 `stable` | 即使发布成功，GitHub 安装版也可能不启用应用内更新，属于发布级缺口 |
| Store workflow | PR 与每个 `v*` tag 都会构建 MSIX artifact | 每次 GitHub 小版本都产生“待上传 Store 包”的噪音，容易误导为必须同步提交 Store |
| 文档与规则 | README、安装指南、产品规格、维护手册和项目规则仍大量使用“Store 优先/未认证/GitHub fallback” | 用户、贡献者和 Codex 会得到互相矛盾的流程指令 |

当前 D 盘候选安装还会按进程名停止 `codex-provider-switcher`，有误伤另一安装来源的风险；同时它会留下重复的开始菜单、桌面快捷方式和卸载登记。这不是“再加一个入口”能解决的问题，必须给每个安装来源固定职责、目录和清理时机。

## 外部调研结论

### 1. Store 不能替 GitHub 直装签名

Microsoft 的分发说明将 Store 分发和旁加载/直装分开。Store 包由 Microsoft Store 重新签名、托管更新；离开 Store 的 `setup.exe` 仍要自行承担下载信任和更新完整性。[选择 Windows 应用分发路径](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path)

因此，保持 Store 大版本、GitHub 小版本的策略是可行的，但 README 必须诚实展示两个版本的差异，不能写成“Store 永远最新”。

### 2. 不购买证书时，GitHub 警告是已知边界，不是可以静默修掉的 bug

Microsoft 明确说明：Store 分发是避免 SmartScreen 警告的最简单路径；未签名直装会触发“Windows 已保护你的电脑”，企业策略可能不允许继续。即使购买有效证书，新二进制也可能在信誉积累前提示；EV 证书不再保证首发绕过提示。[SmartScreen 信誉说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

本项目的决定是：不购买 Windows Authenticode/Artifact Signing，接受 GitHub 首次直装提示；用户文档只说明如何确认官方来源和校验值，绝不承诺绕过企业或 Smart App Control 策略。

### 3. Tauri updater 仍然必要，且和 Windows 代码签名不同

Tauri updater 使用内置公钥验证更新包的签名；私钥只在发布构建环境使用，不能放入安装包、用户界面或仓库。每次 installer 变化都要同步生成新的 `.sig` 和 `latest.json`。这能确认更新包来自持有发布私钥的一方，但不会改变 Windows 对首次下载 `setup.exe` 的 SmartScreen 判断。[Tauri Updater](https://v2.tauri.app/plugin/updater/)

换句话说：GitHub 用户不需要密钥或口令；维护者只需要保管一次生成的 Tauri updater 私钥并放入 GitHub Actions Secrets。它不是 Windows 证书，也不能替代 Store 签名。

### 4. 不能用 `ms-appinstaller:` 伪造一键直装体验

该协议自 2023 年起在普通消费者设备默认禁用，不能作为 GitHub 直装方案的基础。GitHub 路线应使用正常的 `setup.exe` 下载和升级；想要真正的一键、无警告安装体验，就使用 Microsoft Store。[Windows 分发功能现状](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/distribution-feature-status)

### 5. 公开仓库的可借鉴点

[Readest](https://github.com/readest/readest) 这类跨平台桌面项目会把不同商店和直装渠道分开说明，而不是让用户猜哪一个是最新版。本项目吸收的是信息架构原则：README 第一屏先让用户选择下载路径，再解释节奏和限制；不照搬它的具体平台或发布工具。

## 下一个完整 PR：双渠道交付重置

### 为什么可以是一个 PR

本轮不是单纯改一段 README。发布 workflow、更新通道、版本说明、本机入口、规则与文档互相依赖：只改其中一项会继续制造“代码合并了，用户拿不到正确版本”的假象。因此建议作为一个完整的“发布流程重置 PR”处理。

但有一个边界：实际卸载旧候选、清理用户桌面入口、停止旧工具和 provider cutover 不应在 PR 内自动执行。PR 只准备可审计的脚本、说明和验收；实际本机切换只能在合并后、新的 Codex 会话中完成。

### A. GitHub 发布链路

1. 将 workflow 名称、变量和文案从 `fallback` 改为 GitHub 日常发布路径。
2. 删除 Windows PFX/`WINDOWS_CERTIFICATE*` 作为 GitHub 发布的硬前置条件；保留并强制检查 `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
3. 发布构建显式设置 `CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL=stable`，并新增自动检查：GitHub 构建加载 updater，Store 构建不加载 updater。
4. 保留不可变 tag/Release、SHA256、setup 的 updater `.sig`、`latest.json`、远端下载和安装 smoke。没有这些，不允许把 GitHub 直装写成可更新的公开版本。
5. 只由明确的版本 tag 或手动发布动作创建 GitHub Release；普通 PR、普通 merge 不自动发版。
6. 版本发布后在 README/Release notes 写明：GitHub 安装包可能有 Windows 信任提示；仅从官方 Release 下载，校验文件可用于确认下载完整性。

### B. Store 大版本链路

1. Store workflow 改为明确的 Store 候选构建：手动触发或带明确 Store 目标的 tag，不再让每个 GitHub 小版本默认制造“必须上传”的 artifact。
2. 仍可在涉及 MSIX/桌面壳的 PR 中保留轻量构建验证，但它应叫“MSIX 构建校验”，不能暗示已准备 Store 提交。
3. Store 大版本只能从已经完成 GitHub 发布验收的同一 tag 构建。报告和脚本必须核对 SemVer 到四段 MSIX 版本的单调递增规则，Store 第四段固定为 `0`。
4. Partner Center 的最终提交和认证仍需要有账号权限的人完成；每次 GitHub 小版本不需要进行这一步。

### C. 本机目录、入口和候选生命周期

1. 将未来 GitHub 稳定安装默认目录改为 `D:\Software\Signalman AI`。
2. 将维护者候选目录固定为 `D:\Software\Signalman AI Candidate`，并把候选刷新改成显式行为，不能在每次合并后自动运行。
3. Store 保持 Windows 管理的安装位置，不放到 D 盘，也不与 GitHub 版混装成同一个启动入口。
4. 给候选脚本增加按实际可执行路径识别进程、快捷方式和卸载记录的能力，避免只按进程名停止程序。
5. 设计一次性迁移与清理脚本：先确认 GitHub 稳定版已经安装并通过 smoke，再删除旧候选的重复快捷方式和卸载登记；绝不删除 `%LOCALAPPDATA%\CodeX Provider Switcher`，也不读取或输出其中的密钥。
6. 旧版 `D:\AI Studio\CodeX\Codex Switcher` 继续只读保留为回滚源。真正停止它必须在新的 Codex 会话完成切换验证后执行，不随本 PR 自动发生。

### D. 应用内体验

1. Store 构建显示“由 Microsoft Store 管理更新”，只打开 Store 更新入口，不加载 GitHub updater。
2. GitHub stable 构建显示“检查 GitHub 更新”，执行 Tauri updater；更新完成后清楚提示重启应用。
3. 开发版和候选版明确不是公开下载来源，但不把维护者专用交接概念暴露给普通用户。
4. 不预填任何服务商、地址或 API key。用户资料仅在本机兼容目录读取；新用户第一次打开仍是干净配置。

### E. 仓库、文档和规则整理

需要重写的活文档包括：根 README、`docs/user/installation.zh.md`、`docs/user/troubleshooting.zh.md`、`docs/reference/product-spec.zh.md`、`docs/contributing/development-and-prs.zh.md`、`docs/maintainers/release-and-delivery.zh.md`、`docs/reference/repository-structure.zh.md`、release checklist、脚本索引与项目 `AGENTS.md`。

改写原则：

- README 第一屏只回答“这是什么、从哪里下载、两种下载有什么差异”，不把开发命令放给普通用户。
- 安装文档按 GitHub 和 Store 分成两条用户路径，分别说明更新、已知提示和版本差异。
- 贡献和维护文档才写命令、tag、CI、Secret 名称和验收证据。
- 项目规则记录本项目的双渠道节奏、目录和验收顺序；全局规则只记录跨项目通用原则，例如“公开渠道与本机候选必须区分”，不塞入本项目专有路径或版本号。
- `docs/release/` 的历史发布说明、旧品牌名称和历史取证材料保留原样，并加历史索引说明；不能倒改历史来伪造当时状态。
- 清理 `release-assets/`、`store-assets/`、`logs/` 等本机生成目录是否被错误保留或缺少忽略规则；只整理可再生成物，不删除用户资料和历史证据。

## 实施顺序

1. **先改机制与测试**：更新 channel、release workflow、readiness 脚本、Store workflow 触发条件，以及稳定/Store 构建边界测试。
2. **再改入口与迁移脚本**：引入新目录常量、显式候选刷新、路径级清理预检和 dry-run。此阶段不执行真实删除。
3. **最后统一文档和规则**：让 README、安装说明、维护手册、产品规格、脚本索引、项目规则描述同一事实。
4. **PR 前验证**：lint、build、Rust check、更新产物结构、GitHub stable 与 Store 两种构建边界、候选迁移 dry-run、文档链接和 `git diff --check`。
5. **开发版验收**：由维护者看 GitHub 与 Store 构建下的更新提示文案、重启提醒和普通配置路径；无需安装候选包。
6. **合并后发布收口**：只有在决定实际发布 GitHub 版本时才创建 tag/Release、远端下载并安装验证。Store 提交只在下一个大版本做，不阻塞本 PR 合并。
7. **合并后本机收口**：GitHub 稳定版通过真实安装验收后，另开新会话运行已审计的迁移/清理步骤；确认唯一日常入口，再处理旧候选和旧工具。

## 验收矩阵

| 场景 | 必须证明什么 | 证据 |
| --- | --- | --- |
| GitHub stable 构建 | 能检查 Tauri 签名更新；无 Windows PFX 也可发布 | 构建环境、`.sig`、`latest.json`、updater smoke |
| Store 构建 | 不加载 GitHub updater，只走 Store 更新入口 | Store channel 单测/界面 smoke、MSIX 检查 |
| GitHub 发布 | 新 tag、不可变 Release、正确资产、普通用户下载并安装 | Release asset 验证、SHA256、setup 安装 smoke |
| Store 大版本 | 同一 tag 的 MSIX 认证通过并从 Store 安装 | Partner Center 状态、Store 安装版本与启动 smoke |
| 目录迁移 | 不丢用户资料、不误伤 Store 版、不留下重复入口 | dry-run、路径级清单、迁移后快捷方式/卸载项检查 |
| 文档 | 用户能在 README 前两屏选对下载路径 | 人工读者审计、链接检查 |
| 发布规则 | 普通 PR 不会误触 Store 提交或重复云端 CI | workflow trigger 审查、PR CI 记录 |

## 这次 PR 不做什么

- 不购买 Windows Authenticode、EV 或 Artifact Signing。
- 不把 Store 的微软签名描述成 GitHub 安装包的签名。
- 不承诺 GitHub 首次直装没有 SmartScreen 警告，也不教用户绕开企业安全策略。
- 不在当前 Codex 会话写入最终 provider 配置、停止旧工具或删除用户资料。
- 不覆盖旧 tag、旧 GitHub Release、历史 release notes 或正在审核的 Store 包。
- 不把每个 PR 自动升级成公开 Release；PR 合并、GitHub 发布、Store 发布是三个不同状态。

## 本 PR 之后的固定流程

```text
开发分支 -> 本地验证 -> PR -> PR CI -> 合并 main
                                      |
                                      +-> 普通内部/代码 PR：到此结束
                                      |
                                      +-> GitHub 用户可见版本：新 tag -> GitHub Release -> 下载/安装验收
                                                                        |
                                                                        +-> 稳定大版本：同 tag MSIX -> Partner Center -> Store 认证 -> Store 安装验收
```

对外状态只使用以下说法：

- `PR 就绪`：代码、文档和本地/PR 验证已经完成，尚未合并。
- `代码已合并`：进入 `main`，但未必已经公开发布。
- `GitHub 已交付`：不可变 Release 已生成，普通用户下载、安装和更新验收完成。
- `Store 已交付`：Store 认证通过，普通用户从 Store 安装、启动和更新验收完成。

## 证据登记

| 类型 | 来源 | 用途 |
| --- | --- | --- |
| 本机仓库 | `git status`、`git rev-parse`、`.github/workflows/release.yml`、`.github/workflows/store-package.yml`、`src/adapter.ts` | 确认当前 workflow、更新通道与 GitHub Release 缺口 |
| 本机安装 | `Get-AppxPackage ga626.CodexProviderSwitcher`、`D:\Software\CodeX Provider Switcher\candidate-install-state.json` | 确认 Store `0.8.0.0` 与 D 盘候选并存 |
| GitHub 远端 | `gh release list --repo ga626/codex-provider-switcher` | 确认 Latest 仍为 `v0.5.0-alpha` |
| Microsoft 官方 | [选择 Windows 应用分发路径](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path) | Store 与直装是不同分发/更新边界 |
| Microsoft 官方 | [SmartScreen 信誉说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) | Store 无提示、无签名直装警告、证书信誉的真实边界 |
| Microsoft 官方 | [Windows 分发功能现状](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/distribution-feature-status) | `ms-appinstaller:` 默认禁用，不能作为 GitHub 一键安装方案 |
| Tauri 官方 | [Updater](https://v2.tauri.app/plugin/updater/) | updater 的公私钥、`.sig`、`latest.json` 和 Windows 更新行为 |
| 开源项目参考 | [Readest](https://github.com/readest/readest) | 多渠道在 README 中分开说明的产品信息架构参考 |

## 读者审计清单

- 普通用户只看开头，能否知道 GitHub 是最新、Store 是稳定且可能较慢？
- 是否明确说出 GitHub 警告无法在“不购买证书”的前提下消失？
- 是否明确说出 Store 不需要每个小版本上传？
- 是否明确分开了开发版、候选版、GitHub 安装版和 Store 安装版？
- 是否说明了用户资料不会因迁移被删除，且不会把维护者资料带给新用户？
- 是否说清楚哪些步骤由 Codex完成、哪些需要维护者在 GitHub/Partner Center 进行最终动作？

上述问题均已在本文对应章节直接回答。实施 PR 完成后还应再次针对实际 README 和安装说明逐项复核，不能只以本计划为完成证据。
