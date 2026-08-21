# Signalman AI v0.10.10-alpha

## 更顺畅的长任务体验

- 模型目录刷新、草稿模型预览、服务商可用性测试、实验室响应探测、更新检查和配置校验现在通过后台操作执行，不再占用界面线程。
- 界面会显示操作开始、进度、详情、成功或失败及耗时；网络异常会在边界内返回可解释结果，窗口不会因为等待服务商而“卡死”。
- 本地开发后端增加有界 worker、排队上限、请求体限制、读写超时和过载 `503`，并保留健康检查与工作区访问能力。

## 代码结构与回归保护

- Rust 后端按领域拆分为配置域、存储/备份、服务商兼容、服务编排、实验室、更新和 Tauri command 边界；React 前端按首次启动、说明、服务商、实验室、安全、活动记录和共享组件拆分。
- 新增脱敏 UI fixture 性能基线，覆盖模型筛选、活动排序和状态刷新映射。
- 桌面边界、后端功能、运行时边界、反馈合同和过载测试同步更新，修复 CI 中因 TCP 接收队列导致的过载测试时序误判。
- 保留已登记的 glib 0.18.5 上游安全回补，并让 CodeQL 忽略该明确登记的第三方回补目录；这不宣称上游告警已被平台自动关闭。

## Provider 认证与配置保护

- A6、Hiyo、OWL、A18 及未知 OpenAI-compatible 服务商统一使用 `auth.json.OPENAI_API_KEY` 与 `requires_openai_auth = true` 的标准 Bearer 合同，切换时清理旧的 `api_key`、`env_key` 和 `experimental_bearer_token`。
- ModelFlare 保留版本化的 provider-level `auth.command` 适配器，仅精确匹配 `modelflare.dev`；历史上误写到普通服务商的 `provider_command` 配置会自动迁移回标准 Bearer。
- 备份、切换前置检查和写后回读新增受保护配置指纹，覆盖未知 config 根字段、未来 Codex sections，以及 auth.json 中除 provider key 外的字段，防止破坏项目、MCP、插件、hooks、记忆和历史记录。
- 兼容性反馈中的私网地址、Authorization/Bearer、自由文本和本地路径继续脱敏；“导出脱敏内容”现在会生成 JSON 文件并复制到剪贴板。

## 用户资料与渠道

- 不会删除或重置已有服务商、恢复点、Codex 配置或认证资料；不会提交用户密钥、token、`auth.json`、本机路径、运行日志或截图中的真实数据。
- 本版本通过 GitHub alpha 渠道发布。Microsoft Store 仍为独立、低频的稳定渠道，本次不创建 Store 提交。
- GitHub 安装包可能继续受到 Windows SmartScreen 或 Smart App Control 提示；本项目不把未购买的 Windows Authenticode 签名说成已签名。
