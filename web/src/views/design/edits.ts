/**
 * Gestures → edit intents (vskubuno docs/DESIGNER.md §3: "designer = gesture → intent; language server = intent →
 * text"): the page never writes text, it posts `EditOp`s the host applies to the buffer. Pure functions:
 * move / resize / nudge ops, deletions, the Toolbox skeleton markup, and the keyboard map.
 *
 * Every value is a whole CSS px of the view (page px divided by the zoom, rounded - a pointer delta at a zoom or a
 * fractional scale is fractional). `X` is inline-start based (`insetInlineStart`): in a right-to-left container a
 * move to the right decreases it.
 */
import { handleEdges, topLevelIds, widthOf, heightOf, type Handle, type Rect } from './geometry'
import type { BatchOp, EditOp, PageMessage } from './protocol'

/** The current literal placement values of an element (`undefined` = absent / bound). */
export interface Placement {
  readonly X?: number
  readonly Y?: number
  readonly Width?: number
  readonly Height?: number
}

const num = (n: number): string => String(Math.round(n))

function setAttr(elementId: string, name: string, value: number): BatchOp {
  return { kind: 'setAttribute', elementId, name, value: num(value) }
}

/** The ops of a move by a page delta: one `setAttribute` per axis whose rounded value changes. */
export function moveOps(id: string, at: Placement, dx: number, dy: number, zoom: number, rtl: boolean): BatchOp[] {
  const z = zoom > 0 ? zoom : 1
  const ops: BatchOp[] = []
  const x0 = at.X ?? 0
  const y0 = at.Y ?? 0
  const x = Math.round(x0 + (rtl ? -dx : dx) / z)
  const y = Math.round(y0 + dy / z)
  if (x !== x0) ops.push(setAttr(id, 'X', x))
  if (y !== y0) ops.push(setAttr(id, 'Y', y))
  return ops
}

/**
 * The ops of a resize from `before` to `after` (page px) through handle `h`: `Width` / `Height` for the edges
 * it moved, and `X` / `Y` when the start / top edge moved and the element is placed by them (`absolute`).
 * A size without a literal value starts from the painted one.
 */
export function resizeOps(id: string, at: Placement, before: Rect, after: Rect, h: Handle, zoom: number, rtl: boolean, absolute: boolean): BatchOp[] {
  const z = zoom > 0 ? zoom : 1
  const e = handleEdges(h)
  const ops: BatchOp[] = []
  // The inline-start edge is the left one, or the right one in right-to-left.
  const startMoved = rtl ? e.right : e.left
  if (absolute && startMoved) {
    const x0 = at.X ?? 0
    const delta = rtl ? before.right - after.right : after.left - before.left
    const x = Math.round(x0 + delta / z)
    if (x !== x0) ops.push(setAttr(id, 'X', x))
  }
  if (absolute && e.top) {
    const y0 = at.Y ?? 0
    const y = Math.round(y0 + (after.top - before.top) / z)
    if (y !== y0) ops.push(setAttr(id, 'Y', y))
  }
  if (e.left || e.right) {
    const w0 = at.Width ?? Math.round(widthOf(before) / z)
    const w = Math.max(1, Math.round(w0 + (widthOf(after) - widthOf(before)) / z))
    if (w !== at.Width) ops.push(setAttr(id, 'Width', w))
  }
  if (e.top || e.bottom) {
    const h0 = at.Height ?? Math.round(heightOf(before) / z)
    const hh = Math.max(1, Math.round(h0 + (heightOf(after) - heightOf(before)) / z))
    if (hh !== at.Height) ops.push(setAttr(id, 'Height', hh))
  }
  return ops
}

/**
 * Which grab handles resize an element: every one for a child of an absolute container; otherwise only the
 * end / bottom edges that hold an explicit size (`Width` → the inline-end edge, `Height` → the bottom edge, and
 * the corner between them when both).
 */
