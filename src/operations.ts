export type OperationId =
  | 'check-update'
  | 'complete-onboarding'
  | 'create-manual-backup'
  | 'default'
  | 'delete'
  | 'delete-cost-calibration'
  | 'install-update'
  | 'prepare-connection-environment'
  | 'prepare-switch'
  | 'preview-models'
  | 'refresh'
  | 'refresh-models'
  | 'reorder-profiles'
  | 'restore-backup'
  | 'reveal-key'
  | 'run-cost-probe'
  | 'save'
  | 'save-cost-calibration'
  | 'save-model'
  | 'save-profile'
  | 'set-backup-policy'
  | 'switch'
  | 'sync-current-config'
  | 'toggle-auto-start'
  | 'verify'
  | 'verify-profile'

export type OperationScope = 'workspace' | 'provider' | 'lab' | 'update' | 'onboarding'

export type OperationPhase = 'queued' | 'running' | 'completed'

export type OperationResult = 'pending' | 'success' | 'failure' | 'cancelled'

/** Versioned counterpart of Rust's OperationEventV1 contract. */
export type OperationEventV1 = {
  version: 1
  /** Unique invocation id; different from the human-readable operation kind. */
  id: string
  kind: OperationId
  scope: OperationScope
  phase: OperationPhase
  startedAt: string
  elapsedMs: number
  result: OperationResult
  detail?: string
  errorCode?: string
}

function newOperationInvocationId(kind: OperationId, now: number) {
  const randomId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${now}-${Math.random().toString(36).slice(2)}`
  return `${kind}-${randomId}`
}

export function startOperationEvent(
  kind: OperationId,
  scope: OperationScope = 'workspace',
  now = Date.now(),
): OperationEventV1 {
  return {
    version: 1,
    id: newOperationInvocationId(kind, now),
    kind,
    scope,
    phase: 'running',
    startedAt: new Date(now).toISOString(),
    elapsedMs: 0,
    result: 'pending',
  }
}

export function finishOperationEvent(
  event: OperationEventV1,
  result: Exclude<OperationResult, 'pending'>,
  elapsedMs: number,
  detail?: string,
  errorCode?: string,
): OperationEventV1 {
  return {
    ...event,
    phase: 'completed',
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    result,
    ...(detail ? { detail } : {}),
    ...(errorCode ? { errorCode } : {}),
  }
}

export function isTerminalOperationEvent(event: OperationEventV1 | null): boolean {
  return event?.phase === 'completed'
}

export type ActiveOperation = {
  id: OperationId
  startedAt: number
  event: OperationEventV1
}

export function operationStatusLabel(operation: OperationId | null) {
  switch (operation) {
    case 'refresh': return '正在加载当前状态…'
    case 'preview-models': return '正在连接服务商并读取模型目录…'
    case 'refresh-models': return '正在刷新模型目录；请稍候…'
    case 'verify':
    case 'verify-profile': return '正在运行可用性测试；不会改写 Codex 配置…'
    case 'run-cost-probe': return '正在运行固定测试；不会切换服务商…'
    case 'save-profile': return '正在保存服务商配置…'
    case 'save': return '正在保存服务商配置…'
    case 'save-model': return '正在保存默认模型…'
    case 'reorder-profiles': return '正在保存服务商顺序…'
    case 'default': return '正在更新默认服务商…'
    case 'delete': return '正在删除服务商…'
    case 'reveal-key': return '正在读取本机受保护的访问密钥…'
    case 'prepare-connection-environment': return '正在准备连接环境；不会上传配置或密钥…'
    case 'complete-onboarding': return '正在进入工作区…'
    case 'prepare-switch': return '正在检查目标服务商；不会改写 Codex 配置…'
    case 'switch': return '正在安全切换服务商配置…'
    case 'restore-backup': return '正在恢复已确认的配置副本…'
    case 'create-manual-backup': return '正在创建手动恢复点…'
    case 'sync-current-config': return '正在同步当前配置状态…'
    case 'toggle-auto-start': return '正在更新开机启动设置…'
    case 'set-backup-policy': return '正在保存恢复点保留设置…'
    case 'save-cost-calibration': return '正在保存测试费用记录…'
    case 'delete-cost-calibration': return '正在删除测试费用记录…'
    case 'check-update': return '正在检查更新…'
    case 'install-update': return '正在下载并安装更新…'
    default: return '就绪'
  }
}

export function operationElapsedLabel(operation: ActiveOperation | null, now: number) {
  if (!operation) return ''
  const elapsedSeconds = Math.max(0, Math.floor((now - operation.startedAt) / 1000))
  return elapsedSeconds > 0 ? `已等待 ${elapsedSeconds} 秒` : '正在开始'
}
