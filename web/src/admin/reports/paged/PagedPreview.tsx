/**
 * Code-behind of `PagedPreview.kbcontrol` (converted from `PagedPreview.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Minus, Plus, Printer, RotateCw } from "lucide-react"
import { useMenuDropdown } from "@ui"
import type { MenuItem } from "@ui"
import { geometry, MM, SHEET_GAP, SHEET_PAD, SHEET_PAD_X } from "./geometry"
import { paginate } from "./paginate"
import type { Metrics, TableMetrics } from "./paginate"
import TableFragment from "./TableFragment"
import type { FlowItem, Sheet } from "./types"
import type { Orientation, PageGeometry, PaperFormat } from "./geometry"
import { stampUrl } from "./watermark"
import type { WatermarkSpec } from "./watermark"

import { ViewBase } from './PagedPreview.kbcontrol'
import * as __parts from './PagedPreview.parts'

const THUMB_W = 104

export type PagedPreviewProps = {
  items:       FlowItem[]
  format:      PaperFormat
  /** The document's default. Individual sheets may be turned against it. */
  orientation: Orientation
  /** Front sheet, when the operator asked for one. Never numbered. */
  cover?:      React.ReactNode
  /** Running footer. `page`/`total` count every sheet, cover included. */
  footer:      (page: number, total: number) => React.ReactNode
  /** Changes when the document's CONTENT does, forcing a fresh measurement. */
  revision:    string
  /** The stamp across every sheet — text or picture. See `watermark.ts`. */
  watermark?:  WatermarkSpec
  /** Toggling the cover from the sheet's own context menu. */
  onToggleCover?: () => void
  /** Turning the WHOLE document from the same menu. */
  onOrientation?: (o: Orientation) => void
  /**
   * Height of the frozen band above the preview (breadcrumb + toolbar).
   *
   * The rail of thumbnails is pinned too — a page list that scrolls away with
   * the pages is a page list you have to leave the page to reach. It pins
   * DIRECTLY under the band: a sticky top is measured from the scrolling
   * ancestor's padding box (24 px here), hence the offset.
   */
  bandHeight?: number
}

