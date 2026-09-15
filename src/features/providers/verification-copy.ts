import type { ProviderProfile } from '../../types'

export type VerificationSnapshot = Pick<ProviderProfile,
  'verified' | 'verificationStatus' | 'lastVerifiedAt' | 'lastVerificationDetail' |
  'lastVerificationStage' | 'lastVerificationHttpStatus' | 'lastVerificationProviderCode'
  | 'capabilityProfile'
>

export type VerificationPresentation = {
  tone: 'success' | 'warning' | 'danger' | 'info'
  shortLabel: string
  summary: string
  detail: string
  nextStep: string
  technicalDetail?: string
  needsAcknowledgement: boolean
}

function technicalDetail(snapshot: VerificationSnapshot) {
  const items = [
    snapshot.lastVerifiedAt ? `检查时间：${snapshot.lastVerifiedAt}` : '',
    snapshot.lastVerificationStage ? `检查阶段：${snapshot.lastVerificationStage}` : '',
    snapshot.lastVerificationHttpStatus ? `HTTP：${snapshot.lastVerificationHttpStatus}` : '',
    snapshot.lastVerificationProviderCode ? `服务商代码：${snapshot.lastVerificationProviderCode}` : '',
    snapshot.lastVerificationDetail ? `服务商说明：${snapshot.lastVerificationDetail}` : '',
    snapshot.capabilityProfile?.protocol ? `识别协议：${snapshot.capabilityProfile.protocol}` : '',
    snapshot.capabilityProfile?.streaming ? `流式状态：${snapshot.capabilityProfile.streaming}` : '',
    snapshot.capabilityProfile?.completion ? `完成状态：${snapshot.capabilityProfile.completion}` : '',
    snapshot.capabilityProfile?.responseHeaderMs !== undefined ? `响应头：${snapshot.capabilityProfile.responseHeaderMs} ms` : '',
    snapshot.capabilityProfile?.firstEventMs !== undefined ? `首事件：${snapshot.capabilityProfile.firstEventMs} ms` : '',
    snapshot.capabilityProfile?.totalMs !== undefined ? `总耗时：${snapshot.capabilityProfile.totalMs} ms` : '',
    snapshot.capabilityProfile?.transportRetryCount ? `连接重试：${snapshot.capabilityProfile.transportRetryCount} 次` : '',
  ].filter(Boolean)
  return items.length > 0 ? items.join('\n') : undefined
}

export function verificationPresentation(snapshot: VerificationSnapshot | undefined): VerificationPresentation {
  if (!snapshot || snapshot.verificationStatus === 'not_checked') {
    return { tone: 'info', shortLabel: '未测试', summary: '尚未测试', detail: '还没有发送真实请求。', nextStep: '保存配置后运行一次可用性测试。', needsAcknowledgement: false }
  }
  if (snapshot.verified && snapshot.verificationStatus === 'verified') {
    const streamingVerified = snapshot.capabilityProfile?.streaming === 'verified'
    return { tone: 'success', shortLabel: streamingVerified ? '完整可用' : '基本可用', summary: streamingVerified ? '已确认完整流式响应' : '已确认基本调用', detail: streamingVerified ? '模型完成了真实 Responses 流式生命周期。' : '模型返回了完整结果，但流式能力尚未得到完整证明。', nextStep: streamingVerified ? '可以继续切换或使用。' : '可以继续，但长任务和实时输出仍需留意。', technicalDetail: technicalDetail(snapshot), needsAcknowledgement: false }
  }
  const technical = technicalDetail(snapshot)
  switch (snapshot.verificationStatus) {
    case 'timed_out_unconfirmed':
    case 'timeout':
      return { tone: 'warning', shortLabel: '超时', summary: '等待超时，尚未确认', detail: '在 45 秒内没有收到回复；这不等于密钥错误。', nextStep: '可再测一次，或稍后使用。', technicalDetail: technical, needsAcknowledgement: true }
    case 'missing_key':
      return { tone: 'warning', shortLabel: '缺少密钥', summary: '尚未测试', detail: '没有保存本应用的访问密钥。', nextStep: '保存密钥后再测；仍可安全切换。', technicalDetail: technical, needsAcknowledgement: true }
    case 'unauthorized':
      return { tone: 'danger', shortLabel: '认证失败', summary: '密钥或权限未获接受', detail: '服务商拒绝了这次认证请求。', nextStep: '检查密钥、账号权限或服务商侧授权。', technicalDetail: technical, needsAcknowledgement: true }
    case 'billing_unavailable':
      return { tone: 'danger', shortLabel: '额度不可用', summary: '额度或渠道不可用', detail: '服务商目前无法扣费或分配可用通道。', nextStep: '检查余额、套餐或服务商渠道状态。', technicalDetail: technical, needsAcknowledgement: true }
    case 'rate_limited':
      return { tone: 'warning', shortLabel: '请求受限', summary: '服务商暂时太忙', detail: '这次请求被限流，尚未确认模型可用。', nextStep: '按服务商提示等待后再测。', technicalDetail: technical, needsAcknowledgement: true }
    case 'model_unavailable':
    case 'endpoint_or_model_unavailable':
      return { tone: 'danger', shortLabel: '模型不可用', summary: '当前模型没有可用通道', detail: '服务商能连接，但没有为这个模型提供可用响应。', nextStep: '换一个模型，或联系服务商处理模型/渠道路由。', technicalDetail: technical, needsAcknowledgement: true }
    case 'request_incompatible':
    case 'protocol_incompatible':
      return { tone: 'warning', shortLabel: '暂不兼容', summary: '请求方式暂不兼容', detail: '服务商不接受当前 Codex 请求方式。', nextStep: '报告兼容性问题，不要把它当作密钥错误。', technicalDetail: technical, needsAcknowledgement: true }
    case 'chat_completions_only':
      return { tone: 'warning', shortLabel: '仅普通聊天', summary: '只识别到普通聊天接口', detail: '这个模型可以回答，但尚不具备 Codex 所需的 Responses 合同。', nextStep: '不要作为完整 Codex 服务商切换；可等待服务商补齐 Responses。', technicalDetail: technical, needsAcknowledgement: true }
    case 'stream_interrupted':
      return { tone: 'warning', shortLabel: '传输中断', summary: '模型开始回复后连接中断', detail: '平台已经开始返回，但没有完成正常流式生命周期。', nextStep: '检查代理和服务商流式转发后再测；本次不会自动重复计费请求。', technicalDetail: technical, needsAcknowledgement: true }
    case 'response_shape_unconfirmed':
    case 'response_unparseable':
      return { tone: 'warning', shortLabel: '待确认', summary: '服务商有回复，暂未确认兼容', detail: '收到回复，但还不能确认它可被 Codex 正常使用。', nextStep: '查看技术详情并报告兼容性问题。', technicalDetail: technical, needsAcknowledgement: true }
    case 'network_error':
    case 'transport_error':
      return { tone: 'warning', shortLabel: '连接失败', summary: '未能完成连接', detail: '连接中断，尚未确认服务商可用。', nextStep: '检查网络或代理设置后再测。', technicalDetail: technical, needsAcknowledgement: true }
    default:
      return { tone: 'warning', shortLabel: '待确认', summary: '尚未确认可用', detail: '服务商没有给出可用结论。', nextStep: '查看技术详情后再测或报告兼容性问题。', technicalDetail: technical, needsAcknowledgement: true }
  }
}
