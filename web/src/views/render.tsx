/**
 * The renderer: one renderer for compiled plans (production, dev server) and interpreted plans (the
 * designer) - the only difference is whether a binding has a precompiled getter (WEB-VIEWS §2.1).
 *
 * Granularity: every element subscribes to its view's store and recomputes the values it reads; it
 * re-renders only when one of them changed (elements are memoised, a parent's render does not re-render
 * them). The view root re-renders on every change, to run the code-behind's `use()`. The one exception is
 * `ReactHost`: the React component it hosts renders again with its view root, as it did as a child of the TSX
 * screen the view replaces (it may read state nothing notifies the view of - a registry a module fills later).
 */
import {
  Fragment,
  createContext,
  createElement,
  memo,
  use,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react'

import { UNSET, readBinding, writeBinding, type Scope } from './binding'
import { applyArgs, makeArgs, type ArgsContext } from './events'
import type { IconValue, PlanEvent, PlanNode, PlanProp, PlanResArg, ViewPlan } from './plan'
import { hostTranslator, onResourcesChanged, resolveComponent, resolveIcon, resolveResource, resourcesVersion } from './resolve'
import { CELL, KB, forgetMemos, handleFor, notify, notifyElements, setComponentFactory, setLive, type Cell, type Internals, type View, type ViewClass } from './view'
import { ELEVATIONS, HOVER_CLASS, PRESSED_CLASS, ensureViewStyles, tokenColor } from './style'

type Props = Record<string, unknown>
type AnyComponent = ComponentType<Props>

const ViewContext = createContext<Internals | null>(null)
/**
 * How many times the nearest view root has rendered. Only `ReactHost` elements read it: a context change reaches
 * them through the memoised elements, so the hosted component renders again whenever its view root does - the
 * re-render a TSX child got from its parent, which a hosted component may depend on (`<Slot>` reads its registry
 * on render: a dialog a module registers after the first render appears on the next render of the screen).
 */
const RootRender = createContext(0)
const dev = (): boolean => (import.meta as { env?: { DEV?: boolean } }).env?.DEV !== false

// ── Plan helpers ──

const indexes = new WeakMap<ViewPlan, Map<string, PlanNode>>()

/** Every node of a plan by element id. */
function nodeIndex(plan: ViewPlan): Map<string, PlanNode> {
  let index = indexes.get(plan)
  if (!index) {
    index = new Map()
    const add = (n: PlanNode): void => {
      index!.set(n.id, n)
      n.children?.forEach(add)
      n.items?.list.forEach(add)
      Object.values(n.slots ?? {}).forEach((l) => l.forEach(add))
    }
    add(plan.root)
    plan.tray?.forEach(add)
    indexes.set(plan, index)
  }
  return index
}

/** The properties that apply to a node now: base, size-class values, design values (design mode). */
function effectiveProps(i: Internals, node: PlanNode): readonly PlanProp[] {
  let list: readonly PlanProp[] = node.props ?? []
  const sc = node.sc?.[i.sizeClass]
  if (sc?.length) list = [...list.filter((p) => !sc.some((s) => s.n === p.n)), ...sc]
  if (i.design && node.design?.length) {
    const d = node.design
    list = [...list.filter((p) => !d.some((s) => s.n === p.n)), ...d]
  }
  return list
}

/** All properties evaluated by a node's snapshot: its own and its adapter items' (recursively). */
function snapshotProps(i: Internals, node: PlanNode, out: PlanProp[] = []): PlanProp[] {
  out.push(...effectiveProps(i, node))
  for (const item of node.items?.list ?? []) {
    snapshotProps(i, item, out)
    // Nested items (sub-menus, sub-trees) are children of the item, at any depth (WV-5b: TreeView levels).
    const nested = (n: PlanNode): void => {
      for (const c of n.children ?? []) {
        if (c.m) continue
        snapshotProps(i, c, out)
        nested(c)
      }
    }
    nested(item)
  }
  return out
}

const onceValues = new WeakMap<Scope, Map<PlanProp, unknown>>()
const cellReaders = new WeakMap<PlanProp, (row: unknown) => unknown>()

/** The current value of a property of `node` (handle override, binding, resource or literal). */
function valueOf(i: Internals, node: PlanNode, p: PlanProp, scope: Scope): unknown {
  const o = i.overrides.get(node.id)
  if (o?.has(p.n)) return o.get(p.n)
  const b = p.b
  if (b) {
    if (p.to.convert === 'binding-cell') {
      let reader = cellReaders.get(p)
      if (!reader) {
        const segs = b.path.split('.')
        reader = (row) => segs.reduce<unknown>((v, s) => (v && typeof v === 'object' ? (v as Props)[s] : undefined), row)
        cellReaders.set(p, reader)
      }
      return reader
    }
    if (b.mode === 'OneWayToSource') return UNSET
    if (b.mode === 'OneTime') {
      let m = onceValues.get(scope)
      if (!m) onceValues.set(scope, (m = new Map()))
      if (!m.has(p)) m.set(p, readBinding(b, scope))
      return m.get(p)
    }
    return readBinding(b, scope)
  }
  if (p.res) return resolveResource(p.res.key, p.res.set, p.res.args ? resourceArgs(p.res.args, scope) : undefined)
  return p.v === undefined ? UNSET : p.v
}

/** The values of a `{Res}`'s arguments: literals as written, bindings read one way in `scope`. */
function resourceArgs(args: readonly PlanResArg[], scope: Scope): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const a of args) {
    const v = a.b ? readBinding(a.b, scope) : a.v
    out[a.n] = v === UNSET ? '' : v
  }
  return out
}

function shallowEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let k = 0; k < a.length; k++) if (!Object.is(a[k], b[k])) return false
  return true
}

const ICON_SIZES: Readonly<Record<string, number>> = { Small: 16, Medium: 20, Large: 24, XLarge: 32 }

export { tokenColor }

