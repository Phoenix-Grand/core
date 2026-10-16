/**
 * Pure geometry of the design surface (vskubuno docs/DESIGNER.md §9–§10, transposed to the DOM): rectangles,
 * element ids, the layout map built from `[data-kb-id]`, hit-testing, adorner geometry, move / resize. No DOM
 * access except in `buildLayoutMap` (through injectable measures, so jsdom tests can stub them).
 */

export interface Rect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom })
export const widthOf = (r: Rect): number => r.right - r.left
export const heightOf = (r: Rect): number => r.bottom - r.top
export const isEmptyRect = (r: Rect): boolean => r.right - r.left <= 0 || r.bottom - r.top <= 0

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.left && x < r.right && y >= r.top && y < r.bottom
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const r = rect(Math.max(a.left, b.left), Math.max(a.top, b.top), Math.min(a.right, b.right), Math.min(a.bottom, b.bottom))
  return isEmptyRect(r) ? null : r
}

export function inflate(r: Rect, by: number): Rect {
  return rect(r.left - by, r.top - by, r.right + by, r.bottom + by)
}

export function translate(r: Rect, dx: number, dy: number): Rect {
  return rect(r.left + dx, r.top + dy, r.right + dx, r.bottom + dy)
}

// ── Element ids (`Element::stable_id`: dot path of element-child ordinals, `""` = the root) ──

/** `"0.1"` → `"0"`, `"0"` → `""` (the root), `""` → `null`. */
export function parentIdOf(id: string): string | null {
  if (id === '') return null
  const dot = id.lastIndexOf('.')
  return dot < 0 ? '' : id.slice(0, dot)
}

/** Whether `ancestor` is `id` or one of its ancestors (the root is everyone's). */
export function isAncestorOrSelf(ancestor: string, id: string): boolean {
  return ancestor === '' || id === ancestor || id.startsWith(ancestor + '.')
}

/** The element-child ordinal of an id (`"0.3"` → 3); the root → 0. */
export function ordinalOf(id: string): number {
  const last = id.slice(id.lastIndexOf('.') + 1)
  const n = Number(last)
  return id === '' || !Number.isFinite(n) ? 0 : n
}

/**
 * The ids a group gesture applies to: the root and every element whose ancestor is also selected are dropped
 * (Windows Forms: a control follows its selected container), the order kept.
 */
export function topLevelIds(ids: readonly string[]): string[] {
  const set = ids.filter((id) => id !== '')
  return set.filter((id) => !set.some((other) => other !== id && isAncestorOrSelf(other, id)))
}

// ── The layout map ──

export interface LayoutEntry {
  readonly id: string
  readonly parentId: string | null
  /** The painted border box, page (viewport) CSS px. */
  readonly bounds: Rect
  /** What the clipping ancestors (`overflow` ≠ visible) leave visible of the page; `null` = not clipped. */
  readonly clip: Rect | null
  /** Paint (document) order. */
  readonly order: number
  /** The element's inline direction is right-to-left. */
  readonly rtl: boolean
  /** A container painting nothing of its own (no background, border, shadow): drawn with a faint outline. */
  readonly bare: boolean
}

export interface LayoutMap {
  readonly entries: readonly LayoutEntry[]
  /** Entries of each id (several for the rows of a `Repeater` template), in paint order. */
  readonly byId: ReadonlyMap<string, readonly LayoutEntry[]>
}

export function makeLayoutMap(entries: readonly LayoutEntry[]): LayoutMap {
  const byId = new Map<string, LayoutEntry[]>()
  for (const e of entries) {
    const list = byId.get(e.id)
    if (list) list.push(e)
    else byId.set(e.id, [e])
  }
  return { entries, byId }
}

/** The visible part of an entry (bounds ∩ clip), `null` when nothing of it shows. */
export function visibleRect(e: LayoutEntry): Rect | null {
  if (isEmptyRect(e.bounds)) return null
  return e.clip ? intersect(e.bounds, e.clip) : e.bounds
}

/** The bounds of an element (its first painted instance). */
export function boundsOf(map: LayoutMap, id: string): Rect | null {
  return map.byId.get(id)?.[0]?.bounds ?? null
}

