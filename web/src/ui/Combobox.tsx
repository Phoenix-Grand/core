import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import type { TFunction } from 'i18next'
import { usePortalHost } from './portalHost'
import { useIsMobile } from './interaction'
import { MobileSheet } from './MobileSheet'
import { foldIncludes, uiT } from './uiText'

export interface ComboboxOption {
  value:        string
  label:        string
  /** Second line, shown dimmed under the label. Also searched. */
  description?: string
  icon?:        ReactNode
  /** Optional group heading; consecutive options sharing one are banded together. */
  group?:       string
  disabled?:    boolean
  /** Extra searchable terms (synonyms, codes) that are not displayed. */
  keywords?:    string
}

export interface ComboboxProps {
  value:    string | null
  onChange: (value: string) => void
  options:  ComboboxOption[]
  placeholder?:       string
  searchPlaceholder?: string
  /** Shown in place of the list when the query matches nothing. */
  emptyLabel?:        string
  disabled?:          boolean
  /** Adds a clear button on the trigger once something is selected. */
  clearable?:         boolean
  onClear?:           () => void
  /** Fixed trigger width (px or CSS length). Omit to fill the parent. */
  width?:   number | string
  /** Max height of the scrollable list, in px. */
  maxHeight?: number
  name?:      string
  id?:        string
  'aria-label'?: string
  className?: string
  t?:         TFunction
}

interface Pos { left: number; top: number; width: number }

/**
 * Combobox - selection in a LONG list: a trigger, a filter field and a listbox.
 *
 * `Dropdown` is the right control for a handful of fixed choices; it has no
 * filter, so it collapses on real data (the admin currently feeds it the ~600
 * IANA timezones). This component adds the search field, keyboard navigation,
 * and - the part that is routinely got wrong - DIACRITIC-INSENSITIVE matching:
 * typing `unites` finds « Unités », and typing `Unités` finds `unites`, because
 * both sides are folded through NFD + diacritic stripping (see `foldText`).
 *
 * Accessibility follows the ARIA 1.2 combobox pattern: the FILTER INPUT owns
 * `role="combobox"`, the popup is a `role="listbox"`, and the active option is
 * pointed at by `aria-activedescendant` - focus never leaves the input, so what
 * the user types keeps going to the field while the arrow keys move the
 * highlight. Options are `role="option"` with `aria-selected`.
 *
 * On mobile the popup would be a cramped anchored panel over the keyboard, so
 * the hierarchy is rethought instead of shrunk: the list becomes a `MobileSheet`
 * with the search field pinned at its top and thumb-sized rows.
 */
