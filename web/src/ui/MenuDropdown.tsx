import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MENU_ATTR, useMenuDismiss } from './useMenuDismiss'

/** True on touch devices (no precise pointer) → render menus as bottom sheets. */
function useCoarsePointer(): boolean {
  const [c, setC] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)')
    const on = () => setC(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return c
}

export type MenuItem =
  | { type: 'action'; label: string; shortcut?: string; disabled?: boolean; checked?: boolean; danger?: boolean; icon?: React.ReactNode; onClick: () => void }
  | { type: 'separator' }
  | { type: 'label'; text: string }
  | { type: 'submenu'; label: string; icon?: React.ReactNode; disabled?: boolean; items: MenuItem[] }
  | { type: 'custom'; render: (close: () => void) => React.ReactNode }

export interface MenuDropdownPos { top: number; left: number; minWidth?: number }

export type MenuTheme = 'light' | 'dark'

interface MenuPalette {
  bg: string; text: string; sep: string; label: string
  hover: string; hoverText: string; accent: string; shortcut: string; danger: string
  border: string; shadow: string
  /** Bottom sheet (touch): opaque - it has no backdrop-filter, only a dim scrim. */
  sheetBg: string
}

/* Translucent menu surfaces: the panel lets the content underneath show through,
 * blurred and saturated (see ./backdrop). `bg` must therefore stay partially
 * transparent - an opaque colour would silently disable the effect. */

const PALETTES: Record<MenuTheme, MenuPalette> = {
  light: {
    bg: 'var(--kb-float-surface)', text: '#202124', sep: 'var(--kb-black-12)', label: '#5f6368',
    hover: '#1a73e8', hoverText: '#fff', accent: '#1a73e8', shortcut: '#5f6368', danger: '#d93025',
    border: 'var(--kb-float-border)', sheetBg: '#fff',
    shadow: 'var(--kb-float-highlight), var(--kb-shadow-float)',
  },
  dark: {
    // Aligné sur le thème forge C (éditeurs WebGL paintsharp).
    bg: 'var(--kb-float-surface-dark)', text: '#d6d6d6', sep: 'var(--kb-white-12)', label: '#8e8e8e',
    hover: '#5a9bdc', hoverText: '#fff', accent: '#5a9bdc', shortcut: '#8e8e8e', danger: '#e84a4a',
    border: 'var(--kb-float-border-dark)', sheetBg: '#323232',
    shadow: 'var(--kb-float-highlight-dark), var(--kb-shadow-float-dark)',
  },
}

interface MenuDropdownProps {
  items: MenuItem[]
  pos: MenuDropdownPos
  onClose: () => void
  /** Override minWidth (pos.minWidth takes precedence if set) */
  minWidth?: number
  /** Palette : 'light' (défaut) ou 'dark' (éditeurs sombres) */
  theme?: MenuTheme
}

