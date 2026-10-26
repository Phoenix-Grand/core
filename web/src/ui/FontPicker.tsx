import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Search, Check } from 'lucide-react'
import { CaretDown } from './CaretDown'
import { dedupeFontFamilies } from './fontFamily'

export interface FontPickerProps {
  value: string
  onChange: (font: string) => void
  /** Familles de polices proposées (dédoublonnées et triées par le composant). */
  fonts: readonly string[]
  /** Polices récemment utilisées, épinglées en tête (optionnel). */
  recent?: readonly string[]
  width?: number | string
  height?: number
  fontSize?: number
  disabled?: boolean
  className?: string
  variant?: 'default' | 'ghost'
  /** Text shown (greyed) when `value` is empty - e.g. a mixed-font selection. */
  placeholder?: string
  /** Extra styles merged into the trigger button (e.g. to square joined corners). */
  buttonStyle?: React.CSSProperties
  /** Short glyph sample rendered in each font next to its name. '' hides it. */
  sampleText?: string
  /** Colour scheme - `dark` for dark toolbars/panels. */
  theme?: 'light' | 'dark'
}

// Colour tokens for both schemes. Light maps to the app theme variables; dark is
// a self-contained palette for dark toolbars (paintsharp, etc.).
export interface UITheme {
  text: string; sec: string; ter: string; border: string
  bg: string; hover: string; active: string; sel: string; accent: string
}
export const FONT_UI_THEME: Record<'light' | 'dark', UITheme> = {
  light: {
    text: 'var(--color-text-primary)', sec: 'var(--color-text-secondary)', ter: 'var(--color-text-tertiary)',
    border: 'var(--color-border)', bg: 'var(--color-surface-0)', hover: 'var(--color-surface-1)',
    active: 'var(--color-surface-2)', sel: 'var(--color-primary-light)', accent: 'var(--color-primary)',
  },
  dark: {
    text: '#e8e8e8', sec: '#b4b4b4', ter: '#8e8e8e', border: '#3a3a3a',
    bg: '#2a2a2a', hover: '#363636', active: '#404040', sel: 'rgba(90,155,220,0.22)', accent: '#5a9bdc',
  },
}

interface Pos { top: number; left: number; minWidth: number }

// Famille CSS sûre pour l'aperçu (guillemets + repli) - `Times New Roman` etc.
const cssFamily = (f: string) => `"${f.replace(/"/g, '')}", "Segoe UI", system-ui, sans-serif`

// ── Font classification ──────────────────────────────────────────────────────
// Group fonts by visual family the way pro pickers (Figma / Google Fonts) do.
// Heuristic on the family NAME; unknown fonts fall back to "Sans Serif". Order
// matters: monospace/script/display keywords win over the broad serif test.
type FontCat = 'sans' | 'serif' | 'mono' | 'script' | 'display'
const CAT_ORDER: FontCat[] = ['sans', 'serif', 'mono', 'script', 'display']
const CAT_LABEL: Record<FontCat, string> = {
  sans: 'Sans Serif', serif: 'Serif', mono: 'Monospace', script: 'Manuscrite', display: 'Fantaisie',
}
const RE_MONO = /(mono|consol|courier|menlo|monaco|fixedsys|terminal|source code|fira ?code|jetbrains|inconsolata|space mono|ubuntu mono|cascadia|hack|iosevka|\bcode\b)/i
const RE_SCRIPT = /(script|hand|brush|comic|cursive|calligr|pacifico|dancing|lobster|caveat|satisfy|sacramento|great vibes|shadows into|indie flower|kalam|marck|allura|tangerine|segoe script|bradley|lucida handwriting)/i
const RE_DISPLAY = /(display|impact|bebas|oswald|anton|abril|playbill|stencil|bungee|black ops|fredoka|lilita|luckiest|righteous|permanent marker|creepster|monoton|bangers|poster|headline)/i
const RE_SERIF = /(serif|times|georgia|garamond|book antiqua|palatino|cambria|constantia|didot|bodoni|minion|caslon|merriweather|playfair|lora|crimson|spectral|slab|rockwell|century|sylfaen|cardo|vollkorn)/i
function classifyFont(name: string): FontCat {
  const n = name.toLowerCase()
  if (RE_MONO.test(n)) return 'mono'
  if (RE_SCRIPT.test(n)) return 'script'
  if (RE_DISPLAY.test(n)) return 'display'
  if (/\bsans\b/.test(n)) return 'sans'   // "PT Sans", "Noto Sans"… before the serif test
  if (RE_SERIF.test(n)) return 'serif'
  return 'sans'
}

type Row =
  | { kind: 'header'; label: string }
  | { kind: 'opt'; font: string; i: number }

