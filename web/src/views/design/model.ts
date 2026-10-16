/**
 * What the design surface knows of the elements: the catalog (host registry + project registries + user
 * controls - read at run time, never a hard-coded list) and the plan being shown (element id → node, literal
 * attribute values). Pure: no DOM.
 */
import type { PlanNode, ViewPlan } from '../plan'

export type ChildrenModel = 'None' | 'List' | 'SingleWidget'

export interface ComponentInfo {
  readonly name: string
  readonly children: ChildrenModel
  /** Gated children: when not empty, only these may be children. */
  readonly allowed: readonly string[]
  /** `DockAnchor` (Panel, UserControl), `Flow` (Stack), `Tabs`… or null. */
  readonly layoutKind: string | null
  /** `design_defaults.size`: the size a Toolbox drop gives the element in an absolute container. */
  readonly dropSize: readonly [number, number] | null
  readonly nonVisual: boolean
  readonly userControl: boolean
  /** The web block's module and export (the renderer's specifier for the element). */
  readonly module: string | null
  readonly export: string | null
}

interface RawComponent {
  name?: unknown
  children?: unknown
  allowed_children?: unknown
  layout_kind?: unknown
  design_defaults?: { size?: unknown } | null
  non_visual?: unknown
  web?: { module?: unknown; export?: unknown } | null
}

function info(c: RawComponent): ComponentInfo | null {
  if (typeof c.name !== 'string') return null
  const children = c.children === 'List' || c.children === 'SingleWidget' ? c.children : 'None'
  const size = c.design_defaults?.size
  return {
    name: c.name,
    children,
    allowed: Array.isArray(c.allowed_children) ? c.allowed_children.filter((x): x is string => typeof x === 'string') : [],
    layoutKind: typeof c.layout_kind === 'string' ? c.layout_kind : null,
    dropSize: Array.isArray(size) && size.length === 2 && size.every((n) => typeof n === 'number') ? [size[0] as number, size[1] as number] : null,
    nonVisual: c.non_visual === true,
    userControl: false,
    module: typeof c.web?.module === 'string' ? c.web.module : null,
    export: typeof c.web?.export === 'string' ? c.web.export : null,
  }
}

/** The elements of the open project: the host's, the project's own controls, its user controls. */
export class Catalog {
  private readonly byName = new Map<string, ComponentInfo>()
  private readonly gated = new Set<string>()

  constructor(registries: readonly { components?: unknown }[], userControls: readonly { name: string; module: string }[] = []) {
    for (const doc of registries) {
      if (!Array.isArray(doc.components)) continue
      for (const raw of doc.components as RawComponent[]) {
        const c = info(raw)
        // A project element never shadows a host one (the compiler's rule): the first registry wins.
        if (c && !this.byName.has(c.name)) this.byName.set(c.name, c)
      }
    }
    for (const u of userControls) {
      if (this.byName.has(u.name)) continue
      this.byName.set(u.name, {
        name: u.name, children: 'None', allowed: [], layoutKind: null, dropSize: null, nonVisual: false,
        userControl: true, module: u.module, export: 'default',
      })
    }
    for (const c of this.byName.values()) for (const a of c.allowed) this.gated.add(a)
  }

  /** Parses registry documents given as JSON text (invalid ones are skipped). */
  static fromTexts(texts: readonly string[], userControls: readonly { name: string; module: string }[] = []): Catalog {
    const docs: { components?: unknown }[] = []
    for (const t of texts) {
      try {
        docs.push(JSON.parse(t) as { components?: unknown })
      } catch {
        // Skipped: the compiler reports the broken registry.
      }
    }
    return new Catalog(docs, userControls)
  }

  get(name: string): ComponentInfo | undefined {
    return this.byName.get(name)
  }

  /** Some container lists `name` among its gated children: it may only go into such a container. */
  isGated(name: string): boolean {
    return this.gated.has(name)
  }

  get size(): number {
    return this.byName.size
  }
}

