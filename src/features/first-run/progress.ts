import type { InitializationStep } from '../../types.ts'

export const PREPARATION_TASKS = [
  ['paths', '定位配置与恢复目录', '找到当前用户配置与 Signalman 的恢复位置'],
  ['recovery', '检查上次中断的操作', '按持久事务回执处理未完成的写入'],
  ['config', '读取并检查旧配置', '确认配置可安全处理，保留项目、MCP 和插件'],
  ['auth', '检查认证文件', '检查文件格式，保留已有官方登录资料'],
  ['profiles', '盘点可复用的服务商', '核对本机保存的服务商和受控凭据'],
  ['models', '准备模型目录与固定身份', '清理旧指针，核验或重新生成模型目录'],
  ['backup', '创建并验证恢复点', '加密保存旧连接并核验完整性'],
  ['write', '写入、回读并复核保护内容', '确认写入结果和受保护设置'],
  ['summary', '汇总初始化结果', '整理所有任务的真实结果和处理办法'],
] as const

export const PREPARATION_INTERVAL_MS = 680

// Presentation can lag behind the backend, but can never get ahead of it.
export function advancePreparation(cursor: number, shownAt: number, now: number, steps: Array<InitializationStep | undefined>) {
  const current = steps[cursor]
  return current && current.status !== 'running' && now - shownAt >= PREPARATION_INTERVAL_MS
    ? Math.min(cursor + 1, PREPARATION_TASKS.length)
    : cursor
}

export function missingPreparationResults(steps: Array<InitializationStep | undefined>): InitializationStep[] {
  return PREPARATION_TASKS.map(([id, label], index) => {
    const step = steps[index]
    return step && step.status !== 'running' ? step : {
      index, id, label, status: 'failure', detail: '没有收到本项任务的完成回执，不能确认结果。已有文件不会被自动重写。',
      action: '请点“重新检查”；若仍失败，关闭并重新打开 Signalman 后再试。持续失败时，请按提示检查 Codex 是否能正常打开、相关磁盘是否可用以及当前用户是否有读写权限。',
    }
  })
}
