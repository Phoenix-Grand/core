/**
 * The code-behind model (VIEWS-SPEC §9.1): `View` (base of every generated `ViewBase`), the `@bind`
 * accessor decorator, the generated base factory `createViewBase`, element handles, and the live-view
 * registry behind HMR (plan swap for a `.kbview` edit, prototype swap for a code-behind edit).
 */
import type { ComponentType, FunctionComponent } from 'react'

import { resolveResource, type ResourceArgs } from './resolve'
import { VIEWS_ABI, type ViewPlan } from './plan'
import type { Scope } from './binding'

/** The runtime state of one mounted view instance. */
export interface Internals {
  readonly vm: View<object>
  readonly cell: Cell
  readonly scope: Scope
  version: number
  /**
   * What the view root re-renders on (its hooks run again): every notification but the ones flushed after its own
   * render, which reach the elements only.
   */
  rootVersion: number
  readonly listeners: Set<() => void>
  readonly subscribe: (listener: () => void) => () => void
  /** `@bind` storage (kept on the instance, not in the class's private slots, so a prototype swap keeps it). */
  readonly values: Map<string, unknown>
  /** Values set through element handles: element id → property → value. */
  readonly overrides: Map<string, Map<string, unknown>>
  /** Root DOM node of each rendered element, by element id. */
  readonly dom: Map<string, HTMLElement>
  readonly handles: Map<string, ElementHandle>
  state: 'new' | 'mounted' | 'unmounted'
  /** Inside `use()`: notifications are deferred to the commit. */
  deferred: boolean
  pending: boolean
  /** Design mode (the designer): no handler ever runs. */
  design: boolean
  /** Current size class (`Compact`, `Medium`, `Expanded`). */
  sizeClass: string
  /** Reads an element's current property value (set by the renderer). */
  read?: (id: string, property: string) => unknown
}

/** One view file's live state: its current plan, its mounted instances, its latest code-behind class. */
export interface Cell {
  plan: ViewPlan
  readonly instances: Set<Internals>
  base?: ViewClass
  latest?: ViewClass
}