function iconComponent(v: unknown): ComponentType<Props> | undefined {
  if (v && typeof v === 'object') {
    const iv = v as IconValue
    if (iv.c) return iv.c as ComponentType<Props>
    if (iv.$icon) return resolveIcon(iv.$icon) as ComponentType<Props> | undefined
    if (iv.$img) {
      const src = iv.$img
      return (props: Props) => createElement('img', { src, alt: '', width: props.size, height: props.size })
    }
  }
  if (typeof v === 'string' && v) return resolveIcon(v) as ComponentType<Props> | undefined
  return undefined
}

const CURSORS: Readonly<Record<string, string>> = {
  Default: '', Arrow: 'default', IBeam: 'text', Hand: 'pointer', Wait: 'wait', No: 'not-allowed', SizeAll: 'move',
  SizeNS: 'ns-resize', SizeWE: 'ew-resize', SizeNWSE: 'nwse-resize', SizeNESW: 'nesw-resize', Cross: 'crosshair',
  Help: 'help', AppStarting: 'progress', UpArrow: 'default',
}

const ROLES: Readonly<Record<string, string>> = {
  PushButton: 'button', CheckButton: 'checkbox', RadioButton: 'radio', Link: 'link', List: 'list', ListItem: 'listitem',
  Dialog: 'dialog', Alert: 'alert', ToolBar: 'toolbar', StatusBar: 'status', Table: 'table', Row: 'row', Cell: 'cell',
  PageTab: 'tab', PageTabList: 'tablist', Grouping: 'group', Separator: 'separator', ProgressBar: 'progressbar',
  Slider: 'slider', ComboBox: 'combobox', Outline: 'tree', OutlineItem: 'treeitem', MenuItem: 'menuitem',
  MenuPopup: 'menu', MenuBar: 'menubar', Graphic: 'img', StaticText: 'note', Text: 'textbox', Document: 'document',
  Pane: 'region', ToolTip: 'tooltip', Window: 'window', None: 'none',
}

/** `"l, t, r, b"` / `"a"` → CSS px box. */
function box(v: unknown): string | undefined {
  const parts = String(v).split(',').map((s) => Number(s.trim()))
  if (parts.some(Number.isNaN)) return undefined
  const [l, t = l, r = l, b = t] = parts
  return `${t}px ${r}px ${b}px ${l}px`
}

/** What the runtime applies on the DOM root (attributes, style, classes). */
interface DomTargets {
  attrs: Record<string, string | null>
  style: Record<string, string>
  classes: string[]
}

function applyRuntime(t: DomTargets, runtime: string, name: string, v: unknown): void {
  const s = v == null ? '' : String(v)
  switch (runtime) {
    case 'aria-label': t.attrs['aria-label'] = s || null; break
    case 'aria-description': t.attrs['aria-description'] = s || null; break
    case 'aria-hidden': t.attrs['aria-hidden'] = v === true || s === 'true' ? 'true' : null; break
    case 'aria-role': t.attrs.role = s && s !== 'Default' ? (ROLES[s] ?? s.toLowerCase()) : null; break
    case 'tab-index': t.attrs.tabindex = s === '' ? null : s; break
    case 'tab-stop': if (v === false) t.attrs.tabindex = '-1'; break
    case 'enabled': if (v === false) { t.attrs.inert = ''; t.attrs['aria-disabled'] = 'true' } break
    case 'cursor': if (name === 'UseWaitCursor') { if (v === true) t.style.cursor = 'wait' } else if (CURSORS[s]) t.style.cursor = CURSORS[s]; break
    case 'direction': t.attrs.dir = s === 'Yes' ? 'rtl' : s === 'No' ? 'ltr' : null; break
    case 'theme-color': if (s) t.style[name === 'BackColor' ? 'background-color' : 'color'] = tokenColor(s); break
    case 'hover-color': if (s) { t.style['--kb-v-hover-bg'] = tokenColor(s); t.classes.push(HOVER_CLASS); ensureViewStyles() } break
    case 'pressed-color': if (s) { t.style['--kb-v-pressed-bg'] = tokenColor(s); t.classes.push(PRESSED_CLASS); ensureViewStyles() } break
    case 'corner-radius': { const r = Number(v); if (s !== '' && Number.isFinite(r) && r >= 0) t.style['border-radius'] = `${r}px`; break }
    case 'border-brush': if (s) { t.style['border-color'] = tokenColor(s); t.style['border-style'] = 'solid'; t.style['border-width'] ??= '1px' } break
    case 'border-thickness': { const w = Number(v); if (s !== '' && Number.isFinite(w) && w >= 0) t.style['border-width'] = `${w}px`; break }
    case 'elevation': if (ELEVATIONS[s]) t.style['box-shadow'] = ELEVATIONS[s]; break
    case 'class': t.classes.push(...s.split(/\s+/).filter(Boolean)); break
    case 'layout':
      switch (name) {
        case 'Width': if (s) t.style.width = `${s}px`; break
        case 'Height': if (s) t.style.height = `${s}px`; break
        case 'Margin': { const m = box(v); if (m && m !== '0px 0px 0px 0px') t.style.margin = m; break }
        case 'Padding': { const m = box(v); if (m && m !== '0px 0px 0px 0px') t.style.padding = m; break }
        case 'MinimumSize': { const [w, h] = s.split(',').map(Number); if (w) t.style['min-width'] = `${w}px`; if (h) t.style['min-height'] = `${h}px`; break }
        case 'MaximumSize': { const [w, h] = s.split(',').map(Number); if (w) t.style['max-width'] = `${w}px`; if (h) t.style['max-height'] = `${h}px`; break }
        // A filling child may also shrink below its content's width (a truncated label inside it).
        case 'Stack.Fill': if (v === true) { t.style.flex = '1 1 0%'; t.style['min-width'] ??= '0px' } break
        default: break // Dock / Anchor / X / Y / table cells: applied by their container (WV-5a).
      }
      break
    default: break // design, tag, item-state, view-title, component-variant, icon-*: no DOM effect.
  }
}

// ── Elements ──

interface NodeProps {
  node: PlanNode
  scope: Scope
}

interface Menu {
  name: string
  top: number
  left: number
}

