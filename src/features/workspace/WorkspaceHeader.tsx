import { CircleHelp } from 'lucide-react'
import type { ModelCatalog, ProviderProfile } from '../../types'
import { guideChapterForView } from '../guide/GuideWorkspace'
import type { ViewId } from '../../shared/view-types'

export function WorkspaceHeader({
  activeView,
  selectedProfile,
  requiredFailures,
  riskCount,
  selectedModelCatalog,
  onOpenGuide,
}: {
  activeView: ViewId
  selectedProfile: ProviderProfile | undefined
  requiredFailures: number
  riskCount: number
  selectedModelCatalog: ModelCatalog | undefined
  onOpenGuide: () => void
}) {
  if (activeView === 'lab') return null

  const isProviderContext = ['providers', 'models', 'switch-check'].includes(activeView)
  const copy: Record<ViewId, { title: string; note: string }> = {
    providers: {
      title: '服务商',
      note: selectedProfile ? `已选择 ${selectedProfile.name}` : '新增并管理服务商连接。',
    },
    models: {
      title: '模型目录',
      note: selectedModelCatalog?.statusDetail ?? '尚未同步模型目录。',
    },
    'switch-check': {
      title: '切换前检查',
      note: !selectedProfile ? '先新增并保存服务商。' : requiredFailures > 0 ? '请先处理会阻止安全写入的项目。' : riskCount > 0 ? '可以切换，但请先了解使用风险。' : '已满足切换条件。',
    },
    protection: {
      title: '配置保护',
      note: '查看备份、受保护内容和恢复入口。',
    },
    timeline: {
      title: '活动记录',
      note: '切换、检查和配置变更按时间记录。',
    },
    lab: {
      title: '实验室',
      note: '记录同一测试的实际花费，比较服务商性价比。',
    },
  }

  if (isProviderContext) {
    return (
      <header className="workspace-header provider-workspace-header">
        <div>
          <h2>服务商配置</h2>
          <p>{selectedProfile ? `正在编辑 ${selectedProfile.name}；保存、模型、检查和切换都在这里完成。` : '新增或选择一个服务商后，按右侧提示继续。'}</p>
        </div>
        <button className="icon-button workspace-guide-button" type="button" onClick={onOpenGuide} aria-label="查看服务商使用说明" title="查看服务商使用说明" data-guide-target="providers.page-help"><CircleHelp size={16} /></button>
      </header>
    )
  }

  return (
    <header className="workspace-header">
      <div>
        <h2>{copy[activeView].title}</h2>
        <p>{copy[activeView].note}</p>
      </div>
      <button className="icon-button workspace-guide-button" type="button" onClick={onOpenGuide} aria-label={`查看${copy[activeView].title}使用说明`} title={`查看${copy[activeView].title}使用说明`} data-guide-target={`${guideChapterForView(activeView)}.page-help`}><CircleHelp size={16} /></button>
      {activeView === 'switch-check' && <span className={`workspace-badge ${selectedProfile && requiredFailures === 0 ? (riskCount > 0 ? 'warning' : 'ok') : 'warning'}`}>
        {!selectedProfile ? '未选择服务商' : requiredFailures > 0 ? `${requiredFailures} 项阻止切换` : riskCount > 0 ? `可切换，但有 ${riskCount} 项风险` : '可以切换'}
      </span>}
    </header>
  )
}
