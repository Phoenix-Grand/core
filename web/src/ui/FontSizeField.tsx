import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CaretDown } from './CaretDown'
import { FontPicker, FONT_UI_THEME } from './FontPicker'

export interface FontSizeFieldProps {
  /** Current font family - empty string renders blank (mixed/undetermined selection). */
  font: string
  onFontChange: (font: string) => void
  fonts: readonly string[]
  recentFonts?: readonly string[]
  /** Current font size as a string - empty string renders blank (mixed selection). */
  size: string
  onSizeChange: (size: string) => void
  /** Preset sizes offered in the size dropdown. */
  sizes: readonly (number | string)[]
  /** Min/max accepted when typing a custom size. */
  minSize?: number
  maxSize?: number
  /** Shared height of both selectors (px). */
  height?: number
  fontWidth?: number
  sizeWidth?: number
  fontSize?: number
  disabled?: boolean
  className?: string
  /** Colour scheme - `dark` for dark toolbars/panels. */
  theme?: 'light' | 'dark'
}

const R = 'var(--radius-md)'

// ── Editable size combobox: type any value, or pick a preset ─────────────────
function SizeCombo({
  value, onChange, sizes, min, max, width, height, fontSize, disabled, boxStyle, theme = 'light',
}: {
  value: string
  onChange: (v: string) => void
  sizes: readonly (number | string)[]
  min: number
  max: number
  width: number
  height: number
  fontSize: number
  disabled: boolean
  boxStyle: React.CSSProperties
  theme?: 'light' | 'dark'
}) {
  const P = FONT_UI_THEME[theme]
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const [text, setText] = useState(value)
  const [focused, setFocused] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // Mirror the external value unless the user is mid-edit.
  useEffect(() => { if (!focused) setText(value) }, [value, focused])

  const commit = (raw: string) => {
    const s = raw.trim()
    if (s === '') { setText(value); return }          // empty → revert (keeps mixed state)
    const n = Math.round(parseFloat(s.replace(',', '.')))
    if (!Number.isFinite(n)) { setText(value); return }
    onChange(String(Math.max(min, Math.min(max, n))))
  }
  const step = (d: number) => {
    const base = parseInt(text || value || '0', 10) || 0
    const n = Math.max(min, Math.min(max, base + d))
    onChange(String(n)); setText(String(n))
  }
  const openList = () => {
    if (disabled) return
    const r = wrapRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: r.left, width: r.width })
    setOpen(o => !o)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open])

  useLayoutEffect(() => {
    const el = popRef.current
    if (!el || !open || !pos) return
    const r = el.getBoundingClientRect(), M = 8
    let l = pos.left, t = pos.top
    if (r.bottom > window.innerHeight - M) t = Math.max(M, pos.top - r.height - height - 8)
    if (r.right > window.innerWidth - M) l = window.innerWidth - M - r.width
    el.style.left = `${l}px`; el.style.top = `${t}px`
  }, [open, pos, height])

  return (
    <div ref={wrapRef} className="relative" style={{ width }}>
      <div className="flex items-center select-none"
        style={{
          height, background: open ? P.active : undefined,
          border: `1px solid ${P.border}`, cursor: disabled ? 'not-allowed' : 'text',
          opacity: disabled ? 0.5 : 1, transition: 'background 0.12s', ...boxStyle,
        }}
        onMouseEnter={e => { if (!open && !disabled) (e.currentTarget as HTMLElement).style.background = P.hover }}
        onMouseLeave={e => { if (!open) (e.currentTarget as HTMLElement).style.background = '' }}
      >
        <input
          ref={inputRef} value={text} disabled={disabled} inputMode="numeric"
          onChange={e => setText(e.target.value)}
          onFocus={() => { setFocused(true); inputRef.current?.select() }}
          onBlur={() => { setFocused(false); commit(text) }}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commit(text); inputRef.current?.blur() }
            else if (e.key === 'ArrowUp') { e.preventDefault(); step(1) }
            else if (e.key === 'ArrowDown') { e.preventDefault(); step(-1) }
            else if (e.key === 'Escape') { e.preventDefault(); setText(value); inputRef.current?.blur() }
          }}
          className="min-w-0 flex-1 outline-none bg-transparent text-left"
          style={{ height: '100%', padding: '0 2px 0 8px', fontSize, color: P.text, fontFamily: 'var(--font-family-sans)' }}
          aria-label="Font size"
        />
        <button type="button" tabIndex={-1} disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={openList}
          aria-label="Choose a size" aria-haspopup="listbox" aria-expanded={open}
          className="flex items-center justify-center" style={{ width: 18, height: '100%', flexShrink: 0, cursor: disabled ? 'not-allowed' : 'pointer' }}>
          <CaretDown size={10} color={P.sec} />
        </button>
      </div>

      {open && pos && createPortal(
        <div ref={popRef} role="listbox" onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, minWidth: Math.max(56, pos.width),
            maxHeight: 280, overflowY: 'auto', zIndex: 9999, padding: '4px 0',
            background: P.bg, border: `1px solid ${P.border}`, borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,.16), 0 2px 6px rgba(0,0,0,.10)',
          }}>
          {sizes.map(s => {
            const sv = String(s)
            const sel = sv === value
            return (
              <button key={sv} type="button" role="option" aria-selected={sel}
                onClick={() => { onChange(sv); setText(sv); setOpen(false) }}
                className="w-full text-left"
                style={{
                  padding: '5px 12px', fontSize, color: P.text,
                  fontWeight: sel ? 600 : undefined,
                  background: sel ? P.sel : undefined,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = sel ? P.sel : P.hover }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = sel ? P.sel : '' }}>
                {sv}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}

/**
 * Unified font-family + font-size selector (`@ui`). The two selectors share a
 * single height and are glued horizontally: the joined edge is squared (only the
 * outer corners stay rounded) and the middle borders overlap into one divider
 * line. The font side groups by category with previews; the size side is an
 * editable combobox (type any value or pick a preset). Both accept an empty
 * value to render blank on a mixed selection (Word).
 */
export function FontSizeField({
  font, onFontChange, fonts, recentFonts,
  size, onSizeChange, sizes,
  minSize = 1, maxSize = 999,
  height = 30, fontWidth = 150, sizeWidth = 62, fontSize = 13.5,
  disabled = false, className, theme = 'light',
}: FontSizeFieldProps) {
  return (
    <div className={`flex items-stretch ${className ?? ''}`}>
      <FontPicker
        value={font} onChange={onFontChange} fonts={fonts} recent={recentFonts}
        width={fontWidth} height={height} fontSize={fontSize} disabled={disabled}
        placeholder="" theme={theme}
        // Square the right (joined) corners, keep the left ones rounded.
        buttonStyle={{ borderRadius: 0, borderTopLeftRadius: R, borderBottomLeftRadius: R }}
      />
      {/* -1px collapses the two adjacent borders into a single divider line. */}
      <div style={{ marginLeft: -1 }}>
        <SizeCombo
          value={size} onChange={onSizeChange} sizes={sizes} min={minSize} max={maxSize}
          width={sizeWidth} height={height} fontSize={fontSize} disabled={disabled} theme={theme}
          // Square the left (joined) corners, keep the right ones rounded.
          boxStyle={{ borderRadius: 0, borderTopRightRadius: R, borderBottomRightRadius: R }}
        />
      </div>
    </div>
  )
}
