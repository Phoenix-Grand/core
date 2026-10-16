/**
 * Draws the adorners of the design surface into its overlay layer (vskubuno docs/DESIGNER.md §9 "Adorners",
 * WEB-VIEWS.md §4.3): faint outlines of containers that paint nothing, the hover stroke, the dashed outline of
 * the primary selection's parent, a frame 3 px outside each selected element with its 8 grab handles (filled when
 * the handle resizes the element), and the drag feedback (insertion marker, dock band, move / resize ghost with its
 * size). Rectangles are page (viewport) px; the layer is positioned at `origin`.
 */
import { handleRects, selectionFrame, type Handle, type Rect } from './geometry'

export interface SelectedAdorner {
  readonly bounds: Rect
  readonly primary: boolean
  readonly resizable: ReadonlySet<Handle>
  /** Name tag: the control's type and, when set, its `x:Name`. */
  readonly label?: Label
}

/** A rectangle that may carry a name tag (its control's type / `x:Name`). */
export interface TaggedRect {
  readonly rect: Rect
  readonly label?: Label
}

/** A control's identity for a corner tag: its type (`Panel`, `Button`…) and optional `x:Name`. */
export interface Label {
  readonly type: string
  readonly name?: string
}

/** A faint container outline, with its nesting depth (for the alternating tint that keeps nested frames apart). */
export interface OutlineAdorner {
  readonly rect: Rect
  readonly depth: number
}

export interface AdornerSpec {
  readonly outlines: readonly OutlineAdorner[]
  readonly hover: TaggedRect | null
  readonly parent: TaggedRect | null
  readonly selected: readonly SelectedAdorner[]
  readonly marker?: { readonly rect: Rect; readonly kind: 'line' | 'box' | 'ghost'; readonly valid: boolean } | null
  readonly band?: Rect | null
  readonly ghost?: Rect | null
  readonly tip?: { readonly x: number; readonly y: number; readonly text: string } | null
}

function box(layer: HTMLElement, origin: { left: number; top: number }, r: Rect, cls: string, attrs: Record<string, string> = {}): HTMLElement {
  const el = layer.ownerDocument.createElement('div')
  el.className = `kbd-ad ${cls}`
  el.style.left = `${r.left - origin.left}px`
  el.style.top = `${r.top - origin.top}px`
  el.style.width = `${Math.max(0, r.right - r.left)}px`
  el.style.height = `${Math.max(0, r.bottom - r.top)}px`
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  layer.appendChild(el)
  return el
}

/**
 * Draws a name tag anchored to the top-left corner of `r` (the control's type, and its `x:Name` when set): a small
 * flag like a WinForms / Figma designer, so each outline can be told from the others. It sits just above the frame,
 * or inside it when there is no room above (the overlay clips its content). Never takes pointer events.
 */
function tag(layer: HTMLElement, origin: { left: number; top: number }, r: Rect, label: Label, cls: string): void {
  const el = layer.ownerDocument.createElement('div')
  el.className = `kbd-tag ${cls}`
  el.appendChild(layer.ownerDocument.createTextNode(label.type))
  if (label.name) {
    const name = layer.ownerDocument.createElement('span')
    name.className = 'kbd-tag-name'
    name.textContent = label.name
    el.append(' ', name)
  }
  const top = r.top - origin.top
  el.style.left = `${Math.max(0, r.left - origin.left)}px`
  el.style.top = `${top}px`
  // Hang the tag above the frame unless it would be clipped at the top of the overlay, then drop it inside.
  if (top >= 16) el.dataset.above = 'true'
  layer.appendChild(el)
}

/** Replaces the layer's adorners with the ones `spec` describes. */
export function drawAdorners(layer: HTMLElement, origin: { left: number; top: number }, spec: AdornerSpec): void {
  layer.replaceChildren()
  for (const o of spec.outlines) box(layer, origin, o.rect, 'kbd-outline', { 'data-depth': String(o.depth % 2) })
  if (spec.parent) {
    box(layer, origin, spec.parent.rect, 'kbd-parent')
    if (spec.parent.label) tag(layer, origin, spec.parent.rect, spec.parent.label, 'kbd-tag-parent')
  }
  if (spec.hover) {
    // Hover uses the same outset frame as a selection (`selectionFrame`), so the two boxes share the exact same
    // width, height and margins - they differ only by opacity (see `.kbd-hover` / `.kbd-sel`), not by geometry.
    const frame = selectionFrame(spec.hover.rect)
    box(layer, origin, frame, 'kbd-hover')
    if (spec.hover.label) tag(layer, origin, frame, spec.hover.label, 'kbd-tag-hover')
  }
  if (spec.band) box(layer, origin, spec.band, 'kbd-band')
  for (const s of spec.selected) {
    const frame = selectionFrame(s.bounds)
    box(layer, origin, frame, 'kbd-sel', { 'data-primary': String(s.primary) })
    if (s.label) tag(layer, origin, frame, s.label, s.primary ? 'kbd-tag-sel kbd-tag-primary' : 'kbd-tag-sel')
    for (const { handle, rect } of handleRects(frame)) {
      box(layer, origin, rect, 'kbd-handle', { 'data-handle': handle, 'data-resizable': String(s.resizable.has(handle)) })
    }
  }
  if (spec.ghost) box(layer, origin, spec.ghost, 'kbd-ghost')
  if (spec.marker) {
    box(layer, origin, spec.marker.rect, 'kbd-marker', { 'data-kind': spec.marker.kind, 'data-valid': String(spec.marker.valid) })
  }
  if (spec.tip) {
    const el = layer.ownerDocument.createElement('div')
    el.className = 'kbd-size-tip'
    el.style.left = `${spec.tip.x - origin.left + 12}px`
    el.style.top = `${spec.tip.y - origin.top + 14}px`
    el.textContent = spec.tip.text
    layer.appendChild(el)
  }
}

/** The cursor of a grab handle. */
export function handleCursor(h: Handle): string {
  return h === 'n' || h === 's' ? 'ns-resize' : h === 'e' || h === 'w' ? 'ew-resize' : h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize'
}