/** Calls a handler (never in design mode); async errors are reported, not thrown. */
function dispatch(i: Internals, node: PlanNode, e: PlanEvent, raw: readonly unknown[], ctx: ArgsContext = {}, scope?: Scope): void {
  if (i.design) return
  const { e: args, native } = makeArgs(e.from.args, raw, ctx)
  // Inside a Repeater's template: the row the element belongs to (`e.row`, `e.rowIndex`).
  if (scope && scope.row !== undefined) Object.assign(args, { row: scope.row, rowIndex: scope.index ?? -1 })
  const sender = handleFor(i, node.id)
  const vm = i.vm as unknown as Record<string, unknown>
  let result: unknown
  try {
    if (e.f) result = (e.f as (vm: unknown, s: unknown, a: unknown) => unknown)(vm, sender, args)
    else if (typeof vm[e.h] === 'function') result = (vm[e.h] as (s: unknown, a: unknown) => unknown).call(vm, sender, args)
    else console.error(`[views] ${i.cell.plan.file}:${e.at[0]}:${e.at[1]}: handler '${e.h}' is not a method of the code-behind`)
  } catch (err) {
    console.error(`[views] ${i.cell.plan.file}:${e.at[0]}:${e.at[1]}: ${e.n} handler '${e.h}' failed`, err)
  }
  if (result instanceof Promise) result.catch((err) => console.error(`[views] ${e.n} handler '${e.h}' failed`, err))
  applyArgs(args, native)
}

/** Adds a callback to a React prop (or an object prop's field), composing with one already there. */
function addCallback(props: Props, prop: string, field: string | undefined, cb: (...a: unknown[]) => void): void {
  const prev = (field ? getField(props[prop], field) : props[prop]) as ((...a: unknown[]) => void) | undefined
  const fn = prev ? (...a: unknown[]) => { prev(...a); cb(...a) } : cb
  if (field) setField(props, prop, field, fn)
  else props[prop] = fn
}

/** The value at a field path (`label`, `confirm.label`) of an object prop. */
function getField(obj: unknown, field: string): unknown {
  let o = obj
  for (const k of field.split('.')) {
    if (o === null || typeof o !== 'object') return undefined
    o = (o as Props)[k]
  }
  return o
}

/**
 * Sets a field of an object prop, copying the objects along a dotted path (`actions` + `confirm.label` →
 * `actions.confirm.label`): a window's footer is described by nested objects, each field its own property.
 */
function setField(props: Props, prop: string, field: string, value: unknown): void {
  const keys = field.split('.')
  const root: Props = { ...((props[prop] as Props | undefined) ?? {}) }
  let o = root
  for (const k of keys.slice(0, -1)) {
    const next = o[k]
    o = o[k] = next !== null && typeof next === 'object' ? { ...(next as Props) } : {}
  }
  o[keys[keys.length - 1]] = value
  props[prop] = root
}

interface Built {
  props: Props
  dom: DomTargets
  visible: boolean
  domEvents: [string, (ev: Event) => void][]
  menus: { context?: string; dropDown?: string }
  after?: ReactNode
  needsDom: boolean
}

function renderList(nodes: readonly PlanNode[] | undefined, scope: Scope): ReactNode {
  if (!nodes?.length) return undefined
  const els = nodes.map((c) => createElement(KbNode, { key: c.id, node: c, scope }))
  return els.length === 1 ? els[0] : els
}

/** Key of an adapter item's plan node (see `build`). */
const ITEM_NODE: unique symbol = Symbol('kb-item-node')

/** The open item keys an uncontrolled parent last reported (to tell which item a change toggled). */
const lastOpen = new WeakMap<Scope, Map<string, readonly string[]>>()

/**
 * Items opened and closed by their parent (`AccordionSection Open` / `OnToggled`): the parent's `open` list is
 * derived from the items' `Open` (controlled when one of them is bound, else the initial `defaultOpen`), and its
 * `onOpenChange` raises `OnToggled` on each item whose state changed and writes a two-way `Open` back.
 */
function wireOpenItems(i: Internals, node: PlanNode, scope: Scope, values: Map<PlanProp, unknown>, props: Props, keys: readonly string[]): void {
  const list = node.items?.list ?? []
  const openOf = list.map((it) => effectiveProps(i, it).find((p) => p.n === 'Open'))
  const toggled = list.map((it) => it.events?.find((e) => e.from.runtime === 'parent-adapter' && e.from.args === 'open-keys'))
  if (!openOf.some(Boolean) && !toggled.some(Boolean)) return
  const isOpen = (k: number): boolean => {
    const p = openOf[k]
    const v = p ? values.get(p) : false
    return v === true || v === 'true'
  }
  const now = keys.filter((_, k) => isOpen(k))
  const controlled = openOf.some((p) => p?.b && p.b.mode !== 'OneTime')
  if (controlled) props.open = now
  else props.defaultOpen = now
  let seen = lastOpen.get(scope)
  if (!seen) lastOpen.set(scope, (seen = new Map()))
  if (!seen.has(node.id)) seen.set(node.id, now)
  const memo = seen
  addCallback(props, 'onOpenChange', undefined, (next) => {
    if (i.design) return
    const after = new Set((next as unknown[]).map(String))
    const before = new Set(controlled ? now : memo.get(node.id) ?? now)
    memo.set(node.id, [...after])
    let wrote = false
    list.forEach((it, k) => {
      const was = before.has(keys[k])
      const is = after.has(keys[k])
      if (was === is) return
      const b = openOf[k]?.b
      if (b && (b.mode === 'TwoWay' || b.mode === 'OneWayToSource') && writeBinding(b, scope, is)) wrote = true
      const e = toggled[k]
      if (e) dispatch(i, it, e, [[...after]], { item: handleFor(i, it.id), index: k, itemKey: keys[k] }, scope)
    })
    if (wrote) notify(i)
  })
}

/**
 * Items checked by their parent (`CheckedListBox` `Item Checked`): the parent reports a user change with
 * `onItemCheck(index, checked)`; a two-way `Checked` binding on that item is written back (WV-5b).
 */
