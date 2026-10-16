import { useLayoutEffect, useState, type RefObject } from 'react'
import type { DataTableColumn, DataTableSort, SortableValue } from './types'

/**
 * Container-width watcher. The table's layout must follow the box it was GIVEN,
 * not the viewport: the same table renders in a full-width admin page, in a
 * 320 px side panel and in the theme preview's 390 px device stage - on the
 * very same desktop window. `useIsMobile()` answers "is this a phone", which is
 * a different question, and is used only to choose between a bottom sheet and a
 * dropdown for the overflow actions.
 *
 * Returns `null` until the first measurement. That distinction matters: a
 * container that genuinely measures 0 (collapsed panel, clipped accordion) is
 * NOT "unmeasured", and must not be treated as wide - doing so renders a
 * 640 px-min table inside a zero-width box, which then pushes a horizontal
 * scrollbar onto the page. Measuring in a layout effect means the very first
 * paint already has the real width, so there is no cards→table flash either.
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

/** Plain-text name of a column, for the chooser, card labels and aria-labels. */
export function columnLabel<T>(col: DataTableColumn<T>): string {
  if (col.headerText) return col.headerText
  return typeof col.header === 'string' ? col.header : col.id
}

function compare(a: SortableValue, b: SortableValue): number {
  // Empty cells always sink, whatever the direction: "no value" is not a small
  // value, and burying blanks at the bottom is what users expect.
  const aEmpty = a === null || a === undefined || a === ''
  const bEmpty = b === null || b === undefined || b === ''
  if (aEmpty && bEmpty) return 0
  if (aEmpty) return 1
  if (bEmpty) return -1

  if (a instanceof Date || b instanceof Date) {
    return Number(a instanceof Date ? a.getTime() : a) - Number(b instanceof Date ? b.getTime() : b)
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  // `localeCompare` with `numeric` so "Poste 2" precedes "Poste 10", and
  // `sensitivity: base` so accents/case do not fragment the ordering.
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/** Sort a copy of `rows`; blanks sink, and the original order breaks ties. */
export function sortRows<T>(
  rows: T[],
  columns: DataTableColumn<T>[],
  sort: DataTableSort | null,
): T[] {
  if (!sort) return rows
  const col = columns.find(c => c.id === sort.columnId)
  if (!col?.sortValue) return rows
  const get = col.sortValue
  const sign = sort.direction === 'asc' ? 1 : -1
  // Decorate–sort–undecorate: keeps the sort STABLE (equal rows retain their
  // incoming order) and calls `sortValue` once per row instead of O(n log n).
  return rows
    .map((row, index) => ({ row, index, key: get(row) }))
    .sort((a, b) => {
      const c = compare(a.key, b.key)
      return c !== 0 ? c * sign : a.index - b.index
    })
    .map(d => d.row)
}

/** Next state of a sort toggle: asc → desc → none → asc. */
export function nextSort(current: DataTableSort | null, columnId: string): DataTableSort | null {
  if (current?.columnId !== columnId) return { columnId, direction: 'asc' }
  if (current.direction === 'asc') return { columnId, direction: 'desc' }
  return null
}
