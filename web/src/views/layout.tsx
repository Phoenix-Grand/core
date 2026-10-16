/**
 * The layout containers of `.kbview` web views (VIEWS-SPEC §5, lot WV-5a): `UserControl` (the root of a
 * `.kbcontrol`), `Panel` (dock bands, or absolute placement with `Layout="Absolute"`), `Stack` (flow along a
 * direction) and `ScrollArea` (one scrolling child).
 *
 * They live in the runtime, not in `@ui`, because a dock container reads its children's attached layout
 * values (`Dock`, `X`, `Y`…) from the plan: the renderer gives every element of `@kubuno/views` its view
 * (`__view`) and element id (`__id`).
 *
 * Web rendering of a clickable container: `AccessibleRole="PushButton"` renders a native `<button>` and a
 * web-only `Href` renders a link (`<a href>`); either keeps the keyboard and screen-reader behaviour of the
 * native element. A plain left click on a link stays in the app (the view's `OnClick` decides where to go);
 * a modified or middle click opens the address like any link.
 */
import {
  Children,
  createElement,
  forwardRef,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'

import type { PlanNode } from './plan'
import { BUTTON_BOX_CLASS, DIVIDE_CLASS, DIVIDE_X_CLASS, ensureViewStyles, tokenColor } from './style'
import type { Internals } from './view'

/** The theme surfaces a container may paint (VIEWS-SPEC §4.1: tokens only). */
export type Surface = 'None' | 'Layer' | 'Card' | 'Raised' | 'Well'

const SURFACES: Readonly<Record<string, string>> = {
  Layer: 'var(--color-surface-1)',
  Card: 'var(--color-surface-0)',
  Raised: 'var(--color-surface-0)',
  Well: 'var(--color-surface-2)',
}

/** What every container receives besides its own properties. */
interface ContainerBase {
  children?: ReactNode
  className?: string
  style?: CSSProperties
  /** `Enabled="false"`: a native button is disabled, another container made inert. */
  disabled?: boolean
  tabIndex?: number
  'aria-label'?: string
  role?: string
  href?: string
  onClick?: (e: ReactMouseEvent<HTMLElement>) => void
  surface?: Surface
  /** `CornerRadius` (px): the container's corners, its children clipped to them. */
  cornerRadius?: number
  /** Web `DividerColor`: a line between two children (under each one but the last), in this colour. */
  dividerColor?: string
  /** Web `HtmlTag`: the HTML element of the container (a `section`, a `form`, a list…); `div` by default. */
  as?: string
  /** Web `AccessibleModal`: `aria-modal` (a dialog that keeps the reader inside it). */
  'aria-modal'?: boolean
  /** `AutoSize`: sized to its content (a push-button container like a native button) instead of filling its line. */
  autoSize?: boolean
  /** Web `DataAttributes`: `data-*` attributes of the element (`app-chrome; panel=right`), read by styles and scripts. */
  dataAttributes?: string
  /** @internal - given by the renderer to every element of `@kubuno/views`. */
  __view?: Internals
  /** @internal */
  __id?: string
}

/**
 * `DataAttributes="app-chrome; panel=right"` → `{ 'data-app-chrome': '', 'data-panel': 'right' }`: entries separated by
 * `;`, each a name (an empty attribute) or `name=value`; a name that is not a valid attribute name is ignored.
 */
export function dataAttributesOf(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of (spec ?? '').split(';')) {
    const at = entry.indexOf('=')
    const name = (at < 0 ? entry : entry.slice(0, at)).trim().replace(/^data-/, '')
    if (!/^[a-z][a-z0-9-]*$/.test(name)) continue
    out[`data-${name}`] = at < 0 ? '' : entry.slice(at + 1).trim()
  }
  return out
}

/** A disabled push-button container is drawn faded, like the hand-written rows it replaces (`disabled:opacity-60`). */
const DISABLED_OPACITY = 0.6

