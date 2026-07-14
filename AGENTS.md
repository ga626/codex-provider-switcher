# CodeX Provider Switcher Project Rules

## 产品边界

`CodeX Provider Switcher` 是一个本地优先的 Codex provider 切换工具。当前主路线是轻量本地 Web 控制台：双击启动器，静默启动本地后端，只监听 `127.0.0.1`，浏览器打开控制台页面。

Tauri/Rust 代码保留为原生能力和未来安装包路线，但当前不要把产品重新推回“必须打开桌面壳”的重形态。

## 旧工具边界

旧版工具仅作为参考源和回滚源：

```text
D:\AI Studio\CodeX\Codex Switcher
```

不要修改、删除、覆盖旧版 `CodeX-Switcher.exe` 或旧版 `profiles.json`，除非用户明确批准最终 cutover。新工具必须先完成备份、恢复、验证、时间线和回滚能力，再进入旧工具退役。

## Codex 配置安全

本项目会读写用户 Codex 配置，相关改动必须按高风险处理：

- 写 `config.toml` 或 `auth.json` 前必须备份。
- 不提交真实 API key、token、auth 文件、profiles 文件、本机截图或用户私有路径证据。
- 报告和日志中只能保留脱敏摘要。
- 不要在当前运行中的 Codex 会话里执行最终 provider 切换；最终 cutover 交给新会话或另一个 agent，并提供交接包。

必须保留和复验的 Codex 配置不变量包括：

- `model_provider = "custom"`
- `[model_providers.custom].wire_api = "responses"`
- `disable_response_storage = true`
- 用户现有 projects、features、desktop、memories、MCP servers、plugins、marketplaces、windows settings。

## 模型管理

不要继续把 `gpt-5.5` 或任何单个模型名写成产品默认真理。模型选择应来自中转站实际返回的模型列表、本地缓存、官方模型提示和用户确认。

如果 provider 无法刷新模型，UI 可以允许手动输入，但必须标为未验证，写入前需要二次确认。

## 开发流程

默认使用 `codex/` 前缀创建功能分支。改动应按 PR 拆分：

1. 工程化和发布流程。
2. Codex 配置和模型发现。
3. 本地 Web 后端和启动器。
4. 更新、备份、恢复、回滚。
5. 旧工具 cutover 交接。
6. UI 信息架构重构。

## 验证

提交前至少运行：

```powershell
npm run lint
npm run build
git diff --check
```

如果改到 Tauri/Rust 层，还要运行：

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

如果改到用户可见界面或流程，还要启动本地预览并运行 smoke：

```powershell
npm run preview:start -- --NoOpen
npm run qa:smoke
npm run preview:stop
```