export class PagedPreview extends ViewBase {
  @bind accessor sheets: Sheet[] = []
  @bind accessor cols: Record<Orientation, Record<string, number[]>> = {
    portrait: {}, landscape: {},
  }
  @bind accessor flips: Record<number, Orientation> = {}
  @bind accessor zoomWanted: number | null = null
  @bind accessor fitZoom = 1
  @bind accessor active = 1
  @bind accessor geoTick = 0
  @bind accessor menuSheet: number | null = null
  tr!: PagedPreviewStores['t']
  measureRef!: PagedPreviewStores['measureRef']
  footerRef!: PagedPreviewStores['footerRef']
  frameRef!: PagedPreviewStores['frameRef']
  sheetRefs!: PagedPreviewStores['sheetRefs']
  orientOf!: (index: number) => Orientation
  geos!: PagedPreviewHooks['geos']
  stackPx!: number
  menu!: PagedPreviewStores['menu']
  menuItems!: MenuItem[]
  stamps!: { portrait: string | undefined; landscape: string | undefined; }

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const measureRef = useRef<HTMLDivElement>(null)
    const footerRef  = useRef<HTMLDivElement>(null)
    const frameRef   = useRef<HTMLDivElement>(null)
    const sheetRefs  = useRef<(HTMLElement | null)[]>([])
    const menu = useMenuDropdown()
    return { t, measureRef, footerRef, frameRef, sheetRefs, menu }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const measureRef = this.measureRef
    const footerRef = this.footerRef
    const frameRef = this.frameRef
    const sheetRefs = this.sheetRefs
    useEffect(() => { this.flips = {} }, [this.props.orientation, this.props.format, this.props.revision])
    const orientOf = useCallback(
      (index: number): Orientation => this.flips[index] ?? this.props.orientation,
      [this.flips, this.props.orientation],
    )
    this.publish({ orientOf })
    const geos = useRef<Record<Orientation, PageGeometry>>({
      portrait:  geometry(this.props.format, 'portrait', 0),
      landscape: geometry(this.props.format, 'landscape', 0),
    })
    this.publish({ geos })
    const measureAt = useCallback((root: HTMLElement, widthPx: number) => {
      root.style.width = `${widthPx}px`
      const metrics: Metrics = {}
      const widths: Record<string, number[]> = {}
    
      for (const item of this.props.items) {
        const el = root.querySelector<HTMLElement>(`[data-m="${CSS.escape(item.id)}"]`)
        if (!el) continue
    
        if (item.kind === 'atom') {
          metrics[item.id] = { height: el.getBoundingClientRect().height }
          continue
        }
    
        const block = el.querySelector<HTMLElement>('[data-paged-block]')
        const table = el.querySelector<HTMLElement>('[data-paged-table]')
        const head  = el.querySelector<HTMLElement>('[data-paged-head]')
        const body  = el.querySelector<HTMLElement>('[data-paged-body]')
        const foot  = el.querySelector<HTMLElement>('[data-paged-foot]')
        const note  = el.querySelector<HTMLElement>('[data-paged-note]')
        if (!block || !table || !head || !body) continue
    
        // ── Two readings, in this order, and the order is the point ────────────
        // First the columns lay themselves out from ALL the rows; those widths are
        // then PINNED on the table, and only after that are the row heights read.
        // Measuring rows under free columns and printing them under pinned ones
        // would be measuring a different table from the one that prints.
        const cw = Array.from(head.querySelectorAll('th, td'))
          .map(c => c.getBoundingClientRect().width)
    
        const colgroup = document.createElement('colgroup')
        for (const w of cw) {
          const col = document.createElement('col')
          col.style.width = `${w}px`
          colgroup.appendChild(col)
        }
        table.insertBefore(colgroup, table.firstChild)
        const freeLayout = table.style.tableLayout
        table.style.tableLayout = 'fixed'
    
        const b  = block.getBoundingClientRect()
        const tb = table.getBoundingClientRect()
        // The note carries a top margin; measuring from the table's bottom edge
        // takes margin and box together, which is what the cut has to account for.
        const noteH = note ? note.getBoundingClientRect().bottom - tb.bottom : 0
    
        const m: TableMetrics = {
          chromeTop:    tb.top - b.top,
          chromeBottom: b.bottom - (note ? note.getBoundingClientRect().bottom : tb.bottom),
          head:         head.getBoundingClientRect().height,
          foot:         foot ? foot.getBoundingClientRect().height : 0,
          note:         noteH,
          rows:         Array.from(body.children).map(r => r.getBoundingClientRect().height),
        }
        metrics[item.id] = m
        widths[item.id]  = cw
    
        // The measuring subtree is React's; hand it back as it was found.
        table.removeChild(colgroup)
        table.style.tableLayout = freeLayout
      }
    
      return { metrics, widths }
    }, [this.props.items])
    const layout = useCallback(() => {
      const root = measureRef.current
      if (!root) return
    
      // Height AND top margin: `getBoundingClientRect` returns the box alone, and
      // the footer's `margin-top` is 4 mm of the sheet the content will not get.
      // Reading only the box left the last sheet of a packed report six
      // millimetres over the edge — the exact defect this component exists to make
      // impossible.
      const footEl   = footerRef.current?.firstElementChild as HTMLElement | null
      const footerPx = footEl
        ? footEl.getBoundingClientRect().height + parseFloat(getComputedStyle(footEl).marginTop || '0')
        : 0
    
      const g: Record<Orientation, PageGeometry> = {
        portrait:  geometry(this.props.format, 'portrait',  footerPx),
        landscape: geometry(this.props.format, 'landscape', footerPx),
      }
      geos.current = g
      this.geoTick = this.geoTick + 1
    
      const p = measureAt(root, g.portrait.contentWidthPx)
      const l = measureAt(root, g.landscape.contentWidthPx)
      const packs = { portrait: p, landscape: l }
    
      this.cols = { portrait: p.widths, landscape: l.widths }
      this.sheets = paginate(this.props.items, index => {
        const o = this.flips[index] ?? this.props.orientation
        return { height: g[o].contentHeightPx, metrics: packs[o].metrics }
      })
      // `items` is rebuilt on every render by design (it holds React nodes); the
      // revision string is what says the document changed.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [this.props.revision, this.props.format, this.props.orientation, this.flips, measureAt])
    useLayoutEffect(() => { layout() }, [layout])
    useEffect(() => {
      let alive = true
      document.fonts?.ready.then(() => { if (alive) layout() })
      return () => { alive = false }
    }, [layout])
    useEffect(() => {
      const frame = frameRef.current
      if (!frame) return
      const fit = () => {
        // Minus the gutters: they are inside the frame, and a sheet scaled to the
        // frame's full width would sit under the controls that live in them.
        const avail = frame.clientWidth - 2 * SHEET_PAD_X
        const wide  = this.widestMm * MM
        this.fitZoom = avail > 0 && wide > avail ? avail / wide : 1
      }
      fit()
      const ro = new ResizeObserver(fit)
      ro.observe(frame)
      return () => ro.disconnect()
    }, [this.widestMm, this.geoTick])
    useEffect(() => {
      const frame = frameRef.current
      if (!frame) return
      const onWheel = (e: WheelEvent) => {
        if (!e.ctrlKey && !e.metaKey) return
        e.preventDefault()
        const step = e.deltaY > 0 ? 1 / 1.12 : 1.12
        this.zoomWanted = ((z) => {
          const next = (z ?? this.fitZoom) * step
          return Math.min(3, Math.max(0.25, Math.round(next * 100) / 100))
        })(this.zoomWanted)
      }
      frame.addEventListener('wheel', onWheel, { passive: false })
      return () => frame.removeEventListener('wheel', onWheel)
    }, [this.fitZoom])
    const cover = this.props.cover
    const stackPx = useMemo(() => {
      const heights = [
        ...(cover ? [geos.current[this.props.orientation].heightMm] : []),
        ...this.sheets.map((_, i) => geos.current[orientOf(i)].heightMm),
      ]
      return heights.reduce((a, h) => a + h * MM, 0)
        + Math.max(0, heights.length - 1) * SHEET_GAP
        + 2 * SHEET_PAD
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [this.sheets, cover, this.props.orientation, orientOf, this.geoTick])
    this.publish({ stackPx })
    useEffect(() => {
      const els = sheetRefs.current.filter(Boolean) as HTMLElement[]
      if (els.length === 0) return
      const seen = new Map<Element, number>()
      const io = new IntersectionObserver(entries => {
        for (const e of entries) seen.set(e.target, e.intersectionRatio)
        let best = -1, bestI = 1
        els.forEach((el, i) => {
          const r = seen.get(el) ?? 0
          if (r > best) { best = r; bestI = i + 1 }
        })
        this.active = bestI
      }, { threshold: [0, 0.25, 0.5, 0.75, 1] })
      els.forEach(el => io.observe(el))
      return () => io.disconnect()
    }, [this.sheets.length, this.props.cover])
    const menuSheet = this.menuSheet
    const onOrientation = this.props.onOrientation
    const onToggleCover = this.props.onToggleCover
    const menuItems: MenuItem[] = useMemo(() => {
      const s = menuSheet
      const o = s === null ? this.props.orientation : orientOf(s)
      const rows: MenuItem[] = [
        { type: 'label', text: t('admin.rep_menu_sheet', { page: (s ?? 0) + 1 + (cover ? 1 : 0) }) },
        {
          type: 'action', label: t(o === 'portrait' ? 'admin.rep_landscape' : 'admin.rep_portrait'),
          icon: <RotateCw size={14} />, disabled: s === null,
          onClick: () => { if (s !== null) this.flips = ({ ...this.flips, [s]: o === 'portrait' ? 'landscape' : 'portrait' }) },
        },
        { type: 'separator' },
        {
          type: 'submenu', label: t('admin.rep_menu_document'),
          items: [
            { type: 'action', label: t('admin.rep_portrait'),  checked: this.props.orientation === 'portrait',
              onClick: () => onOrientation?.('portrait') },
            { type: 'action', label: t('admin.rep_landscape'), checked: this.props.orientation === 'landscape',
              onClick: () => onOrientation?.('landscape') },
            { type: 'separator' },
            { type: 'action', label: t('admin.rep_cover'), checked: !!cover, onClick: () => onToggleCover?.() },
          ],
        },
        { type: 'separator' },
        { type: 'action', label: t('admin.rep_zoom_in'),  icon: <Plus size={14} />,
          onClick: () => this.zoomWanted = Math.min(3, Math.round(((this.zoomWanted ?? this.fitZoom) + 0.1) * 100) / 100) },
        { type: 'action', label: t('admin.rep_zoom_out'), icon: <Minus size={14} />,
          onClick: () => this.zoomWanted = Math.max(0.25, Math.round(((this.zoomWanted ?? this.fitZoom) - 0.1) * 100) / 100) },
        { type: 'action', label: t('admin.rep_fit'), onClick: () => this.zoomWanted = null },
        { type: 'separator' },
        { type: 'action', label: t('admin.rep_print'), icon: <Printer size={14} />, onClick: () => window.print() },
      ]
      return rows
    }, [menuSheet, this.props.orientation, orientOf, cover, this.fitZoom, onOrientation, onToggleCover, t])
    this.publish({ menuItems })
    const watermark = this.props.watermark
    const stamps = useMemo(() => ({
      portrait:  watermark ? stampUrl(geos.current.portrait,  watermark) : undefined,
      landscape: watermark ? stampUrl(geos.current.landscape, watermark) : undefined,
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [watermark, this.geoTick, this.props.format])
    this.publish({ stamps })
    return { orientOf, geos, measureAt, layout, stackPx, menuItems, stamps }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, measureRef: s.measureRef, footerRef: s.footerRef, frameRef: s.frameRef, sheetRefs: s.sheetRefs, menu: s.menu })
    const h = this.useHooks()
    this.publish({ orientOf: h.orientOf, geos: h.geos, stackPx: h.stackPx, menuItems: h.menuItems, stamps: h.stamps })
  }

  get bandHeight() {
    return this.props.bandHeight ?? 0
  }

  get total(): number {
    return this.sheets.length + (this.props.cover ? 1 : 0)
  }

  get firstOrientation(): Orientation {
    return this.props.cover ? this.props.orientation : this.orientOf(0)
  }

  get widestMm(): number {
    return Math.max(
    ...(this.props.cover ? [this.geos.current[this.props.orientation].widthMm] : []),
    ...this.sheets.map((_, i) => this.geos.current[this.orientOf(i)].widthMm),
    this.geos.current[this.props.orientation].widthMm,
  )
  }

  get zoom(): number {
    return this.zoomWanted ?? this.fitZoom
  }

  get byId(): Map<string, FlowItem> {
    return this.memo('byId', [this.props], () => new Map(this.props.items.map(i => [i.id, i])))
  }

  get stampVars() {
    return this.memo('stampVars', [this.stamps], () => ({
    ['--kb-stamp-p' as string]: this.stamps.portrait  ?? 'none',
    ['--kb-stamp-l' as string]: this.stamps.landscape ?? 'none',
  } as React.CSSProperties))
  }

  get part1_props() {
    return this.memo('part1_props', [this.geos, this.firstOrientation], () => ({ geos: this.geos, firstOrientation: this.firstOrientation }))
  }

  /** A part of the screen still written in React (<style> has no .kbview element yet). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.measureRef, this.props], () => ({ measureRef: this.measureRef, items: this.props.items }))
  }

  /** A part of the screen still written in React (<div ref>: attribute(s) without a .kbview property). */
  get Part2() {
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.footerRef, this.props], () => ({ footerRef: this.footerRef, footer: this.props.footer }))
  }