/**
 * The element a container renders: a `<button>` for `AccessibleRole="PushButton"`, an `<a>` with `Href`,
 * else a `<div>`. The `role` given by the runtime is dropped when the native element already has it.
 * Its text is centred like any button's: a Label inside chooses its own alignment (TextAlign).
 */
function box(p: ContainerBase, layout: CSSProperties, extra: Record<string, unknown>, ref: Ref<HTMLElement>, divideAcross = false): ReactElement {
  const { className, style, disabled, tabIndex, role, href, onClick, surface, cornerRadius, dividerColor } = p
  const isButton = role === 'button' && !href
  const tag = isButton ? 'button' : href ? 'a' : (p.as ?? 'div')
  const own: CSSProperties = {}
  if (surface && surface !== 'None') own.backgroundColor = SURFACES[surface]
  if (cornerRadius !== undefined && Number.isFinite(cornerRadius) && cornerRadius > 0) {
    own.borderRadius = `${cornerRadius}px`
    own.overflow = 'hidden'
  }
  let cls = className
  if (dividerColor) {
    ensureViewStyles()
    ;(own as Record<string, string>)['--kb-v-divide'] = tokenColor(dividerColor)
    cls = [className, divideAcross ? DIVIDE_X_CLASS : DIVIDE_CLASS].filter(Boolean).join(' ')
  }
  if (isButton) {
    if (disabled) own.opacity = DISABLED_OPACITY
    // Sized like the <div> it replaces: the full width of a block or a stretching column (see VIEW_STYLES); with
    // AutoSize, like a native button (its content's width).
    if (!p.autoSize) {
      ensureViewStyles()
      cls = [cls, BUTTON_BOX_CLASS].filter(Boolean).join(' ')
    }
  } else if (p.autoSize) own.width = 'fit-content'
  const props: Record<string, unknown> = {
    ref,
    className: cls,
    style: { ...layout, ...own, ...style },
    tabIndex,
    'aria-label': p['aria-label'],
    'aria-modal': p['aria-modal'] || undefined,
    ...dataAttributesOf(p.dataAttributes),
    ...extra,
  }
  if (isButton) {
    props.type = 'button'
    props.disabled = disabled || undefined
  } else {
    if (role && !(href && role === 'link')) props.role = role
    if (disabled) {
      props.inert = true
      props['aria-disabled'] = 'true'
    }
  }
  if (href) {
    props.href = href
    props.onClick = (e: ReactMouseEvent<HTMLElement>) => {
      // A plain click stays in the app: the view's handler navigates (SPA routing).
      if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) e.preventDefault()
      onClick?.(e)
    }
  } else if (onClick) {
    props.onClick = onClick
  }
  return createElement(tag, props, p.children)
}

// ── Reading the children's attached layout values from the plan ──

/** The plan node of a rendered child (`KbNode` elements carry it), if any. */
function childNode(child: ReactNode): PlanNode | undefined {
  if (!isValidElement(child)) return undefined
  const node = (child.props as { node?: PlanNode }).node
  return node && typeof node === 'object' && 'el' in node ? node : undefined
}

/** A child's current value of a layout property (literal, or bound, through the view). */
function layoutValue(view: Internals | undefined, node: PlanNode | undefined, name: string): unknown {
  if (!node) return undefined
  const p = node.props?.find((x) => x.n === name)
  if (!p) return undefined
  if (p.v !== undefined) return p.v
  return view?.read?.(node.id, name)
}

// ── Panel / UserControl: dock bands ──

export type DockValue = 'None' | 'Top' | 'Bottom' | 'Left' | 'Right' | 'Fill'

/** Where a docked child goes in the dock grid: `[rowStart, rowEnd, colStart, colEnd]` (1-based lines). */
export interface DockPlacement {
  readonly row: readonly [number, number]
  readonly col: readonly [number, number]
}

export interface DockGrid {
  /** `grid-template-rows` / `-columns`. */
  readonly rows: string
  readonly columns: string
  readonly placements: readonly DockPlacement[]
}