/** The painted children of an element, in document order (one entry per child, its first instance). */
export function childEntries(map: LayoutMap, parentId: string): LayoutEntry[] {
  const seen = new Set<string>()
  const out: LayoutEntry[] = []
  for (const e of map.entries) {
    if (e.parentId !== parentId || seen.has(e.id) || isEmptyRect(e.bounds)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out.sort((a, b) => ordinalOf(a.id) - ordinalOf(b.id) || a.order - b.order)
}

/**
 * The deepest element under a point: entries scanned in REVERSE paint order, the first whose visible part holds
 * the point wins (a container is recorded before its children, so the most nested match comes first; between
 * overlapping siblings the later-painted one wins - `LayoutMap::hit_test`'s rule). Entries with nothing visible
 * are skipped; `skip` excludes ids (e.g. the dragged element).
 */
export function hitTest(map: LayoutMap, x: number, y: number, skip?: (id: string) => boolean): LayoutEntry | null {
  for (let k = map.entries.length - 1; k >= 0; k--) {
    const e = map.entries[k]
    if (skip?.(e.id)) continue
    const v = visibleRect(e)
    if (v && contains(v, x, y)) return e
  }
  return null
}

/** What `buildLayoutMap` measures (injectable for tests). */
export interface Measures {
  rectOf(el: Element): Rect
  /** The element clips its content (`overflow` other than `visible` on an axis). */
  clips(el: Element): boolean
  rtl(el: Element): boolean
  /** The element paints something of its own (background, border, shadow). */
  paints(el: Element): boolean
}

export function domMeasures(win: Window = window): Measures {
  const style = (el: Element): CSSStyleDeclaration => win.getComputedStyle(el)
  return {
    rectOf: (el) => {
      const r = el.getBoundingClientRect()
      return rect(r.left, r.top, r.right, r.bottom)
    },
    clips: (el) => {
      const s = style(el)
      return [s.overflow, s.overflowX, s.overflowY].some((v) => !!v && v !== 'visible')
    },
    rtl: (el) => style(el).direction === 'rtl',
    paints: (el) => {
      const s = style(el)
      const bg = s.backgroundColor
      const transparent = !bg || bg === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(bg)
      const border = ['Top', 'Right', 'Bottom', 'Left'].some((side) => {
        const w = s.getPropertyValue(`border-${side.toLowerCase()}-width`)
        const st = s.getPropertyValue(`border-${side.toLowerCase()}-style`)
        return st && st !== 'none' && st !== 'hidden' && parseFloat(w) > 0
      })
      return !transparent || border || (!!s.boxShadow && s.boxShadow !== 'none') || (!!s.backgroundImage && s.backgroundImage !== 'none')
    },
  }
}

/**
 * The layout map of every `[data-kb-id]` element under `root` (the whole document by default: portalled
 * elements included), in document order. `isContainer(id)` says which ids are containers (for `bare`).
 */
export function buildLayoutMap(
  root: ParentNode,
  measures: Measures,
  isContainer: (id: string) => boolean = () => false,
  stopAt: Element | null = null,
): LayoutMap {
  const clipCache = new Map<Element, Rect | null>()
  const clipOf = (el: Element | null): Rect | null => {
    if (!el || el === stopAt || el.nodeType !== 1) return null
    const cached = clipCache.get(el)
    if (cached !== undefined) return cached
    const up = clipOf(el.parentElement)
    let own: Rect | null = up
    if (measures.clips(el)) {
      const r = measures.rectOf(el)
      own = up ? intersect(up, r) ?? rect(0, 0, 0, 0) : r
    }
    clipCache.set(el, own)
    return own
  }
  const entries: LayoutEntry[] = []
  let order = 0
  root.querySelectorAll('[data-kb-id]').forEach((el) => {
    const id = el.getAttribute('data-kb-id') ?? ''
    entries.push({
      id,
      parentId: parentIdOf(id),
      bounds: measures.rectOf(el),
      clip: clipOf(el.parentElement),
      order: order++,
      rtl: measures.rtl(el),
      bare: isContainer(id) && !measures.paints(el),
    })
  })
  return makeLayoutMap(entries)
}

// ── Adorners ──

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** The gap between an element and its selection frame. */
export const FRAME_GAP = 3
/** Side of a grab handle. */
export const HANDLE_SIZE = 7
/** A press must move this far before it becomes a drag. */
export const DRAG_THRESHOLD = 4
/** Smallest size a resize leaves. */
export const MIN_ELEMENT_SIZE = 8

/** The selection frame of an element: 3 px outside its bounds. */
export function selectionFrame(bounds: Rect): Rect {
  return inflate(bounds, FRAME_GAP)
}

/** The centre of each grab handle on a frame. */
export function handlePoint(frame: Rect, h: Handle): [number, number] {
  const cx = (frame.left + frame.right) / 2
  const cy = (frame.top + frame.bottom) / 2
  const x = h.includes('w') ? frame.left : h.includes('e') ? frame.right : cx
  const y = h.startsWith('n') ? frame.top : h.startsWith('s') ? frame.bottom : cy
  return [x, y]
}

export function handleRects(frame: Rect, size = HANDLE_SIZE): { handle: Handle; rect: Rect }[] {
  const half = size / 2
  return HANDLES.map((handle) => {
    const [x, y] = handlePoint(frame, handle)
    return { handle, rect: rect(x - half, y - half, x + half, y + half) }
  })
}

/** The handle under a point (with a little slack), if any. */
export function handleAt(frame: Rect, x: number, y: number, size = HANDLE_SIZE + 4): Handle | null {
  for (const { handle, rect: r } of handleRects(frame, size)) if (contains(r, x, y)) return handle
  return null
}

/** The edges a handle moves. */
export function handleEdges(h: Handle): { left: boolean; right: boolean; top: boolean; bottom: boolean } {
  return { left: h.includes('w'), right: h.includes('e'), top: h.startsWith('n'), bottom: h.startsWith('s') }
}

/** A rectangle resized by dragging handle `h` by `(dx, dy)`; the opposite edges never move; never below `min`. */
export function resizeRect(r: Rect, h: Handle, dx: number, dy: number, min = MIN_ELEMENT_SIZE): Rect {
  const e = handleEdges(h)
  let { left, top, right, bottom } = r
  if (e.left) left = Math.min(left + dx, right - min)
  if (e.right) right = Math.max(right + dx, left + min)
  if (e.top) top = Math.min(top + dy, bottom - min)
  if (e.bottom) bottom = Math.max(bottom + dy, top + min)
  return rect(left, top, right, bottom)
}

/** Points to the axis a flow lays its children along, from how their centres spread (`flow_axis`). */
export function flowAxisOf(siblings: readonly Rect[]): 'horizontal' | 'vertical' {
  if (siblings.length < 2) return 'vertical'
  const xs = siblings.map((r) => (r.left + r.right) / 2)
  const ys = siblings.map((r) => (r.top + r.bottom) / 2)
  const spread = (v: number[]): number => Math.max(...v) - Math.min(...v)
  return spread(xs) > spread(ys) ? 'horizontal' : 'vertical'
}
