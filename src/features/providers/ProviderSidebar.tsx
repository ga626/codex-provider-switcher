import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Plus } from 'lucide-react'
import type { ProviderProfile } from '../../types'
import { SortableProviderRow } from './SortableProviderRow'

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
          <SortableContext items={profiles.map((profile) => profile.id)} strategy={verticalListSortingStrategy}>
            <div className="provider-list scroll-region" role="listbox" aria-label="服务商列表" data-tour="provider-list" data-guide-target="providers.list">
              {profiles.map((profile, index) => (
                <SortableProviderRow
                  key={profile.id}
                  profile={profile}
                  index={index}
                  selected={profile.id === selectedId}
                  disabled={busy}
                  onSelect={() => onSelect(profile)}
                  onMove={(targetIndex) => onMove(profile.id, Math.min(profiles.length - 1, targetIndex))}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </section>
    </aside>
  )
}