/**
 * The CSS grid of a dock layout (WinForms semantics: each docked child, in document order, takes a band
 * along one edge of the room the previous ones left; `Fill` and undocked children share the rest). Columns
 * follow the inline direction, so `Left` is the inline start: a view mirrors correctly in `ar`/`he`.
 */
export function dockGrid(docks: readonly DockValue[]): DockGrid {
  const tops = docks.filter((d) => d === 'Top').length
  const bottoms = docks.filter((d) => d === 'Bottom').length
  const lefts = docks.filter((d) => d === 'Left').length
  const rights = docks.filter((d) => d === 'Right').length
  // Lines: rows 1..tops+1 for the top bands, then the centre row, then the bottom bands.
  let top = 1
  let bottom = tops + 2 + bottoms // the last row line
  let left = 1
  let right = lefts + 2 + rights
  const placements: DockPlacement[] = []
  for (const d of docks) {
    switch (d) {
      case 'Top': placements.push({ row: [top, top + 1], col: [left, right] }); top++; break
      case 'Bottom': placements.push({ row: [bottom - 1, bottom], col: [left, right] }); bottom--; break
      case 'Left': placements.push({ row: [top, bottom], col: [left, left + 1] }); left++; break
      case 'Right': placements.push({ row: [top, bottom], col: [right - 1, right] }); right--; break
      default: placements.push({ row: [-1, -1], col: [-1, -1] }); break // Fill / None: the centre, below
    }
  }
  const centre: DockPlacement = { row: [tops + 1, tops + 2], col: [lefts + 1, lefts + 2] }
  const resolved = placements.map((p) => (p.row[0] === -1 ? centre : p))
  const rows = [...Array<string>(tops).fill('auto'), 'minmax(0, 1fr)', ...Array<string>(bottoms).fill('auto')].join(' ')
  const columns = [...Array<string>(lefts).fill('auto'), 'minmax(0, 1fr)', ...Array<string>(rights).fill('auto')].join(' ')
  return { rows, columns, placements: resolved }
}

interface PanelProps extends ContainerBase {
  /** `Dock` (default) or `Absolute`. */
  layout?: 'Dock' | 'Absolute'
}

/** The edges of an `Anchor` value (`"Top, Right"`); empty or unreadable = `Top, Left`. */
export interface AnchorEdges {
  readonly top: boolean
  readonly bottom: boolean
  readonly left: boolean
  readonly right: boolean
}

export function parseAnchor(value: unknown): AnchorEdges {
  const words = String(value ?? '').split(/[\s,|]+/).map((w) => w.toLowerCase()).filter(Boolean)
  if (words.length === 0) return { top: true, left: true, bottom: false, right: false }
  return { top: words.includes('top'), bottom: words.includes('bottom'), left: words.includes('left'), right: words.includes('right') }
}

/**
 * Where an undocked child of an absolute `Panel` goes (WinForms anchor semantics, as the desktop's
 * `panel_child_rects`): `X`/`Y`/`Width`/`Height` are authored against the panel's design size; an anchored edge
 * keeps its distance to the panel's edge when the panel is larger or smaller, both edges of an axis stretch the
 * child, neither edge keeps its size and moves by half the change. `X` counts from the inline start (it
 * mirrors in `ar`/`he`), so `Right` is the inline end. Without a design size the child stays where `X`/`Y` say.
 */
export function anchoredStyle(
  anchor: AnchorEdges,
  at: { x: number; y: number; width?: number; height?: number },
  design: { width: number; height: number } | undefined,
): CSSProperties {
  const style: CSSProperties = { position: 'absolute' }
  const axis = (start: boolean, end: boolean, pos: number, size: number | undefined, extent: number | undefined): { pos: string | number; size?: string } => {
    if (extent === undefined || (start && !end)) return { pos }
    if (start && end) return size === undefined ? { pos } : { pos, size: `calc(${size}px + 100% - ${extent}px)` }
    if (end) return { pos: `calc(${pos - extent}px + 100%)` }
    return { pos: `calc(${pos}px + (100% - ${extent}px) / 2)` }
  }
  const h = axis(anchor.left, anchor.right, at.x, at.width, design?.width)
  const v = axis(anchor.top, anchor.bottom, at.y, at.height, design?.height)
  style.insetInlineStart = h.pos
  style.top = v.pos
  if (h.size) style.width = h.size
  if (v.size) style.height = v.size
  return style
}

