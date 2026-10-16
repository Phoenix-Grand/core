import { useCallback, useRef, useState } from 'react'

/** Below this a column is a sliver that can hold nothing - not even an ellipsis. */
const MIN_WIDTH = 56

/**
 * Column resizing for the table layout.
 *
 * Two things are worth knowing here:
 *
 * 1. The table switches to `table-layout: fixed` as soon as ONE column has been
 *    resized, and every column's current width is snapshotted at that moment. In
 *    `auto` layout a width is only a hint - the browser re-solves the whole row
 *    from the content, so dragging one edge would shuffle the others. Snapshotting
 *    first is what makes a drag move a single boundary.
 *
 * 2. The pointer is captured on the handle, so the drag survives the cursor
 *    leaving the 5px strip - which it does immediately on any real gesture.
 */
export function useColumnResize() {
  const [widths, setWidths] = useState<Record<string, number>>({})
  const drag = useRef<{ id: string; startX: number; startW: number } | null>(null)

  /** `true` once anything has been resized: the caller then pins the layout. */
  const pinned = Object.keys(widths).length > 0

  /** Snapshot every header width, so the untouched columns keep what they had. */
  const snapshot = (handle: HTMLElement): Record<string, number> => {
    const row = handle.closest('tr')
    if (!row) return {}
    const out: Record<string, number> = {}
    row.querySelectorAll<HTMLElement>('th[data-col]').forEach(th => {
      out[th.getAttribute('data-col') ?? ''] = Math.round(th.getBoundingClientRect().width)
    })
    return out
  }

  const begin = useCallback((e: React.PointerEvent<HTMLElement>, colId: string) => {
    // Never let the gesture reach the header button underneath: a resize must not
    // also sort the column.
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget
    const base = snapshot(handle)
    const startW = base[colId] ?? MIN_WIDTH
    drag.current = { id: colId, startX: e.clientX, startW }
    setWidths(prev => ({ ...base, ...prev, [colId]: startW }))
    handle.setPointerCapture(e.pointerId)
  }, [])

  const move = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    const next = Math.max(MIN_WIDTH, d.startW + (e.clientX - d.startX))
    setWidths(prev => (prev[d.id] === next ? prev : { ...prev, [d.id]: next }))
  }, [])

  const end = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (drag.current) e.currentTarget.releasePointerCapture(e.pointerId)
    drag.current = null
  }, [])

  /** Keyboard equivalent - a mouse-only affordance is not an affordance. */
  const nudge = useCallback((colId: string, delta: number, handle: HTMLElement) => {
    setWidths(prev => {
      const base = Object.keys(prev).length ? prev : snapshot(handle)
      return { ...base, [colId]: Math.max(MIN_WIDTH, (base[colId] ?? MIN_WIDTH) + delta) }
    })
  }, [])

  /** Double-click on a handle drops that column back to automatic width. */
  const reset = useCallback((colId: string) => {
    setWidths(prev => {
      const { [colId]: _dropped, ...rest } = prev
      return rest
    })
  }, [])

  return { widths, pinned, begin, move, end, nudge, reset }
}