function wireCheckedItems(i: Internals, node: PlanNode, scope: Scope, props: Props): void {
  const list = node.items?.list ?? []
  const bindings = list.map((it) => effectiveProps(i, it).find((p) => p.n === 'Checked')?.b)
  const events = list.map((it) => it.events?.find((e) => e.from.runtime === 'parent-adapter' && e.from.args === 'item-check'))
  const writes = (b: (typeof bindings)[number]): boolean => !!b && (b.mode === 'TwoWay' || b.mode === 'OneWayToSource')
  if (!bindings.some(writes) && !events.some(Boolean)) return
  addCallback(props, 'onItemCheck', undefined, (index, checked) => {
    const k = Number(index)
    if (i.design || !list[k]) return
    const b = bindings[k]
    if (b && writes(b) && writeBinding(b, scope, !!checked)) notify(i)
    // The item's own `OnCheckedChanged` (the change event of its two-way `Checked`).
    const e = events[k]
    if (e) dispatch(i, list[k], e, [k, !!checked], { item: handleFor(i, list[k].id), index: k }, scope)
  })
}

/** Builds the React props of a node from its current values. */
function build(
  i: Internals,
  node: PlanNode,
  scope: Scope,
  values: Map<PlanProp, unknown>,
  pending: Map<string, unknown>,
  setPending: (name: string, v: unknown | typeof UNSET) => void,
  selected: [string | undefined, (k: string) => void],
  ctx: ArgsContext = {},
): Built {
  const props: Props = { ...(node.fixed ?? {}) }
  if (node.m === '@kubuno/views') {
    props.__view = i
    props.__id = node.id
  }
  const dom: DomTargets = { attrs: {}, style: {}, classes: [] }
  const out: Built = { props, dom, visible: true, domEvents: [], menus: {}, needsDom: false }
  const list = effectiveProps(i, node)
  const byName = (n: string): unknown => {
    const p = list.find((x) => x.n === n)
    return p ? values.get(p) : UNSET
  }
  const keys = node.items?.list.map((it, k) => it.name ?? String(k)) ?? []
  const iconOpts = (): Props => {
    const size = byName('IconSize')
    const color = byName('IconColor')
    const o: Props = {}
    if (size !== UNSET && size !== '') o.size = ICON_SIZES[String(size)] ?? (Number(String(size).split(',')[0]) || undefined)
    if (color !== UNSET && color) o.color = tokenColor(String(color))
    return o
  }
  const convert = (conv: string | undefined, v: unknown): unknown => {
    switch (conv) {
      case undefined: case 'identity': case 'binding-cell': case 'gradient-css': case 'status-text': case 'workspace-theme': return v
      case 'invert': return !v
      case 'method': { const vm = i.vm as unknown as Record<string, unknown>; const name = String(v); return (...a: unknown[]) => (vm[name] as ((...x: unknown[]) => unknown) | undefined)?.apply(vm, a) }
      case 'null-when-false': return v === false ? null : UNSET
      // `HostStrings`: the host's translator as the element's `t` (its own strings from the host's catalogue).
      case 'host-t': return v === true || v === 'true' ? hostTranslator() ?? UNSET : UNSET
      case 'icon-node': { const C = iconComponent(v); return C ? createElement(C, iconOpts()) : UNSET }
      case 'icon-component': return iconComponent(v) ?? UNSET
      case 'equals-value': { const own = byName('Value'); return own !== UNSET && String(v) === String(own) }
      case 'index-to-key': return keys[Number(v)] ?? keys[0]
      case 'element-ref': { const id = i.cell.plan.names[String(v)]; return { get current() { return id === undefined ? null : (i.dom.get(id) ?? null) } } }
      case 'items-source': {
        if (!Array.isArray(v)) return []
        const dm = byName('DisplayMember')
        const vmb = byName('ValueMember')
        return v.map((it) => {
          if (it === null || typeof it !== 'object') return { value: String(it), label: String(it) }
          const o = it as Props
          return dm !== UNSET || vmb !== UNSET ? { ...o, label: dm !== UNSET ? o[String(dm)] : o.label, value: vmb !== UNSET ? o[String(vmb)] : o.value } : o
        })
      }
      // Rows from a list whose `Icon` field names a Kubuno icon (`Sidebar ItemsSource`): the name becomes the icon.
      case 'items-source-icons': {
        if (!Array.isArray(v)) return []
        return v.map((it) => {
          if (it === null || typeof it !== 'object') return { Text: String(it) }
          const o = it as Props
          const name = o.Icon ?? o.icon
          const C = typeof name === 'string' ? iconComponent(name) : undefined
          return C ? { ...o, Icon: createElement(C, { size: 20 }), icon: undefined } : o
        })
      }
      default: return v
    }
  }

  for (const p of list) {
    let v = pending.has(p.n) ? pending.get(p.n) : values.get(p)
    // A `Visible` binding that gives no value hides the element, as `{cond && <X/>}` renders nothing for an undefined
    // `cond` (in the designer the element stays shown: its bindings have no data there).
    if (p.to.runtime === 'visible' && p.b && !i.design && (v === UNSET || v === undefined || v === null)) { out.visible = false; continue }
    if (v === UNSET || v === undefined) continue
    if (p.b && p.to.convert !== 'binding-cell' && v !== null) {
      if (p.kind === 'F32' && typeof v !== 'number') v = Number(v)
      else if (p.kind === 'Bool' && typeof v !== 'boolean') v = v === 'true' || v === true
      else if ((p.kind === 'String' || p.kind === 'Enum') && (typeof v === 'number' || typeof v === 'boolean')) v = String(v)
    }
    if (p.to.values && typeof v === 'string' && v in p.to.values) v = p.to.values[v]
    const t = p.to
    if (t.runtime) {
      if (t.runtime === 'visible') { if (v === false) out.visible = false; continue }
      // A tooltip is the DOM root's `title`: layout-neutral (no wrapper), the accessible name or description a
      // hand-written `title` gives, and the shell draws the Kubuno bubble for it (TitleTooltips).
      if (t.runtime === 'tooltip') { if (v) dom.attrs.title = String(v); continue }
      if (t.runtime === 'context-menu') { if (v) out.menus.context = String(v); continue }
      if (t.runtime === 'drop-down-menu') { if (v) out.menus.dropDown = String(v); continue }
      applyRuntime(dom, t.runtime, p.n, v)
      continue
    }
    if (!t.prop) continue
    const c = convert(t.convert, v)
    if (c === UNSET) continue
    if (t.field) setField(props, t.prop, t.field, c)
    else props[t.prop] = c
  }

  // Two-way bindings: write the user's change back (VIEWS-SPEC §6.1).
  for (const p of list) {
    const b = p.b
    const src = p.to.change_from
    if (!b || !src?.prop || (b.mode !== 'TwoWay' && b.mode !== 'OneWayToSource')) continue
    addCallback(props, src.prop, src.field, (...raw) => {
      if (i.design) return
      let v = makeArgs(src.args, raw, { keys }).e.value
      if (p.to.convert === 'invert') v = !v
      if (p.to.convert === 'equals-value') { if (!v) return; v = byName('Value') }
      if (p.to.values) {
        const back = Object.entries(p.to.values).find(([, mapped]) => Object.is(mapped, v))
        if (back) v = back[0]
      }
      if (b.trigger === 'LostFocus' || b.trigger === 'Explicit') { setPending(p.n, v); return }
      if (writeBinding(b, scope, v)) notify(i)
      if (b.mode === 'OneWayToSource') setPending(p.n, v)
    })
    if (b.trigger === 'LostFocus') {
      out.needsDom = true
      out.domEvents.push(['focusout', () => {
        if (!pending.has(p.n)) return
        if (writeBinding(b, scope, pending.get(p.n))) notify(i)
        setPending(p.n, UNSET)
      }])
    }
  }

  // Events.
  for (const e of node.events ?? []) {
    const f = e.from
    if (f.prop) addCallback(props, f.prop, f.field, (...raw) => dispatch(i, node, e, raw, { keys, ...ctx }, scope))
    else if (f.dom) {
      out.needsDom = true
      out.domEvents.push([f.dom === 'mousehover' ? 'mouseover' : f.dom === 'resize' ? 'kb-resize' : f.dom, (ev) => dispatch(i, node, e, [ev], { keys, ...ctx }, scope)])
    }
  }

  // Children → prop adapter.
  const items = node.items
  // No item children: the list comes from `ItemsSource` (already in the prop), not from an empty adapter.
  if (items && !(items.list.length === 0 && props[items.prop] !== undefined)) {
    const content = items.content as { field?: string } | string | undefined
    const buildItem = (it: PlanNode, k: number, key: string): Props => {
      const ib = build(i, it, scope, values, new Map(), () => {}, [undefined, () => {}], { item: handleFor(i, it.id), index: k, itemKey: key })
      const o = ib.props
      // The item's plan node, for the parent's runtime (menu check marks); not enumerable, so never a React prop.
      Object.defineProperty(o, ITEM_NODE, { value: it })
      if (items.key) o[items.key] = key
      const sub = it.children ?? []
      if (items.nested && sub.length && sub.every((c) => c.el === it.el)) {
        o[items.nested] = sub.map((c, j) => buildItem(c, j, c.name ?? `${key}.${j}`))
        if (it.el === 'MenuItem') o.type = 'submenu'
      } else if (content && typeof content === 'object' && content.field) {
        o[content.field] = renderList(sub, scope)
      }
      return o
    }
    // An item with Visible="false" is left out of the parent's list (a hidden menu command, tab or step).
    const shown = items.list.map((it, k) => [it, k] as const).filter(([it]) => !effectiveProps(i, it).some((p) => p.to.runtime === 'visible' && values.get(p) === false))
    const built = shown.map(([it, k]) => buildItem(it, k, keys[k]))
    props[items.prop] = items.shape === 'record' ? Object.fromEntries(built.map((o, k) => [keys[shown[k][1]], o])) : built
    wireOpenItems(i, node, scope, values, props, keys)
    wireCheckedItems(i, node, scope, props)
    if (content === 'selected-after') {
      // A strip without a bound selection keeps its own (the first item at first).
      if (props.value === undefined) {
        props.value = selected[0] ?? keys[0]
        addCallback(props, 'onChange', undefined, (k) => selected[1](String(k)))
      }
      const at = keys.indexOf(String(props.value))
      if (at >= 0) out.after = renderList(items.list[at].children, scope)
    }
  }

  // Content and slots.
  if (node.content && node.children?.length && !node.template) props[node.content] = renderList(node.children, scope)
  for (const [slot, nodes] of Object.entries(node.slots ?? {})) props[slot] = renderList(nodes, scope)

  if (node.name || out.menus.context || out.menus.dropDown || i.design) out.needsDom = true
  if (Object.keys(dom.attrs).length || Object.keys(dom.style).length || dom.classes.length) out.needsDom = true
  return out
}

