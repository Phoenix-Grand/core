import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { focusIsWorthKeeping } from './focusGuard'
import { createPortal } from 'react-dom'
import { MENU_ATTR, useMenuDismiss } from './useMenuDismiss'
import { CaretDown } from './CaretDown'


export interface DropdownOption {
  value: string
  label: string
  icon?: React.ReactNode
}

type DropdownVariant = 'default' | 'dark' | 'ghost'

interface DropdownProps {
  value: string
  onChange: (v: string) => void
  options: DropdownOption[]
  /** Fixed width in px or CSS string (e.g. '100%'). Omit for natural/flex sizing. */
  width?: number | string
  /** Explicit min-width for the dropdown list. Defaults to trigger width. */
  dropdownMinWidth?: number
  placeholder?: string
  disabled?: boolean
  /** Trigger height in px (default 28 - matches toolbar style) */
  height?: number
  fontSize?: number
  className?: string
  variant?: DropdownVariant
  /** Extra styles merged into the trigger button (e.g. to square joined corners). */
  buttonStyle?: React.CSSProperties
  /**
   * Whether the trigger takes the focus a click hands it.
   *
   * `'auto'` (the default) is what a native select does - the click moves the
   * focus here, so the field the reader has just left goes dark - EXCEPT when
   * a text-editing surface holds the focus, where the click leaves it there so
   * the selection a toolbar is about to act on survives (see focusGuard.ts).
   * `true` always takes it; `false` never does. Neither is needed by a form.
   */
  focusable?: boolean | 'auto'
}

interface DropdownPos { top: number; left: number; minWidth: number }

const T: Record<DropdownVariant, {
  text: string; hoverBg: string; activeBg: string; chevron: string; border: string
  popBg: string; popShadow: string; popBorder: string
  itemText: string; itemHover: string
  selBg: string; selHoverBg: string; checkColor: string
}> = {
  default: {
    text: '#202124', hoverBg: 'rgba(0,0,0,0.06)', activeBg: 'rgba(0,0,0,0.08)',
    // Read at the point of USE, with the shared border as the fallback: a window
    // that dresses its fields (a tinted form canvas, say) sets the token on
    // itself and the trigger follows, instead of being the one control in the
    // form that cannot be dressed because it paints itself inline.
    chevron: '#5f6368', border: 'var(--kb-field-border, var(--color-border))',
    popBg: 'var(--kb-float-surface)', popShadow: 'var(--kb-float-highlight), var(--kb-shadow-float)',
    popBorder: 'var(--kb-float-border)',
    itemText: '#202124', itemHover: 'rgba(0,0,0,0.06)',
    selBg: 'rgba(26,115,232,0.12)', selHoverBg: 'rgba(26,115,232,0.16)', checkColor: '#1a73e8',
  },
  dark: {
    text: '#cccccc', hoverBg: 'rgba(255,255,255,0.08)', activeBg: 'rgba(255,255,255,0.12)',
    chevron: '#808080', border: '#3c3c3c',
    popBg: 'rgb(37 37 38 / 72%)', popShadow: 'var(--kb-float-highlight-dark), var(--kb-shadow-float-dark)',
    popBorder: 'var(--kb-float-border-dark)',
    itemText: '#cccccc', itemHover: 'rgba(255,255,255,0.08)',
    selBg: 'rgba(0,120,212,0.2)', selHoverBg: 'rgba(0,120,212,0.3)', checkColor: '#007acc',
  },
  ghost: {
    // Variant volontairement sans bordure (sélecteurs de barres d'outils).
    text: '#5f6368', hoverBg: 'rgba(0,0,0,0.04)', activeBg: 'rgba(0,0,0,0.06)',
    chevron: '#80868b', border: 'transparent', // ghost = sans bordure (toolbars)
    popBg: 'var(--kb-float-surface)', popShadow: 'var(--kb-float-highlight), var(--kb-shadow-float)',
    popBorder: 'var(--kb-float-border)',
    itemText: '#202124', itemHover: 'rgba(0,0,0,0.06)',
    selBg: 'rgba(26,115,232,0.12)', selHoverBg: 'rgba(26,115,232,0.16)', checkColor: '#1a73e8',
  },
}