// Split `text` around the first case-insensitive match of `q`, emphasising it.
function highlightMatch(text: string, q: string): React.ReactNode {
  if (!q) return text
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>{text.slice(i, i + q.length)}</span>
      {text.slice(i + q.length)}
    </>
  )
}

/**
 * Sélecteur de police partagé (`@ui`). Chaque entrée est rendue dans SA police
 * (aperçu) et regroupée par catégorie (Sans Serif / Serif / Monospace / …), façon
 * Figma / Google Fonts. Recherche avec surbrillance, échantillon de glyphes, et
 * accessibilité complète (combobox / listbox / option). Dédoublonne la liste reçue
 * (cf. `dedupeFontFamilies`) - le regroupement des styles (Calibri Bold/Light…)
 * sous une seule famille se fait au CHARGEMENT des polices (cf. `parseFontMeta`).
 */
export function FontPicker({
  value, onChange, fonts, recent = [],
  width = 150, height = 36, fontSize = 13.5,
  disabled = false, className, variant = 'default',
  placeholder = '', buttonStyle, sampleText = 'AaBbCc', theme = 'light',
}: FontPickerProps) {
  const P = FONT_UI_THEME[theme]
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Pos | null>(null)
  const [query, setQuery] = useState('')
  const [hi, setHi] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const all = useMemo(() => dedupeFontFamilies([...recent, ...fonts]), [recent, fonts])
  const recentSet = useMemo(() => new Set(recent.map(r => r.toLowerCase())), [recent])

  // Build the ordered rows (headers + options) and the flat list of selectable
  // fonts (`options`, over which the keyboard highlight `hi` moves).
  const { rows, options } = useMemo(() => {
    const rows: Row[] = []
    const options: string[] = []
    const add = (fonts: string[], label: string | null) => {
      if (!fonts.length) return
      if (label) rows.push({ kind: 'header', label })
      for (const f of fonts) { rows.push({ kind: 'opt', font: f, i: options.length }); options.push(f) }
    }
    const q = query.trim().toLowerCase()
    if (q) {
      // Flat, ranked list while searching (prefix matches first).
      const hits = all.filter(f => f.toLowerCase().includes(q))
      hits.sort((a, b) => (a.toLowerCase().startsWith(q) ? 0 : 1) - (b.toLowerCase().startsWith(q) ? 0 : 1))
      add(hits, null)
    } else {
      const recentFonts = all.filter(f => recentSet.has(f.toLowerCase()))
      add(recentFonts, recentFonts.length ? "Recent" : null)
      const rest = all.filter(f => !recentSet.has(f.toLowerCase()))
      for (const cat of CAT_ORDER) {
        add(rest.filter(f => classifyFont(f) === cat).sort((a, b) => a.localeCompare(b)), CAT_LABEL[cat])
      }
    }
    return { rows, options }
  }, [all, recentSet, query])

  const openMenu = () => {
    if (disabled) return
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: r.left, minWidth: Math.max(248, r.width) })
    setQuery(''); setOpen(o => !o)
  }

  // On open: focus search, highlight the current font and centre it in view.
  useEffect(() => {
    if (!open) return
    const idx = Math.max(0, options.indexOf(value))
    setHi(idx)
    const onDown = (e: MouseEvent) => {
      if (!triggerRef.current?.contains(e.target as Node) && !popupRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    const id = setTimeout(() => {
      searchRef.current?.focus()
      listRef.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)?.scrollIntoView({ block: 'center' })
    }, 0)
    return () => { document.removeEventListener('mousedown', onDown, true); clearTimeout(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Keep the highlighted option in view as the user navigates.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${hi}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [hi, open])

  useLayoutEffect(() => {
    const el = popupRef.current
    if (!el || !open || !pos) return
    const r = el.getBoundingClientRect(), M = 8
    let l = pos.left, t = pos.top
    if (r.right > window.innerWidth - M) l = window.innerWidth - M - r.width
    if (r.bottom > window.innerHeight - M) t = Math.max(M, window.innerHeight - M - r.height)
    if (l < M) l = M
    el.style.left = `${l}px`; el.style.top = `${t}px`
  }, [open, pos, rows.length])

  const choose = (f: string) => { onChange(f); setOpen(false) }
  const onKey = (e: React.KeyboardEvent) => {
    const last = options.length - 1
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(i => Math.min(last, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(i => Math.max(0, i - 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setHi(0) }
    else if (e.key === 'End') { e.preventDefault(); setHi(last) }
    else if (e.key === 'PageDown') { e.preventDefault(); setHi(i => Math.min(last, i + 8)) }
    else if (e.key === 'PageUp') { e.preventDefault(); setHi(i => Math.max(0, i - 8)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (options[hi]) choose(options[hi]) }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
  }

  const ghost = variant === 'ghost'
  const q = query.trim()

  return (
    <div className={`relative ${className ?? ''}`} style={{ width }}>
      <button
        type="button" ref={triggerRef} onClick={openMenu} onMouseDown={e => e.preventDefault()} disabled={disabled}
        role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-label="Police"
        className="w-full flex items-center justify-between gap-1 select-none"
        style={{
          height, padding: '0 6px 0 10px', fontSize, color: P.text,
          // The TRIGGER always reads in the UI face, whatever font is selected - the
          // field's own label must stay legible and consistent, not morph into the
          // picked face (a serif/script value made the field itself hard to read).
          // The dropdown OPTIONS still preview each in their own font (below).
          fontFamily: 'Outfit, var(--font-family-sans, "Segoe UI"), system-ui, sans-serif',
          background: open ? P.active : undefined,
          border: `1px solid ${ghost ? 'transparent' : P.border}`,
          borderRadius: 'var(--radius-md)', cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1, transition: 'background 0.12s, border-color 0.12s',
          ...buttonStyle,
        }}
        onMouseEnter={e => { if (!open && !disabled) (e.currentTarget as HTMLElement).style.background = P.hover }}
        onMouseLeave={e => { if (!open) (e.currentTarget as HTMLElement).style.background = '' }}
        title={value || placeholder}
      >
        {/* Empty value (e.g. mixed-font selection) → show the greyed placeholder. */}
        <span className="truncate flex-1 text-left" style={value ? undefined : { color: P.ter }}>{value || placeholder}</span>
        <CaretDown size={11} color={P.sec} />
      </button>

      {open && pos && createPortal(
        <div
          ref={popupRef}
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, minWidth: pos.minWidth, width: 'max-content', maxWidth: 360,
            zIndex: 9999, background: P.bg, borderRadius: 10,
            border: `1px solid ${P.border}`,
            boxShadow: '0 8px 24px rgba(0,0,0,.16), 0 2px 6px rgba(0,0,0,.10)', overflow: 'hidden',
          }}
        >
          {/* Recherche */}
          <div className="flex items-center gap-2 px-2.5" style={{ height: 40, borderBottom: `1px solid ${P.border}` }}>
            <Search size={15} style={{ color: P.ter, flexShrink: 0 }} />
            <input
              ref={searchRef} value={query} onChange={e => { setQuery(e.target.value); setHi(0) }} onKeyDown={onKey}
              placeholder="Search fonts…" aria-label="Search fonts"
              aria-controls={listId} aria-autocomplete="list"
              className="flex-1 outline-none bg-transparent" style={{ color: P.text, fontSize: 11.5 }}
            />
            {query && (
              <button type="button" onClick={() => { setQuery(''); setHi(0); searchRef.current?.focus() }}
                className="text-xs px-1.5 py-0.5 rounded" style={{ color: P.sec }}
                aria-label="Clear search">Effacer</button>
            )}
          </div>
          {/* Liste */}
          <div ref={listRef} id={listId} role="listbox" aria-activedescendant={options[hi] ? `${listId}-opt-${hi}` : undefined}
            style={{ maxHeight: 340, overflowY: 'auto', padding: '4px 0' }}>
            {options.length === 0 && (
              <div className="px-4 py-6 text-center" style={{ color: P.ter, fontSize: 11.5 }}>

                No fonts for “ {q} »
              </div>
            )}
            {rows.map((row, ri) => row.kind === 'header' ? (
              <div key={`h${ri}`} aria-hidden
                style={{ padding: '8px 12px 4px', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: P.ter, fontFamily: 'var(--font-family-sans)' }}>
                {row.label}
              </div>
            ) : (
              <button
                key={`o${row.i}`} id={`${listId}-opt-${row.i}`} data-idx={row.i}
                type="button" role="option" aria-selected={row.font === value}
                onClick={() => choose(row.font)} onMouseEnter={() => setHi(row.i)}
                className="w-full text-left flex items-center gap-2"
                style={{
                  padding: '7px 10px 7px 12px', color: P.text,
                  background: row.i === hi ? P.sel : row.font === value ? P.hover : undefined,
                }}
              >
                <span style={{ width: 16, flexShrink: 0, color: P.accent, display: 'inline-flex' }}>
                  {row.font === value && <Check size={15} />}
                </span>
                <span className="truncate flex-1" style={{ fontFamily: cssFamily(row.font), fontSize: 15 }}>
                  {highlightMatch(row.font, q)}
                </span>
                {sampleText && (
                  <span className="truncate" style={{ flexShrink: 0, maxWidth: 96, marginLeft: 8, fontFamily: cssFamily(row.font), fontSize: 15, color: P.ter }}>
                    {sampleText}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