function dockOf(view: Internals | undefined, child: ReactNode): DockValue {
  const v = String(layoutValue(view, childNode(child), 'Dock') ?? 'None')
  return (['Top', 'Bottom', 'Left', 'Right', 'Fill'].includes(v) ? v : 'None') as DockValue
}

/** The children placed in a dock grid: `kids[k]` goes to the band of `docks[k]`. */
function dockCells(kids: readonly ReactNode[], docks: readonly DockValue[]): { cells: ReactNode[]; grid: DockGrid } {
  const grid = dockGrid(docks)
  const cells = kids.map((child, k) => {
    const at = grid.placements[k]
    const node = childNode(child)
    const style: CSSProperties = {
      gridRow: `${at.row[0]} / ${at.row[1]}`,
      gridColumn: `${at.col[0]} / ${at.col[1]}`,
      display: 'grid',
      minHeight: 0,
      minWidth: 0,
    }
    if (docks[k] === 'Fill' || docks[k] === 'None') style.gridTemplateRows = 'minmax(0, 1fr)'
    return createElement('div', { key: node?.id ?? k, style, 'data-kb-dock': docks[k] }, child)
  })
  return { cells, grid }
}

/** The size a panel's children were authored against: its literal Width × Height, the view's design size for the root. */
function authoredSize(p: PanelProps): { width: number; height: number } | undefined {
  const plan = p.__view?.cell?.plan
  if (!plan || p.__id === undefined) return undefined
  const node = findNode(plan.root, p.__id)
  // Literal values only: a bound size changes at run time, it is not what the children were placed against.
  const num = (name: string): number | undefined => {
    const v = Number(node?.props?.find((x) => x.n === name)?.v)
    return Number.isFinite(v) && v > 0 ? v : undefined
  }
  const w = num('Width')
  const h = num('Height')
  if (w !== undefined && h !== undefined) return { width: w, height: h }
  // The view's root: its design size, when the plan carries it (design builds).
  if (plan.root.id === p.__id && plan.design_size) return { width: plan.design_size[0], height: plan.design_size[1] }
  return undefined
}

function findNode(n: PlanNode, id: string): PlanNode | undefined {
  if (n.id === id) return n
  for (const c of n.children ?? []) {
    const f = findNode(c, id)
    if (f) return f
  }
  for (const list of Object.values(n.slots ?? {})) {
    for (const c of list) {
      const f = findNode(c, id)
      if (f) return f
    }
  }
  return undefined
}