/** One element of a view. */
export const KbNode = memo(function KbNode({ node, scope }: NodeProps): ReactNode {
  const i = useContext(ViewContext)
  if (!i) throw new Error('[views] an element rendered outside its view')
  // A hosted React component renders again with its view root (`RootRender`); `use` may be called conditionally,
  // and a node's element kind never changes for a given KbNode.
  if (node.el === 'ReactHost') use(RootRender)
  const cache = useRef<unknown[] | null>(null)
  const props = snapshotProps(i, node)
  const getSnapshot = (): unknown[] => {
    // `i.design` is part of the snapshot: turning design mode on or off re-renders every element (`data-kb-id`).
    const next = [node, i.sizeClass, i.design, resourcesVersion(), ...props.map((p) => valueOf(i, node, p, scope))]
    const prev = cache.current
    if (prev && shallowEqual(prev, next)) return prev
    cache.current = next
    return next
  }
  const snapshot = useSyncExternalStore(i.subscribe, getSnapshot, getSnapshot)
  const values = new Map<PlanProp, unknown>()
  props.forEach((p, k) => values.set(p, snapshot[k + 4]))

  const [pending, setPendingState] = useState<Map<string, unknown>>(() => new Map())
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [menu, setMenu] = useState<Menu | null>(null)
  const setPending = (name: string, v: unknown): void =>
    setPendingState((m) => {
      const n = new Map(m)
      if (v === UNSET) n.delete(name)
      else n.set(name, v)
      return n
    })

  const built = build(i, node, scope, values, pending, setPending, [selected, setSelected])
  const rootRef = useRef<HTMLElement | null>(null)
  /** The `display: contents` wrapper, when the element needs one to reach its DOM root. */
  const wrapRef = useRef<HTMLElement | null>(null)
  const applied = useRef<{ attrs: string[]; classes: string[]; style: string[] }>({ attrs: [], classes: [], style: [] })

  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    i.dom.set(node.id, el)
    const prev = applied.current
    for (const a of prev.attrs) el.removeAttribute(a)
    for (const c of prev.classes) el.classList.remove(c)
    for (const s of prev.style) el.style.removeProperty(s)
    const now = { attrs: [] as string[], classes: built.dom.classes, style: [] as string[] }
    for (const [a, v] of Object.entries(built.dom.attrs)) {
      if (v === null) continue
      el.setAttribute(a, v)
      now.attrs.push(a)
    }
    if (i.design) {
      el.setAttribute('data-kb-id', node.id)
      now.attrs.push('data-kb-id')
    }
    for (const c of built.dom.classes) el.classList.add(c)
    for (const [s, v] of Object.entries(built.dom.style)) {
      el.style.setProperty(s, v)
      now.style.push(s)
    }
    const wrap = wrapRef.current
    if (wrap && wrap !== el && wrap.isConnected) {
      // The `display: contents` wrapper sits among the parent's children, where the parent's child selectors
      // (`space-y-*`, `divide-y`) give it margins and borders it never draws: the element it wraps takes them, on the
      // sides it sets none of its own (its own classes win over the parent's, as they did without a wrapper).
      const w = getComputedStyle(wrap)
      const own = getComputedStyle(el)
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const m = `margin-${side}`
        if (parseFloat(w.getPropertyValue(m)) && !parseFloat(own.getPropertyValue(m)) && !el.style.getPropertyValue(m)) {
          el.style.setProperty(m, w.getPropertyValue(m))
          now.style.push(m)
        }
        const bw = `border-${side}-width`
        if (parseFloat(w.getPropertyValue(bw)) && w.getPropertyValue(`border-${side}-style`) !== 'none' && !parseFloat(own.getPropertyValue(bw)) && !el.style.getPropertyValue(bw)) {
          for (const p of [bw, `border-${side}-style`, `border-${side}-color`]) {
            el.style.setProperty(p, w.getPropertyValue(p))
            now.style.push(p)
          }
        }
      }
    }
    applied.current = now
    const off: (() => void)[] = []
    for (const [type, fn] of built.domEvents) {
      if (type === 'kb-resize') {
        const ro = new ResizeObserver(() => fn(new Event('resize')))
        ro.observe(el)
        off.push(() => ro.disconnect())
      } else {
        el.addEventListener(type, fn)
        off.push(() => el.removeEventListener(type, fn))
      }
    }
    if (built.menus.context) {
      const open = (ev: MouseEvent): void => {
        ev.preventDefault()
        setMenu({ name: built.menus.context!, top: ev.clientY, left: ev.clientX })
      }
      el.addEventListener('contextmenu', open)
      off.push(() => el.removeEventListener('contextmenu', open))
    }
    if (built.menus.dropDown) {
      const open = (): void => {
        const r = el.getBoundingClientRect()
        setMenu({ name: built.menus.dropDown!, top: r.bottom + 4, left: r.left })
      }
      el.addEventListener('click', open)
      off.push(() => el.removeEventListener('click', open))
    }
    return () => {
      for (const f of off) f()
      if (i.dom.get(node.id) === el) i.dom.delete(node.id)
    }
  })

  if (!built.visible) return null

  if (node.template) return renderTemplate(i, node, scope, values)

  const Component = (node.c ?? resolveComponent(node.m, node.x)) as AnyComponent | undefined
  let element: ReactNode
  if (!Component) {
    if (dev()) console.warn(`[views] ${i.cell.plan.file}:${node.at[0]}:${node.at[1]}: no component for <${node.el}> (${node.m ?? '?'} ${node.x ?? '?'})`)
    element = createElement('div', { 'data-kb-missing': node.el, ref: (el: HTMLElement | null) => { rootRef.current = el } })
  } else if (node.dom === 'ref') {
    element = createElement(Component, { ...built.props, ref: (el: HTMLElement | null) => { rootRef.current = el } })
  } else if (built.needsDom && !i.design && classesOnly(node, built) && (Component as { kbRootClass?: boolean }).kbRootClass) {
    // Classes alone, on a component that puts its `className` on its root (`Card`, `Callout`…): passed as that prop.
    // A `display: contents` wrapper would sit among its parent's children, where `space-y-*`, `divide-y` and
    // `> *` selectors would land on it - and nothing of a `display: contents` box is drawn.
    const own = typeof built.props.className === 'string' ? built.props.className : ''
    element = createElement(Component, { ...built.props, className: [own, ...built.dom.classes].filter(Boolean).join(' ') })
  } else {
    element = createElement(Component, built.props)
    if (built.needsDom) {
      element = createElement('div', {
        style: { display: 'contents' },
        ref: (el: HTMLElement | null) => {
          wrapRef.current = el
          rootRef.current = (el?.firstElementChild as HTMLElement | null) ?? el
        },
      }, element)
    }
  }
  const extra: ReactNode[] = []
  if (built.after !== undefined) extra.push(createElement(Fragment, { key: 'after' }, built.after))
  if (menu) extra.push(renderMenu(i, scope, menu, () => setMenu(null)))
  if (extra.length === 0) return element
  return createElement(Fragment, null, element, ...extra)
})