/** The handle of an element named by `x:Name` (VIEWS-SPEC §9.1): camelCase properties, read/write. */
export interface ElementHandle {
  /** The element id (`0.1.2`). */
  readonly id: string
  /** The element's root DOM node, once rendered. */
  readonly element: HTMLElement | null
  focus(): void
  click(): void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ViewClass = (abstract new () => View<any>) & { [CELL]?: Cell }

export const KB: unique symbol = Symbol.for('kubuno.views.internals')
export const CELL: unique symbol = Symbol.for('kubuno.views.cell')

const live = new Set<Internals>()
const dev = (): boolean => (import.meta as { env?: { DEV?: boolean } }).env?.DEV !== false

/** Notifies the elements of a view that its state changed. */
export function notify(i: Internals): void {
  if (i.deferred) {
    i.pending = true
    return
  }
  i.version++
  i.rootVersion++
  for (const l of [...i.listeners]) l()
}

/**
 * Tells the elements of a view that values changed during the root's own render (hooks published new values, new
 * props): they recompute what they read; the root, which has just rendered with those values, does not render again
 * (a hook returning a new object on every render would otherwise re-render the view without end).
 */
export function notifyElements(i: Internals): void {
  i.version++
  for (const l of [...i.listeners]) l()
}

/** Re-renders every live view (language change, theme change). */
export function invalidateViews(): void {
  for (const i of live) {
    forgetMemos(i.vm)
    notify(i)
  }
}

/** @internal */
export function setLive(i: Internals, on: boolean): void {
  if (on) live.add(i)
  else live.delete(i)
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** The handle of element `id` of a view. */
export function handleFor(i: Internals, id: string): ElementHandle {
  let h = i.handles.get(id)
  if (h) return h
  const target = {} as ElementHandle
  h = new Proxy(target, {
    get(_, prop) {
      if (prop === 'id') return id
      if (prop === 'element') return i.dom.get(id) ?? null
      if (prop === 'focus') return () => i.dom.get(id)?.focus()
      if (prop === 'click') return () => i.dom.get(id)?.click()
      if (typeof prop !== 'string') return undefined
      const name = cap(prop)
      const o = i.overrides.get(id)
      if (o?.has(name)) return o.get(name)
      return i.read?.(id, name)
    },
    set(_, prop, value) {
      if (typeof prop !== 'string') return false
      let o = i.overrides.get(id)
      if (!o) i.overrides.set(id, (o = new Map()))
      o.set(cap(prop), value)
      notify(i)
      return true
    },
  })
  i.handles.set(id, h)
  return h
}

/** Defines (again, after a plan swap) one getter per `x:Name` on a view instance. */
function defineHandles(vm: View<object>): void {
  const i = vm[KB]
  for (const [name, id] of Object.entries(i.cell.plan.names)) {
    Object.defineProperty(vm, name, { configurable: true, enumerable: false, get: () => handleFor(i, id) })
  }
}

/** `Object.is`, or for two plain objects / arrays, the same keys with `Object.is` values (one level). */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const pa = Object.getPrototypeOf(a)
  if (pa !== Object.getPrototypeOf(b) || (pa !== Object.prototype && pa !== Array.prototype)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** The memos of `View.memo`, per view instance (outside the instance: a prototype swap keeps them). */
const memos = new WeakMap<object, Map<string, { deps: unknown[]; value: unknown }>>()

/**
 * Drops what a view memoized (`View.memo`): on a language or theme change, a value computed from translated texts or
 * from a registry (a module's name) is computed again, as the TSX it replaces did on every render.
 */
export function forgetMemos(vm: object): void {
  memos.delete(vm)
}

/**
 * Base of every view's code-behind (through its generated `ViewBase`). `P` is the root's `x:Props`.
 */
export abstract class View<P extends object = object> {
  /** @internal */
  declare readonly [KB]: Internals
  /** The props the view was rendered with. */
  props: Readonly<P> = {} as P
  /** Paths not found on the instance resolve here (VIEWS-SPEC §6.1). */
  dataContext: unknown = undefined

  constructor() {
    const cell = (new.target as ViewClass)[CELL]
    if (!cell) throw new Error('[views] a view class must extend the ViewBase generated from its .kbview')
    const listeners = new Set<() => void>()
    const i: Internals = {
      vm: this,
      cell,
      scope: { vm: this as unknown as Scope['vm'] },
      version: 0,
      rootVersion: 0,
      listeners,
      subscribe: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
      values: new Map(),
      overrides: new Map(),
      dom: new Map(),
      handles: new Map(),
      state: 'new',
      deferred: false,
      pending: false,
      design: false,
      sizeClass: 'Expanded',
    }
    Object.defineProperty(this, KB, { value: i })
    defineHandles(this)
  }

  /** Runs on every render of the view; the only place React hooks are allowed. */
  use(): void {}

  /** A string of the view's resources (`{Res}`) in the current language; `args` fill its `{{placeholders}}` and `Count` picks its plural form. */
  t(key: string, set?: string, args?: ResourceArgs): string {
    return resolveResource(key, set, args)
  }

  /**
   * The value `compute()` returns, computed again only when one of `deps` changed (`Object.is`) since the last call
   * with this `key`: what a getter returning an object or a list uses, so that reading it twice gives the same object
   * (a new array on every read would re-render without end). `get rows() { return this.memo('rows', [this.items],
   * () => this.items.map(…)) }`.
   */
  protected memo<T>(key: string, deps: readonly unknown[], compute: () => T): T {
    const store = (memos.get(this) ?? memos.set(this, new Map()).get(this))!
    const last = store.get(key)
    if (last && last.deps.length === deps.length && last.deps.every((d, k) => Object.is(d, deps[k]))) return last.value as T
    const value = compute()
    store.set(key, { deps: [...deps], value })
    return value
  }

  /**
   * Sets fields from what hooks gave this render (`this.publish({ user, items })` in `use()`), notifying the view only
   * when one changed - compared shallowly, so a hook returning a fresh but equal object or list on every render does
   * not re-render the view without end, as a `@bind` field (compared by identity) would.
   */
  protected publish(values: Readonly<Record<string, unknown>>): void {
    let changed = false
    const self = this as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(values)) {
      if (shallowEqual(self[k], v)) continue
      self[k] = v
      changed = true
    }
    if (changed) notify(this[KB])
  }

  /** Marks the view as changed (after mutating a `@bind` object in place). */
  invalidate(): void {
    notify(this[KB])
  }

  /** The view as a React component (`export default MyView.component()`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static component<T extends View<any>>(this: abstract new () => T): FunctionComponent<T['props']> {
    const cls = this as unknown as ViewClass
    const cell = cls[CELL]
    if (!cell) throw new Error('[views] component() must be called on a class extending a generated ViewBase')
    // A code-behind edit re-evaluates its module: move the live instances of the previous version of
    // this class onto the new prototype (fields and @bind values are kept).
    const prev = cell.latest
    if (prev && prev !== cls && prev.name === cls.name) {
      for (const i of cell.instances) {
        if (Object.getPrototypeOf(i.vm) === prev.prototype) {
          Object.setPrototypeOf(i.vm, cls.prototype)
          notify(i)
        }
      }
    }
    cell.latest = cls
    return componentFor(cell, cls) as FunctionComponent<T['props']>
  }
}

let componentFactory: ((cell: Cell, cls: ViewClass) => ComponentType<object>) | null = null

/** @internal - set by the renderer (keeps this module free of React rendering code). */
export function setComponentFactory(f: (cell: Cell, cls: ViewClass) => ComponentType<object>): void {
  componentFactory = f
}

function componentFor(cell: Cell, cls: ViewClass): ComponentType<object> {
  if (!componentFactory) throw new Error('[views] renderer not loaded')
  return componentFactory(cell, cls)
}

type Accessor<This, V> = { get(this: This): V; set(this: This, value: V): void }

/**
 * `@bind accessor name = value` - a bindable field: assigning it re-renders the elements bound to it
 * (VIEWS-SPEC §9.1). Mutating an object in place is not seen: assign a new object, or call `invalidate()`.
 */
export function bind<This extends View<object>, V>(
  target: Accessor<This, V>,
  context: ClassAccessorDecoratorContext<This, V>,
): ClassAccessorDecoratorResult<This, V> {
  const name = String(context.name)
  return {
    get(this: This): V {
      const i = this[KB]
      return i.values.has(name) ? (i.values.get(name) as V) : target.get.call(this)
    },
    set(this: This, value: V): void {
      const i = this[KB]
      if (i.values.has(name) && Object.is(i.values.get(name), value)) return
      i.values.set(name, value)
      if (i.state === 'unmounted') {
        if (dev()) console.warn(`[views] ${this.constructor.name}.${name} written after the view was unmounted: ignored`)
        return
      }
      notify(i)
    },
    init(this: This, value: V): V {
      this[KB].values.set(name, value)
      return value
    },
  }
}

const hotCells: Map<string, Cell> = ((globalThis as { __kbViewCells?: Map<string, Cell> }).__kbViewCells ??= new Map())

/**
 * The generated base of a view's code-behind (`export const ViewBase = createViewBase(plan, key)`). With a
 * `hotKey` (dev server: the module URL), a re-evaluated view module swaps its new plan into the live views
 * and returns the same class.
 */
export function createViewBase(plan: ViewPlan, hotKey?: string | false): ViewClass {
  if (plan.abi !== VIEWS_ABI) {
    throw new Error(`[views] ${plan.file} was compiled for views ABI ${plan.abi}; this host runs ABI ${VIEWS_ABI} (rebuild the module with a matching @kubuno/views-compiler)`)
  }
  const key = hotKey ? hotKey.split('?')[0] : undefined
  const existing = key ? hotCells.get(key) : undefined
  if (existing?.base) {
    existing.plan = plan
    for (const i of existing.instances) {
      defineHandles(i.vm)
      notify(i)
    }
    return existing.base
  }
  const cell: Cell = { plan, instances: new Set() }
  abstract class ViewBase extends View {
    static readonly [CELL] = cell
  }
  cell.base = ViewBase as unknown as ViewClass
  if (key) hotCells.set(key, cell)
  return cell.base
}