  /** A part of the screen still written in React (<div ref>: attribute(s) without a .kbview property). */
  get Part3() {
    return __parts.Part3
  }

  get part4_props() {
    return this.memo('part4_props', [this.frameRef, this.zoom, this.stackPx, this.stampVars, this.props, this.memo, this.menuSheet, this.menu, this.sheetRefs, this.geos, this.sheets, this.orientOf, this.flips, this.tr, this.byId, this.cols, this.total], () => ({ frameRef: this.frameRef, zoom: this.zoom, stackPx: this.stackPx, stampVars: this.stampVars, cover: this.props.cover, orientation: this.props.orientation, setMenuSheet: this.memo("setMenuSheet:bound", [], () => this.setMenuSheet.bind(this)), menu: this.menu, sheetRefs: this.sheetRefs, styleOf: this.memo("styleOf:bound", [], () => this.styleOf.bind(this)), geos: this.geos, sheets: this.sheets, orientOf: this.orientOf, setFlips: this.memo("setFlips:bound", [], () => this.setFlips.bind(this)), t: this.tr, sheetContent: this.memo("sheetContent:bound", [], () => this.sheetContent.bind(this)) }))
  }

  /** A part of the screen still written in React (<div ref>: attribute(s) without a .kbview property). */
  get Part4() {
    return __parts.Part4
  }