/** A `ContextMenu` of the view's tray, opened at a position. */
function renderMenu(i: Internals, scope: Scope, menu: Menu, close: () => void): ReactNode {
  const id = i.cell.plan.names[menu.name]
  const tray = id === undefined ? undefined : nodeIndex(i.cell.plan).get(id)
  if (!tray) return null
  const Menu = (tray.c ?? resolveComponent(tray.m, tray.x)) as AnyComponent | undefined
  if (!Menu) return null
  const values = new Map<PlanProp, unknown>()
  for (const p of snapshotProps(i, tray)) values.set(p, valueOf(i, tray, p, scope))
  const built = build(i, tray, scope, values, new Map(), () => {}, [undefined, () => {}])
  const checks = menuChecks.get(i) ?? new Map<string, boolean>()
  menuChecks.set(i, checks)
  const index = nodeIndex(i.cell.plan)
  const itemValue = (n: PlanNode, name: string): unknown => {
    const p = effectiveProps(i, n).find((x) => x.n === name)
    if (!p) return undefined
    const v = valueOf(i, n, p, scope)
    return v === UNSET ? undefined : v
  }
  const checkedOf = (n: PlanNode): boolean => checks.get(n.id) ?? itemValue(n, 'Checked') === true
  /** `CheckOnClick` / `RadioGroup`: the check marks a choice changes, `OnCheckedChanged` on each changed command. */
  const toggle = (n: PlanNode): void => {
    const group = String(itemValue(n, 'RadioGroup') ?? '')
    const changes: [PlanNode, boolean][] = []
    if (group) {
      for (const other of index.values()) {
        if (other.el !== 'MenuItem' || String(itemValue(other, 'RadioGroup') ?? '') !== group) continue
        const want = other === n
        if (checkedOf(other) !== want) changes.push([other, want])
      }
    } else if (itemValue(n, 'CheckOnClick') === true) {
      changes.push([n, !checkedOf(n)])
    }
    let wrote = false
    for (const [m, v] of changes) {
      checks.set(m.id, v)
      const b = effectiveProps(i, m).find((x) => x.n === 'Checked')?.b
      if (b && (b.mode === 'TwoWay' || b.mode === 'OneWayToSource') && writeBinding(b, scope, v)) wrote = true
      const e = m.events?.find((x) => x.n === 'OnCheckedChanged')
      if (e) dispatch(i, m, e, [v], { item: handleFor(i, m.id) }, scope)
    }
    if (wrote) notify(i)
  }
  const base = tray.items?.list.length ? ((built.props.items as Props[] | undefined) ?? []) : []
  const items = base.map(function wrap(it: Props): Props {
    const n = (it as { [ITEM_NODE]?: PlanNode })[ITEM_NODE]
    const onClick = it.onClick as (() => void) | undefined
    const sub = it.items as Props[] | undefined
    const out: Props = { type: 'action', ...it, onClick: () => { close(); if (n) toggle(n); onClick?.() }, ...(sub ? { items: sub.map(wrap) } : {}) }
    if (n && (checks.has(n.id) || itemValue(n, 'CheckOnClick') === true || itemValue(n, 'RadioGroup'))) out.checked = checkedOf(n)
    if (out.type === 'label' && out.text === undefined) out.text = out.label
    return out
  })
  // `ItemsSource`: commands made from a list, after the MenuItem children; choosing one raises `OnItemClicked` with its key.
  const source = effectiveProps(i, tray).find((p) => p.n === 'ItemsSource')
  const rows = source ? valueOf(i, tray, source, scope) : UNSET
  const clicked = tray.events?.find((e) => e.n === 'OnItemClicked')
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const r = (row && typeof row === 'object' ? row : { Text: String(row) }) as Props
      const get = (k: string): unknown => r[k] ?? r[k.charAt(0).toLowerCase() + k.slice(1)]
      const kind = String(get('Kind') ?? 'Command')
      if (kind === 'Separator' || get('Text') === '-') { items.push({ type: 'separator' }); continue }
      if (kind === 'Header') { items.push({ type: 'label', text: String(get('Text') ?? '') }); continue }
      const key = String(get('Key') ?? get('Value') ?? get('Text') ?? '')
      const Icon = iconComponent(get('Icon'))
      items.push({
        type: 'action',
        label: String(get('Text') ?? key),
        shortcut: get('ShortcutKeys') as string | undefined,
        checked: get('Checked') === true ? true : undefined,
        disabled: get('Enabled') === false ? true : undefined,
        danger: get('Danger') === true ? true : undefined,
        icon: Icon ? createElement(Icon, { size: 16 }) : undefined,
        onClick: () => { close(); if (clicked) dispatch(i, tray, clicked, [key], {}, scope) },
      })
    }
  }
  return createElement(Menu, { key: 'menu', ...built.props, items, pos: { top: menu.top, left: menu.left }, onClose: close })
}