function useDockLayout(p: PanelProps, ref: Ref<HTMLElement>, root: CSSProperties): ReactElement {
  const kids = Children.toArray(p.children)
  const absolute = p.layout === 'Absolute'
  const docks = kids.map((child) => dockOf(p.__view, child))
  const anchors = absolute ? kids.map((child) => parseAnchor(layoutValue(p.__view, childNode(child), 'Anchor'))) : []
  // Absolute: without an authored size, the panel's first layout is the reference (like the desktop's).
  const authored = absolute ? authoredSize(p) : undefined
  const needsReference = absolute && !authored && anchors.some((a, k) => docks[k] === 'None' && (a.right || a.bottom || !a.left || !a.top))
  const own = useRef<HTMLElement | null>(null)
  const [measured, setMeasured] = useState<{ width: number; height: number } | undefined>(undefined)
  useLayoutEffect(() => {
    if (!needsReference || measured || !own.current) return
    const el = own.current
    // After the whole commit: the runtime applies the panel's own Width / Height in its parent's layout effect.
    queueMicrotask(() => {
      // The padding box: what `100%` of an absolutely placed child is.
      if (el.clientWidth > 0 || el.clientHeight > 0) setMeasured({ width: el.clientWidth, height: el.clientHeight })
    })
  })
  const setRef = (el: HTMLElement | null): void => {
    own.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) (ref as { current: HTMLElement | null }).current = el
  }
  const design = authored ?? measured

  if (absolute) {
    const inFlow: ReactNode[] = []
    const inFlowDocks: DockValue[] = []
    const placed: ReactNode[] = []
    kids.forEach((child, k) => {
      if (docks[k] !== 'None') {
        inFlow.push(child)
        inFlowDocks.push(docks[k])
        return
      }
      const node = childNode(child)
      const n = (name: string): number | undefined => {
        const raw = layoutValue(p.__view, node, name)
        if (raw === undefined || raw === '') return undefined
        const v = Number(raw)
        return Number.isFinite(v) ? v : undefined
      }
      const style = anchoredStyle(anchors[k], { x: n('X') ?? 0, y: n('Y') ?? 0, width: n('Width'), height: n('Height') }, design)
      // A stretched axis: the child fills its wrapper whatever its own Width / Height (see VIEW_STYLES).
      const a = anchors[k]
      const stretch = [design && a.left && a.right ? 'x' : '', design && a.top && a.bottom ? 'y' : ''].filter(Boolean).join(' ')
      if (stretch) ensureViewStyles()
      placed.push(createElement('div', { key: node?.id ?? k, style, 'data-kb-anchor': stretch || '' }, child))
    })
    if (inFlow.length === 0) return box({ ...p, children: placed }, { position: 'relative', ...root }, {}, setRef)
    const { cells, grid } = dockCells(inFlow, inFlowDocks)
    const layout: CSSProperties = { position: 'relative', display: 'grid', gridTemplateRows: grid.rows, gridTemplateColumns: grid.columns, minHeight: 0, ...root }
    return box({ ...p, children: [...cells, ...placed] }, layout, {}, setRef)
  }
  // Nothing docked: a plain block, children in flow.
  if (docks.every((d) => d === 'None')) return box(p, root, {}, setRef)
  const { cells, grid } = dockCells(kids, docks)
  const layout: CSSProperties = { display: 'grid', gridTemplateRows: grid.rows, gridTemplateColumns: grid.columns, minHeight: 0, ...root }
  return box({ ...p, children: cells }, layout, {}, setRef)
}

/**
 * `<Panel>`: children docked as bands (`Dock`); with `Layout="Absolute"` the undocked children are placed by
 * `X`/`Y`/`Width`/`Height` and kept at their `Anchor` edges, the docked ones still taking their bands.
 */
export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel(props, ref) {
  return useDockLayout(props, ref, {})
})

/**
 * `<UserControl>`: the root of a `.kbcontrol` - a dock container that fills the room its host gives it
 * (it shrinks with a capped host, so a `Dock="Fill"` child can scroll).
 */
export const UserControl = forwardRef<HTMLElement, PanelProps>(function UserControl(props, ref) {
  return useDockLayout(props, ref, { minHeight: 0, flex: '1 1 auto' })
})

// ── Stack: flow along a direction ──

const DIRECTIONS: Readonly<Record<string, CSSProperties['flexDirection']>> = {
  TopDown: 'column', LeftToRight: 'row', RightToLeft: 'row-reverse', BottomUp: 'column-reverse',
}
const CROSS: Readonly<Record<string, CSSProperties['alignItems']>> = {
  Stretch: 'stretch', Start: 'flex-start', Center: 'center', End: 'flex-end',
}
const JUSTIFY: Readonly<Record<string, CSSProperties['justifyContent']>> = {
  Start: 'flex-start', Center: 'center', End: 'flex-end', SpaceBetween: 'space-between',
}

interface StackProps extends ContainerBase {
  direction?: string
  gap?: number
  crossAlign?: string
  justify?: string
  wrap?: boolean
}

