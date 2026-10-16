// <Ribbon> - MS Office style ribbon, shared by all the modules' sub-editors.
// Data-driven rendering from `RibbonTab[]`: tab strip (+ contextual tabs on the
// right with a coloured edge) then, for the active tab, a row of GROUPS (box
// + label at the bottom, separated by rules). Small items are stacked in columns
// of 3 (like Office); big buttons take the full height of the group.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Dropdown } from '../Dropdown'
import { MenuDropdown } from '../MenuDropdown'
import { useIsMobile } from '../interaction'
import type { MenuItem, MenuDropdownPos } from '../MenuDropdown'
import type { RibbonTheme } from './types'
import type { RibbonTab, RibbonGroup, RibbonItem } from './types'

const TAB_H        = 30   // height of the tab strip
const CONTENT_H    = 84   // height of the groups area (items + label)
const MOBILE_BAR_H = 48   // height of the mobile command bar (at the bottom)

// Ribbon tab strip, extracted so it can be rendered either INLINE above the
// groups (historical default) or IN THE TOPBAR of the WorkspaceShell (`inTopbar`:
// tabs aligned at the bottom, transparent background - the topbar already has the strip colour).
// Once moved into the topbar the dedicated row disappears → 30px of height gained, and the
// search mode (opaque overlay on the topbar) hides the tabs without shifting anything.
export function RibbonTabStrip({ tabs, theme, activeId, onSelect, tabStripActions, inTopbar = false, height, collapsed = false, onToggleCollapsed, expandLabel = 'Développer le ruban (Ctrl+F1)', collapseLabel = 'Réduire le ruban (Ctrl+F1)' }: {
  tabs: RibbonTab[]
  theme: RibbonTheme
  activeId?: string
  onSelect: (id: string) => void
  // Block of actions (Save/Undo/Redo/star/trash) inserted right after the
  // "File" tab (or at the start if there is no File tab).
  tabStripActions?: ReactNode
  inTopbar?: boolean
  height?: number          // explicit height in topbar mode (= topbarHeight)
  // Ribbon collapse button: rendered AT THE END of the tab strip (hence ALWAYS
  // visible, including when collapsed - no more "thin bar" under the tabs).
  collapsed?: boolean
  onToggleCollapsed?: () => void
  /** Tooltip of the collapse button when the ribbon is collapsed / expanded (the host passes translated text). */
  expandLabel?: string
  collapseLabel?: string
}) {
  const visibleTabs = tabs.filter(t => t.visible !== false)
  const colored = !!theme.topbarText
  const stripBg = colored ? (theme.topbarBg ?? theme.accent) : theme.header
  const tabInactive = colored ? (theme.topbarText ?? '#ffffff') : theme.textDim
  const fileTab = visibleTabs.find(t => t.backstage != null)
  // nullish activeId (ribbon collapsed WITHOUT peek) → no active tab (Office style).
  const cur = activeId != null ? visibleTabs.find(t => t.id === activeId) : undefined
  const tabH = colored ? 'h-[26px]' : (inTopbar ? 'h-[30px]' : 'h-full')
  return (
    <div data-ribbon-tabs className={`flex items-end gap-0.5 ${inTopbar ? '' : 'px-2'}`}
         style={inTopbar ? { height: height ?? '100%' } : { height: TAB_H, background: stripBg }}>
      {/* No "File" tab → the actions block opens the strip. */}
      {!fileTab && tabStripActions && (
        <div className="flex items-center gap-0.5 self-center mr-1">{tabStripActions}</div>
      )}
      {visibleTabs.map(tab => {
        const isActive = tab.id === cur?.id
        const ctx = tab.contextual
        const isFile = tab === fileTab
        // File tab: solid accent-colour pill (Office style). The actions block
        // (Save/Undo/…/trash) is inserted RIGHT AFTER it.
        if (isFile) {
          return (
            <Fragment key={tab.id}>
              <button onClick={() => onSelect(tab.id)}
                className={`relative px-3.5 text-[14px] font-semibold ${tabH} rounded-t`}
                style={{ color: 'var(--kbn-office-file-accent-text, #fff)', background: `var(--kbn-office-file-accent, ${theme.fileAccent ?? theme.accent})`, borderTopLeftRadius: 5, borderTopRightRadius: 5 }}
                onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(1.1)' }}
                onMouseLeave={e => { e.currentTarget.style.filter = 'none' }}>
                {tab.label}
              </button>
              {tabStripActions && (
                <div className="flex items-center gap-0.5 self-center mx-1">{tabStripActions}</div>
              )}
            </Fragment>
          )
        }
        return (
          <button key={tab.id} onClick={() => onSelect(tab.id)}
            className={`relative px-3.5 text-[14px] font-medium ${colored ? 'h-[26px]' : (inTopbar ? 'h-[30px] rounded-t' : 'h-full rounded-t')}`}
            style={{
              color: isActive ? `var(--kbn-office-tab-active-text, ${theme.accent})` : tabInactive,
              background: isActive ? theme.bg : 'transparent',
              borderTopLeftRadius: 5,
              borderTopRightRadius: 5,
              borderTop: ctx ? `2px solid ${ctx.accent}` : undefined,
            }}
            onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = colored ? 'var(--kbn-office-strip-hover, rgba(255,255,255,0.16))' : (theme.dark ? 'rgba(255,255,255,0.08)' : 'var(--kbn-ws-hover, #f1f3f4)') }}
            onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}>
            {ctx && <span style={{ color: isActive ? ctx.accent : tabInactive, marginRight: 4, fontSize: 9 }}>●</span>}
            {tab.label}
            {!colored && isActive && <span style={{ position: 'absolute', left: 6, right: 6, bottom: 0, height: 2, background: theme.accent, borderRadius: 2 }} />}
          </button>
        )
      })}
      {/* Ribbon collapse button, ALWAYS visible at the end of the tab strip.
          Aligned to the BOTTOM (almost level with the tabs) rather than centred. */}
      {onToggleCollapsed && (
        <div className="self-end mb-0.5 ml-1 flex-shrink-0">
          <RibbonCollapseButton
            collapsed={collapsed} onToggle={onToggleCollapsed} colored={colored}
            label={collapsed
              ? expandLabel
              : collapseLabel} />
        </div>
      )}
    </div>
  )
}

