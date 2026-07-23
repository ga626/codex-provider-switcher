# 品牌与兼容性边界

当前对外产品名是 **Signalman AI**。所有普通用户可见位置必须使用这个名称：桌面窗口、安装器、MSIX 显示名、商店一览、截图、README、支持页和新发布资产。

以下标识不是展示品牌，必须保留以保证升级连续性：

| 标识 | 原因 | 允许修改的条件 |
| --- | --- | --- |
| Store ID `9P7PGV62WKK6` | 已关联 Partner Center 产品 | 不修改 |
| MSIX Identity `ga626.CodexProviderSwitcher` 与 Application ID `CodeXProviderSwitcher` | Store 分配的包身份 | 仅在 Partner Center 明确重新分配身份时修改 |
| `codex-provider-switcher.exe`、仓库 slug 与 updater URL | 已安装版本和更新链路的技术标识 | 必须先设计旧版本升级路径并验证 |
| `%LOCALAPPDATA%\CodeX Provider Switcher` | 已存放 DPAPI 保护的资料、备份和活动记录 | 必须先完成可回滚的数据迁移并验证 |
| `D:\Software\CodeX Provider Switcher` | 旧维护者候选安装位置 | 只在 GitHub 稳定安装 smoke 通过后的受控迁移中清理，不删除用户资料 |
| `D:\Software\Signalman AI` | 维护者本机 GitHub 稳定安装位置 | 可作为 GitHub 日常入口，不与 Store 混用 |
| `D:\Software\Signalman AI Candidate` | 维护者短期候选安装位置 | 仅在显式候选验收时刷新，不作为公开入口 |

历史发布说明和历史考古记录保留当时的真实名称，不倒改。任何新产品材料不得把上述兼容性标识当作产品名称展示。
