import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Bottom sheet - the mobile stand-in for a popover/dropdown. Anchored popovers
 * assume a mouse and enough room beside the trigger; on a phone the same choices
 * belong in a sheet that slides up from the bottom edge, is thumb-reachable and
 * dismissed by tapping the scrim.
 *
 * Rendered in a portal so it escapes the explorer's scroll/transform context,
 * above the shell's bottom nav (z-40) and FAB.
 */
export function MobileSheet({ open, onClose, title, children }: {
  open:     boolean
  onClose:  () => void
  title?:   ReactNode
  children: ReactNode
}) {
  // Escape closes; body scroll is locked so the page behind doesn't move under
  // the sheet (iOS scroll chaining).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[9997] lg:hidden" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 animate-[kb-sheet-fade_.15s_ease-out]" onClick={onClose} />
      <div
        className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl bg-white
                   shadow-[0_-8px_30px_rgba(0,0,0,0.18)] animate-[kb-sheet-up_.2s_ease-out]"
        style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}
      >
        {/* Grab handle - signals "drag/tap to dismiss" even though we only tap. */}
        <div className="flex justify-center pt-2.5 pb-1">
          <div className="h-1 w-10 rounded-full bg-border-strong" />
        </div>
        {title && (
          <div className="px-4 pb-2 pt-1 text-sm font-medium text-text-primary truncate">{title}</div>
        )}
        <div className="py-1">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

/** One row inside a sheet. Sized for a thumb (52px), not a cursor. */
export function MobileSheetItem({ icon, label, trailing, danger, selected, onClick }: {
  icon?:     ReactNode
  label:     ReactNode
  trailing?: ReactNode
  danger?:   boolean
  selected?: boolean
  onClick:   () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3.5 px-4 h-[52px] text-left text-[15px] active:bg-surface-2 transition-colors
                  ${danger ? 'text-danger' : 'text-text-primary'} ${selected ? 'bg-primary-light' : ''}`}
    >
      {icon && <span className={`w-5 flex justify-center shrink-0 ${danger ? 'text-danger' : 'text-text-secondary'}`}>{icon}</span>}
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {trailing}
    </button>
  )
}

export function MobileSheetSeparator() {
  return <div className="my-1 h-px bg-border" />
}