/** `<Stack>`: children along `Direction`, `Gap` px apart; a child with `Stack.Fill="true"` takes the rest. */
export const Stack = forwardRef<HTMLElement, StackProps>(function Stack(p, ref) {
  const direction = DIRECTIONS[p.direction ?? 'TopDown'] ?? 'column'
  const layout: CSSProperties = {
    display: 'flex',
    flexDirection: direction,
    alignItems: CROSS[p.crossAlign ?? 'Stretch'] ?? 'stretch',
  }
  const gap = p.gap ?? 8
  if (gap) layout.gap = `${gap}px`
  if (p.justify && p.justify !== 'Start') layout.justifyContent = JUSTIFY[p.justify]
  if (p.wrap) layout.flexWrap = 'wrap'
  const row = direction === 'row' || direction === 'row-reverse'
  const cross = p.crossAlign && p.crossAlign !== 'Stretch' ? p.crossAlign : undefined
  return box(p, layout, { 'data-kb-stack': row ? 'row' : 'column', 'data-kb-cross': cross }, ref, row)
})

// ── TableLayoutPanel: a grid of cells ──

/** One `ColumnStyles` / `RowStyles` entry → a CSS track (`Absolute 120`, `Percent 50`, `AutoSize`). */
export function trackOf(style: string | undefined, fallback: string): string {
  const m = /^\s*(absolute|percent|autosize)\s*(-?[\d.]+)?\s*$/i.exec(style ?? '')
  if (!m) return fallback
  const n = Number(m[2])
  switch (m[1].toLowerCase()) {
    case 'absolute': return Number.isFinite(n) ? `${n}px` : fallback
    // A share of the room the absolute and auto-sized tracks leave (WinForms percent styles).
    case 'percent': return `minmax(0, ${Number.isFinite(n) && n > 0 ? n : 1}fr)`
    default: return 'auto'
  }
}

/** The grid tracks of a table: `count` tracks, each from its `;`-separated style or the fallback. */
export function tableTracks(styles: string | undefined, count: number, fallback: string): string {
  const list = (styles ?? '').split(';').map((s) => s.trim())
  const n = Math.max(1, Math.floor(count) || 1)
  return Array.from({ length: n }, (_, k) => trackOf(list[k], fallback)).join(' ')
}

interface TableLayoutPanelProps extends ContainerBase {
  columnCount?: number
  rowCount?: number
  columnStyles?: string
  rowStyles?: string
  growStyle?: 'AddRows' | 'AddColumns' | 'FixedSize'
  cellBorderStyle?: 'None' | 'Single'
  cellSpacing?: number
}

/** Where a cell's child sits in it, from its `Anchor` (WinForms: anchored on both sides = stretched) or `Dock`. */
function cellAlign(anchor: AnchorEdges, dock: DockValue): CSSProperties {
  if (dock === 'Fill') return { justifySelf: 'stretch', alignSelf: 'stretch' }
  const axis = (start: boolean, end: boolean): string => (start && end ? 'stretch' : end ? 'end' : start ? 'start' : 'center')
  return { justifySelf: axis(anchor.left, anchor.right), alignSelf: axis(anchor.top, anchor.bottom) }
}

/**
 * `<TableLayoutPanel>`: `ColumnCount` × `RowCount` cells sized by `ColumnStyles` / `RowStyles` (a column without a
 * style gets an equal share, a row without one sizes to its content), the children placed in reading order or at
 * their `TableLayoutPanel.Row` / `.Column`, spanning `RowSpan` / `ColumnSpan`; more children than cells add rows
 * (`GrowStyle="AddRows"`) or columns (`AddColumns`). Columns follow the reading direction.
 */
