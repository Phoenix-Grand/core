import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'

export type SortDirection = 'asc' | 'desc'

export interface DataTableSort {
  columnId:  string
  direction: SortDirection
}

/** Value a column can be sorted on. `null`/`undefined` always sink to the end. */
export type SortableValue = string | number | boolean | Date | null | undefined

export interface DataTableColumn<T> {
  id:     string
  header: ReactNode
  /** Plain-text header, needed when `header` is a node (column chooser, card labels). */
  headerText?: string
  cell:   (row: T) => ReactNode
  /**
   * Makes the column sortable. Returning the raw value (not the rendered node)
   * keeps "12" < "100" and dates chronological.
   */
  sortValue?: (row: T) => SortableValue
  width?:    number | string
  minWidth?: number
  align?:    'left' | 'right' | 'center'
  /** Hidden until the user turns it on in the column chooser. */
  defaultHidden?: boolean
  /** Cannot be hidden - the column that identifies the row. */
  required?: boolean
  /**
   * Marks the column that titles the row in the narrow (card) layout. Exactly
   * one column should carry it; the first column is used when none does.
   */
  primary?:  boolean
  /** Skip this column in the card layout (redundant once the card is built). */
  hideOnCards?: boolean
}

export interface DataTableRowAction<T> {
  id:      string
  label:   string
  icon?:   ReactNode
  danger?: boolean
  onClick: (row: T) => void
  /** Hide the action for rows it does not apply to. */
  hidden?: (row: T) => boolean
}

export interface DataTableBulkAction<T> {
  id:      string
  label:   string
  icon?:   ReactNode
  danger?: boolean
  onClick: (rows: T[]) => void
}

export interface DataTableProps<T> {
  rows:    T[]
  columns: DataTableColumn<T>[]
  /** Stable identity of a row - used for selection, keys and sort stability. Unset: the row's position in `rows`. */
  rowKey?: (row: T) => string

  // ── State: loading / error / empty ────────────────────────────────────────
  loading?:      boolean
  skeletonRows?: number
  /** Non-null switches the body to the `error` empty state. */
  error?:        ReactNode
  onRetry?:      () => void
  /** True while a search/filter is active - picks `no-results` over `first-use`. */
  filtered?:     boolean
  /** Clears the caller's filters; drives the `no-results` action. */
  onClearFilters?: () => void
  /** Replaces the built-in "nothing yet" state (an `<EmptyState variant="first-use">`). */
  emptyState?:     ReactNode
  /** Title and description of the built-in "nothing yet" state (`.kbview` `EmptyTitle` / `EmptyText`). */
  emptyTitle?: string
  emptyText?:  string
  /** Replaces the built-in "no match" state (an `<EmptyState variant="no-results">`). */
  noResultsState?: ReactNode

  // ── Sorting ──────────────────────────────────────────────────────────────
  defaultSort?:  DataTableSort | null
  sort?:         DataTableSort | null
  onSortChange?: (sort: DataTableSort | null) => void
  /** The caller sorts (server-side): the table only reflects the indicator. */
  manualSort?:   boolean

  // ── Pagination ───────────────────────────────────────────────────────────
  /** `0` disables pagination entirely. */
  pageSize?:         number
  pageSizeOptions?:  number[]
  onPageSizeChange?: (size: number) => void
  /** Controlled page (0-based - the whole component is 0-based internally). */
  page?:         number
  onPageChange?: (page: number) => void
  /** Total row count when the caller paginates server-side. */
  totalRows?:        number
  manualPagination?: boolean

  // ── Selection ────────────────────────────────────────────────────────────
  selectable?:         boolean
  selectedIds?:        string[]
  onSelectionChange?:  (ids: string[]) => void
  bulkActions?:        DataTableBulkAction<T>[]

  // ── Row actions ──────────────────────────────────────────────────────────
  rowActions?: DataTableRowAction<T>[]
  onRowClick?: (row: T) => void
  /** Enter on a focused row, or a double click: the row and its index in `rows` (`.kbview` `OnRowActivated`). */
  onRowActivate?: (row: T, index: number) => void

  // ── Single selection (`.kbview` `SelectedIndex`) ──────────────────────────
  /**
   * The selected row's index in `rows` (whatever the sort), `-1` = none. Controlled when given; with it or
   * `onSelectedIndexChange`, a click or the arrow keys select one row (tinted, `aria-selected`).
   */
  selectedIndex?: number
  onSelectedIndexChange?: (index: number) => void

  // ── Columns ──────────────────────────────────────────────────────────────
  /** Show the column chooser. */
  configurableColumns?:  boolean
  /**
   * Drag the edge of a header to resize it (table layout only - a card list has
   * no columns to resize). Defaults to `true`.
   */
  resizableColumns?:     boolean
  hiddenColumns?:        string[]
  onHiddenColumnsChange?: (ids: string[]) => void

  // ── Chrome ───────────────────────────────────────────────────────────────
  title?:      ReactNode
  /** Row height: `compact`, `normal` (default) or `comfortable` (`.kbview` `Density`). */
  density?:    'compact' | 'normal' | 'comfortable'
  /** Left side of the toolbar - a search field, filter chips… */
  toolbar?:    ReactNode
  /** Force the layout instead of following the container width. */
  layout?:     'auto' | 'table' | 'cards'
  /** Container width (px) under which `auto` switches to cards. */
  cardsBelow?: number
  /** Minimum table width; below it the table scrolls INSIDE its own box. */
  minTableWidth?: number
  className?:  string
  t?:          TFunction
}
