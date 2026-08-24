import type { ProviderProfile } from '../../types'

export type VerificationSnapshot = Pick<ProviderProfile,
  'verified' | 'verificationStatus' | 'lastVerifiedAt' | 'lastVerificationDetail' |
  'lastVerificationStage' | 'lastVerificationHttpStatus' | 'lastVerificationProviderCode'
>

export type VerificationPresentation = {
  tone: 'success' | 'warning' | 'danger' | 'info'
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
  ].filter(Boolean)
  return items.length > 0 ? items.join('\n') : undefined
}

export function verificationPresentation(snapshot: VerificationSnapshot | undefined): VerificationPresentation {
  if (!snapshot || snapshot.verificationStatus === 'not_checked') {
    return { tone: 'info', summary: '尚未测试', detail: '还没有发送真实请求。', nextStep: '保存配置后运行一次可用性测试。', needsAcknowledgement: false }
  }
  if (snapshot.verified && snapshot.verificationStatus === 'verified') {
    return { tone: 'success', summary: '已确认可用', detail: '刚刚完成一次真实请求。', nextStep: '可以继续切换或使用。', technicalDetail: technicalDetail(snapshot), needsAcknowledgement: false }
  }
  const technical = technicalDetail(snapshot)
  switch (snapshot.verificationStatus) {
    case 'timed_out_unconfirmed':
    case 'timeout':
      return { tone: 'warning', summary: '等待超时，尚未确认', detail: '在 45 秒内没有收到回复；这不等于密钥错误。', nextStep: '可再测一次，或稍后使用。', technicalDetail: technical, needsAcknowledgement: true }
    case 'missing_key':
      return { tone: 'warning', summary: '尚未测试', detail: '没有保存本应用的访问密钥。', nextStep: '保存密钥后再测；仍可安全切换。', technicalDetail: technical, needsAcknowledgement: true }
    case 'unauthorized':
      return { tone: 'danger', summary: '密钥或权限未获接受', detail: '服务商拒绝了这次认证请求。', nextStep: '检查密钥、账号权限或服务商侧授权。', technicalDetail: technical, needsAcknowledgement: true }
    case 'billing_unavailable':
      return { tone: 'danger', summary: '额度或渠道不可用', detail: '服务商目前无法扣费或分配可用通道。', nextStep: '检查余额、套餐或服务商渠道状态。', technicalDetail: technical, needsAcknowledgement: true }
    case 'rate_limited':
      return { tone: 'warning', summary: '服务商暂时太忙', detail: '这次请求被限流，尚未确认模型可用。', nextStep: '按服务商提示等待后再测。', technicalDetail: technical, needsAcknowledgement: true }
    case 'model_unavailable':
    case 'endpoint_or_model_unavailable':
      return { tone: 'danger', summary: '当前模型没有可用通道', detail: '服务商能连接，但没有为这个模型提供可用响应。', nextStep: '换一个模型，或联系服务商处理模型/渠道路由。', technicalDetail: technical, needsAcknowledgement: true }
    case 'request_incompatible':
    case 'protocol_incompatible':
      return { tone: 'warning', summary: '请求方式暂不兼容', detail: '服务商不接受当前 Codex 请求方式。', nextStep: '报告兼容性问题，不要把它当作密钥错误。', technicalDetail: technical, needsAcknowledgement: true }
    case 'response_shape_unconfirmed':
    case 'response_unparseable':
      return { tone: 'warning', summary: '服务商有回复，暂未确认兼容', detail: '收到回复，但还不能确认它可被 Codex 正常使用。', nextStep: '查看技术详情并报告兼容性问题。', technicalDetail: technical, needsAcknowledgement: true }
    case 'network_error':
    case 'transport_error':
      return { tone: 'warning', summary: '未能完成连接', detail: '连接中断，尚未确认服务商可用。', nextStep: '检查网络或代理设置后再测。', technicalDetail: technical, needsAcknowledgement: true }
    default:
      return { tone: 'warning', summary: '尚未确认可用', detail: '服务商没有给出可用结论。', nextStep: '查看技术详情后再测或报告兼容性问题。', technicalDetail: technical, needsAcknowledgement: true }
  }
}
