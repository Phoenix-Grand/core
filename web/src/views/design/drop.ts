/**
 * Where a drop lands (a Toolbox item, or an element dragged to another place), per container kind - pure
 * (vskubuno docs/DESIGNER.md §4, §10 "Toolbox drop", transposed to the web containers):
 *
 * - routing: the element under the pointer when it takes children, else its parent (a leaf → before / after it
 *   in its parent, by the pointer's half). A `SingleWidget` container (`ScrollArea`, `Card`) delegates to its
 *   child when that child is a container, and is a valid target only while empty;
 * - `Stack` (`Flow`): an insertion line between children, perpendicular to `Direction` (reversed by
 *   `RightToLeft` / `BottomUp`, and by a right-to-left page for a row);
 * - `Panel` / `UserControl` (dock): a line between children in document order (the axis read from how the
 *   children spread, `flow_axis`); when the dragged element has `Dock`, the band it would take is reported too;
 * - `Panel Layout="Absolute"`: free X / Y (whole CSS px of the view, inline-start based: from the right edge in
 *   right-to-left), the marker a ghost of the element at the pointer;
 * - not a valid child (gated children, a filled `SingleWidget`, a leaf), or the dragged element itself / inside it:
 *   `valid: false`, drawn as "not allowed".
 */
import {
  childEntries,
  contains,
  flowAxisOf,
  heightOf,
  hitTest,
  isAncestorOrSelf,
  ordinalOf,
  parentIdOf,
  rect,
  visibleRect,
  widthOf,
  type LayoutEntry,
  type LayoutMap,
  type Rect,
} from './geometry'
import { containerKind, literal, type Catalog, type ContainerKind, type NodeInfo } from './model'

export interface DropContext {
  readonly map: LayoutMap
  readonly nodes: ReadonlyMap<string, NodeInfo>
  readonly catalog: Catalog
  /** View CSS px per page px is `1 / zoom`. */
  readonly zoom: number
  /** The view's frame (page px): a point inside it over no element targets the view's root. */
  readonly frame?: Rect | null
}

/** What is dragged: a new element (its name; `null` while unknown, the HTML5 fallback before the drop) or an element. */
export type DragSubject = { readonly kind: 'new'; readonly component: string | null } | { readonly kind: 'move'; readonly id: string }

export interface DropTarget {
  readonly valid: boolean
  readonly parentId: string
  readonly index: number
  /** Page px: an insertion line, the container's box, or a ghost of the new element. */
  readonly marker: Rect
  readonly markerKind: 'line' | 'box' | 'ghost'
  /** Absolute containers: the element's new `X` / `Y` (view CSS px, whole). */
  readonly xy?: readonly [number, number]
  /** A docked element being moved: the band it would take in the target container. */
  readonly band?: Rect
  readonly container: ContainerKind
}

/** Thickness of an insertion line. */
export const MARKER_THICKNESS = 3

/** The size a new element is dropped at in an absolute container (`design_defaults.size`, else the desktop's rule). */
export function dropSize(catalog: Catalog, component: string | null): [number, number] {
  const c = component ? catalog.get(component) : undefined
  if (c?.dropSize) return [c.dropSize[0], c.dropSize[1]]
  if (c && c.children !== 'None') return [200, 100]
  return [120, 36]
}

/** Whether `component` may be a child of `containerId` (registry rules), given the children it has. */
export function canHold(ctx: DropContext, containerId: string, component: string | null, existing: number): boolean {
  const n = ctx.nodes.get(containerId)
  const c = n ? ctx.catalog.get(n.el) : undefined
  if (!c) return n === undefined // a property element (not in the plan): its owner decides; nothing to check here
  if (component !== null && !ctx.catalog.get(component)) return false // not an element of this project
  if (c.children === 'None') return false
  if (c.children === 'SingleWidget') return existing === 0
  if (component === null) return true
  if (c.allowed.length > 0) return c.allowed.includes(component)
  return !ctx.catalog.isGated(component)
}

/** The visible box of an element (its first painted instance). */
function boxOf(map: LayoutMap, id: string): Rect | null {
  const e = map.byId.get(id)?.[0]
  return e ? visibleRect(e) ?? e.bounds : null
}

function entryOf(map: LayoutMap, id: string): LayoutEntry | undefined {
  return map.byId.get(id)?.[0]
}