// Ribbon collapse/expand button (MS Office style). UP chevron = collapse
// (the ribbon folds upwards); DOWN chevron = expand. Tooltip mandatory.
// `colored`: placed on the COLOURED tab strip (topbar) → light text.
function RibbonCollapseButton({ collapsed = false, onToggle, label, colored = false }: {
  collapsed?: boolean
  onToggle: () => void
  label: string
  colored?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
      className={`h-6 w-6 rounded flex items-center justify-center transition-colors ${colored ? 'text-white/70 hover:bg-white/15 hover:text-white' : 'text-text-tertiary hover:bg-black/5 hover:text-text-primary'}`}
    >
      {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
    </button>
  )
}

export function Ribbon({ tabs, theme, activeTabId, onTabChange, tabStripActions, hideTabs = false, collapsed = false, peeking = false, onClosePeek }: {
  tabs: RibbonTab[]
  theme: RibbonTheme
  activeTabId?: string
  onTabChange?: (id: string) => void
  // Block of actions (Save/Undo/Redo/star/trash) inserted IN the
  // tab strip, right after the "File" tab (desktop only).
  tabStripActions?: ReactNode
  // The tab strip is rendered ELSEWHERE (in the topbar, via RibbonTabStrip):
  // the ribbon only renders the groups row (+ backstage).
  hideTabs?: boolean
  // Ribbon collapse (state driven by OfficeShell, which also owns the tabs):
  // `collapsed` = folded (groups row hidden, ribbon = 0px); `peeking` = a tab
  // is temporarily shown as a floating flyout while the ribbon is folded. The collapse BUTTON
  // is NOT here: it lives in the tab strip (RibbonTabStrip, topbar).
  collapsed?: boolean
  peeking?: boolean
  onClosePeek?: () => void
}) {
  const visibleTabs = tabs.filter(t => t.visible !== false)
  const [internalActive, setInternalActive] = useState<string>(visibleTabs[0]?.id ?? '')
  const active = activeTabId ?? internalActive
  const setActive = (id: string) => { onTabChange?.(id); if (activeTabId === undefined) setInternalActive(id) }

  // Auto-switch to a contextual tab that JUST appeared (object selection),
  // and fall back to the 1st tab if the active tab disappears.
  const prevCtxRef = useRef<string[]>([])
  useEffect(() => {
    const ctxNow = visibleTabs.filter(t => t.contextual).map(t => t.id)
    const fresh = ctxNow.find(id => !prevCtxRef.current.includes(id))
    prevCtxRef.current = ctxNow
    if (fresh) { setActive(fresh); return }
    // Fall back if the active tab disappears: pick the 1st NORMAL tab (never
    // the "File"/backstage tab, otherwise deselecting an object would open the
    // backstage unexpectedly).
    if (!visibleTabs.some(t => t.id === active)) {
      const firstNormal = visibleTabs.find(t => t.backstage == null) ?? visibleTabs[0]
      if (firstNormal) setActive(firstNormal.id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTabs.map(t => t.id).join('|')])

  const cur = visibleTabs.find(t => t.id === active) ?? visibleTabs[0]

  // ── "File" tab (Office-style backstage) ─────────────────────────────────────────
  // Detected by a non-empty `backstage`. When active, this content is rendered as a full-module
  // OVERLAY (measured on the ribbon root → covers ribbon + editing area, keeps
  // the WorkspaceShell header above). Styled with the app accent.
  const backstageActive = cur?.backstage != null
  const isMobile = useIsMobile()

  // ── Ribbon collapse (MS Office style) ───────────────────────────────────────────
  // The state (collapsed / peek) is driven by OfficeShell; the BUTTON lives in the tab
  // strip (topbar). Here: rendering + closing the peek flyout when focus leaves.
  // Peek (ribbon collapsed + tab clicked): the flyout closes as soon as an action happens
  // OUTSIDE the ribbon and OUTSIDE the tab strip (click in the document, Escape).
  const peekRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!peeking) return
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node
      if (peekRef.current?.contains(node)) return
      if ((node as Element).closest?.('[data-ribbon-tabs]')) return
      onClosePeek?.()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClosePeek?.() }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey) }
  }, [peeking, onClosePeek])

  const rootRef = useRef<HTMLDivElement>(null)
  const [bsBox, setBsBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    if (!backstageActive) { setBsBox(null); return }
    // The backstage covers the area BELOW the tab strip (which stays visible, Office
    // style) down to the bottom of the module; width = ribbon (not the viewport, otherwise it
    // overflows onto the right rail). Synced via rAF: CONTINUOUSLY follows the ribbon
    // position (animated side panel collapse/expand, resize…); only re-renders if the
    // box really changes (otherwise React bails out). On mobile the tab strip
    // does not exist (bottom bar): the backstage starts at the top of the ribbon. Same when the
    // strip is rendered elsewhere (topbar, `hideTabs`).
    const topOffset = (isMobile || hideTabs) ? 0 : TAB_H
    let raf = 0
    const tick = () => {
      const r = rootRef.current?.getBoundingClientRect()
      if (r) {
        const next = { top: r.top + topOffset, left: r.left, width: r.width, height: window.innerHeight - (r.top + topOffset) }
        setBsBox(prev => (prev && prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.height === next.height) ? prev : next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [backstageActive, isMobile, hideTabs])

  // While the File (backstage) tab is open, mark <html> so the global rule hides
  // every `.kb-collab-indicator` (remote pointers/carets). The backstage overlay
  // owns the module area then; foreign cursors drawn above it must not float over
  // the File screen. Attribute (not a prop) so it reaches indicators wherever they
  // are rendered, in any sub-editor, without threading state through each one.
  useEffect(() => {
    const root = document.documentElement
    if (backstageActive) root.setAttribute('data-kb-backstage', 'true')
    else root.removeAttribute('data-kb-backstage')
    return () => root.removeAttribute('data-kb-backstage')
  }, [backstageActive])

  // ── MOBILE version: command bar at the BOTTOM + bottom-sheet palette ──────────
  // (the desktop ribbon - tab strip + groups row - is not rendered).
  // Empty `tabs` (e.g. documents READ mode) → no bar: full screen.
  if (isMobile) {
    return (
      <div ref={rootRef} style={{ flexShrink: 0, userSelect: 'none' }}>
        {visibleTabs.length > 0 && <MobileRibbon tabs={visibleTabs} cur={cur} setActive={setActive} theme={theme} />}
        {backstageActive && bsBox != null && createPortal(
          <div style={{ position: 'fixed', top: bsBox.top, left: bsBox.left, width: bsBox.width, height: bsBox.height, zIndex: 40, background: theme.bg, overflow: 'auto' }}>
            {cur?.backstage}
          </div>,
          document.body,
        )}
      </div>
    )
  }

  return (
    <div ref={rootRef} style={{ flexShrink: 0, userSelect: 'none' }}>
      {/* Tab strip (hidden if rendered elsewhere - in the topbar) */}
      {!hideTabs && (
        <RibbonTabStrip tabs={visibleTabs} theme={theme} activeId={cur?.id} onSelect={setActive} tabStripActions={tabStripActions} />
      )}

      {/* Groups row of the active tab (empty for the File tab: its
          content is rendered as an overlay under the tab strip, which stays visible).
          Responsive collapse: when the row overflows, the RIGHTMOST groups fold
          one by one into big dropdown buttons (see RibbonGroupsRow). */}
      {collapsed ? (
        // Collapsed + tab clicked → PEEK: the groups row is shown as a FLOATING FLYOUT
        // (over the content, without pushing it), and closes on the 1st click outside the
        // ribbon / tabs. Collapsed WITHOUT peek → NOTHING (ribbon = 0px, no bar).
        peeking ? (
          <div className="relative" style={{ height: 0 }}>
            <div ref={peekRef} className="absolute left-0 right-0 top-0 z-40"
                 style={{ boxShadow: '0 10px 26px rgba(0,0,0,0.20)' }}>
              <RibbonGroupsRow key={cur?.id} groups={cur?.groups ?? []} theme={theme} height={CONTENT_H} />
            </div>
          </div>
        ) : null
      ) : (
        <RibbonGroupsRow key={cur?.id} groups={cur?.groups ?? []} theme={theme} height={CONTENT_H} />
      )}

      {/* Backstage (File tab active): overlay UNDER the tab strip. */}
      {backstageActive && bsBox != null && createPortal(
        <div style={{ position: 'fixed', top: bsBox.top, left: bsBox.left, width: bsBox.width, height: bsBox.height, zIndex: 40, background: theme.bg, overflow: 'hidden' }}>
          {cur?.backstage}
        </div>,
        document.body,
      )}
    </div>
  )
}

// Groups row WITH responsive collapse (MS Office style). As long as everything fits, the
// groups are rendered normally. As soon as the row overflows in width, groups are folded
// STARTING FROM THE RIGHT, one by one, into "big dropdown buttons" (chips):
// the group content is then reachable in a popover. We measure the NATURAL width of each
// group (offsetWidth when expanded) and the chip width (when collapsed), memoised by id,
// then compute the minimal number of groups to fold.
function RibbonGroupsRow({ groups, theme, height }: { groups: RibbonGroup[]; theme: RibbonTheme; height: number }) {
  const rowRef = useRef<HTMLDivElement>(null)
  const naturalRef = useRef<Map<string, number>>(new Map())   // id → expanded width
  const collapsedRef = useRef<Map<string, number>>(new Map()) // id → collapsed width (chip)
  const expandedEls = useRef<Map<string, HTMLDivElement>>(new Map())
  const chipEls = useRef<Map<string, HTMLDivElement>>(new Map())
  const [collapsed, setCollapsed] = useState(0)
  const [containerW, setContainerW] = useState(0)

  // Available width of the row (follows resize + collapse/expand of the side panel).
  useLayoutEffect(() => {
    const el = rowRef.current
    if (!el) return
    const measure = () => setContainerW(el.clientWidth)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  const n = groups.length
  // Collapse estimate before the 1st real chip measurement (icon + label + chevron).
  const chipEstimate = (g: RibbonGroup) => 40 + g.label.length * 6.5

  // After each render: (1) memoise the measured widths, (2) recompute the number of
  // groups to fold. No deps array → converges (setCollapsed is only called on
  // change; memoised widths are stable once measured).
  useLayoutEffect(() => {
    for (let i = 0; i < n; i++) {
      const g = groups[i]
      if (i < n - collapsed) {
        const el = expandedEls.current.get(g.id)
        if (el && el.offsetWidth > 0) naturalRef.current.set(g.id, el.offsetWidth)
      } else {
        const el = chipEls.current.get(g.id)
        if (el && el.offsetWidth > 0) collapsedRef.current.set(g.id, el.offsetWidth)
      }
    }
    if (containerW <= 0 || n === 0) return
    const natW = (g: RibbonGroup) => naturalRef.current.get(g.id) ?? 120
    const colW = (g: RibbonGroup) => collapsedRef.current.get(g.id) ?? chipEstimate(g)
    // Total width if the `c` rightmost groups are folded.
    const totalFor = (c: number) => {
      let s = 0
      for (let i = 0; i < n; i++) s += i < n - c ? natW(groups[i]) : colW(groups[i])
      return s
    }
    let c = 0
    while (c < n && totalFor(c) > containerW - 1) c++
    if (c !== collapsed) setCollapsed(c)
  })

  return (
    // overflow-hidden: no more scrollbar - we fold instead of scrolling.
    <div ref={rowRef} className="flex items-stretch px-2 overflow-hidden" style={{ height, background: theme.bg, borderBottom: `1px solid ${theme.border}`, fontSize: 11 }}>
      {groups.map((g, i) => {
        const last = i === n - 1
        const setEl = (map: { current: Map<string, HTMLDivElement> }) => (el: HTMLDivElement | null) => { if (el) map.current.set(g.id, el); else map.current.delete(g.id) }
        if (i < n - collapsed) {
          return (
            <div key={g.id} ref={setEl(expandedEls)} className="flex flex-shrink-0">
              <RibbonGroupView group={g} theme={theme} last={last} />
            </div>
          )
        }
        return (
          <div key={g.id} ref={setEl(chipEls)} className="flex flex-shrink-0">
            <CollapsedGroupView group={g} theme={theme} last={last} />
          </div>
        )
      })}
    </div>
  )
}

// COLLAPSED group: big button (representative icon + label + chevron) taking the
// place of a group; a click opens a popover containing the whole group (normal rendering).
function CollapsedGroupView({ group, theme, last }: { group: RibbonGroup; theme: RibbonTheme; last: boolean }) {
  const [open, setOpen] = useState(false)
  // `anchor` = raw anchor point (below the button); `box` = actual CLAMPED position
  // of the popover after measurement, so that it stays ENTIRELY within the viewport.
  const [anchor, setAnchor] = useState<{ top: number; left: number; btnTop: number } | null>(null)
  const [box, setBox] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const icon = group.items.find(it => it.icon)?.icon

  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setAnchor({ top: r.bottom + 2, left: r.left, btnTop: r.top })
    setBox(null)
    setOpen(o => !o)
  }
  // After opening: measure the popover and reposition it so it fits in the
  // window (right overflow → shifted left; bottom overflow → flipped above).
  useLayoutEffect(() => {
    if (!open || !anchor || !popRef.current) return
    const el = popRef.current
    const w = el.offsetWidth, h = el.offsetHeight, m = 8
    let left = Math.min(anchor.left, window.innerWidth - m - w)
    left = Math.max(m, left)
    let top = anchor.top
    if (top + h > window.innerHeight - m) {
      const above = anchor.btnTop - 2 - h
      top = above >= m ? above : Math.max(m, window.innerHeight - m - h)
    }
    setBox(prev => (prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5) ? prev : { top, left })
  }, [open, anchor])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div className="flex flex-col items-center justify-between flex-shrink-0 px-2 py-0.5"
      style={{ borderRight: last ? undefined : `1px solid ${theme.border}` }}>
      <button ref={btnRef} title={group.label} onMouseDown={e => e.preventDefault()} onClick={toggle}
        className="flex flex-col items-center justify-center gap-1 flex-1 rounded-xs px-2"
        style={{ minWidth: 48, background: open ? (theme.dark ? 'rgba(255,255,255,0.10)' : 'var(--kbn-ws-hover, #f1f3f4)') : 'transparent', color: theme.text }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.background = theme.dark ? 'rgba(255,255,255,0.08)' : 'var(--kbn-ws-hover, #f1f3f4)' }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.background = 'transparent' }}>
        {icon && <span className="flex items-center justify-center" style={{ width: 22, height: 22 }}>{icon}</span>}
        <ChevronDown size={12} style={{ color: theme.textDim }} />
      </button>
      <div className="text-[10px] text-center whitespace-nowrap" style={{ color: theme.textDim }}>{group.label}</div>
      {open && anchor && createPortal(
        // As long as the clamped position is not computed, render the popover invisible
        // (but measurable) to avoid a visible jump. maxWidth bounds very large
        // groups on narrow screens (inner scrolling rather than overflow).
        <div ref={popRef} className="flex items-stretch"
          style={{ position: 'fixed', top: (box ?? anchor).top, left: (box ?? anchor).left, zIndex: 50,
            visibility: box ? 'visible' : 'hidden',
            maxWidth: 'calc(100vw - 16px)', overflowX: 'auto',
            background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: 4, fontSize: 11 }}>
          <RibbonGroupView group={group} theme={theme} last />
        </div>,
        document.body,
      )}
    </div>
  )
}

