# CodeX Provider Switcher 0.4.1-alpha 发布说明

## 摘要

本版本修复桌面应用已发现新版本后，点击下载仍被手动 Release 页地址校验阻断的问题。

## 主要改动

- 已由 Tauri updater 校验并准备好的更新，直接执行签名下载、安装和重启。
- 手动打开下载页的 fallback 继续限制为本项目的 GitHub Release 页面。
- 新增桌面边界 smoke，防止未来把原生更新对象重新放到 URL guard 之后。

## 用户影响

`0.3.2-alpha` 和 `0.4.0-alpha` 包含这个界面阻断问题，无法用自身自动升级到本版本。请从 GitHub Release 手动运行一次 `0.4.1-alpha` setup；之后的已验证更新不需要输入密钥、口令或 Release 地址。

## 发布后验收

1. 从 GitHub Release 下载 setup，并校验 SHA256。
2. 覆盖安装到 `D:\Software\CodeX Provider Switcher` 后，确认打开一个桌面窗口、没有常驻 CMD 或外部浏览器。
3. 下一个高于 `0.4.1-alpha` 的版本发布时，从已安装的 `0.4.1-alpha` 点击“检查更新”，确认下载、签名校验、重启、版本变化和用户数据保留。