/** The check marks the user changed in a view's menus (`CheckOnClick`, `RadioGroup`), by item id. */
const menuChecks = new WeakMap<Internals, Map<string, boolean>>()

/**
 * The sample rows a `Repeater` shows in design mode when it has no rows (no data at design time):
 * `DesignItemCount` of them (default 3, at most 50), whose fields read their own name and row number
 * (`{Binding name}` shows `name 1`, `name 2`…), as the desktop designer does.
 */
function sampleRows(node: PlanNode): unknown[] {
  const p = node.props?.find((x) => x.n === 'DesignItemCount')
  const n = p && typeof p.v === 'number' ? Math.max(0, Math.min(50, Math.round(p.v))) : 3
  return Array.from({ length: n }, (_, k) => new Proxy({}, {
    get: (_t, key) => (typeof key === 'string' ? `${key} ${k + 1}` : undefined),
    has: (_t, key) => typeof key === 'string',
  }))
}

/** A `Repeater`: its children once per item of `ItemsSource`, each with the item as its row scope. */
function renderTemplate(i: Internals, node: PlanNode, scope: Scope, values: Map<PlanProp, unknown>): ReactNode {
  const source = node.props?.find((p) => p.n === 'ItemsSource')
  let rows = source ? values.get(source) : UNSET
  if (!Array.isArray(rows) && i.design) rows = sampleRows(node)
  if (!Array.isArray(rows)) return null
  const keyProp = node.props?.find((p) => p.n === 'ItemKey')
  const keyField = keyProp && typeof keyProp.v === 'string' ? keyProp.v : undefined
  return createElement(
    Fragment,
    null,
    rows.map((row, index) => {
      const key = keyField && row && typeof row === 'object' ? String((row as Props)[keyField]) : String(index)
      return createElement(RowScope, { key, row, index, scope, node })
    }),
  )
}

