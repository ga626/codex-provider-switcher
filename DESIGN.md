# Signalman AI 设计决策

### UI decision: 未知服务商能力协商

- 目标与主路径：用户只需填写服务商地址、密钥和模型；Signalman 通过真实但最小的请求识别 Responses、流式完成或仅 Chat Completions，并用讲人话的状态说明能否作为 Codex 服务商。
- 选中能力卡 / 项目现有基础：沿用项目现有 React 工作台、`verificationPresentation`、活动记录和技术详情；新增统一能力画像，不新增页面或导航。
- 数据与权限合同：能力画像绑定当前服务商地址和模型，保存协议、流式状态、完成状态、受控重试次数及阶段耗时；不保存提示正文、完整响应或密钥。跨域重定向不携带认证。
- 状态合同：区分配置不完整、连接失败、认证失败、额度/限流、Responses 完整流式、Responses 非流式、仅 Chat Completions、流式中断和响应形状未确认。
- 重试合同：只有尚未收到 HTTP 响应的连接失败可用新连接重试一次；收到 HTTP 状态、SSE 事件或 request ID 后不自动重试。
- 实验室边界：费用固定测试继续等待完整响应和 usage，不复用“首事件即开始工作”的结束条件；只共享网络和错误分类原则。
- 新增依赖、MCP 或资产：无。
- 动效目的与 reduced-motion：无新增动效。
- 验收：Rust 单元测试、后端功能 smoke、前端 build/lint、IAB 的日常开发板检查；验证旧服务商 JSON Responses、标准 SSE、仅 Chat Completions、连接重试和实验室费用合同。
- 回滚：移除能力画像字段和协商探针，恢复原单次非流式 Responses 检测；旧 profile 因字段带默认值可继续读取。
