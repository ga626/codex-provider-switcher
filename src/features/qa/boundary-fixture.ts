import data from './boundary-fixture.json'
import type { AppState, ProviderProfile, ModelCatalog, ActivityItem, CostCalibration, ResponseProbeObservation } from '../../types'

// 与原生持久化注入共用资料；不变更组件、字体或业务计算方式。
export function applyBoundaryFixture(state: AppState) {
  state.backupPolicy = { automaticLimit: 10, manualLimit: 10 }
  const current = state.profiles.find((profile) => profile.id === 'example-provider-a')
  if (current) current.name = data.currentProviderName
  state.profiles.push(...structuredClone(data.profiles) as ProviderProfile[])
  state.modelCatalogs.push(...structuredClone(data.modelCatalogs) as ModelCatalog[])
  state.activity.unshift(...structuredClone(data.activity) as ActivityItem[])
  // Boundary data represents manually checked fixture invoices, so it remains
  // eligible after the product starts requiring explicit confirmation.
  state.costCalibrations.push(...(structuredClone(data.costCalibrations) as CostCalibration[]).map((item) => ({ ...item, debitConfirmed: true })))
  state.responseProbes.push(...structuredClone(data.responseProbes) as ResponseProbeObservation[])
  for (let index = 0; index < data.backupCount; index++) {
    state.backups.push({ id: `qa-manual-20260918-${index.toString().padStart(6, '0')}`, label: `qa-manual-20260918-${index.toString().padStart(6, '0')}`, time: '2026-09-18 09:15', files: 3, fileCategories: ['Codex 设置', '本机登录信息', '恢复说明'], kind: 'manual', retentionManaged: true, restoreReady: true, restoreDetail: '隔离样本的手动恢复点；恢复操作仍需确认。' })
  }
}
