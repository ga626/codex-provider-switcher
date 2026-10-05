import type { InitializationReport } from '../../types'
import { PREPARATION_TASKS } from './progress'

export type FirstRunResultPreview =
  | 'degraded-all' | 'blocked-all'
  | 'degraded-models' | 'degraded-backup' | 'degraded-summary'
  | 'blocked-paths' | 'blocked-recovery' | 'blocked-config' | 'blocked-auth'
  | 'blocked-profiles' | 'blocked-models' | 'blocked-backup' | 'blocked-write' | 'blocked-receipt'

// UI examples only: never invoke initialization or persist a completion receipt.
export function firstRunResultPreview(kind: FirstRunResultPreview): InitializationReport {
  const warningKind = kind.startsWith('degraded-')
  const allWarnings = kind === 'degraded-all'
  const allBlocked = kind === 'blocked-all'
  const warningId = warningKind ? kind.replace('degraded-', '') : ''
  const blockedIds: Record<string, string> = { paths: 'paths', recovery: 'recovery', config: 'config', auth: 'auth', profiles: 'profiles', models: 'models', backup: 'backup', write: 'write', receipt: 'summary' }
  const blockedId = kind.startsWith('blocked-') ? blockedIds[kind.replace('blocked-', '')] : ''
  const warningDetails: Record<string, [string, string]> = {
    models: ['这次没有生成模型列表，所以软件还不知道可以选择哪些模型。', '请先点“重新检查”。如果仍然失败，请确认 Codex 能正常打开，并检查网络后再试。'],
    backup: ['之前的备份不能确认可以使用，所以出了问题时可能无法恢复。', '请点“重新检查”重新创建并验证备份；在备份确认可用前，不能进入软件。'],
    summary: ['配置已经写好，但这次没有拿到完整的检查结果。', '请点“重新检查”。如果连续失败，请关闭并重新打开 Signalman 后再试。'],
  }
  const blockedDetails: Record<string, [string, string]> = {
    paths: ['Signalman 没有成功找到或打开这台电脑上的 Codex 配置目录，或没有成功打开自己的恢复目录，所以现在不能安全改文件。', '这通常是 Codex 路径被移动、目录没有读写权限、磁盘暂时不可用，或上次初始化留下了失效位置。Signalman 会自动重新定位并准备恢复目录；仍失败时，请确认 Codex 能正常启动、相关磁盘可用且当前用户有权限，然后点“重新检查”。不需要先去设置里填写路径。'],
    recovery: ['上一次修改没有完整结束，系统现在不知道哪些文件已经改过。', '请点“重新检查”，让 Signalman 自动处理上次中断的操作。不要手动删除文件，也不要连续重复点击。'],
    config: ['Codex 的配置文件已经损坏，继续写可能把项目、插件等设置弄丢。', '请先修复或恢复 Codex 配置，再点“重新检查”。在此之前不能进入软件。'],
    auth: ['Codex 的登录文件读不出来，系统无法确认登录信息是否完整。', '请先让 Codex 恢复正常登录状态，再点“重新检查”。不要把密钥复制给任何人。'],
    profiles: ['以前保存的服务商资料读不出来，系统无法安全复用它们。', '请重新打开 Signalman 后再点“重新检查”；如果仍失败，需要检查本机资料是否损坏。'],
    models: ['模型列表和固定身份没有成功准备好，继续使用可能连错服务商。', '请先修复 Codex 安装或恢复模型目录，再点“重新检查”。'],
    backup: ['没有找到一份确认可用的备份，出问题时就没有安全退路。', '请检查磁盘空间和写入权限，然后点“重新检查”创建备份。备份确认可用前不能进入软件。'],
    write: ['文件写进去以后，读回来的内容对不上，系统无法确认修改是否成功。', '请点“重新检查”。在确认结果前不要继续操作或手动改文件。'],
    summary: ['初始化没有返回完整结果，系统无法确认连接环境是否准备好。', '请点“重新检查”；如果仍失败，请关闭并重新打开 Signalman 后再试。'],
  }
  const warningIds = allWarnings ? Object.keys(warningDetails) : [warningId]
  const blockedIssueIds = allBlocked ? Object.values(blockedIds) : [blockedId]
  return {
    state: null,
    // A preview must obey the same gate as the real first-run flow: any
    // warning or failure is unresolved, so it cannot be used to enter.
    canContinue: !warningKind && !allBlocked,
    steps: PREPARATION_TASKS.map(([id, label], index) => {
      const warningActive = warningKind && warningIds.includes(id)
      const blockedActive = (!warningKind || allBlocked) && blockedIssueIds.includes(id)
      const issue = warningActive ? warningDetails[id] : blockedDetails[blockedIds[id] ?? id]
      const active = warningActive || blockedActive
      return { index, id, label, status: active ? (warningActive ? 'warning' : 'failure') : 'success', detail: active ? (issue?.[0] ?? '') : '本项检查已通过。', action: active ? (issue?.[1] ?? '') : '' }
    }),
  }
}

export const FIRST_RUN_PREVIEW_GROUPS: Array<{ label: string; id: FirstRunResultPreview }> = [
  { label: '降级（阻止进入）', id: 'degraded-all' },
  { label: '必须处理的阻断', id: 'blocked-all' },
]