export const TableLayoutPanel = forwardRef<HTMLElement, TableLayoutPanelProps>(function TableLayoutPanel(p, ref) {
  const kids = Children.toArray(p.children)
  const columns = Math.max(1, Math.floor(p.columnCount ?? 2) || 1)
  const rows = Math.max(1, Math.floor(p.rowCount ?? 2) || 1)
  const byColumn = p.growStyle === 'AddColumns'
  const spacing = p.cellSpacing ?? 0
  const lines = p.cellBorderStyle === 'Single'
  const layout: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: tableTracks(p.columnStyles, columns, 'minmax(0, 1fr)'),
    gridTemplateRows: tableTracks(p.rowStyles, rows, 'auto'),
    gridAutoFlow: byColumn ? 'column' : 'row',
    ...(byColumn ? { gridAutoColumns: 'minmax(0, 1fr)' } : { gridAutoRows: 'auto' }),
  }
  if (spacing > 0) layout.gap = `${spacing}px`
  if (lines) {
    layout.borderTop = '1px solid var(--color-border)'
    layout.borderInlineStart = '1px solid var(--color-border)'
  }
  const cells = kids.map((child, k) => {
    const node = childNode(child)
    const num = (name: string): number | undefined => {
      const raw = layoutValue(p.__view, node, name)
      if (raw === undefined || raw === '') return undefined
      const v = Number(raw)
      return Number.isFinite(v) ? v : undefined
    }
    const row = num('TableLayoutPanel.Row')
    const col = num('TableLayoutPanel.Column')
    const rowSpan = Math.max(1, Math.floor(num('TableLayoutPanel.RowSpan') ?? 1))
    const colSpan = Math.max(1, Math.floor(num('TableLayoutPanel.ColumnSpan') ?? 1))
    const style: CSSProperties = {
      display: 'grid',
      minWidth: 0,
      minHeight: 0,
      gridRow: row !== undefined && row >= 0 ? `${row + 1} / span ${rowSpan}` : `span ${rowSpan}`,
      gridColumn: col !== undefined && col >= 0 ? `${col + 1} / span ${colSpan}` : `span ${colSpan}`,
    }
    if (lines) {
      style.borderBottom = '1px solid var(--color-border)'
      style.borderInlineEnd = '1px solid var(--color-border)'
    }
    const inner = createElement('div', { style: { ...cellAlign(parseAnchor(layoutValue(p.__view, node, 'Anchor')), dockOf(p.__view, child)), display: 'grid', minWidth: 0 } }, child)
    return createElement('div', { key: node?.id ?? k, style, 'data-kb-cell': '' }, inner)
  })
  return box({ ...p, children: cells }, layout, {}, ref)
})

// ── ScrollArea: one scrolling child ──

interface ScrollAreaProps extends ContainerBase {
  /** `Corner`: radius of the scrolling viewport, px. */
  corner?: number
  /** Web: `scrollbar-gutter`. */
  gutter?: 'Auto' | 'Stable' | 'StableBothEdges'
  /** Web: which axes scroll. */
  scrollBars?: 'Vertical' | 'Horizontal' | 'Both'
  /** Web `ScrollBarStyle`: `Inset` = the thin bar inset from the rounded corners (the host's `kb-inset-scroll`). */
  scrollBarStyle?: 'Default' | 'Inset'
}

const GUTTERS: Readonly<Record<string, CSSProperties['scrollbarGutter']>> = {
  Stable: 'stable', StableBothEdges: 'stable both-edges',
}

/** `<ScrollArea>`: its single child scrolls inside it (it shrinks with its container: `min-height: 0`). */
export const ScrollArea = forwardRef<HTMLElement, ScrollAreaProps>(function ScrollArea(p, ref) {
  const axes = p.scrollBars ?? 'Vertical'
  // Only the axes asked for are set (`overflow-y: auto` alone, as hand-written lists do).
  const layout: CSSProperties =
    axes === 'Vertical' ? { overflowY: 'auto' } : axes === 'Horizontal' ? { overflowX: 'auto' } : { overflow: 'auto' }
  layout.minHeight = 0
  if (p.corner) layout.borderRadius = `${p.corner}px`
  const gutter = p.gutter ? GUTTERS[p.gutter] : undefined
  if (gutter) layout.scrollbarGutter = gutter
  const q = p.scrollBarStyle === 'Inset' ? { ...p, className: [p.className, 'kb-inset-scroll'].filter(Boolean).join(' ') } : p
  return box(q, layout, { 'data-kb-scroll': '' }, ref)
})
