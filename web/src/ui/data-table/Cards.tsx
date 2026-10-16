import { useRef, useState } from 'react'
import { Copy, MoreVertical, TextCursorInput } from 'lucide-react'
import type { TFunction } from 'i18next'
import { Checkbox } from '../Checkbox'
import { MenuDropdown, type MenuItem } from '../MenuDropdown'
import { MobileSheet, MobileSheetItem } from '../MobileSheet'
import { uiT } from '../uiText'
import { copyText, rowText, selectionText } from './copy'
import { columnLabel } from './helpers'
import type { DataTableColumn, DataTableRowAction } from './types'

export interface CardsProps<T> {
  rows:    T[]
  columns: DataTableColumn<T>[]
  rowKey:  (row: T) => string
  selectable: boolean
  selected:   Set<string>
  onToggle:   (id: string) => void
  rowActions?: DataTableRowAction<T>[]
  onRowClick?: (row: T) => void
  touch: boolean
  t?: TFunction
}

/**
 * Narrow layout - the table becomes a list of cards.
 *
 * This is a different HIERARCHY, not a squeezed table: the primary column
 * becomes the card's title, the remaining columns become label/value pairs, and
 * the row's actions collapse into a single overflow control (a bottom sheet on
 * touch, a menu with a mouse). A horizontally scrolling table on a phone is a
 * table nobody reads.
 */
export function DataTableCards<T>({
  rows, columns, rowKey, selectable, selected, onToggle,
  rowActions, onRowClick, touch, t,
}: CardsProps<T>) {
  const tr = uiT(t)
  const [menu, setMenu]   = useState<{ row: T; top: number; left: number } | null>(null)
  const [sheet, setSheet] = useState<T | null>(null)
  /* Captured when the overflow control is pressed, not when the menu renders: the
   * text selection is cleared by the tap that opens the menu. */
  const [copySrc, setCopySrc] = useState<{ row: string; sel: string }>({ row: '', sel: '' })
  const btnRefs = useRef(new Map<string, HTMLButtonElement>())

  const shown   = columns.filter(c => !c.hideOnCards)
  const primary = shown.find(c => c.primary) ?? shown[0]
  const rest    = shown.filter(c => c !== primary)

  const actionsFor = (row: T) => (rowActions ?? []).filter(a => !a.hidden?.(row))

  return (
    <>
      <ul className="flex flex-col gap-2 p-2">
        {rows.map(row => {
          const id = rowKey(row)
          const isSelected = selected.has(id)
          return (
            <li
              key={id}
              data-row-card=""
              className={`rounded-lg border p-3 transition-colors ${
                isSelected ? 'border-primary bg-primary-light' : 'border-border bg-surface-0'
              }`}
            >
              <div className="flex items-start gap-2.5">
                {selectable && (
                  <Checkbox
                    checked={isSelected}
                    onChange={() => onToggle(id)}
                    className="mt-0.5"
                    labelClassName="sr-only"
                    label={tr('ui.dt_select_row')}
                  />
                )}
                <div
                  className={`min-w-0 flex-1 ${onRowClick ? 'cursor-pointer' : ''}`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  <div data-col={primary?.id} className="truncate font-medium text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
                    {primary?.cell(row)}
                  </div>
                </div>
                {/* Always shown: even with no row action, the menu still carries the
                    copy entries. A card has no cell grid and no columns, so only
                    "copy the card" and "copy the selection" are offered here. */}
                <button
                    ref={el => { if (el) btnRefs.current.set(id, el); else btnRefs.current.delete(id) }}
                    type="button"
                    aria-haspopup="menu"
                    aria-label={tr('ui.more_actions')}
                    onClick={e => {
                      const card = (e.currentTarget as HTMLElement).closest('[data-row-card]')
                      setCopySrc({ row: card ? rowText(card) : '', sel: selectionText() })
                      if (touch) { setSheet(row); return }
                      const r = btnRefs.current.get(id)?.getBoundingClientRect()
                      if (r) setMenu({ row, top: r.bottom + 4, left: Math.max(8, r.right - 200) })
                    }}
                    // 44px hit target: this is the phone layout.
                    className="-mr-1.5 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-md
                               text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary
                               focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                  <MoreVertical size={16} />
                </button>
              </div>

              {rest.length > 0 && (
                <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
                  {rest.map(col => (
                    <div key={col.id} className="contents">
                      <dt className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                        {columnLabel(col)}
                      </dt>
                      <dd data-col={col.id} className="min-w-0 text-text-primary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                        {col.cell(row)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          )
        })}
      </ul>

      {menu && (
        <MenuDropdown
          pos={{ top: menu.top, left: menu.left }}
          onClose={() => setMenu(null)}
          items={[
            ...actionsFor(menu.row).map<MenuItem>(a => ({
              type: 'action', label: a.label, icon: a.icon, danger: a.danger,
              onClick: () => { a.onClick(menu.row); setMenu(null) },
            })),
            ...(actionsFor(menu.row).length ? [{ type: 'separator' } as MenuItem] : []),
            { type: 'action', label: tr('ui.dt_copy_card'), icon: <Copy size={14} />,
              onClick: () => { void copyText(copySrc.row); setMenu(null) } },
            ...(copySrc.sel
              ? [{ type: 'action', label: tr('ui.dt_copy_selection'), icon: <TextCursorInput size={14} />,
                   onClick: () => { void copyText(copySrc.sel); setMenu(null) } } as MenuItem]
              : []),
          ]}
        />
      )}

      <MobileSheet open={sheet !== null} onClose={() => setSheet(null)} title={tr('ui.actions')}>
        {sheet !== null && actionsFor(sheet).map(a => (
          <MobileSheetItem
            key={a.id} icon={a.icon} label={a.label} danger={a.danger}
            onClick={() => { const row = sheet; setSheet(null); a.onClick(row) }}
          />
        ))}
        {/* Copy lands in the same sheet: on a phone this IS the row menu. */}
        <MobileSheetItem
          icon={<Copy size={16} />} label={tr('ui.dt_copy_card')}
          onClick={() => { setSheet(null); void copyText(copySrc.row) }}
        />
        {copySrc.sel && (
          <MobileSheetItem
            icon={<TextCursorInput size={16} />} label={tr('ui.dt_copy_selection')}
            onClick={() => { setSheet(null); void copyText(copySrc.sel) }}
          />
        )}
      </MobileSheet>
    </>
  )
}
