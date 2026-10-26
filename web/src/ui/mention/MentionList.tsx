import { createPortal } from 'react-dom'
import type { MentionItem } from './types'
import { highlightMatch } from './foldHighlight'

export interface MentionListProps {
  items: MentionItem[]
  activeIndex: number
  query: string
  /** Viewport rect of the caret; the list drops just below it. */
  anchorRect: DOMRect | null
  onPick: (item: MentionItem) => void
  onHover?: (index: number) => void
  loading?: boolean
}

const MAX_WIDTH = 320
const GAP = 4

// Letter pill fallback when an item has no avatar (mirrors AddressSuggest).
function Pill({ item }: { item: MentionItem }) {
  if (item.avatarUrl) {
    return <img src={item.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover shrink-0" />
  }
  const letter = (item.label || item.email || '?').trim()[0]?.toUpperCase() ?? '?'
  return (
    <span className="w-7 h-7 rounded-full bg-primary/15 text-primary text-xs font-medium flex items-center justify-center shrink-0">
      {letter}
    </span>
  )
}

/**
 * Dropdown of mention candidates, portalled to <body> and positioned near the
 * caret. Selection happens on `pointerdown` + `preventDefault` so it lands
 * before the field loses focus. The matching sub-string of the label is
 * emboldened, accent- and case-insensitively.
 */
export function MentionList({
  items, activeIndex, query, anchorRect, onPick, onHover, loading,
}: MentionListProps) {
  if (typeof document === 'undefined') return null
  if (!anchorRect || (!items.length && !loading)) return null

  // Keep the list within the viewport horizontally.
  const left = Math.min(anchorRect.left, window.innerWidth - MAX_WIDTH - 8)
  const top = anchorRect.bottom + GAP

  return createPortal(
    <div
      role="listbox"
      className="fixed z-[9999] min-w-56 max-w-80 py-1 rounded-lg border border-border
                 bg-white/95 backdrop-blur-md shadow-lg max-h-64 overflow-y-auto"
      style={{ left: Math.max(8, left), top }}
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          onPointerDown={(e) => { e.preventDefault(); onPick(item) }}
          onMouseEnter={() => onHover?.(i)}
          className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left
                     ${i === activeIndex ? 'bg-surface-2' : 'hover:bg-surface-1'}`}
        >
          <Pill item={item} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-text-primary truncate">
              {highlightMatch(item.label, query).map((seg, si) =>
                seg.hit
                  ? <strong key={si} className="font-semibold text-primary">{seg.text}</strong>
                  : <span key={si}>{seg.text}</span>,
              )}
            </span>
            {item.secondary && (
              <span className="block text-xs text-text-secondary truncate">{item.secondary}</span>
            )}
          </span>
        </button>
      ))}
      {loading && !items.length && (
        <div className="px-3 py-2 text-xs text-text-tertiary">Searching…</div>
      )}
    </div>,
    document.body,
  )
}