/** One element of the plan shown, with what the surface reads of it. */
export interface NodeInfo {
  readonly id: string
  readonly el: string
  readonly node: PlanNode
  /** The ids of its element children (not slots, not items), in document order. */
  readonly children: readonly string[]
}

/** Every node of a plan by element id (children, slots, adapter items and the tray). */
export function indexPlan(plan: ViewPlan | null): Map<string, NodeInfo> {
  const out = new Map<string, NodeInfo>()
  if (!plan) return out
  const add = (n: PlanNode): void => {
    out.set(n.id, { id: n.id, el: n.el, node: n, children: (n.children ?? []).map((c) => c.id) })
    n.children?.forEach(add)
    n.items?.list.forEach(add)
    for (const list of Object.values(n.slots ?? {})) list.forEach(add)
  }
  add(plan.root)
  plan.tray?.forEach(add)
  return out
}

/** The literal value of an attribute of a node (`undefined` when absent or bound). */
export function literal(node: PlanNode | undefined, name: string): unknown {
  const p = node?.props?.find((x) => x.n === name)
  return p && p.v !== undefined && !p.b && !p.res ? p.v : undefined
}

/** A literal numeric attribute (`X="12"` → 12), else `undefined`. */
export function literalNumber(node: PlanNode | undefined, name: string): number | undefined {
  const v = literal(node, name)
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** Every module specifier a plan names, with the exports it uses (`/src/x/AppTileGrid` → `AppTileGrid`). */
export function planModules(plan: ViewPlan): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const { node } of indexPlan(plan).values()) {
    if (!node.m || !node.x) continue
    let set = out.get(node.m)
    if (!set) out.set(node.m, (set = new Set()))
    set.add(node.x)
  }
  return out
}

/** How a container lays out its children, as far as the surface's gestures are concerned. */
export type ContainerKind = 'leaf' | 'flow' | 'dock' | 'absolute' | 'single' | 'list'

/** The container kind of an element (an id the plan does not know - a property element - is a `list`). */
export function containerKind(nodes: ReadonlyMap<string, NodeInfo>, catalog: Catalog, id: string): ContainerKind {
  const n = nodes.get(id)
  if (!n) return 'list'
  const c = catalog.get(n.el)
  if (!c) return n.children.length ? 'list' : 'leaf'
  if (c.children === 'None') return 'leaf'
  if (c.children === 'SingleWidget') return 'single'
  if (c.layoutKind === 'DockAnchor') return literal(n.node, 'Layout') === 'Absolute' ? 'absolute' : 'dock'
  if (c.layoutKind === 'Flow') return 'flow'
  return 'list'
}

/** Whether an element is placed by `X` / `Y` (a child of an absolute container). */
export function isAbsoluteChild(nodes: ReadonlyMap<string, NodeInfo>, catalog: Catalog, id: string): boolean {
  if (id === '') return false
  const parent = id.lastIndexOf('.') < 0 ? '' : id.slice(0, id.lastIndexOf('.'))
  return containerKind(nodes, catalog, parent) === 'absolute'
}

/**
 * What the surface shows: a `page` (`.kbview`: a page, window or dialog - designed on a white sheet, its boundary
 * dashed) or a `control` (`.kbcontrol`: a user control, on the canvas in Visual Studio's colours). The file's
 * extension decides; without a file yet, the plan's kind does; with neither, the canvas keeps Visual Studio's colours.
 */
export function designDocumentKind(file: string | null | undefined, plan: ViewPlan | null): 'page' | 'control' {
  if (file && /\.kbcontrol$/i.test(file)) return 'control'
  if (file && /\.kbview$/i.test(file)) return 'page'
  if (!plan) return 'control'
  return plan.kind === 'control' ? 'control' : 'page'
}

/** `src/a/X.kbcontrol` + `./X` → `/src/a/X` (posix, `.` / `..` resolved). */
export function moduleOfCodeBehind(file: string, codeBehind: string): string {
  const dir = file.split('/').slice(0, -1)
  const parts = codeBehind.startsWith('/') ? [] : [...dir]
  for (const seg of codeBehind.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return '/' + parts.join('/')
}