export function Combobox({
  value, onChange, options,
  placeholder, searchPlaceholder, emptyLabel,
  disabled = false, clearable = false, onClear,
  width, maxHeight = 280,
  name, id, className, t,
  'aria-label': ariaLabel,
}: ComboboxProps) {
  const tr = uiT(t)
  const reactId = useId()
  const listId  = `${reactId}-list`
  const optId   = (i: number) => `${reactId}-opt-${i}`

  const isMobile = useIsMobile()
  const { host, scoped } = usePortalHost()

  const [open, setOpen]   = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<Pos | null>(null)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef   = useRef<HTMLInputElement>(null)
  const popupRef   = useRef<HTMLDivElement>(null)
  const listRef    = useRef<HTMLDivElement>(null)

  const selected = useMemo(() => options.find(o => o.value === value) ?? null, [options, value])

  // Filtering is diacritic- and case-insensitive over label + description +
  // keywords, so "ete" matches « Été » and a synonym finds its option.
  const filtered = useMemo(() => {
    if (!query.trim()) return options
    return options.filter(o =>
      foldIncludes(o.label, query) ||
      (o.description ? foldIncludes(o.description, query) : false) ||
      (o.keywords ? foldIncludes(o.keywords, query) : false),
    )
  }, [options, query])

  // Index of the first selectable row - the highlight never rests on a disabled one.
  const firstEnabled = useCallback((from: number, dir: 1 | -1): number => {
    if (filtered.length === 0) return -1
    let i = from
    for (let step = 0; step < filtered.length; step++) {
      if (i < 0) i = filtered.length - 1
      if (i >= filtered.length) i = 0
      if (!filtered[i].disabled) return i
      i += dir
    }
    return -1
  }, [filtered])

  // Reopening starts on the current selection (or the first row); a new query
  // resets the highlight to the top of the fresh result set.
  useEffect(() => {
    if (!open) return
    const selIdx = filtered.findIndex(o => o.value === value)
    setActive(firstEnabled(selIdx >= 0 ? selIdx : 0, 1))
  }, [open, filtered, value, firstEnabled])

  const measure = useCallback(() => {
    const trigger = triggerRef.current
    const popup   = popupRef.current
    if (!trigger) return
    const r = trigger.getBoundingClientRect()
    const b = scoped && host ? host.getBoundingClientRect() : null
    const ox = b ? b.left : 0, oy = b ? b.top : 0
    const vw = b ? b.width : window.innerWidth
    const vh = b ? b.height : window.innerHeight
    const M = 8
    const w = r.width
    const h = popup?.offsetHeight ?? Math.min(maxHeight + 52, 340)
    let top  = (r.bottom - oy) + 4
    if (top + h > vh - M) top = Math.max(M, (r.top - oy) - h - 4)
    let left = r.left - ox
    if (left + w > vw - M) left = Math.max(M, vw - M - w)
    if (left < M) left = M
    setPos({ left, top, width: w })
  }, [scoped, host, maxHeight])

  useLayoutEffect(() => { if (open && !isMobile) measure() }, [open, isMobile, measure, filtered.length])

  // Keep the panel glued to its trigger while anything scrolls or resizes.
  useEffect(() => {
    if (!open || isMobile) return
    const onMove = () => measure()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open, isMobile, measure])

  // Outside pointerdown closes. Not `mousedown`: a Radix trigger calls
  // preventDefault on pointerdown, which suppresses the compatibility mousedown.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popupRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  // Focus the filter as soon as the panel exists, and keep the highlighted row
  // scrolled into view as the arrows walk the list.
  useEffect(() => { if (open) inputRef.current?.focus() }, [open, isMobile])
  useEffect(() => {
    if (!open || active < 0) return
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optId(active))}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, active]) // eslint-disable-line react-hooks/exhaustive-deps

  const openList = () => {
    if (disabled) return
    setQuery('')
    setOpen(true)
  }

  const commit = (opt: ComboboxOption) => {
    if (opt.disabled) return
    onChange(opt.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive(a => firstEnabled(a + 1, 1)); break
      case 'ArrowUp':   e.preventDefault(); setActive(a => firstEnabled(a - 1, -1)); break
      case 'Home':      e.preventDefault(); setActive(firstEnabled(0, 1)); break
      case 'End':       e.preventDefault(); setActive(firstEnabled(filtered.length - 1, -1)); break
      case 'Enter':
        if (active >= 0 && filtered[active]) { e.preventDefault(); commit(filtered[active]) }
        break
      case 'Escape':
        e.preventDefault(); e.stopPropagation()
        setOpen(false); triggerRef.current?.focus()
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  // ── Trigger ────────────────────────────────────────────────────────────────
  const triggerLabel = selected?.label ?? placeholder ?? tr('ui.cb_select')

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      id={id}
      role="combobox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-haspopup="listbox"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => (open ? setOpen(false) : openList())}
      onKeyDown={e => {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openList() }
      }}
      className={[
        'flex h-9 w-full items-center gap-2 rounded-md border px-3 text-left transition-colors',
        'bg-white text-text-primary',
        'kb-field-focus',
        'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-60',
        open ? 'kb-field-focus--on' : 'border-border hover:bg-surface-1',
      ].join(' ')}
      style={{ fontSize: 'var(--kb-text-body)' }}
    >
      {selected?.icon && <span className="flex shrink-0 items-center text-text-secondary">{selected.icon}</span>}
      <span className={`min-w-0 flex-1 truncate ${selected ? '' : 'text-text-tertiary'}`}>{triggerLabel}</span>
      {clearable && selected && (
        <span
          role="button"
          tabIndex={-1}
          aria-label={tr('ui.cb_clear')}
          onClick={e => { e.stopPropagation(); onClear?.(); onChange('') }}
          className="shrink-0 rounded-sm p-0.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
        >
          <X size={13} />
        </span>
      )}
      <ChevronDown size={15} className="shrink-0 text-text-secondary" aria-hidden />
    </button>
  )

  // ── Filter field + list (shared by the popover and the mobile sheet) ────────
  const searchField = (
    <div className="border-b border-border p-2">
      <div className="relative flex items-center">
        <Search size={14} className="pointer-events-none absolute left-2.5 text-text-tertiary" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          // ARIA 1.2 combobox: the input owns the role, the popup is its listbox,
          // and the highlighted row is named here - never focused - so the
          // caret stays in the field.
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 && filtered.length ? optId(active) : undefined}
          aria-label={searchPlaceholder ?? tr('ui.cb_search')}
          placeholder={searchPlaceholder ?? tr('ui.cb_search')}
          className="h-8 w-full rounded-md border border-border bg-white pl-8 pr-2 text-text-primary
                     placeholder:text-text-tertiary kb-field-focus"
          style={{ fontSize: 'var(--kb-text-body)' }}
        />
      </div>
    </div>
  )

  const list = (
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label={ariaLabel ?? placeholder}
      className="overflow-y-auto overscroll-contain p-1"
      style={{ maxHeight }}
    >
      {filtered.length === 0 ? (
        <p className="px-3 py-6 text-center text-text-tertiary" style={{ fontSize: 'var(--kb-text-body)' }}>
          {emptyLabel ?? tr('ui.cb_no_results')}
        </p>
      ) : filtered.map((opt, i) => {
        const isSel  = opt.value === value
        const isAct  = i === active
        const header = opt.group && (i === 0 || filtered[i - 1].group !== opt.group)
        return (
          <div key={opt.value}>
            {header && (
              <p
                className="px-2 pb-1 pt-2 font-medium uppercase tracking-wide text-text-tertiary"
                style={{ fontSize: 'var(--kb-text-micro)' }}
              >
                {opt.group}
              </p>
            )}
            <div
              id={optId(i)}
              role="option"
              aria-selected={isSel}
              aria-disabled={opt.disabled || undefined}
              onPointerDown={e => e.preventDefault()}  // keep focus in the filter
              onClick={() => commit(opt)}
              onMouseEnter={() => !opt.disabled && setActive(i)}
              className={[
                'flex cursor-pointer items-center gap-2 rounded-md px-2',
                isMobile ? 'min-h-[44px] py-2' : 'py-1.5',
                opt.disabled ? 'cursor-not-allowed opacity-50' : '',
                isAct ? 'bg-surface-2' : '',
                isSel ? 'text-primary' : 'text-text-primary',
              ].join(' ')}
              style={{ fontSize: 'var(--kb-text-body)' }}
            >
              <span className="flex w-4 shrink-0 justify-center text-primary" aria-hidden>
                {isSel && <Check size={14} />}
              </span>
              {opt.icon && <span className="flex shrink-0 items-center text-text-secondary">{opt.icon}</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{opt.label}</span>
                {opt.description && (
                  <span className="block truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                    {opt.description}
                  </span>
                )}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )

  return (
    <div className={`relative min-w-0 ${className ?? ''}`} style={width !== undefined ? { width } : undefined}>
      {name && <input type="hidden" name={name} value={value ?? ''} />}
      {trigger}

      {open && isMobile && (
        <MobileSheet open onClose={() => setOpen(false)} title={placeholder ?? ariaLabel}>
          <div ref={popupRef}>
            {searchField}
            {list}
          </div>
        </MobileSheet>
      )}

      {open && !isMobile && host && createPortal(
        <div
          ref={popupRef}
          className={`${scoped ? 'absolute' : 'fixed'} overflow-hidden rounded-lg border border-border bg-white`}
          style={{
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            width: pos?.width,
            minWidth: 200,
            zIndex: 9999,
            boxShadow: 'var(--kb-shadow-float)',
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
          {searchField}
          {list}
        </div>,
        host,
      )}
    </div>
  )
}