export function MenuDropdown({ items, pos, onClose, minWidth: minWidthProp = 200, theme = 'light' }: MenuDropdownProps) {
  const minWidth = pos.minWidth ?? minWidthProp
  const c = PALETTES[theme]
  const ref = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isCoarse = useCoarsePointer()
  // Bottom-sheet submenu drill-in (touch has no hover-cascade).
  const [drill, setDrill] = useState<{ label: string; items: MenuItem[] } | null>(null)
  // Highlight is an accent-filled pill: icon and shortcut must recolour with the
  // row, so the hovered row is tracked in state rather than mutated in the DOM.
  const [hovered, setHovered] = useState<number | null>(null)

  // Clic extérieur : le test porte sur `[data-kb-menu]` et non sur `ref.contains`, sinon
  // un clic dans un sous-menu - porté dans `document.body` - fermerait le menu parent.
  useEffect(() => {
    const handler = (e: Event) => {
      const t = e.target
      const el = t instanceof Element ? t : (t as Node | null)?.parentElement ?? null
      if (!el?.closest(`[${MENU_ATTR}]`)) onClose()
    }
    // `pointerdown`, pas `mousedown` : un déclencheur Radix appelle `preventDefault()`
    // sur pointerdown, ce qui SUPPRIME le mousedown de compatibilité - le menu ouvert
    // ne voyait alors jamais le clic et restait affiché. Capture pour passer devant
    // tout composant qui stoppe la propagation.
    document.addEventListener('pointerdown', handler, true)
    return () => document.removeEventListener('pointerdown', handler, true)
  }, [onClose])

  useMenuDismiss(true, onClose)

  // Garde le menu TOUJOURS entièrement visible : on le ramène à l'intérieur du
  // viewport s'il déborde, et on borne sa hauteur (défilement interne) s'il est
  // plus grand que l'écran. Ré-appliqué au redimensionnement de la fenêtre.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || isCoarse) return // bottom sheet uses CSS positioning, no clamp
    const M = 8 // marge minimale avec le bord du viewport
    const clamp = () => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      // Borne la hauteur (et la largeur) pour un menu plus grand que l'écran :
      // il défile à l'intérieur plutôt que de déborder hors de la zone visible.
      // Le défilement est porté par la couche de contenu, pas par le panneau : celui-ci
      // doit rester sans rognage, sinon la couche floutée débordante serait tronquée.
      if (scrollRef.current) scrollRef.current.style.maxHeight = `${vh - 2 * M - 2}px`
      el.style.maxWidth  = `${vw - 2 * M}px`
      // Repart de l'ancre demandée avant de mesurer → re-clamp idempotent.
      el.style.left = `${pos.left}px`
      el.style.top  = `${pos.top}px`
      const r = el.getBoundingClientRect()
      let l = pos.left
      let t = pos.top
      if (l + r.width  > vw - M) l = vw - M - r.width
      if (t + r.height > vh - M) t = vh - M - r.height
      if (l < M) l = M
      if (t < M) t = M
      el.style.left = `${l}px`
      el.style.top  = `${t}px`
    }
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [pos, isCoarse])

  // ── Bottom sheet (touch) ─────────────────────────────────────────────────────
  if (isCoarse) {
    const shown = drill ? drill.items : items
    const rowBase: React.CSSProperties = {
      padding: '13px 20px', fontSize: 15, lineHeight: '22px', minHeight: 50,
      display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
    }
    return createPortal(
      <>
        <div className="fixed inset-0 z-[9998]" style={{ background: 'rgba(0,0,0,0.35)' }} onClick={onClose} />
        <div
          ref={ref}
          onMouseDown={e => e.stopPropagation()}
          {...{ [MENU_ATTR]: '' }}
          className="fixed left-0 right-0 bottom-0 z-[9999]"
          style={{
            background: c.sheetBg, color: c.text,
            borderTopLeftRadius: 16, borderTopRightRadius: 16,
            maxHeight: '78vh', overflowY: 'auto',
            paddingBottom: 'calc(8px + env(safe-area-inset-bottom))',
            boxShadow: '0 -8px 30px rgba(0,0,0,0.28)',
            animation: 'kbnSheetUp 0.18s ease-out',
          }}
        >
          <style>{'@keyframes kbnSheetUp{from{transform:translateY(100%)}to{transform:translateY(0)}}'}</style>
          {/* Grab handle */}
          <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 2px' }}>
            <div style={{ width: 38, height: 4, borderRadius: 2, background: c.sep }} />
          </div>

          {/* Back row when drilled into a submenu */}
          {drill && (
            <button onClick={() => setDrill(null)} style={{ ...rowBase, color: c.text, fontWeight: 600, borderBottom: `1px solid ${c.sep}` }}>
              <span style={{ width: 20, flexShrink: 0, color: c.accent, fontSize: 18, display: 'inline-flex', alignItems: 'center' }}>‹</span>
              <span style={{ flex: 1 }}>{drill.label}</span>
            </button>
          )}

          {shown.map((item, i) => {
            if (item.type === 'separator') return <div key={i} style={{ background: c.sep, height: 1, margin: '4px 0' }} />
            if (item.type === 'label') return (
              <div key={i} style={{ padding: '8px 20px 4px', fontSize: 'var(--kb-text-body)', color: c.label, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{item.text}</div>
            )
            if (item.type === 'custom') return <React.Fragment key={i}>{item.render(onClose)}</React.Fragment>
            if (item.type === 'submenu') return (
              <button key={i} disabled={item.disabled} onClick={() => setDrill({ label: item.label, items: item.items })}
                style={{ ...rowBase, color: c.text, opacity: item.disabled ? 0.4 : 1 }}>
                <span style={{ width: 20, flexShrink: 0, color: c.accent, fontSize: 16, display: 'inline-flex', alignItems: 'center' }}>{item.icon ?? ''}</span>
                <span style={{ flex: 1 }}>{item.label}</span>
                <span style={{ color: c.label, fontSize: 16, flexShrink: 0 }}>›</span>
              </button>
            )
            const fg = item.danger ? c.danger : c.text
            return (
              <button key={i} disabled={item.disabled} onClick={() => { item.onClick(); onClose() }}
                style={{ ...rowBase, color: fg, opacity: item.disabled ? 0.4 : 1 }}>
                <span style={{ width: 20, flexShrink: 0, color: item.danger ? c.danger : c.accent, fontSize: 16, display: 'inline-flex', alignItems: 'center' }}>
                  {item.checked ? '✓' : item.icon ? item.icon : ''}
                </span>
                <span style={{ flex: 1 }}>{item.label}</span>
              </button>
            )
          })}
        </div>
      </>,
      document.body,
    )
  }

  return createPortal(
    <div
      ref={ref}
      onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
      {...{ [MENU_ATTR]: '' }}
      className={theme === 'dark' ? 'kb-frosted kb-frosted-dark' : 'kb-frosted'}
      style={{ position: 'fixed', top: pos.top, left: pos.left, minWidth, zIndex: 9999 }}
    >
      <div className="kb-frost-layer" aria-hidden />
      <div
        ref={scrollRef}
        // Side padding forms the gutter the highlight pill is inset by.
        // GRID: icon | label | shortcut, shared by every row through `subgrid`
        // below, so shortcuts line up in their OWN column across the whole menu
        // (native-menu behaviour) instead of trailing each label.
        style={{
          padding: 5, overflowY: 'auto', overflowX: 'hidden',
          display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignContent: 'start',
        }}
      >
      {items.map((item, i) => {
        if (item.type === 'separator') {
          return <div key={i} style={{ gridColumn: '1 / -1', background: c.sep, height: 1, margin: '5px 6px' }} />
        }
        if (item.type === 'label') {
          return (
            <div
              key={i}
              style={{ gridColumn: '1 / -1', padding: '4px 10px', fontSize: 'var(--kb-text-meta)', color: c.label, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}
            >
              {item.text}
            </div>
          )
        }
        if (item.type === 'submenu') {
          return <SubmenuItem key={i} item={item} onClose={onClose} theme={theme}
                                index={i} hovered={hovered} setHovered={setHovered} />
        }
        if (item.type === 'custom') {
          return <div key={i} style={{ gridColumn: '1 / -1' }}>{item.render(onClose)}</div>
        }
        const on = hovered === i && !item.disabled
        const fg = on ? c.hoverText : item.danger ? c.danger : c.text
        return (
          <button
            key={i}
            disabled={item.disabled}
            onClick={() => { item.onClick(); onClose() }}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(h => (h === i ? null : h))}
            className="w-full text-left disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              // `subgrid` → this row reuses the MENU's columns, so every icon,
              // label and shortcut aligns with the other rows'.
              display: 'grid', gridColumn: '1 / -1', gridTemplateColumns: 'subgrid',
              alignItems: 'center', columnGap: 8,
              padding: '5px 12px 5px 10px', fontSize: 'var(--kb-text-body)', color: fg, lineHeight: '20px',
              borderRadius: 6, background: on ? c.hover : 'transparent',
            }}
          >
            <span style={{ width: 20, flexShrink: 0, color: on ? c.hoverText : item.danger ? c.danger : c.accent, fontSize: 14, display: 'inline-flex', alignItems: 'center' }}>
              {item.checked ? '✓' : item.icon ? item.icon : ''}
            </span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
            {/* Third column: left-aligned so the shortcuts read as a clean column
                (the column itself is `auto`, i.e. as wide as the longest one).
                Always rendered - an empty cell keeps the columns in step. */}
            <span style={{ color: on ? c.hoverText : c.shortcut, fontSize: 'var(--kb-text-body)', textAlign: 'left', paddingLeft: 16, opacity: on ? 0.85 : 1 }}>
              {item.shortcut ?? ''}
            </span>
          </button>
        )
      })}
      </div>
    </div>,
    document.body,
  )
}