function RibbonGroupView({ group, theme, last }: { group: RibbonGroup; theme: RibbonTheme; last: boolean }) {
  return (
    <div className="flex flex-col items-center justify-between flex-shrink-0 px-2 py-0.5"
      style={{ borderRight: last ? undefined : `1px solid ${theme.border}` }}>
      <div className="flex items-stretch gap-0.5 flex-1">
        {toColumns(group.items).map((col, ci) => (
          <div key={ci} className="flex flex-col justify-start gap-[1px]">
            {col.map(it => <RibbonItemView key={it.id} item={it} theme={theme} />)}
          </div>
        ))}
      </div>
      <div className="text-[10px] text-center whitespace-nowrap" style={{ color: theme.textDim }}>{group.label}</div>
    </div>
  )
}

// RULE: a 1-position item (small button / toggle / icon split) can never be
// on more than 3 rows - we STACK these items in columns of 3 MAX, Office style, so as NOT
// to waste horizontal space. ⚠️ A SEPARATOR does NOT interrupt stacking (otherwise it would isolate
// partial columns): it is ignored when packing.
// Only "wide" components (big `size:'large'` button, dropdown, gallery, menu,
// custom) form their own column.
const MAX_STACK = 3
function toColumns(items: RibbonItem[]): RibbonItem[][] {
  const cols: RibbonItem[][] = []
  let run: RibbonItem[] = []
  const flush = () => { if (run.length) { cols.push(run); run = [] } }
  for (const it of items) {
    if (it.kind === 'separator') continue   // does not interrupt stacking
    const stackable = (it.kind === 'button' || it.kind === 'toggle' || it.kind === 'split') && (it.size ?? 'small') !== 'large'
    if (stackable) { run.push(it); if (run.length === MAX_STACK) flush() }
    else { flush(); cols.push([it]) }
  }
  flush()
  return cols
}

