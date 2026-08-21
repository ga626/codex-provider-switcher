import { GripVertical, Server, Star } from 'lucide-react'
import { CSS } from '@dnd-kit/utilities'
import { useSortable } from '@dnd-kit/sortable'
import type { ProviderProfile } from '../../types'
import { providerModelLabel } from './model-utils'

export function SortableProviderRow({
  profile,
  index,
  selected,
  disabled,
  onSelect,
  onMove,
}: {
  profile: ProviderProfile
  index: number
  selected: boolean
  disabled: boolean
  onSelect: () => void
  onMove: (targetIndex: number) => void
}) {
  const { attributes, isDragging, isOver, listeners, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({
    id: profile.id,
    disabled,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-provider-id={profile.id}
      className={`provider-row ${selected ? 'selected' : ''} ${profile.active ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isOver ? 'drag-over' : ''}`}
      role="option"
      aria-selected={selected}
      tabIndex={disabled ? -1 : 0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.altKey && event.key === 'ArrowUp') {
          event.preventDefault()
          onMove(Math.max(0, index - 1))
        } else if (event.altKey && event.key === 'ArrowDown') {
          event.preventDefault()
          onMove(index + 1)
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      <button
        ref={setActivatorNodeRef}
        className="provider-drag-handle"
        type="button"
        title="拖动排序"
        aria-label={`拖动 ${profile.name} 调整列表顺序`}
        onClick={(event) => event.stopPropagation()}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={15} aria-hidden="true" />
      </button>
      <span className="provider-symbol" aria-hidden="true"><Server size={16} /></span>
      <span className="provider-row-main">
        <strong>
          {profile.name}
          {profile.isDefault && <Star size={12} />}
        </strong>
        <small>{profile.model ? `模型：${providerModelLabel(profile.model)}` : '尚未设置默认模型'}</small>
      </span>
      <span className={`row-state ${profile.verified ? 'ok' : 'warning'}`} />
    </div>
  )
}
