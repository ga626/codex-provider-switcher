import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Plus } from 'lucide-react'
import type { ProviderProfile } from '../../types'
import { SortableProviderRow } from './SortableProviderRow'
import { providerConnectionKind, type ProviderConnectionKind } from './provider-utils'

const connectionGroups: Array<{ id: ProviderConnectionKind; label: string }> = [
  { id: 'chatgpt-account', label: 'ChatGPT 官方账号' },
  { id: 'official-api', label: '厂商官方 API' },
  { id: 'relay', label: '中转站' },
]

export function ProviderSidebar({
  profiles,
  selectedId,
  busy,
  onSelect,
  onAdd,
  onMove,
}: {
  profiles: ProviderProfile[]
  selectedId: string
  busy: boolean
  onSelect: (profile: ProviderProfile) => void
  onAdd: () => void
  onMove: (profileId: string, targetIndex: number) => void
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const groupedProfiles = connectionGroups.map((group) => ({
    ...group,
    profiles: profiles.filter((profile) => providerConnectionKind(profile) === group.id),
  })).filter((group) => group.profiles.length > 0)

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    const targetIndex = profiles.findIndex((profile) => profile.id === over.id)
    if (targetIndex >= 0) onMove(String(active.id), targetIndex)
  }

  return (
    <aside id="provider-object-pane" className="provider-object-pane" aria-labelledby="saved-connections-title">
      <section className="sidebar-connections">
        <div className="sidebar-section-title">
          <span id="saved-connections-title">服务商列表</span>
          <span className="provider-add-transition-target" data-transition-target="provider-add">
            <button type="button" onClick={onAdd} disabled={busy} aria-label="新增服务商" data-tour="provider-add" data-guide-target="providers.add">
              <Plus size={15} />
            </button>
          </span>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <div className="provider-list scroll-region" role="listbox" aria-label="服务商列表" data-tour="provider-list" data-guide-target="providers.list">
            {groupedProfiles.map((group) => <section className={`provider-group ${group.id}`} role="group" aria-labelledby={`provider-group-${group.id}`} key={group.id}>
              <header><span id={`provider-group-${group.id}`}>{group.label}</span><small>{group.profiles.length}</small></header>
              <SortableContext items={group.profiles.map((profile) => profile.id)} strategy={verticalListSortingStrategy}>
                <div className="provider-group-list">
                  {group.profiles.map((profile, index) => (
                    <SortableProviderRow
                      key={profile.id}
                      profile={profile}
                      kind={group.id}
                      index={index}
                      selected={profile.id === selectedId}
                      disabled={busy}
                      onSelect={() => onSelect(profile)}
                      onMove={(targetIndex) => {
                        const target = group.profiles[Math.max(0, Math.min(group.profiles.length - 1, targetIndex))]
                        if (target) onMove(profile.id, profiles.findIndex((item) => item.id === target.id))
                      }}
                    />
                  ))}
                </div>
              </SortableContext>
            </section>)}
            </div>
        </DndContext>
      </section>
    </aside>
  )
}