// Content of a BIG button (3 vertical positions), Office style:
//  · icon AT THE TOP, larger than the small buttons (24 vs 16); takes the 1st position.
//  · label on 2 lines MAX, those 2 lines ALWAYS reserved (positions 2 & 3) - constant height
//    whatever the label.
//  · MENU button (`chevron`): the chevron goes ON the 2nd line if the label fits on 1
//    line, or AT THE END of the 2nd line if the label spans 2 lines (measured at runtime).
//    For a `split`, `chevronOnClick` makes the chevron clickable (opens the menu) without leaving
//    the button's main action - via a <span> to avoid nesting two <button>.
function LargeButtonContent({ icon, label, chevron, chevronOnClick }: {
  icon?: ReactNode
  label?: string
  chevron: boolean
  chevronOnClick?: () => void
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [twoLines, setTwoLines] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) { setTwoLines(false); return }
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 13
    setTwoLines(el.scrollHeight > lh * 1.6)
  }, [label])
  const chev = (
    <ChevronDown size={11}
      onClick={chevronOnClick ? (e => { e.stopPropagation(); e.preventDefault(); chevronOnClick() }) : undefined}
      onMouseDown={chevronOnClick ? (e => e.preventDefault()) : undefined}
      className={`inline align-middle ${chevronOnClick ? 'cursor-pointer' : ''}`} />
  )
  return (
    <>
      {/* Icon: takes the top space (1st position), forced to 32px (> 16 for the small ones),
          Word style (big ribbon buttons). */}
      <span className="flex-1 flex items-center justify-center min-h-0">
        <span className="flex items-center justify-center [&>svg]:w-8 [&>svg]:h-8">{icon}</span>
      </span>
      {/* Label: 2 lines ALWAYS reserved (positions 2 & 3). BLOCK (div) so that
          `text-center` and the chevron-on-2nd-line work. */}
      <div className="text-center text-[11px] leading-tight break-words" style={{ height: '2.4em', maxWidth: '4.6rem', margin: '0 auto', overflow: 'hidden' }}>
        <span ref={ref} className="line-clamp-2">{label}{chevron && twoLines ? <>{' '}{chev}</> : null}</span>
        {chevron && !twoLines ? <div className="leading-none">{chev}</div> : null}
      </div>
    </>
  )
}

