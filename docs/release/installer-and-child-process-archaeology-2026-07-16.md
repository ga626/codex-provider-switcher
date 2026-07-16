# 安装器与 Windows 子进程考古记录

日期：2026-07-16

## 结论

这次现象不是 Tauri 主窗口再次打包成控制台程序，而是桌面 GUI 在加载状态和执行功能时调用了 Windows `tasklist.exe`。该子进程没有设置 Windows 创建标志，因此系统为控制台程序创建了可见窗口。截图中的窗口标题 `C:\Windows\system32\tasklist.exe` 与源码调用完全对应。

安装器英文问题也有明确的配置原因：`src-tauri/tauri.conf.json` 原来没有配置 NSIS `languages`，Tauri schema 的默认值是 `English`；同时没有配置 `headerImage` 或 `sidebarImage`，所以使用默认安装器视觉。

## 本地证据

- `src-tauri/src/lib.rs` 的 `legacy_process_running()` 使用 `Command::new("tasklist")` 检查旧版工具进程。
- 该检查从 `legacy_switcher_status()` 进入，启动时和多个功能状态刷新都会触发。
- `src-tauri/Cargo.toml` 已有 `default-run = "codex-provider-switcher"`，主入口修复与本次子进程窗口问题是两个独立边界。
- `src-tauri/tauri.conf.json` 原来只有 `installMode`，没有 NSIS 语言和品牌图片配置。

## 外部证据登记

| 来源 | 访问路径 | 关键事实 | 强度 |
| --- | --- | --- | --- |
| Rust 标准库 `CommandExt` | [doc.rust-lang.org/std/os/windows/process/trait.CommandExt.html](https://doc.rust-lang.org/std/os/windows/process/trait.CommandExt.html) | `creation_flags` 会传给 Windows `CreateProcess`，适合设置 Windows 专用创建标志。 | 强 |
| Microsoft Win32 | [Process Creation Flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags) | `CREATE_NO_WINDOW` 用于让控制台程序在没有控制台窗口的情况下运行。 | 强 |
| Tauri 配置文档 | [v2.tauri.app/reference/config](https://v2.tauri.app/reference/config/) | Tauri 配置集中定义 `bundle` 与 Windows 安装器行为。 | 强 |
| Tauri CLI schema | `node_modules/@tauri-apps/cli/config.schema.json` | NSIS `languages` 默认是 `English`；`displayLanguageSelector` 默认关闭；支持 `headerImage` 和 `sidebarImage`。 | 强 |
| NSIS 官方语言目录 | [NSIS language files](https://github.com/kichik/nsis/tree/master/Contrib/Language%20files) | `SimpChinese` 是 NSIS 的简体中文语言标识。 | 中到强 |

本次调研通过 KnowledgeRadar 原生 MCP 完成：`health_check(summary)`、`get_capabilities(summary=true)`、`kr_research(first_wave, budget=deep)`，之后对官方页面做正文抽取。KnowledgeRadar 路线标识为 `host_internal_web_wave`；本记录没有使用独立的未授权网页搜索旁路。

## 已采取的修复

- 增加 `hidden_command()`，Windows 下给系统探测命令设置 `CREATE_NO_WINDOW`，当前 `tasklist` 已改用该 helper。
- NSIS 固定使用 `SimpChinese`，关闭语言选择器，避免中文 Windows 因回退策略显示英文。
- 新增 150 x 57 的页眉 BMP 和 164 x 314 的侧栏 BMP，使用现有应用图标和产品名。
- 将安装器资产生成纳入 `tauri:build`，避免本地构建和发布构建出现视觉漂移。
- 发布构建开始前清理旧的 `.sig` 文件，避免失败构建留下的过期签名被误拾取。

## 验证证据

- `npm run lint`：通过。
- `npm run build`：通过。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过。
- `cargo test --manifest-path src-tauri/Cargo.toml`：2 个测试通过。
- `npm run tauri:desktop-boundary:smoke`：通过，包含子进程隐藏、NSIS 配置和 BMP 尺寸断言。
- 安装候选包覆盖 `D:\Software\CodeX Provider Switcher`：安装退出码为 0，版本为 `0.3.1-alpha`。
- 启动安装版：窗口标题为 `CodeX Provider Switcher`，进程响应正常；观察到 `tasklist` 进程但没有窗口句柄或窗口标题。
- 关闭安装版：应用进程和可见 tasklist 窗口均为 0。

## 发布边界

本次代码修改已具备 PR 验证条件。正式签名 Release 仍需要本机加密 updater 私钥的口令；在口令未提供前，不把本地未签名候选包宣称为 GitHub 产品发布。