/** Élément de menu ouvrant un sous-menu en cascade vers la droite (au survol). */
function SubmenuItem({ item, onClose, theme, index, hovered, setHovered }: {
  item: Extract<MenuItem, { type: 'submenu' }>
  onClose: () => void
  theme: MenuTheme
  index: number
  hovered: number | null
  setHovered: React.Dispatch<React.SetStateAction<number | null>>
}) {
  const [pos, setPos] = React.useState<MenuDropdownPos | null>(null)
  const c = PALETTES[theme]
  const btnRef   = useRef<HTMLButtonElement>(null)
  const closeTmr = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const openNow = () => {
    if (closeTmr.current) clearTimeout(closeTmr.current)
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const SUB_W = 220
    // Ouverture en cascade vers la droite par défaut ; on bascule à GAUCHE du
    // parent si la droite déborde du viewport (et qu'il y a la place à gauche),
    // pour ne pas recouvrir le menu parent. Le clamp final affine la position.
    const openLeft = r.right + SUB_W > window.innerWidth - 8 && r.left - SUB_W > 8
    const left = openLeft ? r.left - SUB_W + 2 : r.right - 2
    setPos({ top: r.top - 4, left, minWidth: SUB_W })
  }
  const scheduleClose = () => {
    if (closeTmr.current) clearTimeout(closeTmr.current)
    closeTmr.current = setTimeout(() => setPos(null), 180)
  }

  // Le panneau du sous-menu s'attarde 180 ms pour laisser traverser en diagonale, mais la
  // SURBRILLANCE ne doit pas s'attarder avec lui : sinon, en passant à une ligne voisine,
  // deux lignes restaient allumées en même temps. Elle suit donc le pointeur, sauf quand
  // celui-ci est entré dans le sous-menu - auquel cas aucune ligne du parent n'est
  // survolée et on garde la ligne d'origine allumée, comme le fait macOS.
  const on = hovered === index || (pos !== null && hovered === null)

  return (
    <div
      onMouseEnter={() => { setHovered(index); openNow() }}
      onMouseLeave={() => { setHovered(h => (h === index ? null : h)); scheduleClose() }}
      // The wrapper exists to anchor the child panel; it must still relay the
      // menu's columns to its button, hence subgrid on two levels.
      style={{
        position: 'relative', display: 'grid', gridColumn: '1 / -1',
        gridTemplateColumns: 'subgrid',
      }}
    >
      <button
        ref={btnRef}
        disabled={item.disabled}
        className="w-full text-left disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          display: 'grid', gridColumn: '1 / -1', gridTemplateColumns: 'subgrid',
          alignItems: 'center', columnGap: 8,
          padding: '5px 12px 5px 10px', fontSize: 'var(--kb-text-body)', color: on ? c.hoverText : c.text, lineHeight: '20px',
          borderRadius: 6, background: on ? c.hover : 'transparent',
        }}
      >
        <span style={{ width: 20, flexShrink: 0, color: on ? c.hoverText : c.accent, fontSize: 14, display: 'inline-flex', alignItems: 'center' }}>{item.icon ?? ''}</span>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
        {/* The caret sits in the SHORTCUT column: a submenu has no shortcut, and
            the two never coexist - so the arrow lines up with the shortcuts. */}
        <span style={{ color: on ? c.hoverText : c.label, fontSize: 'var(--kb-text-body)', textAlign: 'right', paddingLeft: 16 }}>▸</span>
      </button>
      {pos && (
        <div onMouseEnter={openNow} onMouseLeave={scheduleClose}>
          <MenuDropdown items={item.items} pos={pos} onClose={onClose} theme={theme} />
        </div>
      )}
    </div>
  )
}

/** Hook to manage open/closed state + positioning for a MenuDropdown trigger */
export function useMenuDropdown() {
  const [pos, setPos] = React.useState<MenuDropdownPos | null>(null)

  // Opens the menu below the triggering element (button) or, for a right-click
  // (contextmenu) event, exactly at the cursor coordinates.
  const open = (e: React.MouseEvent | React.MouseEvent<HTMLElement>) => {
    if (e.type === 'contextmenu') {
      setPos({ top: e.clientY, left: e.clientX })
      return
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPos({ top: r.bottom + 2, left: r.left })
  }

  // Opens the menu at explicit viewport coordinates (e.g. a right-click position).
  const openAt = (x: number, y: number) => setPos({ top: y, left: x })

  const close = () => setPos(null)

  return { pos, open, openAt, close, isOpen: pos !== null }
}
