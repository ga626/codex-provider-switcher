## 摘要

说明这次改动解决了什么问题，以及项目推进到了什么状态。

## 主要改动

- 改动 1
- 改动 2

## 验证

列出实际运行过的高信号命令和结论。小改动写相关验证；发布影响 PR 还要写开发版验收、`npm run release:channel-smoke`、`npm run release:readiness:smoke` 和 `npm run release:readiness -- -Mode Maintainer -Channel github -ReportOnly` 的结论。

## 风险和边界

说明是否读写 `config.toml`、`auth.json`、profiles、备份或旧工具；写清失败和回滚路径。没有覆盖的功能也要明确列出。

## 用户影响

说明用户入口、桌面窗口、安装、更新、文档或配置安全边界是否改变。

## 发布计划/后续动作

说明是否为发布影响 PR、目标版本和 tag、计划发布的资产，以及合并后需要做的下载/安装验收。GitHub 日常发布和 Store 稳定发布必须分开说明：Store 不跟随每个 GitHub tag。发布影响 PR 必须粘贴 `npm run release:readiness -- -Mode Maintainer -Channel github -ReportOnly` 的简短结论；若缺 updater 签名或其他发布条件，明确写“代码可合并，产品未交付”和下一步负责人。

没有完成新 tag、不可变 GitHub Release、远端下载、安装、启动和升级验收时，状态只能写“代码已合并，产品未交付”。不得复用旧 tag 或覆盖旧 Release。