export function resizableHandles(absolute: boolean, at: Placement, rtl: boolean): Set<Handle> {
  if (absolute) return new Set<Handle>(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'])
  const out = new Set<Handle>()
  const end: Handle = rtl ? 'w' : 'e'
  if (at.Width !== undefined) out.add(end)
  if (at.Height !== undefined) out.add('s')
  if (at.Width !== undefined && at.Height !== undefined) out.add(rtl ? 'sw' : 'se')
  return out
}

/** The arrow-key nudge of the selected absolute children (1 px, Shift: 8): `null` when nothing moves. */
export function nudgeMessage(items: readonly { id: string; at: Placement; rtl: boolean }[], key: string, shift: boolean): PageMessage | null {
  const step = shift ? 8 : 1
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0
  if (dx === 0 && dy === 0) return null
  const ops = items.flatMap((it) => moveOps(it.id, it.at, dx, dy, 1, it.rtl))
  return ops.length ? { type: 'editRequests', gesture: 'move', ops } : null
}

/** Delete of a selection: one `removeElement` for one element, a `delete` batch for several; the root never. */
export function deleteMessage(ids: readonly string[]): PageMessage | null {
  const top = topLevelIds(ids)
  if (top.length === 0) return null
  if (top.length === 1) return { type: 'editRequest', op: { kind: 'removeElement', elementId: top[0] } }
  return { type: 'editRequests', gesture: 'delete', ops: top.map((elementId) => ({ kind: 'removeElement', elementId })) }
}

/** An `editRequest` inserting `xml` into `parentId` at `index`. */
export function insertMessage(parentId: string, index: number, xml: string): PageMessage {
  const op: EditOp = { kind: 'insertChild', elementId: '', parentId, index, xml }
  return { type: 'editRequest', op }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/

/**
 * The markup a Toolbox drop inserts (the desktop's `skeleton_xml`): `<Name/>` in a flow or other container;
 * `<Name X="…" Y="…" Width="…" Height="…" Anchor="Top, Left"/>` in an absolute one (placed at the drop point
 * with its default size and Windows Forms' default anchoring). A non-visual element never gets a place.
 */
export function skeletonXml(component: string, xy: readonly [number, number] | null | undefined, size: readonly [number, number], nonVisual = false): string {
  if (!NAME.test(component)) throw new Error(`not an element name: ${component}`)
  if (!xy || nonVisual) return `<${component}/>`
  return `<${component} X="${num(xy[0])}" Y="${num(xy[1])}" Width="${num(size[0])}" Height="${num(size[1])}" Anchor="Top, Left"/>`
}

/** The element a Toolbox text names: `kubuno-toolbox:Button`, or markup `<Button …/>`; `null` otherwise. */
export function toolboxComponentOf(text: string): string | null {
  const t = text.trim()
  const m = /^kubuno-toolbox:([A-Za-z_][A-Za-z0-9_.]*)$/.exec(t) ?? /^<([A-Za-z_][A-Za-z0-9_.]*)[\s/>]/.exec(t)
  return m ? m[1] : null
}

// ── Keyboard ──

export interface KeyInput {
  readonly key: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly alt: boolean
}

export interface KeyContext {
  /** The selection, primary first. */
  readonly selection: readonly string[]
  /** The selected elements placed by X / Y, with their literal placement and direction. */
  readonly absolute: readonly { id: string; at: Placement; rtl: boolean }[]
  readonly parentOf: (id: string) => string | null
  /** The painted siblings of an element (Ctrl+A: select them all). */
  readonly siblingsOf: (id: string) => readonly string[]
}

export interface KeyResult {
  /** Messages to post (the selection change, if any, is posted by the caller with fresh bounds). */
  readonly messages: PageMessage[]
  /** A new selection (primary first). */
  readonly select?: readonly string[]
  /** The page used the key (prevent its default). */
  readonly handled: boolean
}

const COMMANDS: Readonly<Record<string, 'copy' | 'cut' | 'paste' | 'duplicate'>> = { c: 'copy', x: 'cut', v: 'paste', d: 'duplicate' }
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'])

/** What a key does on the design surface. Keys it does not use go to the host (`unhandledKey`). */
export function keyMessages(k: KeyInput, ctx: KeyContext): KeyResult {
  const primary = ctx.selection[0] ?? null
  if (MODIFIERS.has(k.key)) return { messages: [], handled: false }
  if (!k.ctrl && !k.alt) {
    if (k.key === 'Delete') {
      const m = deleteMessage(ctx.selection)
      return { messages: m ? [m] : [], handled: true }
    }
    if (k.key.startsWith('Arrow')) {
      const m = nudgeMessage(ctx.absolute, k.key, k.shift)
      return { messages: m ? [m] : [], handled: true }
    }
    if (k.key === 'Escape') {
      if (primary === null) return { messages: [], handled: true }
      const parent = ctx.parentOf(primary)
      return { messages: [], select: [parent ?? primary], handled: true }
    }
  }
  if (k.ctrl && !k.alt && !k.shift) {
    const name = COMMANDS[k.key.toLowerCase()]
    if (name) return { messages: [{ type: 'command', name, elementId: primary }], handled: true }
    if (k.key.toLowerCase() === 'a') {
      const base = primary === null || primary === '' ? null : primary
      const all = base === null ? ctx.siblingsOf('') : ctx.siblingsOf(base)
      if (all.length === 0) return { messages: [], handled: true }
      const ordered = base !== null && all.includes(base) ? [base, ...all.filter((x) => x !== base)] : [...all]
      return { messages: [], select: ordered, handled: true }
    }
  }
  return { messages: [{ type: 'unhandledKey', key: k.key, ctrl: k.ctrl, shift: k.shift, alt: k.alt }], handled: false }
}