  get show_total() {
    return this.total > 1
  }

  get part5_props() {
    return this.memo('part5_props', [this.stampVars, this.bandHeight, this.tr, this.props, this.memo, this.active, this.sheetRefs, this.geos, this.sheets, this.orientOf, this.byId, this.cols, this.total], () => {
      if (!(this.total > 1)) return undefined as never
      return ({ stampVars: this.stampVars, bandHeight: this.bandHeight, t: this.tr, cover: this.props.cover, thumb: this.memo("thumb:bound", [], () => this.thumb.bind(this)), geos: this.geos, orientation: this.props.orientation, sheets: this.sheets, orientOf: this.orientOf, sheetContent: this.memo("sheetContent:bound", [], () => this.sheetContent.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<aside> with a computed style). */
  get Part5() {
    if (!(this.total > 1)) return undefined as never
    return __parts.Part5
  }

  get show_menu_pos() {
    return this.memo('show_menu_pos', [this.menu], () => !!(this.menu.pos))
  }

  get part6_props() {
    return this.memo('part6_props', [this.menuItems, this.menu], () => {
      if (!(this.menu.pos)) return undefined as never
      return ({ menuItems: this.menuItems, menu_pos: this.menu?.pos, menu: this.menu })
    })
  }

  /** A part of the screen still written in React (<ContextMenu> pos, onClose: no .kbview property). */
  get Part6() {
    if (!(this.menu.pos)) return undefined as never
    return __parts.Part6
  }

  get part7_props() {
    return this.memo('part7_props', [this.active, this.total, this.memo, this.sheetRefs, this.tr], () => ({ active: this.active, total: this.total, setActive: this.memo("setActive:bound", [], () => this.setActive.bind(this)), goTo: this.memo("goTo:bound", [], () => this.goTo.bind(this)), t: this.tr }))
  }

  /** A part of the screen still written in React (<input> has no .kbview element yet). */
  get Part7() {
    return __parts.Part7
  }

  get span_text() {
    return this.memo('span_text', [this.total], () => "/ " + String(this.total))
  }

  get text() {
    return Math.round(this.zoom * 100)
  }

  goTo(page: number) {
    const el = this.sheetRefs.current[page - 1]
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  sheetContent(sheet: Sheet, index: number) {
    return (
    <div data-sheet-body>
      <div data-sheet-content>
        {sheet.placements.map((p, k) => {
          const item = this.byId.get(p.id)
          if (!item) return null
          if (p.kind === 'atom' || item.kind === 'atom') {
            // No wrapper: the blocks carry their own top margin, and an extra
            // box would either eat it or add to it — either way the sheet would
            // no longer match what was measured.
            return <Fragment key={k}>{item.kind === 'atom' ? item.node : null}</Fragment>
          }
          return (
            <TableFragment
              key={k}
              item={item}
              slice={{ from: p.from, to: p.to, continued: p.continued, last: p.last }}
              widths={this.cols[this.orientOf(index)][p.id]}
            />
          )
        })}
      </div>
      <div data-sheet-footer>{this.props.footer(index + 1 + (this.props.cover ? 1 : 0), this.total)}</div>
    </div>
  )
  }

  styleOf(g: PageGeometry): React.CSSProperties {
    return ({
    width:   `${g.widthMm}mm`,
    height:  `${g.heightMm}mm`,
    padding: `${g.marginMm}mm`,
  })
  }

  thumb(page: number, g: PageGeometry, body: React.ReactNode, o: Orientation) {
    const k = THUMB_W / (g.widthMm * MM)
    const on = this.active === page
    return (
      <div key={page} className="flex flex-col items-center gap-1">
        <span
          className={on ? 'text-primary' : 'text-text-tertiary'}
          style={{ fontSize: 'var(--kb-text-micro)' }}
        >
          {page}
        </span>
        <button
          type="button"
          onClick={() => this.goTo(page)}
          aria-current={on}
          className={`overflow-hidden rounded-md bg-white transition-shadow ${
            on ? 'ring-2 ring-primary' : 'ring-1 ring-border hover:ring-border-strong'
          }`}
          style={{ width: THUMB_W, height: g.heightMm * MM * k }}
        >
          {/* The sheet at true size, painted at `k`. Rendering the real thing
              rather than a placeholder is the point of a thumbnail rail: the
              operator recognises the page they want by its shape. */}
          <span
            data-admin-report
            data-sheet-face
            data-o={o}
            className="block origin-top-left"
            style={{ ...this.styleOf(g), transform: `scale(${k})`, display: 'block' }}
          >
            {body}
          </span>
        </button>
      </div>
    )
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    window.print()
  }

  panel_click2(_sender: unknown, _args: MouseEventArgs) {
    this.zoomWanted = Math.max(0.25, Math.round((this.zoom - 0.1) * 100) / 100)
  }

  panel_click3(_sender: unknown, _args: MouseEventArgs) {
    this.zoomWanted = null
  }

  panel_click4(_sender: unknown, _args: MouseEventArgs) {
    this.zoomWanted = Math.min(3, Math.round((this.zoom + 0.1) * 100) / 100)
  }

  /** `setMenuSheet` of the TSX: a value, or an update of the previous one. */
  setMenuSheet(value: number | null | ((prev: number | null) => number | null)) {
    this.menuSheet = typeof value === 'function' ? (value as (prev: number | null) => number | null)(this.menuSheet) : value
  }

  /** `setFlips` of the TSX: a value, or an update of the previous one. */
  setFlips(value: Record<number, Orientation> | ((prev: Record<number, Orientation>) => Record<number, Orientation>)) {
    this.flips = typeof value === 'function' ? (value as (prev: Record<number, Orientation>) => Record<number, Orientation>)(this.flips) : value
  }

  /** `setActive` of the TSX: a value, or an update of the previous one. */
  setActive(value: PagedPreview['active'] | ((prev: PagedPreview['active']) => PagedPreview['active'])) {
    this.active = typeof value === 'function' ? (value as (prev: PagedPreview['active']) => PagedPreview['active'])(this.active) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type PagedPreviewStores = ReturnType<PagedPreview['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type PagedPreviewHooks = ReturnType<PagedPreview['useHooks']>

export default PagedPreview.component()