/** The insertion slot among painted siblings along an axis: the position in `siblings` and the line. */
export function flowSlot(
  siblings: readonly Rect[],
  container: Rect,
  axis: 'horizontal' | 'vertical',
  reversed: boolean,
  x: number,
  y: number,
  thickness = MARKER_THICKNESS,
): { position: number; marker: Rect } {
  const p = axis === 'horizontal' ? x : y
  const mid = (r: Rect): number => (axis === 'horizontal' ? (r.left + r.right) / 2 : (r.top + r.bottom) / 2)
  // Siblings visually before the point, in document order.
  const position = siblings.filter((r) => (reversed ? mid(r) > p : mid(r) < p)).length
  // Edges along the axis in the visual direction: `start` is where a child begins visually.
  const start = (r: Rect): number => (axis === 'horizontal' ? (reversed ? r.right : r.left) : reversed ? r.bottom : r.top)
  const end = (r: Rect): number => (axis === 'horizontal' ? (reversed ? r.left : r.right) : reversed ? r.top : r.bottom)
  let at: number
  if (siblings.length === 0) at = axis === 'horizontal' ? (reversed ? container.right : container.left) : reversed ? container.bottom : container.top
  else if (position === 0) at = start(siblings[0])
  else if (position >= siblings.length) at = end(siblings[siblings.length - 1])
  else at = (end(siblings[position - 1]) + start(siblings[position])) / 2
  const half = thickness / 2
  const marker = axis === 'horizontal' ? rect(at - half, container.top, at + half, container.bottom) : rect(container.left, at - half, container.right, at + half)
  return { position, marker }
}

/**
 * The index an insertion slot is, in `edit::insert_child` / `move_element` terms (Vec semantics, the moved
 * element taken out first): before the sibling at `position` → its element-child ordinal; after the last → the
 * last's ordinal + 1 (or the container's child count when nothing is painted).
 */
export function slotIndex(ctx: DropContext, parentId: string, siblingIds: readonly string[], position: number, moved: string | null): number {
  let index: number
  if (position < siblingIds.length) index = ordinalOf(siblingIds[position])
  else if (siblingIds.length > 0) index = ordinalOf(siblingIds[siblingIds.length - 1]) + 1
  else index = ctx.nodes.get(parentId)?.children.filter((c) => c !== moved).length ?? 0
  if (moved !== null && parentIdOf(moved) === parentId && ordinalOf(moved) < index) index--
  return index
}

function invalid(parentId: string, marker: Rect, container: ContainerKind): DropTarget {
  return { valid: false, parentId, index: 0, marker, markerKind: 'box', container }
}

/** The band a docked element takes along its edge of a container (inline edges follow the direction). */
export function dockBand(container: Rect, dock: string, size: Rect, rtl: boolean): Rect | null {
  const w = widthOf(size)
  const h = heightOf(size)
  const startLeft = !rtl
  switch (dock) {
    case 'Top': return rect(container.left, container.top, container.right, Math.min(container.bottom, container.top + h))
    case 'Bottom': return rect(container.left, Math.max(container.top, container.bottom - h), container.right, container.bottom)
    case 'Left': return startLeft ? rect(container.left, container.top, Math.min(container.right, container.left + w), container.bottom) : rect(Math.max(container.left, container.right - w), container.top, container.right, container.bottom)
    case 'Right': return startLeft ? rect(Math.max(container.left, container.right - w), container.top, container.right, container.bottom) : rect(container.left, container.top, Math.min(container.right, container.left + w), container.bottom)
    case 'Fill': return container
    default: return null
  }
}