function RibbonItemView({ item, theme }: { item: RibbonItem; theme: RibbonTheme }) {
  const [menu, setMenu] = useState<MenuDropdownPos | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const tip = [item.tooltip ?? item.label, item.shortcut].filter(Boolean).join(' · ')

  if (item.kind === 'separator') return <div style={{ width: 1, alignSelf: 'stretch', background: theme.border, margin: '0 2px' }} />
  if (item.kind === 'custom') return <>{item.render}</>

  if (item.kind === 'dropdown') {
    // Ribbon dropdowns: compact and at 11px (the @ui default = 14px/36px, too big here).
    return <Dropdown value={item.value ?? ''} onChange={v => item.onChange?.(v)}
      options={item.options ?? []} width={item.width ?? 120} fontSize={11} height={24} />
  }

  if (item.kind === 'gallery') {
    return (
      <div className="flex items-center gap-0.5">
        {(item.options ?? []).map(o => (
          <button key={o.value} title={o.label} onMouseDown={e => e.preventDefault()} onClick={() => item.onChange?.(o.value)}
            className="px-2 h-7 rounded-xs text-[11px] hover:bg-black/5"
            style={{ color: theme.text, border: `1px solid ${theme.border}` }}>
            {o.icon ?? o.label}
          </button>
        ))}
      </div>
    )
  }

  const large = item.size === 'large'
  // ACTIVE item highlight tinted by the app accent (≈12% opacity); in
  // dark theme, translucent white veil. `color-mix` handles a non-hex accent
  // (a `var(...)` string set by a theme) where hex+alpha concatenation would fail.
  const tint = /^#[0-9a-fA-F]{6}$/.test(theme.accent)
    ? `${theme.accent}22`
    : `color-mix(in srgb, ${theme.accent} 13%, transparent)`
  const activeBg = item.active ? (theme.dark ? 'rgba(255,255,255,0.14)' : `var(--kbn-office-item-active-bg, ${tint})`) : 'transparent'
  const activeFg = item.active ? `var(--kbn-office-item-active-text, ${theme.accent})` : theme.text

  const openSplit = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setMenu({ top: r.bottom + 2, left: r.left })
  }

  const core = (
    <button ref={btnRef} title={tip} disabled={item.disabled}
      onMouseDown={e => e.preventDefault()}
      onClick={() => { if ((item.kind === 'split' || item.kind === 'menu') && !item.onClick) openSplit(); else item.onClick?.() }}
      onDoubleClick={item.onDoubleClick ? () => item.onDoubleClick!() : undefined}
      className={`flex ${large ? 'flex-col h-full items-center px-2 py-0.5 min-w-[3.5rem] max-w-[200px]' : 'flex-row items-center h-[20px] px-1.5 gap-1'} rounded-xs disabled:opacity-40`}
      style={{ background: activeBg, color: activeFg }}
      onMouseEnter={e => { if (!item.active) e.currentTarget.style.background = theme.dark ? 'rgba(255,255,255,0.08)' : 'var(--kbn-ws-hover, #f1f3f4)' }}
      onMouseLeave={e => { if (!item.active) e.currentTarget.style.background = 'transparent' }}>
      {large ? (
        <LargeButtonContent icon={item.icon} label={item.label}
          chevron={item.kind === 'menu' || item.kind === 'split'}
          chevronOnClick={item.kind === 'split' ? openSplit : undefined} />
      ) : (
        <>
          <span className="flex items-center justify-center flex-shrink-0" style={{ width: 16, height: 16 }}>{item.icon}</span>
          {item.label && <span className="text-[11px] whitespace-nowrap">{item.label}</span>}
          {item.kind === 'menu' && <ChevronDown size={11} style={{ color: theme.textDim }} />}
        </>
      )}
    </button>
  )

  // Button whose WHOLE surface opens a menu: free content (`menuRender`)
  // otherwise list of actions (`splitItems`).
  if (item.kind === 'menu') {
    return (
      // ⚠️ `h-full` when large: otherwise the button's `h-full` resolves to the NATURAL
      // height of the content (the wrapper is not stretched) → big menu button shorter
      // than a simple big button. With `h-full` the wrapper fills the column → identical
      // height for ALL big buttons (3 positions consumed).
      <span className={`flex items-center ${large ? 'h-full' : ''}`}>
        {core}
        {menu && (
          <MenuDropdown
            items={item.menuRender
              ? [{ type: 'custom', render: close => item.menuRender!(close) }]
              : (item.splitItems ?? []).map<MenuItem>(si => ({
                  type: 'action', label: si.label ?? si.id, icon: si.icon, checked: si.active, disabled: si.disabled,
                  onClick: () => { if (!si.disabled) si.onClick?.() },
                }))}
            pos={{ ...menu, minWidth: item.menuRender ? undefined : 180 }} onClose={() => setMenu(null)} />
        )}
      </span>
    )
  }

  if (item.kind === 'split') {
    return (
      <span className={`flex items-center ${large ? 'h-full' : ''}`}>
        {core}
        {/* BIG split: the chevron is INSIDE the button (see LargeButtonContent). Small
            split: separate chevron on the right. */}
        {!large && (
          <button title={tip} onMouseDown={e => e.preventDefault()} onClick={openSplit}
            className="flex items-center justify-center w-4 h-[20px] rounded-xs hover:bg-black/5" style={{ color: theme.textDim }}>
            <ChevronDown size={11} />
          </button>
        )}
        {menu && (
          <MenuDropdown
            items={item.menuRender ? [{ type: 'custom', render: close => item.menuRender!(close) }] : (item.splitItems ?? []).map<MenuItem>(si => ({
              type: 'action', label: si.label ?? si.id, checked: si.active, disabled: si.disabled,
              onClick: () => { if (!si.disabled) si.onClick?.() },
            }))}
            pos={{ ...menu, minWidth: 180 }} onClose={() => setMenu(null)} />
        )}
      </span>
    )
  }

  return core
}

