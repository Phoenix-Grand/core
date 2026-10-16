import { cn } from '../cn'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, ArrowDown, ArrowUp, ChevronsUpDown, Columns3, Copy, Inbox,
  MoreVertical, Rows3, SearchX, TextCursorInput,
} from 'lucide-react'
import { Checkbox } from '../Checkbox'
import { EmptyState } from '../EmptyState'
import { MenuDropdown, type MenuItem } from '../MenuDropdown'
import { MobileSheet, MobileSheetItem } from '../MobileSheet'
import { isCoarsePointer } from '../interaction'
import { uiT } from '../uiText'
import { DataTableCards } from './Cards'
import { Pagination } from './Pagination'
import { DataTableSkeleton } from './Skeleton'
import { DataTableToolbar } from './Toolbar'
import { cellText, columnText, copyText, rowText, selectionText } from './copy'
import { columnLabel, nextSort, sortRows, useContainerWidth } from './helpers'
import { useColumnResize } from './useColumnResize'
import type { DataTableColumn, DataTableProps, DataTableSort } from './types'

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const
/** Vertical padding of the cells per `density`. */
const DENSITY = { compact: 'py-1.5', normal: 'py-2.5', comfortable: 'py-3.5' } as const

/// How a sortable header's button positions itself inside its cell.
///
/// Two CSS facts meet here and neither is obvious. A `<button>` keeps
/// shrink-to-fit sizing even at `display: flex`, so it does **not** span the
/// cell - which is why `justify-end` changes nothing, there is no free space to
/// distribute. And being a block-level box, it ignores the `text-align` the
/// `<th>` carries. The only thing that moves it is an automatic margin.
///
/// The negative margin that pulls the label flush with the cell padding is
/// therefore declared per side rather than as `-mx-1`, so the side that must go
/// `auto` is not fighting a shorthand for the same property.
const HEADER_ALIGN = {
  left:   '-mx-1',
  right:  '-mr-1 ml-auto',
  center: 'mx-auto',
} as const

/**
 * DataTable - the one table of the design system.
 *
 * Replaces five hand-written `<table>`s (three paddings, four header skins, no
 * sorting anywhere) and the two divergent paginations - one 0-based and
 * server-side, the other 1-based and client-side. Everything they disagreed on
 * is settled here: the public API is 0-based, the displayed page is 1-based, and
 * the bar always lives in the table's own footer.
 *
 * ── Horizontal overflow ──────────────────────────────────────────────────────
 * The table scrolls INSIDE its own box. The scroller is `overflow-x-auto` and
 * the root is `min-w-0` - without that, a wide table makes its flex/grid parent
 * grow and the whole PAGE scrolls sideways, which the project forbids.
 *
 * ── Layout ───────────────────────────────────────────────────────────────────
 * `layout="auto"` follows the CONTAINER width, not the viewport: under
 * `cardsBelow` (700 px) the rows become cards (see `Cards.tsx`). A table in a
 * narrow side panel is just as unreadable on a desktop as on a phone.
 *
 * ── States ───────────────────────────────────────────────────────────────────
 * loading → skeleton · error → `EmptyState variant="error"` with a retry ·
 * no rows → `first-use` (invites creation) · no rows WITH filters on →
 * `no-results` (offers to clear them, never a creation). Pass `filtered` for
 * that distinction to be made correctly.
 */