export function Dropdown({
  value, onChange, options,
  width, dropdownMinWidth,
  placeholder, disabled = false,
  height = 36, fontSize = 13.5,
  className, variant = 'default', buttonStyle,
  focusable = 'auto',
}: DropdownProps) {
  const [open, setOpen]  = useState(false)
  const closePopup = useCallback(() => setOpen(false), [])
  useMenuDismiss(open, closePopup)
  const [focused, setFocused] = useState(false)

  // One icon gutter for the whole list: if a single option has an icon, every
  // row reserves the space, so their labels stay in one column.
  const anyIcon = options.some(o => !!o.icon)
  const [pos,  setPos]   = useState<DropdownPos | null>(null)
  const triggerRef       = useRef<HTMLButtonElement>(null)
  const popupRef         = useRef<HTMLDivElement>(null)
  const t                = T[variant]

  const selected = options.find(o => o.value === value)
  const label    = selected?.label ?? placeholder ?? value
  const selectedIdx = options.findIndex(o => o.value === value)

  // ── Keyboard: what a native <select> does ─────────────────────────────────
  //
  // The popup never takes the focus; the trigger keeps it and NAMES the row the
  // keyboard is on (`aria-activedescendant`), so Tab still leaves from the
  // trigger and a screen reader hears the highlighted option. Mouse and
  // keyboard drive the same highlight, so they never disagree about which row
  // is "the current one".
  const [hi, setHi] = useState(-1)
  const listId = useRef(`kb-dd-${Math.random().toString(36).slice(2, 8)}`).current
  const optId  = (i: number) => `${listId}-${i}`
  // Type-ahead: the letters typed in quick succession, matched against the
  // start of the labels - "bo", "boo", "book" - and forgotten after a pause,
  // exactly as a native list does it.
  const typed = useRef({ text: '', at: 0 })

  const placeAt = () => {
    if (triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect()
      setPos({ top: r.bottom + 2, left: r.left, minWidth: Math.max(dropdownMinWidth ?? 0, r.width) })
    }
  }
  const openWith = (i: number) => {
    if (disabled) return
    placeAt()
    setHi(i)
    setOpen(true)
  }
  const openDropdown = () => {
    if (disabled) return
    if (open) { setOpen(false); return }
    openWith(selectedIdx)
  }
  const commit = (i: number) => {
    const o = options[i]
    if (o) onChange(o.value)
    setOpen(false)
  }
  const clamp = (i: number) => Math.max(0, Math.min(options.length - 1, i))

  /** The option whose label starts with what was just typed, searched from the
   *  row after the current one so repeated letters walk through the matches. */
  const typeAhead = (ch: string, from: number): number => {
    const now = Date.now()
    const t0 = typed.current
    const text = now - t0.at < 600 ? t0.text + ch : ch
    typed.current = { text: text.toLowerCase(), at: now }
    const q = typed.current.text
    const n = options.length
    // A single repeated letter cycles ("b", "b", "b" → next "b…" each time).
    const single = q.length > 1 && q.split('').every(c => c === q[0])
    const needle = single ? q[0] : q
    const start = single || q.length === 1 ? from + 1 : from
    for (let k = 0; k < n; k++) {
      const i = ((start + k) % n + n) % n
      if (options[i].label.toLowerCase().startsWith(needle)) return i
    }
    return -1
  }

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    const n = options.length
    if (!open) {
      switch (e.key) {
        case 'ArrowDown': case 'ArrowUp': case 'Enter': case ' ':
          e.preventDefault(); openWith(selectedIdx < 0 ? 0 : selectedIdx); return
        case 'Home': e.preventDefault(); openWith(0); return
        case 'End':  e.preventDefault(); openWith(n - 1); return
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const i = typeAhead(e.key, selectedIdx)
        if (i >= 0) { e.preventDefault(); openWith(i) }
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setHi(h => clamp(h + 1)); return
      case 'ArrowUp':   e.preventDefault(); setHi(h => clamp(h - 1)); return
      case 'Home':      e.preventDefault(); setHi(0); return
      case 'End':       e.preventDefault(); setHi(n - 1); return
      case 'PageDown':  e.preventDefault(); setHi(h => clamp(h + 10)); return
      case 'PageUp':    e.preventDefault(); setHi(h => clamp(h - 10)); return
      case 'Enter': case ' ':
        e.preventDefault(); if (hi >= 0) commit(hi); else setOpen(false); return
      // Escape is taken on the window, in capture (see the open effect).
      case 'Tab':
        // Leaving takes the highlighted row with it, as a native list does.
        if (hi >= 0) commit(hi); else setOpen(false); return
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const i = typeAhead(e.key, hi)
      if (i >= 0) { e.preventDefault(); setHi(i) }
    }
  }

  // Keep the highlighted row in view as the keyboard walks the list.
  useEffect(() => {
    if (!open || hi < 0) return
    document.getElementById(optId(hi))?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hi])

  // Reposition the (position:fixed) popup so it stays anchored to the trigger -
  // recomputed from the trigger's CURRENT rect, so it follows on scroll/resize
  // instead of drifting away. Flips above the trigger when there's no room below.
  // Is the trigger still visible, or has it scrolled out of the viewport / behind
  // a clipping ancestor (e.g. a sticky header)? Used to close the menu when the
  // trigger disappears, so a fixed popup never floats alone over other content.
  const isTriggerVisible = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return false
    const tr = trigger.getBoundingClientRect()
    if (tr.bottom <= 0 || tr.top >= window.innerHeight || tr.right <= 0 || tr.left >= window.innerWidth) return false
    // Clipped by any scrollable/overflow ancestor?
    let node = trigger.parentElement
    while (node) {
      const cs = getComputedStyle(node)
      if (/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflowX)) {
        const cr = node.getBoundingClientRect()
        if (tr.bottom <= cr.top || tr.top >= cr.bottom || tr.right <= cr.left || tr.left >= cr.right) return false
      }
      node = node.parentElement
    }
    return true
  }, [])

  const reposition = useCallback(() => {
    const trigger = triggerRef.current
    const el = popupRef.current
    if (!trigger || !el) return
    const tr = trigger.getBoundingClientRect()
    const r  = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const M = 8
    let l = tr.left
    let t = tr.bottom + 2
    if (l + r.width  > vw - M) l = vw - M - r.width
    if (t + r.height > vh - M) t = Math.max(M, tr.top - 2 - r.height)
    if (l < M) l = M
    if (t < M) t = M
    el.style.left = `${l}px`
    el.style.top  = `${t}px`
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (!triggerRef.current?.contains(e.target as Node)
        && !popupRef.current?.contains(e.target as Node)) setOpen(false)
    }
    // Keep the popup glued to the trigger while any ancestor scrolls or the
    // window resizes. Capture phase catches scrollable ancestors (scroll doesn't
    // bubble); the popup's own list scroll is ignored (it doesn't move the trigger).
    const onMove = () => {
      // Trigger scrolled out of sight → close instead of leaving the popup
      // floating over unrelated content. Otherwise keep it glued to the trigger.
      if (!isTriggerVisible()) setOpen(false)
      else reposition()
    }
    // `pointerdown`, pas `mousedown` : un déclencheur Radix appelle `preventDefault()`
    // sur pointerdown, ce qui SUPPRIME le mousedown de compatibilité - le menu ouvert
    // ne voyait alors jamais le clic et restait affiché. Capture pour passer devant
    // tout composant qui stoppe la propagation.
    // Escape closes THE LIST, and nothing else. Every window and page listens
    // for Escape on `window` too; a handler on the trigger runs after some of
    // them and a React `stopPropagation` does not reach a listener that was
    // installed natively on the window - the editor closed under the list
    // (found by test). Capture on the window is the first thing to run, so
    // the key is consumed here before anyone else can read it.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onEsc, true)
    document.addEventListener('pointerdown', close, true)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('keydown', onEsc, true)
      document.removeEventListener('pointerdown', close, true)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open, reposition, isTriggerVisible])

  useLayoutEffect(() => {
    if (open && pos) reposition()
  }, [open, pos, reposition])

  const containerStyle: React.CSSProperties = {}
  if (width !== undefined) containerStyle.width = width

  const PRIMARY = 'var(--color-primary, #1a73e8)'
  // The shared "active" affordance, generalised on the primary component: the
  // default-variant trigger wears the SAME border + ring as a focused <Input>
  // whenever the list is open (or the trigger is keyboard-focused). Toolbar
  // variants (ghost/dark) keep their subtle look.
  const focusBorder = variant === 'default' && (open || focused)
  // Resting fill. Only the default variant follows the container: a toolbar
  // dropdown must stay transparent even inside a window that dresses its fields.
  const restBg = variant === 'default' ? 'var(--kb-field-bg, transparent)' : ''

  return (
    <div className={`relative ${className ?? ''}`} style={containerStyle}
      // While the list is open the trigger is part of the menu: the keys it
      // receives drive the list, and the generic dismiss must not read them as
      // "a keystroke somewhere else".
      {...(open ? { [MENU_ATTR]: '' } : {})}>
      <button
        type="button"
        ref={triggerRef}
        onClick={openDropdown}
        onKeyDown={onTriggerKeyDown}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && hi >= 0 ? optId(hi) : undefined}
        // Decided at the click, not at the call site: refuse the focus only
        // when it is worth keeping where it is (a toolbar over an editor).
        onMouseDown={e => {
          const refuse = focusable === false || (focusable === 'auto' && focusIsWorthKeeping())
          if (refuse) e.preventDefault()
        }}
        /* `:focus-visible`, not plain focus - the browser's own answer to "does
           this focus deserve to be shown?". A trigger clicked with the mouse
           keeps the DOM focus and would otherwise stay lit after its list is
           closed, which reads as a field that never let go. */
        onFocus={e => setFocused(e.currentTarget.matches(':focus-visible'))}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        className="w-full flex items-center justify-between gap-1 select-none outline-none"
        style={{
          height,
          padding: '0 4px 0 8px',
          fontSize,
          fontFamily: 'var(--font-family-sans)',
          color: t.text,
          background: open && !focusBorder ? t.activeBg : restBg,
          border: `1px solid ${focusBorder ? PRIMARY : t.border}`,
          borderRadius: 'var(--radius-md)',
          // ONE painting for the focus stroke: an outline with a NEGATIVE offset,
          // which overlaps the border instead of abutting it. A 1px border
          // followed by a 2px shadow are two paintings whose shared edge does not
          // round to the same physical pixels on a fractionally scaled screen
          // (Windows at 175%): a sliver of the background shows between them and
          // what you read is a double border. Same visual footprint as before.
          outline: focusBorder ? `3px solid ${PRIMARY}` : undefined,
          outlineOffset: focusBorder ? '-1px' : undefined,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: 'background 0.1s, box-shadow 0.1s, border-color 0.1s',
          ...buttonStyle,
        }}
        onMouseEnter={e => { if (!open && !disabled && !focusBorder) (e.currentTarget as HTMLElement).style.background = t.hoverBg }}
        onMouseLeave={e => { if (!open) (e.currentTarget as HTMLElement).style.background = restBg }}
      >
        <span className="truncate flex-1 text-left">{label}</span>
        <CaretDown color={t.chevron} />
      </button>

      {open && pos && createPortal(
        <div
          ref={popupRef}
          onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            minWidth: pos.minWidth,
            zIndex: 9999,
          }}
          {...{ [MENU_ATTR]: '' }}
          className={variant === 'dark' ? 'kb-frosted kb-frosted-dark' : 'kb-frosted'}
        >
          <div className="kb-frost-layer" aria-hidden />
          <div id={listId} role="listbox" style={{ maxHeight: 280, overflowY: 'auto', padding: 5 }}>
          {options.map((o, i) => {
            const isSel = o.value === value
            const isHi  = i === hi
            return (
            <button
              key={o.value}
              id={optId(i)}
              type="button"
              role="option"
              aria-selected={isSel}
              tabIndex={-1}
              onClick={() => commit(i)}
              onMouseEnter={() => setHi(i)}
              className="w-full text-left flex items-center gap-2"
              style={{
                padding: '5px 10px',
                borderRadius: 6,
                fontSize,
                color: t.itemText,
                background: isHi ? (isSel ? t.selHoverBg : t.itemHover) : isSel ? t.selBg : undefined,
                fontWeight: isSel ? 600 : undefined,
              }}
            >
              {/* Fixed gutters, always the same width whether the check and the
                  icon are there or not: labels of the same level must line up.
                  The check used to carry a negative margin, which shifted the
                  selected row's text out of column. */}
              <span style={{ width: 14, flexShrink: 0, textAlign: 'center', color: t.checkColor, fontSize: 14 }}>
                {o.value === value ? '✓' : ''}
              </span>
              {anyIcon && (
                <span className="flex-shrink-0 flex items-center justify-center" style={{ width: 18 }}>
                  {o.icon}
                </span>
              )}
              {o.label}
            </button>
            )
          })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
