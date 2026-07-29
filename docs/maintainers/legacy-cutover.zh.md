# 旧工具替换记录

> **状态：已完成的历史运维记录（2026-07-24）。** 本文保留切换门槛、验证结果和回滚边界，不能作为日常维护脚本或重复执行的清单。

## 完成事实

- 公开 GitHub stable `v0.9.0-alpha` 已安装在 `D:\Software\Signalman AI`，桌面 `Signalman AI` 快捷方式指向该安装。
- 新 Codex 会话完成了真实 provider canary：`SIGNALMAN_PROVIDER_CANARY_OK`，`provider=custom`，`model=gpt-5.6-terra`。
- 受限退役过程在核验 stable 入口后，仅删除了 `D:\Software\CodeX Provider Switcher` 和一个指向其可执行文件的失效 Start-menu 快捷方式；核验后 stable 入口仍有效。
- 检查时没有检测到旧候选或回滚参考的运行进程、`47831` 监听、Run/RunOnce、Startup、计划任务或服务自启来源。

## 保留边界与回滚

- `D:\AI Studio\CodeX\Codex Switcher` 仍是受保护的回滚参考，未被修改、删除或覆盖。
- Microsoft Store `0.8.0.0` 是独立低频渠道；它未参与本次操作。
- `config.toml`、`auth.json`、用户数据和任何密钥均不在清理范围内。
- 如果需要回退 provider，先使用 Signalman AI 中已确认的恢复点；如果需要研究或退役保留的回滚参考，必须先获得新的明确批准，并制作新的只读预检与回滚计划。

## 原始门槛（仅供追溯）

本次已完成运维遵循的核心门槛是：稳定安装已按用户路径 smoke 通过、切换在新 Codex 会话执行、provider 真实请求通过、清理范围限定为旧候选目录及其匹配入口，并在前后核验桌面入口和自启状态。过去关于“停止旧工具”“重新执行 preflight”或“删除候选”的命令均已失效，不能在没有新批准的情况下重复执行。
