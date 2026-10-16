import { cn } from '../cn'
import { useRef, useState, type ReactNode, type RefObject } from 'react'
import { MoreHorizontal, Settings2, X } from 'lucide-react'
import type { TFunction } from 'i18next'
import { Button } from '../Button'
import { Checkbox } from '../Checkbox'
import { MenuDropdown, type MenuItem } from '../MenuDropdown'
import { MobileSheet, MobileSheetItem, MobileSheetSeparator } from '../MobileSheet'
import { uiT } from '../uiText'
import { columnLabel } from './helpers'
import type { DataTableBulkAction, DataTableColumn } from './types'

export interface ToolbarProps<T> {
  title?:   ReactNode
  toolbar?: ReactNode
  columns:  DataTableColumn<T>[]
  hidden:   string[]
  onHiddenChange: (ids: string[]) => void
  configurableColumns: boolean
  selectedRows: T[]
  bulkActions?: DataTableBulkAction<T>[]
  onClearSelection: () => void
  /** Narrow container → the bar must stay ONE row. */
  compact:  boolean
  /** Real touch device → overflow opens a bottom sheet instead of a menu. */
  touch:    boolean
  t?:       TFunction
}

/** How many bulk actions stay visible before the rest fold into the overflow. */
const INLINE_BULK_DESKTOP = 3
const INLINE_BULK_COMPACT = 1

/**
 * The table's top band. It has two mutually exclusive faces:
 *
 *  • idle       - title, the caller's filters, and the column chooser;
 *  • selection  - "N selected", the bulk actions, and a way out.
 *
 * They swap rather than coexist: stacking a selection bar under a filter bar is
 * exactly how a toolbar ends up wrapping onto three rows on a narrow screen.
 * When the container is narrow only ONE bulk action stays inline and the rest
 * move to an overflow - a bottom sheet on touch, a menu with a mouse.
 */
export function DataTableToolbar<T>({
  title, toolbar, columns, hidden, onHiddenChange, configurableColumns,
  selectedRows, bulkActions, onClearSelection, compact, touch, t,
}: ToolbarProps<T>) {
  const tr = uiT(t)
  const colBtnRef  = useRef<HTMLButtonElement>(null)
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const [colMenu,  setColMenu]  = useState<{ top: number; left: number } | null>(null)
  const [moreMenu, setMoreMenu] = useState<{ top: number; left: number } | null>(null)
  const [sheet, setSheet] = useState(false)

  const selectionMode = selectedRows.length > 0 && !!bulkActions?.length
  const openAt = (
    ref: RefObject<HTMLButtonElement | null>,
    set: (p: { top: number; left: number } | null) => void,
  ) => {
    const r = ref.current?.getBoundingClientRect()
    if (r) set({ top: r.bottom + 4, left: r.left })
  }

  // ── Selection face ─────────────────────────────────────────────────────────
  if (selectionMode) {
    const inline   = compact ? INLINE_BULK_COMPACT : INLINE_BULK_DESKTOP
    const shown    = bulkActions.slice(0, inline)
    const overflow = bulkActions.slice(inline)

    return (
      <div className="flex min-w-0 items-center gap-2 rounded-lg bg-primary-light px-2.5 py-2">
        <button
          type="button"
          onClick={onClearSelection}
          aria-label={tr('ui.dt_clear_sel')}
          className="shrink-0 rounded-md p-1 text-primary transition-colors hover:bg-[var(--kb-black-08)]
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <X size={15} />
        </button>
        <span className="min-w-0 flex-1 truncate text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
          {selectedRows.length} {tr('ui.dt_selected')}
        </span>
        {shown.map(a => (
          <Button
            key={a.id}
            size="sm"
            variant={a.danger ? 'danger' : 'secondary'}
            icon={a.icon}
            onClick={() => a.onClick(selectedRows)}
            className="shrink-0"
          >
            {compact ? null : a.label}
          </Button>
        ))}
        {overflow.length > 0 && (
          <>
            <button
              ref={moreBtnRef}
              type="button"
              aria-label={tr('ui.more_actions')}
              aria-haspopup="menu"
              onClick={() => (touch ? setSheet(true) : openAt(moreBtnRef, setMoreMenu))}
              className="shrink-0 rounded-md p-1.5 text-primary transition-colors hover:bg-[var(--kb-black-08)]
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <MoreHorizontal size={16} />
            </button>
            {moreMenu && (
              <MenuDropdown
                pos={moreMenu}
                onClose={() => setMoreMenu(null)}
                items={overflow.map<MenuItem>(a => ({
                  type: 'action', label: a.label, icon: a.icon, danger: a.danger,
                  onClick: () => { a.onClick(selectedRows); setMoreMenu(null) },
                }))}
              />
            )}
            <MobileSheet open={sheet} onClose={() => setSheet(false)} title={`${selectedRows.length} ${tr('ui.dt_selected')}`}>
              {overflow.map(a => (
                <MobileSheetItem
                  key={a.id} icon={a.icon} label={a.label} danger={a.danger}
                  onClick={() => { setSheet(false); a.onClick(selectedRows) }}
                />
              ))}
              <MobileSheetSeparator />
              <MobileSheetItem label={tr('ui.dt_clear_sel')} onClick={() => { setSheet(false); onClearSelection() }} />
            </MobileSheet>
          </>
        )}
      </div>
    )
  }

  // ── Idle face ──────────────────────────────────────────────────────────────
  if (!title && !toolbar && !configurableColumns) return null

  return (
    <div className={cn('flex min-w-0 gap-2', compact ? 'flex-col items-stretch' : 'items-center')}>
      {title != null && (
        <h3 className="min-w-0 flex-1 truncate font-medium text-text-primary" style={{ fontSize: 'var(--kb-text-heading)' }}>
          {title}
        </h3>
      )}
      {toolbar && <div className={cn('min-w-0', compact ? '' : 'flex-1')}>{toolbar}</div>}
      {configurableColumns && (
        <div className={cn('shrink-0', compact && 'self-end')}>
          <button
            ref={colBtnRef}
            type="button"
            aria-haspopup="menu"
            aria-label={tr('ui.dt_columns')}
            onClick={() => openAt(colBtnRef, setColMenu)}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-white px-2.5
                       text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            style={{ fontSize: 'var(--kb-text-body)' }}
          >
            <Settings2 size={14} />
            {!compact && tr('ui.dt_columns')}
          </button>
          {colMenu && (
            <MenuDropdown
              pos={colMenu}
              minWidth={220}
              onClose={() => setColMenu(null)}
              items={[
                { type: 'label', text: tr('ui.dt_columns') },
                ...columns.map<MenuItem>(col => ({
                  type: 'custom',
                  render: () => (
                    <div className="px-2.5 py-1.5">
                      <Checkbox
                        checked={!hidden.includes(col.id)}
                        disabled={col.required}
                        label={columnLabel(col)}
                        onChange={on => onHiddenChange(
                          on ? hidden.filter(id => id !== col.id) : [...hidden, col.id],
                        )}
                      />
                    </div>
                  ),
                })),
              ]}
            />
          )}
        </div>
      )}
    </div>
  )
}