export function DataTable<T>({
  rows, columns, rowKey: rowKeyProp,
  loading = false, skeletonRows = 5, error, onRetry,
  filtered = false, onClearFilters, emptyState, noResultsState,
  defaultSort = null, sort: sortProp, onSortChange, manualSort = false,
  pageSize: pageSizeProp = 25, pageSizeOptions = [10, 25, 50, 100], onPageSizeChange,
  page: pageProp, onPageChange, totalRows, manualPagination = false,
  selectable = false, selectedIds, onSelectionChange, bulkActions,
  rowActions, onRowClick, onRowActivate, selectedIndex, onSelectedIndexChange,
  emptyTitle, emptyText, density = 'normal',
  configurableColumns = false, hiddenColumns, onHiddenColumnsChange,
  resizableColumns = true,
  title, toolbar,
  layout = 'auto', cardsBelow = 700, minTableWidth = 640,
  className, t,
}: DataTableProps<T>) {
  const tr = uiT(t)
  // A row's index in `rows` (the `.kbview` SelectedIndex / OnRowActivated), and the fallback row key.
  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r, i] as const)), [rows])
  const rowKey = useMemo(() => rowKeyProp ?? ((r: T) => String(indexOf.get(r) ?? -1)), [rowKeyProp, indexOf])
  // ── Single selection (uncontrolled unless `selectedIndex` is supplied) ─────
  const single = selectedIndex !== undefined || !!onSelectedIndexChange
  const [singleState, setSingleState] = useState(-1)
  const current = selectedIndex ?? singleState
  const pick = (index: number) => {
    if (!single || index === current) return
    if (selectedIndex === undefined) setSingleState(index)
    onSelectedIndexChange?.(index)
  }
  const rowsFocusable = single || !!onRowActivate
  const cellPad = DENSITY[density]
  const rootRef = useRef<HTMLDivElement>(null)
  const width = useContainerWidth(rootRef)
  // `width === null` only on the very first render (before the layout effect):
  // fall back to the table. Any measured width - including 0 - is honoured.
  const compact = layout === 'cards' || (layout === 'auto' && width !== null && width < cardsBelow)
  const touch = isCoarsePointer()

  // ── Sorting (uncontrolled unless `sort` is supplied) ───────────────────────
  const [sortState, setSortState] = useState<DataTableSort | null>(defaultSort)
  const sort = sortProp !== undefined ? sortProp : sortState
  const applySort = (next: DataTableSort | null) => {
    if (sortProp === undefined) setSortState(next)
    onSortChange?.(next)
  }

  // ── Pagination ─────────────────────────────────────────────────────────────
  const [pageState, setPageState] = useState(0)
  const [sizeState, setSizeState] = useState(pageSizeProp)
  const page     = pageProp !== undefined ? pageProp : pageState
  const pageSize = onPageSizeChange ? pageSizeProp : sizeState
  const paginated = pageSize > 0

  const setPage = (p: number) => {
    if (pageProp === undefined) setPageState(p)
    onPageChange?.(p)
  }
  const setPageSize = (s: number) => {
    if (onPageSizeChange) onPageSizeChange(s)
    else setSizeState(s)
    setPage(0)
  }

  // ── Hidden columns ─────────────────────────────────────────────────────────
  const [hiddenState, setHiddenState] = useState<string[]>(
    () => columns.filter(c => c.defaultHidden).map(c => c.id),
  )
  const hidden = hiddenColumns ?? hiddenState
  const setHidden = (ids: string[]) => {
    if (hiddenColumns === undefined) setHiddenState(ids)
    onHiddenColumnsChange?.(ids)
  }
  const visibleColumns = useMemo(
    () => columns.filter(c => !hidden.includes(c.id)),
    [columns, hidden],
  )

  // ── Selection ──────────────────────────────────────────────────────────────
  const [selState, setSelState] = useState<string[]>([])
  const selectedList = selectedIds ?? selState
  const selected = useMemo(() => new Set(selectedList), [selectedList])
  const setSelected = (ids: string[]) => {
    if (selectedIds === undefined) setSelState(ids)
    onSelectionChange?.(ids)
  }
  const toggleRow = (id: string) =>
    setSelected(selected.has(id) ? selectedList.filter(x => x !== id) : [...selectedList, id])

  // ── Data pipeline: sort → paginate ─────────────────────────────────────────
  const sorted = useMemo(
    () => (manualSort ? rows : sortRows(rows, columns, sort)),
    [rows, columns, sort, manualSort],
  )
  const total = manualPagination ? (totalRows ?? rows.length) : sorted.length
  const pageCount = paginated ? Math.max(1, Math.ceil(total / pageSize)) : 1
  const pageRows = useMemo(() => {
    if (!paginated || manualPagination) return sorted
    return sorted.slice(page * pageSize, page * pageSize + pageSize)
  }, [sorted, paginated, manualPagination, page, pageSize])

  // A filter that shrinks the result set can strand the user on a page that no
  // longer exists - snap back instead of showing an empty page.
  useEffect(() => {
    if (paginated && page > 0 && page >= pageCount) setPage(pageCount - 1)
  }, [pageCount]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedRows = useMemo(
    () => sorted.filter(r => selected.has(rowKey(r))),
    [sorted, selected, rowKey],
  )

  // Select-all covers the CURRENT PAGE only: silently selecting rows the user
  // cannot see (and may not have loaded) before a bulk delete is a trap.
  const pageKeys = pageRows.map(rowKey)
  const allOnPage  = pageKeys.length > 0 && pageKeys.every(k => selected.has(k))
  const someOnPage = pageKeys.some(k => selected.has(k))
  // A partial page selection must read as "indeterminate", not as "unchecked".
  // `Checkbox` now owns that: it pushes the DOM property (the tri-state exists
  // nowhere else) AND draws the dash, which the CSS control never did.
  const headIndeterminate = someOnPage && !allOnPage

  const toggleAll = () => setSelected(
    allOnPage
      ? selectedList.filter(k => !pageKeys.includes(k))
      : [...new Set([...selectedList, ...pageKeys])],
  )

  // ── Row overflow menu (table layout) ───────────────────────────────────────
  const [rowMenu, setRowMenu]   = useState<{ row: T; top: number; left: number } | null>(null)
  const [rowSheet, setRowSheet] = useState<T | null>(null)

  // ── Column resizing ────────────────────────────────────────────────────────
  // Table layout only: a card list has no columns, and an 8px drag strip is not a
  // touch target. Both conditions, not just the prop.
  const resize = useColumnResize()
  const canResize = resizableColumns && !compact && !touch

  // ── Copy context menu (right-click on a row) ───────────────────────────────
  // What was right-clicked is resolved from the EVENT TARGET, not from the row
  // object: the menu offers the cell under the cursor, which only the DOM knows.
  const [copyMenu, setCopyMenu] = useState<
    { top: number; left: number; cell: string; row: string; colId: string; colLabel: string; sel: string } | null
  >(null)

  const openCopyMenu = (e: React.MouseEvent<HTMLTableRowElement>) => {
    const td = (e.target as Element).closest?.('[data-col]')
    const tr = e.currentTarget
    if (!td || !tr.contains(td)) return          // the actions cell, a checkbox…
    e.preventDefault()
    const colId = td.getAttribute('data-col') ?? ''
    const col = visibleColumns.find(c => c.id === colId)
    setCopyMenu({
      top: e.clientY, left: e.clientX,
      cell: cellText(td), row: rowText(tr), colId,
      colLabel: col ? columnLabel(col) : colId,
      sel: selectionText(),
    })
  }

  const copyItems = (): MenuItem[] => {
    if (!copyMenu) return []
    const run = (text: string) => () => { void copyText(text); setCopyMenu(null) }
    const items: MenuItem[] = [
      { type: 'action', label: tr('ui.dt_copy_cell'), icon: <Copy size={14} />, onClick: run(copyMenu.cell) },
      { type: 'action', label: tr('ui.dt_copy_row'),  icon: <Rows3 size={14} />, onClick: run(copyMenu.row) },
      {
        type: 'action',
        label: tr('ui.dt_copy_column', { name: copyMenu.colLabel }),
        icon: <Columns3 size={14} />,
        onClick: () => {
          if (rootRef.current) void copyText(columnText(rootRef.current, copyMenu.colId))
          setCopyMenu(null)
        },
      },
    ]
    // Only offered when something is actually highlighted - an item that copies
    // an empty string is worse than an absent one.
    if (copyMenu.sel) {
      items.push({ type: 'separator' })
      items.push({ type: 'action', label: tr('ui.dt_copy_selection'), icon: <TextCursorInput size={14} />, onClick: run(copyMenu.sel) })
    }
    return items
  }
  const rowKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>, row: T, index: number) => {
    if (e.target !== e.currentTarget) return
    const go = (next: Element | null) => {
      if (!(next instanceof HTMLTableRowElement)) return
      e.preventDefault()
      next.focus()
      next.click()
    }
    if (e.key === 'ArrowDown') go(e.currentTarget.nextElementSibling)
    else if (e.key === 'ArrowUp') go(e.currentTarget.previousElementSibling)
    else if (e.key === 'Home') go(e.currentTarget.parentElement?.firstElementChild ?? null)
    else if (e.key === 'End') go(e.currentTarget.parentElement?.lastElementChild ?? null)
    else if (e.key === 'Enter' && onRowActivate) { e.preventDefault(); onRowActivate(row, index) }
    else if (e.key === ' ') { e.preventDefault(); pick(index) }
  }
  const actionsFor = (row: T) => (rowActions ?? []).filter(a => !a.hidden?.(row))
  const hasActionsColumn = !!rowActions?.length

  // ── Body ───────────────────────────────────────────────────────────────────
  const bodyEmpty = (() => {
    if (error != null) {
      return (
        <EmptyState
          t={t}
          variant="error"
          icon={<AlertCircle size={24} />}
          title={tr('ui.dt_error_title')}
          description={typeof error === 'boolean' ? tr('ui.dt_error_desc') : error}
          action={onRetry ? { label: tr('ui.retry'), onClick: onRetry } : undefined}
        />
      )
    }
    if (filtered) {
      return noResultsState ?? (
        <EmptyState
          t={t}
          variant="no-results"
          icon={<SearchX size={24} />}
          title={tr('ui.dt_nores_title')}
          description={tr('ui.dt_nores_desc')}
          // Deliberately NOT a creation: the row the user wants probably exists,
          // just outside the current filters.
          action={onClearFilters ? { label: tr('ui.dt_clear_filters'), onClick: onClearFilters } : undefined}
        />
      )
    }
    return emptyState ?? (
      <EmptyState
        t={t}
        variant="first-use"
        icon={<Inbox size={24} />}
        title={emptyTitle ?? tr('ui.dt_empty_title')}
        description={emptyText ?? tr('ui.dt_empty_desc')}
      />
    )
  })()

  const isEmpty = !loading && (error != null || pageRows.length === 0)

  const sortButton = (col: DataTableColumn<T>) => {
    const isActive = sort?.columnId === col.id
    const dir = isActive ? sort.direction : undefined
    return (
      <button
        type="button"
        onClick={() => applySort(nextSort(sort, col.id))}
        aria-label={`${columnLabel(col)} - ${dir === 'asc' ? tr('ui.dt_sort_desc') : tr('ui.dt_sort_asc')}`}
        // Alignment restated here because the `<th>`'s `text-align` cannot reach
        // inside this button - see [`HEADER_ALIGN`]. Without it every sortable
        // right-aligned column shows its values right and its label left, which
        // was the case across the storage, roles, backup and rules tables.
        className={cn(
          'group flex items-center gap-1 rounded-sm px-1 py-0.5 transition-colors',
          'hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          HEADER_ALIGN[col.align ?? 'left'],
        )}
      >
        <span className="truncate">{col.header}</span>
        {isActive
          ? (dir === 'asc' ? <ArrowUp size={12} className="shrink-0 text-primary" /> : <ArrowDown size={12} className="shrink-0 text-primary" />)
          : <ChevronsUpDown size={12} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />}
      </button>
    )
  }

  return (
    // `min-w-0` + `w-full`: the table may never widen its parent.
    <div ref={rootRef} className={cn('flex w-full min-w-0 flex-col gap-2', className)}>
      <DataTableToolbar
        title={title}
        toolbar={toolbar}
        columns={columns}
        hidden={hidden}
        onHiddenChange={setHidden}
        configurableColumns={configurableColumns}
        selectedRows={selectedRows}
        bulkActions={bulkActions}
        onClearSelection={() => setSelected([])}
        compact={compact}
        touch={touch}
        t={t}
      />

      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface-0">
        {loading ? (
          <DataTableSkeleton columns={Math.max(1, visibleColumns.length)} rows={skeletonRows} selectable={selectable} t={t} />
        ) : isEmpty ? (
          bodyEmpty
        ) : compact ? (
          <DataTableCards
            rows={pageRows}
            columns={visibleColumns}
            rowKey={rowKey}
            selectable={selectable}
            selected={selected}
            onToggle={toggleRow}
            rowActions={rowActions}
            onRowClick={onRowClick}
            touch={touch}
            t={t}
          />
        ) : (
          // THE horizontal scroller. Wide content scrolls here, never in <body>.
          <div className="min-w-0 overflow-x-auto">
            <table
              className="w-full border-collapse"
              // Pinned only once something has been resized - see `useColumnResize`.
              style={{ minWidth: minTableWidth, tableLayout: resize.pinned ? 'fixed' : 'auto' }}
            >
              <thead>
                <tr className="border-b border-border bg-surface-1">
                  {selectable && (
                    <th scope="col" className="w-10 px-3 py-2.5">
                      <span className="flex">
                        <Checkbox
                          checked={allOnPage}
                          indeterminate={headIndeterminate}
                          onChange={toggleAll}
                          label={tr('ui.dt_select_all')}
                          labelClassName="sr-only"
                        />
                      </span>
                    </th>
                  )}
                  {visibleColumns.map(col => {
                    const isActive = sort?.columnId === col.id
                    return (
                      <th
                        key={col.id}
                        scope="col"
                        data-col={col.id}
                        // `aria-sort` on the header cell is what tells assistive
                        // tech the table is ordered, and by which column.
                        aria-sort={isActive ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                        className={cn(
                          'relative px-4 py-2.5 font-medium text-text-secondary',
                          ALIGN[col.align ?? 'left'],
                        )}
                        style={{
                          // A resized width wins over the declared one; `minWidth` is
                          // dropped with it, or it would fight the drag.
                          width: resize.widths[col.id] ?? col.width,
                          minWidth: resize.widths[col.id] ? undefined : col.minWidth,
                          // Body size, like the cells underneath: a column header is
                          // read as often as the data, not as a caption.
                          fontSize: 'var(--kb-text-body)',
                        }}
                      >
                        {col.sortValue ? sortButton(col) : <span className="truncate">{col.header}</span>}
                        {canResize && (
                          <span
                            role="separator"
                            aria-orientation="vertical"
                            aria-label={tr('ui.dt_resize_column', { name: columnLabel(col) })}
                            tabIndex={0}
                            onPointerDown={e => resize.begin(e, col.id)}
                            onPointerMove={resize.move}
                            onPointerUp={resize.end}
                            onDoubleClick={() => resize.reset(col.id)}
                            onKeyDown={e => {
                              const step = e.shiftKey ? 24 : 8
                              if (e.key === 'ArrowRight') { e.preventDefault(); resize.nudge(col.id, step, e.currentTarget) }
                              if (e.key === 'ArrowLeft')  { e.preventDefault(); resize.nudge(col.id, -step, e.currentTarget) }
                            }}
                            /* Wide enough to grab (8px), but the visible rule is 1px and
                               only on hover/focus - a permanent grid of lines would
                               compete with the data. `touch-none` stops the browser
                               scrolling the table instead of resizing. */
                            className="absolute right-0 top-0 z-10 h-full w-2 translate-x-1/2 cursor-col-resize touch-none
                                       select-none after:absolute after:inset-y-1 after:left-1/2 after:w-px
                                       after:bg-transparent hover:after:bg-border-strong focus:outline-none
                                       focus-visible:after:bg-primary"
                          />
                        )}
                      </th>
                    )
                  })}
                  {hasActionsColumn && <th scope="col" className="w-12 px-2 py-2.5"><span className="sr-only">{tr('ui.actions')}</span></th>}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row, i) => {
                  const id = rowKey(row)
                  const index = indexOf.get(row) ?? -1
                  const isSel = selected.has(id) || (single && index === current)
                  const actions = actionsFor(row)
                  return (
                    <tr
                      key={id}
                      aria-selected={selectable || single ? isSel : undefined}
                      onClick={onRowClick || single ? () => { pick(index); onRowClick?.(row) } : undefined}
                      onDoubleClick={onRowActivate ? () => onRowActivate(row, index) : undefined}
                      // Rows take the focus one at a time (roving): Up / Down move it and select, Enter activates.
                      tabIndex={rowsFocusable ? (index === current || (current < 0 && i === 0) ? 0 : -1) : undefined}
                      onKeyDown={rowsFocusable ? e => rowKeyDown(e, row, index) : undefined}
                      onContextMenu={openCopyMenu}
                      /* Zebra on `surface-1`, hover one step further on `surface-2`.
                       * The two must not share a tone: hovering an odd row would then
                       * produce no change at all. Selection outranks both - it is a
                       * state, not a reading aid. Tint only, never a left accent bar. */
                      className={cn(
                        'border-b border-border transition-colors last:border-0',
                        isSel
                          ? 'bg-primary-light'
                          : cn(i % 2 === 1 && 'bg-surface-1', 'hover:bg-surface-2'),
                        (onRowClick || single) && 'cursor-pointer',
                        rowsFocusable && 'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary',
                      )}
                    >
                      {selectable && (
                        <td className={cn('px-3', cellPad)} onClick={e => e.stopPropagation()}>
                          <Checkbox
                            checked={selected.has(id)}
                            onChange={() => toggleRow(id)}
                            label={tr('ui.dt_select_row')}
                            labelClassName="sr-only"
                          />
                        </td>
                      )}
                      {visibleColumns.map(col => (
                        <td
                          key={col.id}
                          // Marks the DATA cells for the copy menu: reading by index
                          // would drift by one as soon as a checkbox or an actions
                          // cell is present.
                          data-col={col.id}
                          className={cn('px-4 text-text-primary', cellPad, ALIGN[col.align ?? 'left'])}
                          style={{ fontSize: 'var(--kb-text-body)' }}
                        >
                          {col.cell(row)}
                        </td>
                      ))}
                      {hasActionsColumn && (
                        <td className="px-2 py-2.5" onClick={e => e.stopPropagation()}>
                          {actions.length > 0 && (
                            <button
                              type="button"
                              aria-haspopup="menu"
                              aria-label={tr('ui.more_actions')}
                              onClick={e => {
                                if (touch) { setRowSheet(row); return }
                                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                                setRowMenu({ row, top: r.bottom + 4, left: Math.max(8, r.right - 200) })
                              }}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary
                                         transition-colors hover:bg-surface-2 hover:text-text-primary
                                         focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                            >
                              <MoreVertical size={15} />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {paginated && !loading && !isEmpty && total > 0 && (
          <div className="border-t border-border bg-surface-1 px-3 py-2">
            <Pagination
              page={page}
              pageCount={pageCount}
              total={total}
              pageSize={pageSize}
              pageSizeOptions={pageSizeOptions}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              compact={compact}
              t={t}
            />
          </div>
        )}
      </div>

      {/* Copy menu - right-click on a row. On a touch device `MenuDropdown` renders
          itself as a bottom sheet, so no separate mobile branch is needed here. */}
      {copyMenu && (
        <MenuDropdown
          pos={{ top: copyMenu.top, left: copyMenu.left }}
          onClose={() => setCopyMenu(null)}
          items={copyItems()}
        />
      )}

      {rowMenu && (
        <MenuDropdown
          pos={{ top: rowMenu.top, left: rowMenu.left }}
          onClose={() => setRowMenu(null)}
          items={actionsFor(rowMenu.row).map<MenuItem>(a => ({
            type: 'action', label: a.label, icon: a.icon, danger: a.danger,
            onClick: () => { a.onClick(rowMenu.row); setRowMenu(null) },
          }))}
        />
      )}

      <MobileSheet open={rowSheet !== null} onClose={() => setRowSheet(null)} title={tr('ui.actions')}>
        {rowSheet !== null && actionsFor(rowSheet).map(a => (
          <MobileSheetItem
            key={a.id} icon={a.icon} label={a.label} danger={a.danger}
            onClick={() => { const row = rowSheet; setRowSheet(null); a.onClick(row) }}
          />
        ))}
      </MobileSheet>
    </div>
  )
}
