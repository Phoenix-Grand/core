import type { TFunction } from 'i18next'
import { uiT } from '../uiText'

/**
 * Loading state - a SKELETON, not a spinner.
 *
 * A spinner says "something is happening somewhere"; a skeleton says "a table
 * with these columns is arriving here", so the layout does not jump when the
 * rows land and the eye already knows where to look. Widths vary per column so
 * the placeholder reads as text rather than as a bar chart.
 *
 * The whole block is `aria-hidden` behind a single polite status message: a
 * screen reader has nothing to gain from forty grey rectangles.
 */
export function DataTableSkeleton({ columns, rows = 5, selectable = false, t }: {
  columns: number
  rows?: number
  selectable?: boolean
  t?: TFunction
}) {
  const tr = uiT(t)
  // Deterministic pseudo-widths: a random() would reshuffle on every re-render
  // and make the placeholder shimmer sideways.
  const width = (row: number, col: number) => 45 + ((row * 7 + col * 23) % 5) * 11

  return (
    <div>
      <span role="status" className="sr-only">{tr('ui.dt_loading')}</span>
      <div aria-hidden className="divide-y divide-border">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex items-center gap-4 px-4 py-3">
            {selectable && <span className="h-[18px] w-[18px] shrink-0 rounded-sm bg-surface-2 animate-pulse" />}
            {Array.from({ length: columns }, (_, c) => (
              <span key={c} className="h-3.5 flex-1 rounded-sm bg-surface-2 animate-pulse" style={{ maxWidth: `${width(r, c)}%` }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