/** Where a drop at `(x, y)` lands, or `null` when the point is over no element of the view. */
export function computeDropTarget(ctx: DropContext, subject: DragSubject, x: number, y: number): DropTarget | null {
  const moved = subject.kind === 'move' ? subject.id : null
  const component = subject.kind === 'move' ? ctx.nodes.get(subject.id)?.el ?? null : subject.component
  const hit = hitTest(ctx.map, x, y) ?? (ctx.frame && contains(ctx.frame, x, y) && ctx.nodes.has('') ? { id: '', bounds: ctx.frame } : null)
  if (!hit) return null

  // Routing: into the element under the pointer when it takes children, else next to it in its parent.
  let targetId: string
  if (moved !== null && isAncestorOrSelf(moved, hit.id)) {
    if (hit.id !== moved) {
      // Inside the dragged element: it cannot be dropped into itself.
      return invalid(moved, boxOf(ctx.map, moved) ?? hit.bounds, containerKind(ctx.nodes, ctx.catalog, moved))
    }
    const parent = parentIdOf(moved)
    if (parent === null) return null // the root does not move
    targetId = parent
  } else {
    targetId = containerKind(ctx.nodes, ctx.catalog, hit.id) === 'leaf' && hit.id !== '' ? parentIdOf(hit.id) ?? '' : hit.id
  }

  // A SingleWidget delegates to its child when that child is a container.
  for (let guard = 0; guard < 32; guard++) {
    if (containerKind(ctx.nodes, ctx.catalog, targetId) !== 'single') break
    const child = ctx.nodes.get(targetId)?.children[0]
    if (child === undefined || child === moved) break
    const kind = containerKind(ctx.nodes, ctx.catalog, child)
    if (kind === 'leaf') break
    targetId = child
  }

  const kind = containerKind(ctx.nodes, ctx.catalog, targetId)
  const box = boxOf(ctx.map, targetId) ?? (targetId === '' && ctx.frame ? ctx.frame : null)
  if (!box) return null
  if (kind === 'leaf') return invalid(targetId, box, kind)

  const allChildren = ctx.nodes.get(targetId)?.children ?? []
  const others = allChildren.filter((c) => c !== moved)
  if (kind === 'single') {
    const valid = others.length === 0 && canHold(ctx, targetId, component, 0)
    return { valid, parentId: targetId, index: 0, marker: box, markerKind: 'box', container: kind }
  }

  const valid = canHold(ctx, targetId, component, others.length)
  const container = entryOf(ctx.map, targetId)
  const rtl = container?.rtl ?? false

  if (kind === 'absolute') {
    const z = ctx.zoom > 0 ? ctx.zoom : 1
    const localX = Math.max(0, Math.round((rtl ? box.right - x : x - box.left) / z))
    const localY = Math.max(0, Math.round((y - box.top) / z))
    let w: number
    let h: number
    const movedBox = moved !== null ? entryOf(ctx.map, moved)?.bounds : undefined
    if (movedBox) {
      w = widthOf(movedBox)
      h = heightOf(movedBox)
    } else {
      const [dw, dh] = dropSize(ctx.catalog, component)
      w = dw * z
      h = dh * z
    }
    const marker = rtl ? rect(x - w, y, x, y + h) : rect(x, y, x + w, y + h)
    // Placement is X / Y: a new element is appended (painted on top); an element of this container keeps its slot.
    const index = moved !== null && parentIdOf(moved) === targetId ? ordinalOf(moved) : allChildren.length
    return { valid, parentId: targetId, index, marker, markerKind: 'ghost', xy: [localX, localY], container: kind }
  }

  // Flow, dock and other lists: an insertion line between the painted children.
  const painted = childEntries(ctx.map, targetId).filter((e) => e.id !== moved)
  const rects = painted.map((e) => e.bounds)
  let axis: 'horizontal' | 'vertical'
  let reversed: boolean
  if (kind === 'flow') {
    const dir = String(literal(ctx.nodes.get(targetId)?.node, 'Direction') ?? 'TopDown')
    axis = dir === 'LeftToRight' || dir === 'RightToLeft' ? 'horizontal' : 'vertical'
    reversed = axis === 'horizontal' ? (dir === 'RightToLeft') !== rtl : dir === 'BottomUp'
  } else {
    axis = flowAxisOf(rects)
    reversed = axis === 'horizontal' && rtl
  }
  const { position, marker } = flowSlot(rects, box, axis, reversed, x, y)
  const index = slotIndex(ctx, targetId, painted.map((e) => e.id), position, moved)
  let band: Rect | undefined
  if (kind === 'dock' && moved !== null) {
    const dock = literal(ctx.nodes.get(moved)?.node, 'Dock')
    const movedBox = entryOf(ctx.map, moved)?.bounds
    if (typeof dock === 'string' && movedBox) band = dockBand(box, dock, movedBox, rtl) ?? undefined
  }
  return { valid, parentId: targetId, index, marker, markerKind: 'line', container: kind, ...(band ? { band } : {}) }
}

/** Whether a move's target leaves the element where it is (a reorder onto its own slot). */
export function isNoOpMove(moved: string, target: DropTarget): boolean {
  return parentIdOf(moved) === target.parentId && ordinalOf(moved) === target.index
}
