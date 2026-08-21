import { CircleHelp } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'

/**
 * Shared modal shell used by every feature dialog.
 *
 * Keeping focus management here makes dialog behavior consistent while the
 * feature workspaces remain responsible only for their own content.
 */
export function ModalDialog({
  className = '',
  labelledBy,
  onClose,
  children,
}: {
  className?: string
  labelledBy: string
  onClose: () => void
  children: ReactNode
}) {
  const dialogRef = useModalDialog(onClose)
  return (
    <div className="confirm-backdrop" role="presentation">
      <section ref={dialogRef} className={`confirm-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </section>
    </div>
  )
}

/** Small, keyboard-accessible explanation marker used beside field labels. */
export function FieldHint({ text }: { text: string }) {
  return (
    <span className="field-hint">
      <button type="button" aria-label="查看字段说明"><CircleHelp size={14} aria-hidden="true" /></button>
      <span role="tooltip">{text}</span>
    </span>
  )
}

function useModalDialog(onClose: () => void) {
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusInitialAction = () => dialogRef.current?.querySelector<HTMLElement>('[data-dialog-initial-focus]')?.focus()
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const focusTimer = window.setTimeout(focusInitialAction, 0)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus()
    }
  }, [onClose])

  return dialogRef
}
