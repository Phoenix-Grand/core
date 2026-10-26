/**
 * Picking labels for one element, as a form field.
 *
 * ## Why a field and not only a menu
 *
 * Labels could already be attached from a context menu, which works for an
 * element that exists and is on screen. It does not work while you are still
 * writing the thing: an event being created has nowhere to attach them yet, and
 * a menu buried under "other actions" is not where anyone looks for a property
 * of what they are filling in. So labels get a line in the form like the date
 * or the location - visible, editable, and readable at a glance.
 *
 * ## Presentational on purpose
 *
 * It is handed the labels that exist and the ones chosen, and reports back what
 * was chosen. It never calls the labels API: the element being labelled may not
 * exist yet, and only the module knows when it does and under what identity.
 * That keeps the same field usable for an event, a task, or anything else.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Search, Tag, X } from 'lucide-react'
import { AnchoredPopover } from './AnchoredPopover'
import { MENU_ATTR } from './useMenuDismiss'
import { Input } from './Input'

export interface LabelOption {
  id: string
  name: string
  /** Any CSS colour. The chip is filled with it and its text is white. */
  color: string
}

export interface LabelFieldProps {
  /** Every label the person may choose from. */
  options: LabelOption[]
  /** Ids currently chosen. */
  value: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
  /** Shown on the button that opens the list. */
  placeholder?: string
  /** Shown in place of the list when there is nothing to choose from. */
  emptyHint?: string
  /** Search box label, for the list. */
  searchPlaceholder?: string
}

export function LabelField({
  options, value, onChange, disabled,
  placeholder = "Labels…",
  emptyHint = "No labels yet.",
  searchPlaceholder = "Search",
}: LabelFieldProps) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const anchor = useRef<HTMLButtonElement>(null)

  const byId = useMemo(() => new Map(options.map(o => [o.id, o])), [options])
  // Kept in the order they were chosen; an id whose label has since been
  // deleted simply disappears rather than drawing an empty chip.
  const chosen = value.map(id => byId.get(id)).filter(Boolean) as LabelOption[]
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? options.filter(o => o.name.toLowerCase().includes(needle)) : options
  }, [options, q])

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter(v => v !== id) : [...value, id])

  // Escape closes the LIST, and stops there. Racing the window for the event
  // does not work - both listen in the capture phase and the window, having
  // mounted first, is first. The house convention is the other way round: an
  // open list MARKS itself, and a window declines Escape while such a mark is
  // on the page. So the list is marked below, and this only has to close it.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault(); setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chosen.map(l => (
        <span key={l.id}
          className="flex items-center gap-1.5 rounded-full py-1 pl-2 pr-1.5 text-xs text-white"
          style={{ backgroundColor: l.color }}>
          <Tag size={9} />{l.name}
          {!disabled && (
            <button type="button" aria-label={`Retirer ${l.name}`}
              onClick={() => toggle(l.id)}
              className="rounded-full p-0.5 hover:bg-black/20"><X size={11} /></button>
          )}
        </span>
      ))}
      <button ref={anchor} type="button" disabled={disabled}
        onClick={() => { setQ(''); setOpen(v => !v) }}
        className="flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1
                   text-xs text-text-secondary hover:bg-surface-1 disabled:opacity-50">
        <Tag size={12} />{placeholder}
      </button>
      {open && (
        <AnchoredPopover anchorRef={anchor} open onClose={() => setOpen(false)}>
          <div className="w-64 rounded-lg border border-border bg-surface-0 p-2 shadow-xl"
            {...{ [MENU_ATTR]: '' }}
            onMouseDown={e => e.stopPropagation()}>
            {options.length > 6 && (
              <div className="relative mb-2">
                <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary" />
                <Input autoFocus value={q} onChange={e => setQ(e.target.value)}
                  placeholder={searchPlaceholder} className="w-full pl-7 text-sm" />
              </div>
            )}
            {options.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-text-tertiary">{emptyHint}</p>
            ) : (
              <ul className="max-h-64 overflow-y-auto">
                {shown.map(l => {
                  const on = value.includes(l.id)
                  return (
                    <li key={l.id}>
                      <button type="button" onClick={() => toggle(l.id)}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-1">
                        <span className="h-3.5 w-3.5 shrink-0 rounded-full"
                          style={{ backgroundColor: l.color }} />
                        <span className="min-w-0 flex-1 truncate text-text-primary">{l.name}</span>
                        {on && <Check size={14} className="shrink-0 text-primary" />}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </AnchoredPopover>
      )}
    </div>
  )
}