// ── MOBILE ribbon ─────────────────────────────────────────────────────────────
// Replaces the desktop ribbon below 1024px (mobile office-suite style):
//  · a fixed BAR at the bottom of the screen - "active tab ⌃" pill + the commands
//    of the tab laid out flat (icons, horizontal scroll, rules between groups);
//  · the pill opens a half-height bottom-sheet PALETTE: tab selector at the
//    top (including "File"/backstage and the contextual tabs) then the
//    groups of the active tab stacked vertically, items with labels.
// Entirely generated from the same RibbonTab[]: no command is lost.
function MobileRibbon({ tabs, cur, setActive, theme }: {
  tabs: RibbonTab[]
  cur: RibbonTab | undefined
  setActive: (id: string) => void
  theme: RibbonTheme
}) {
  const [paletteOpen, setPaletteOpen] = useState(false)

  // The bar follows the VIRTUAL KEYBOARD (Word mobile style): visualViewport gives
  // the really visible height → the bar sticks above the keyboard
  // when it is open, at the bottom of the screen otherwise. Small deltas (<60px,
  // collapsing URL bar…) are ignored.
  const [kbInset, setKbInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      setKbInset(inset < 60 ? 0 : inset)
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update) }
  }, [])

  // CLEAN bottom bar: the group's `mobileQuick` if declared (manifest
  // selection by the editor, e.g. B/I/U of the documents' custom Font group;
  // `[]` = group absent from the bar), otherwise automatic selection = icon
  // action buttons (button/toggle/split) - dropdowns, galleries and rich
  // controls would saturate the row; they live in the palette.
  const flat: RibbonItem[] = []
  for (const g of cur?.groups ?? []) {
    const keep = g.mobileQuick ?? g.items.filter(it =>
      (it.kind === 'button' || it.kind === 'toggle' || it.kind === 'split' || it.kind === 'menu') && it.icon)
    if (!keep.length) continue
    if (flat.length) flat.push({ id: `__gsep_${g.id}`, kind: 'separator' as const })
    flat.push(...keep)
  }

  const tint = theme.dark ? 'rgba(255,255,255,0.10)'
    : (/^#[0-9a-fA-F]{6}$/.test(theme.accent) ? `${theme.accent}1f` : `color-mix(in srgb, ${theme.accent} 12%, transparent)`)

  return createPortal(
    <>
      {/* Command bar: bottom of the screen, or right ABOVE the keyboard. */}
      <div data-app-chrome className="fixed left-0 right-0 z-[45] flex items-center gap-1 pl-1.5 pr-1"
        style={{ bottom: kbInset,
          height: kbInset ? MOBILE_BAR_H : `calc(${MOBILE_BAR_H}px + env(safe-area-inset-bottom))`,
          paddingBottom: kbInset ? 0 : 'env(safe-area-inset-bottom)',
          background: theme.bg, borderTop: `1px solid ${theme.border}` }}>
        <button onClick={() => setPaletteOpen(o => !o)}
          className="flex items-center gap-1 h-9 px-3 rounded-full text-xs font-medium flex-shrink-0"
          style={{ color: `var(--kbn-office-tab-active-text, ${theme.accent})`, background: tint }}>
          {cur?.label}
          <ChevronUp size={14} style={{ transform: paletteOpen ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
        </button>
        <div className="flex items-center gap-0.5 flex-1 overflow-x-auto overflow-y-hidden self-stretch px-1"
          style={{ scrollbarWidth: 'none' }}>
          {flat.map(it => <MobileItemView key={it.id} item={it} theme={theme} />)}
        </div>
      </div>

      {/* Palette: the whole ribbon as a half-height sheet. */}
      {paletteOpen && (
        <>
          <div className="fixed inset-0 z-[46] bg-black/40" style={{ animation: 'kb-sheet-fade .15s ease-out' }}
            onClick={() => setPaletteOpen(false)} />
          <div className="fixed left-0 right-0 z-[47] flex flex-col rounded-t-2xl overflow-hidden"
            style={{ bottom: kbInset, maxHeight: '62vh', background: theme.bg, boxShadow: '0 -8px 32px rgba(0,0,0,0.25)',
              paddingBottom: kbInset ? 0 : 'env(safe-area-inset-bottom)', animation: 'kb-sheet-up .18s ease-out' }}>
            {/* Tab selector (File accent-styled, contextual ones with coloured edge). */}
            <div className="flex items-center gap-1 px-2 pt-2.5 pb-2 overflow-x-auto flex-shrink-0"
              style={{ borderBottom: `1px solid ${theme.border}`, scrollbarWidth: 'none' }}>
              {tabs.map(t => {
                const activeT = t.id === cur?.id
                if (t.backstage != null) {
                  return (
                    <button key={t.id} onClick={() => { setPaletteOpen(false); setActive(t.id) }}
                      className="h-8 px-3.5 rounded-full text-xs font-semibold flex-shrink-0"
                      style={{ color: 'var(--kbn-office-file-accent-text, #fff)', background: `var(--kbn-office-file-accent, ${theme.fileAccent ?? theme.accent})` }}>
                      {t.label}
                    </button>
                  )
                }
                return (
                  <button key={t.id} onClick={() => setActive(t.id)}
                    className="h-8 px-3.5 rounded-full text-xs font-medium flex-shrink-0"
                    style={{ color: activeT ? `var(--kbn-office-tab-active-text, ${theme.accent})` : theme.textDim,
                      background: activeT ? tint : 'transparent',
                      boxShadow: t.contextual ? `inset 0 2px 0 ${t.contextual.accent}` : undefined }}>
                    {t.label}
                  </button>
                )
              })}
            </div>
            {/* Groups of the active tab, stacked - each command is a LABELLED TILE
                (2-column grid, text = label or tooltip); rich controls
                (dropdown/gallery/custom) in full-width rows, in the group's
                original order. */}
            <div className="flex-1 overflow-y-auto px-3 py-2.5">
              {(cur?.groups ?? []).map(g => (
                <div key={g.id} className="mb-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: theme.textDim }}>
                    {g.label}
                  </div>
                  <PaletteGroup items={g.items} theme={theme} onAction={() => setPaletteOpen(false)} />
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>,
    document.body,
  )
}

// ── Palette: readability / vertical density balance ───────────────────────────
// · Icon TOGGLES (bold, alignments, lists… - visual state, well-known icons)
//   form rows of COMPACT icons (horizontal cluster, Office
//   mobile style) → 6-8 commands per 36px row.
// · ACTIONS (button/split, and toggles without icon) stay LABELLED tiles
//   (text = label ?? tooltip) in a 2-column grid - that is where the
//   label adds meaning.
// · Dropdown / gallery / custom: full-width rows, group order
//   preserved. Separators are unnecessary (each group has its header).
function PaletteGroup({ items, theme, onAction }: { items: RibbonItem[]; theme: RibbonTheme; onAction?: () => void }) {
  type Block = { kind: 'tiles' | 'toggles'; items: RibbonItem[] } | { kind: 'wide'; item: RibbonItem }
  const blocks: Block[] = []
  let run: RibbonItem[] = []
  let runKind: 'tiles' | 'toggles' = 'tiles'
  const flush = () => { if (run.length) { blocks.push({ kind: runKind, items: run }); run = [] } }
  const push = (kind: 'tiles' | 'toggles', it: RibbonItem) => {
    if (run.length && runKind !== kind) flush()
    runKind = kind
    run.push(it)
  }
  for (const it of items) {
    if (it.kind === 'separator') { flush(); continue }
    if (it.kind === 'toggle' && it.icon && !it.paletteTile) push('toggles', it)
    else if (it.kind === 'button' || it.kind === 'split' || it.kind === 'menu' || it.kind === 'toggle') push('tiles', it)
    else { flush(); blocks.push({ kind: 'wide', item: it }) }
  }
  flush()
  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((b, i) => b.kind === 'wide' ? (
        <PaletteWideRow key={i} item={b.item} theme={theme} />
      ) : b.kind === 'toggles' ? (
        <div key={i} className="flex flex-wrap gap-1">
          {b.items.map(it => <PaletteToggle key={it.id} item={it} theme={theme} />)}
        </div>
      ) : (
        <div key={i} className="grid grid-cols-2 gap-1">
          {b.items.map(it => <PaletteTile key={it.id} item={it} theme={theme} onAction={onAction} />)}
        </div>
      ))}
    </div>
  )
}

// Compact toggle: 44×36 icon tile (the title carries the label) - the tinted
// active state makes the function obvious, as on the desktop ribbon.
function PaletteToggle({ item, theme }: { item: RibbonItem; theme: RibbonTheme }) {
  const tint = /^#[0-9a-fA-F]{6}$/.test(theme.accent)
    ? `${theme.accent}22`
    : `color-mix(in srgb, ${theme.accent} 13%, transparent)`
  const activeBg = item.active ? (theme.dark ? 'rgba(255,255,255,0.14)' : `var(--kbn-office-item-active-bg, ${tint})`) : (theme.dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)')
  const activeFg = item.active ? `var(--kbn-office-item-active-text, ${theme.accent})` : theme.text
  return (
    <button title={item.tooltip ?? item.label} disabled={item.disabled} onClick={() => item.onClick?.()}
      className="flex items-center justify-center rounded-lg disabled:opacity-40"
      style={{ width: 44, height: 36, background: activeBg, color: activeFg }}>
      <span className="flex items-center justify-center" style={{ width: 18, height: 18 }}>{item.icon}</span>
    </button>
  )
}

function PaletteTile({ item, theme, onAction }: { item: RibbonItem; theme: RibbonTheme; onAction?: () => void }) {
  const [menu, setMenu] = useState<MenuDropdownPos | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const text = item.label ?? item.tooltip ?? item.id

  const tint = /^#[0-9a-fA-F]{6}$/.test(theme.accent)
    ? `${theme.accent}22`
    : `color-mix(in srgb, ${theme.accent} 13%, transparent)`
  const activeBg = item.active ? (theme.dark ? 'rgba(255,255,255,0.14)' : `var(--kbn-office-item-active-bg, ${tint})`) : (theme.dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)')
  const activeFg = item.active ? `var(--kbn-office-item-active-text, ${theme.accent})` : theme.text

  const openSplit = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setMenu({ top: r.top - 4, left: r.left })
  }

  return (
    <span className="flex items-stretch min-w-0 rounded-lg overflow-hidden" style={{ background: activeBg }}>
      <button ref={btnRef} disabled={item.disabled}
        onClick={() => {
          if ((item.kind === 'split' || item.kind === 'menu') && !item.onClick) { openSplit(); return }
          item.onClick?.()
          // An executed command closes the palette (Office mobile style): its
          // effect is on the slide/document, hidden behind the sheet. Formatting
          // TOGGLES (bold…) stay open, as they chain -
          // except those marked `paletteTile` (VIEW or TOOL choice: we want to
          // use it right away on the document).
          if (item.kind !== 'toggle' || item.paletteTile) onAction?.()
        }}
        className="flex items-center gap-2 h-9 px-2 text-left flex-1 min-w-0 disabled:opacity-40"
        style={{ color: activeFg }}>
        <span className="flex items-center justify-center flex-shrink-0" style={{ width: 18, height: 18 }}>{item.icon}</span>
        <span className="text-xs truncate">{text}</span>
      </button>
      {item.kind === 'split' && (
        <button onClick={openSplit} disabled={item.disabled}
          className="flex items-center justify-center w-7 flex-shrink-0 disabled:opacity-40"
          style={{ color: theme.textDim, borderLeft: `1px solid ${theme.border}` }}>
          <ChevronDown size={13} />
        </button>
      )}
      {menu && (
        <MenuDropdown
          items={item.menuRender ? [{ type: 'custom', render: close => item.menuRender!(close) }] : (item.splitItems ?? []).map<MenuItem>(si => ({
            type: 'action', label: si.label ?? si.id, checked: si.active, disabled: si.disabled,
            onClick: () => { if (!si.disabled) si.onClick?.() },
          }))}
          pos={{ ...menu, minWidth: 180 }} onClose={() => setMenu(null)} />
      )}
    </span>
  )
}

// Full-width palette row: dropdown (label on the left if known),
// gallery (scrollable options), custom (rendered as is).
function PaletteWideRow({ item, theme }: { item: RibbonItem; theme: RibbonTheme }) {
  const text = item.label ?? item.tooltip
  if (item.kind === 'dropdown') {
    return (
      <div className="flex items-center gap-2.5 min-h-10">
        {text && <span className="text-xs flex-shrink-0 w-24 truncate" style={{ color: theme.textDim }}>{text}</span>}
        <Dropdown value={item.value ?? ''} onChange={v => item.onChange?.(v)}
          options={item.options ?? []} width={item.width ?? 150} />
      </div>
    )
  }
  if (item.kind === 'gallery') {
    return (
      <div className="flex items-center gap-1 overflow-x-auto py-0.5" style={{ scrollbarWidth: 'none' }}>
        {(item.options ?? []).map(o => (
          <button key={o.value} title={o.label} onClick={() => item.onChange?.(o.value)}
            className="px-2.5 h-10 rounded-lg text-xs flex-shrink-0"
            style={{ color: theme.text, border: `1px solid ${theme.border}` }}>
            {o.icon ?? o.label}
          </button>
        ))}
      </div>
    )
  }
  // custom
  return <div className="flex items-center flex-wrap gap-1.5 min-h-10">{item.render}</div>
}

// Ribbon item in TOUCH rendering: target ≥ 36px, icon 18px. `labeled` (palette)
// also shows the label; the bottom bar stays icon-only (tooltip = title).
function MobileItemView({ item, theme, labeled }: { item: RibbonItem; theme: RibbonTheme; labeled?: boolean }) {
  const [menu, setMenu] = useState<MenuDropdownPos | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const tip = [item.tooltip ?? item.label, item.shortcut].filter(Boolean).join(' · ')

  if (item.kind === 'separator') {
    return <div className="self-stretch flex-shrink-0" style={{ width: 1, background: theme.border, margin: labeled ? '2px 4px' : '8px 4px' }} />
  }
  if (item.kind === 'custom') return <span className="flex items-center flex-shrink-0">{item.render}</span>
  if (item.kind === 'dropdown') {
    return (
      <span className="flex-shrink-0">
        <Dropdown value={item.value ?? ''} onChange={v => item.onChange?.(v)}
          options={item.options ?? []} width={item.width ?? 110} />
      </span>
    )
  }
  if (item.kind === 'gallery') {
    return (
      <span className="flex items-center gap-0.5 flex-shrink-0">
        {(item.options ?? []).map(o => (
          <button key={o.value} title={o.label} onClick={() => item.onChange?.(o.value)}
            className="px-2 h-9 rounded text-xs" style={{ color: theme.text, border: `1px solid ${theme.border}` }}>
            {o.icon ?? o.label}
          </button>
        ))}
      </span>
    )
  }

  const tint = /^#[0-9a-fA-F]{6}$/.test(theme.accent)
    ? `${theme.accent}22`
    : `color-mix(in srgb, ${theme.accent} 13%, transparent)`
  const activeBg = item.active ? (theme.dark ? 'rgba(255,255,255,0.14)' : `var(--kbn-office-item-active-bg, ${tint})`) : 'transparent'
  const activeFg = item.active ? `var(--kbn-office-item-active-text, ${theme.accent})` : theme.text

  const openSplit = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setMenu({ top: r.top - 4, left: r.left })
  }

  return (
    <span className="flex items-center flex-shrink-0">
      <button ref={btnRef} title={tip} disabled={item.disabled}
        onClick={() => { if ((item.kind === 'split' || item.kind === 'menu') && !item.onClick) openSplit(); else item.onClick?.() }}
        className={`flex items-center justify-center gap-1.5 rounded-lg disabled:opacity-40 ${labeled ? 'h-9 px-2.5 min-w-9' : 'h-10 min-w-10 px-1.5'}`}
        style={{ background: activeBg, color: activeFg }}>
        {item.icon && <span className="flex items-center justify-center" style={{ width: 18, height: 18 }}>{item.icon}</span>}
        {(labeled || !item.icon) && item.label && <span className="text-xs whitespace-nowrap">{item.label}</span>}
      </button>
      {item.kind === 'split' && (
        <button title={tip} onClick={openSplit}
          className="flex items-center justify-center w-5 self-stretch" style={{ color: theme.textDim }}>
          <ChevronDown size={12} />
        </button>
      )}
      {menu && (
        <MenuDropdown
          items={item.menuRender ? [{ type: 'custom', render: close => item.menuRender!(close) }] : (item.splitItems ?? []).map<MenuItem>(si => ({
            type: 'action', label: si.label ?? si.id, checked: si.active, disabled: si.disabled,
            onClick: () => { if (!si.disabled) si.onClick?.() },
          }))}
          pos={{ ...menu, minWidth: 180 }} onClose={() => setMenu(null)} />
      )}
    </span>
  )
}