/** One row of a template; its scope object is stable while the row is. */
const RowScope = memo(function RowScope({ row, index, scope, node }: { row: unknown; index: number; scope: Scope; node: PlanNode }): ReactNode {
  const ref = useRef<Scope | null>(null)
  if (!ref.current || ref.current.row !== row || ref.current.index !== index || ref.current.up !== scope) {
    ref.current = { vm: scope.vm, row, index, up: scope }
  }
  return renderList(node.children, ref.current) ?? null
})

// ── The view root ──

/** The size class of a width (VIEWS-SPEC §5.3). */
export function sizeClassOf(width: number): string {
  return width < 640 ? 'Compact' : width < 1024 ? 'Medium' : 'Expanded'
}

function hasSizeClasses(plan: ViewPlan): boolean {
  for (const n of nodeIndex(plan).values()) if (n.sc && Object.keys(n.sc).length) return true
  return false
}

/**
 * The node a view renders first. A user control whose `<UserControl>` root has nothing of its own - no name, no
 * property, no DOM event, no menu - and holds one element it does not lay out (no `Dock`, `Anchor` or position)
 * renders that element as its DOM root (VIEWS-SPEC §1.1, web):
 * the control is exactly as large as its content and its host's child selectors (`space-y-*`, `divide-y`) reach
 * it, as they reached the component it was converted from. The designer keeps the root (the surface the control is
 * designed on).
 */
export function contentRoot(plan: ViewPlan, design: boolean): PlanNode {
  const root = plan.root
  if (design || plan.kind !== 'control' || root.el !== 'UserControl') return root
  const own = !!root.name || !!root.props?.length || !!root.events?.some((e) => !e.from.runtime) || !!root.slots || !!root.items || !!root.sc
  if (own || root.children?.length !== 1) return root
  const only = root.children[0]
  return only.props?.some((p) => p.to.runtime === 'layout') ? root : only
}

function rootEvents(i: Internals, kind: string): void {
  const root = i.cell.plan.root
  for (const e of root.events ?? []) if (e.from.runtime === kind) dispatch(i, root, e, [])
}

interface ViewRootProps {
  cell: Cell
  cls: ViewClass
  props: object
  design?: boolean
}

/** Renders one view instance (the component returned by `X.component()`). */
export function ViewRoot({ cell, cls, props, design }: ViewRootProps): ReactNode {
  const ref = useRef<Internals | null>(null)
  if (!ref.current) {
    const C = (cell.latest ?? cls) as unknown as new () => View<object>
    const vm = new C()
    ref.current = vm[KB]
  }
  const i = ref.current
  // Design mode turned on or off on a live view: its elements must look again (after the commit).
  const designChanged = i.state !== 'new' && i.design !== !!design
  i.design = !!design
  // New props from the host: the elements reading them (through `this.props` or a getter) must look again,
  // after `use()` (the notification is deferred to the commit, like any change made during a render).
  const propsChanged = i.state !== 'new' && (i.vm as { props: object }).props !== props
  ;(i.vm as { props: object }).props = props
  if (!i.read) {
    i.read = (id, name) => {
      const node = nodeIndex(i.cell.plan).get(id)
      const p = node?.props?.find((x) => x.n === name)
      if (!node || !p) return undefined
      const v = valueOf(i, node, p, i.scope)
      return v === UNSET ? undefined : v
    }
  }
  useSyncExternalStore(i.subscribe, () => i.rootVersion, () => i.rootVersion)
  useEffect(() => onResourcesChanged(() => {
    forgetMemos(i.vm)
    notify(i)
  }), [i])
  i.deferred = true
  try {
    i.vm.use()
  } finally {
    i.deferred = false
  }
  if (propsChanged || designChanged) i.pending = true
  useLayoutEffect(() => {
    if (i.pending) {
      i.pending = false
      notifyElements(i)
    }
  })
  const plan = i.cell.plan
  const rootEl = useRef<HTMLDivElement | null>(null)
  const responsive = hasSizeClasses(plan)
  useEffect(() => {
    const el = rootEl.current
    if (!responsive || !el) return
    const update = (): void => {
      const c = sizeClassOf(el.getBoundingClientRect().width)
      if (c !== i.sizeClass) {
        i.sizeClass = c
        notify(i)
      }
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [responsive, i])
  useEffect(() => {
    i.state = 'mounted'
    cell.instances.add(i)
    setLive(i, true)
    rootEvents(i, 'view-load')
    rootEvents(i, 'view-shown')
    return () => {
      rootEvents(i, 'view-unload')
      i.state = 'unmounted'
      cell.instances.delete(i)
      setLive(i, false)
    }
  }, [cell, i])
  const renders = useRef(0)
  renders.current++
  const content = createElement(KbNode, { node: contentRoot(plan, i.design), scope: i.scope })
  const body = responsive ? createElement('div', { ref: rootEl, style: { display: 'contents' } }, content) : content
  return createElement(ViewContext.Provider, { value: i }, createElement(RootRender.Provider, { value: renders.current }, body))
}

setComponentFactory((cell, cls) => {
  const C = (props: object): ReactNode => createElement(ViewRoot, { cell, cls, props })
  C.displayName = `View(${cls.name || cell.plan.file})`
  return C
})

/** Renders a view class or component with props (`<KbView view={NotesSettingsPage} …/>`). */
export function KbView({ view, design, ...props }: { view: ViewClass | ComponentType<object>; design?: boolean } & Record<string, unknown>): ReactNode {
  const cls = view as ViewClass
  const cell = cls[CELL]
  if (cell) return createElement(ViewRoot, { cell, cls, props, design })
  return createElement(view as ComponentType<object>, props)
}

/** Whether all a node needs of its DOM root is classes (no name, events, attributes, styles or menus). */
function classesOnly(node: PlanNode, built: Built): boolean {
  return !node.name && built.dom.classes.length > 0 && !built.domEvents.length && !built.menus.context && !built.menus.dropDown &&
    !Object.keys(built.dom.attrs).length && !Object.keys(built.dom.style).length
}
