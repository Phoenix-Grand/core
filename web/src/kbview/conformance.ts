/**
 * Conformance of the web element registry with the desktop one (VIEWS-SPEC §10): same element →
 * same property and event names, kinds, enum values, defaults, args types; every difference is
 * either listed in `allowlist.ts` with a reason, or a failure.
 *
 * The desktop side is the real `kubuno/registry` export (`view_embed --export-registry`), reduced by
 * `normalizeDesktopExport` to a deduplicated snapshot (inherited levels stored once) that is
 * committed as `__fixtures__/desktop-registry.snapshot.json`.
 */
import type { ComponentJson, EventJson, PropertyJson, RegistryExportJson } from './export.ts'

// ── The desktop snapshot ──

/** A desktop property, reduced to what conformance compares (and the French docs, for the report). */
export interface SnapshotProperty {
  name: string
  kind: unknown
  default: string
  category: string | null
  bindable: boolean
  localizable: boolean
  editor: string | null
  type_converter: string | null
  design_time: boolean
  root_only: boolean
  aliases: string[]
  doc_fr: string | null
}

export interface SnapshotEvent {
  name: string
  category: string
  args_type: string
  args_chain: string[]
  cancelable: boolean
  aliases: string[]
  root_only: boolean
  doc_fr: string | null
}

export interface SnapshotComponent {
  name: string
  family: string
  children: string
  allowed_children: string[]
  layout_kind: string | null
  default_event: string | null
  base_chain: string[]
  kind: string
  non_visual: boolean
  /** Own members only; inherited ones live in `levels`. */
  properties: SnapshotProperty[]
  events: SnapshotEvent[]
}

export interface DesktopSnapshot {
  /** Where the snapshot comes from (registry version, element count, how it was produced). */
  source: { version: string; components: number; produced_by: string }
  /** Inherited members by declaring level (`Control`, `ButtonBase`, `View`…). */
  levels: Record<string, { properties: SnapshotProperty[]; events: SnapshotEvent[] }>
  components: SnapshotComponent[]
}

interface DesktopExport {
  version: string
  components: Array<ComponentJson | (Omit<ComponentJson, 'web' | 'design_defaults'>)>
}

function snapProperty(p: PropertyJson): SnapshotProperty {
  return {
    name: p.name, kind: p.kind, default: p.default, category: p.category, bindable: p.bindable,
    localizable: p.localizable, editor: p.editor, type_converter: p.type_converter,
    design_time: p.design_time, root_only: p.root_only, aliases: [...p.aliases], doc_fr: p.doc_fr,
  }
}

function snapEvent(e: EventJson): SnapshotEvent {
  return {
    name: e.name, category: e.category, args_type: e.args_type, args_chain: [...e.args_chain],
    cancelable: e.cancelable, aliases: [...e.aliases], root_only: e.root_only, doc_fr: e.doc_fr,
  }
}

/**
 * Reduces a full desktop export (`{version, components}`, several MB because every element
 * repeats its inherited members) to the snapshot: built-in elements only, each inherited member
 * stored once under its level. Throws when two elements disagree on an inherited member - the
 * snapshot would then not be faithful.
 */
export function normalizeDesktopExport(raw: DesktopExport, producedBy: string): DesktopSnapshot {
  const levels: DesktopSnapshot['levels'] = {}
  const seen = new Map<string, string>()
  const components: SnapshotComponent[] = []
  for (const c of raw.components) {
    if (c.origin !== 'builtin') continue
    const own: SnapshotComponent = {
      name: c.name, family: c.family, children: c.children, allowed_children: [...c.allowed_children],
      layout_kind: c.layout_kind, default_event: c.default_event, base_chain: [...c.base_chain], kind: c.kind,
      non_visual: c.non_visual, properties: [], events: [],
    }
    for (const p of c.properties) {
      if (!p.inherited_from) { own.properties.push(snapProperty(p)); continue }
      const s = snapProperty(p)
      const key = `P:${p.inherited_from}:${p.name}`
      const text = JSON.stringify(s)
      const prior = seen.get(key)
      if (prior === undefined) {
        seen.set(key, text)
        ;(levels[p.inherited_from] ??= { properties: [], events: [] }).properties.push(s)
      } else if (prior !== text) {
        throw new Error(`inherited property ${p.inherited_from}.${p.name} differs between elements (at ${c.name})`)
      }
    }
    for (const e of c.events) {
      if (!e.inherited_from) { own.events.push(snapEvent(e)); continue }
      const s = snapEvent(e)
      const key = `E:${e.inherited_from}:${e.name}`
      const text = JSON.stringify(s)
      const prior = seen.get(key)
      if (prior === undefined) {
        seen.set(key, text)
        ;(levels[e.inherited_from] ??= { properties: [], events: [] }).events.push(s)
      } else if (prior !== text) {
        throw new Error(`inherited event ${e.inherited_from}.${e.name} differs between elements (at ${c.name})`)
      }
    }
    components.push(own)
  }
  return { source: { version: raw.version, components: components.length, produced_by: producedBy }, levels, components }
}

/** The members an element has on the desktop: own, then each level of its chain, then `View`. */
function desktopMembers(snapshot: DesktopSnapshot, c: SnapshotComponent) {
  const props = new Map<string, SnapshotProperty & { level: string | null }>()
  const events = new Map<string, SnapshotEvent & { level: string | null }>()
  for (const p of c.properties) props.set(p.name, { ...p, level: null })
  for (const e of c.events) events.set(e.name, { ...e, level: null })
  const levels = [...c.base_chain.slice(1)]
  if (c.base_chain.includes('Control')) levels.push('View')
  for (const level of levels) {
    const table = snapshot.levels[level]
    if (!table) continue
    for (const p of table.properties) if (!props.has(p.name)) props.set(p.name, { ...p, level })
    // `View` events are only listed for a control; the common events only where not overridden.
    for (const e of table.events) if (!events.has(e.name)) events.set(e.name, { ...e, level })
  }
  return { props, events }
}

// ── Differences, allowlist, report ──

export type DiffKind =
  | 'element-missing-on-web'
  | 'element-web-only'
  | 'element-mismatch'
  | 'property-missing-on-web'
  | 'property-web-only'
  | 'property-mismatch'
  | 'event-missing-on-web'
  | 'event-web-only'
  | 'event-mismatch'
  | 'doc-fr-differs'

export interface Diff {
  kind: DiffKind
  element: string
  /** Property / event name, or the element field for `element-mismatch`. */
  member?: string
  /** The level declaring the member on the desktop (or on the web for a web-only one). */
  level?: string | null
  /** For a mismatch: the field that differs (`kind`, `default`, `args_type`…). */
  field?: string
  desktop?: unknown
  web?: unknown
}

/** One accepted difference. `'*'` matches anything; a missing `member`/`level`/`field` too. */
export interface AllowEntry {
  kind: DiffKind
  element: string
  member?: string
  level?: string
  field?: string
  reason: string
}

/** Differences that never fail the test: they measure coverage or documentation, not semantics. */
const INFO_KINDS: ReadonlySet<DiffKind> = new Set(['element-missing-on-web', 'doc-fr-differs'])

const ELEMENT_FIELDS = [
  'family', 'children', 'allowed_children', 'layout_kind', 'default_event', 'base_chain', 'kind', 'non_visual',
] as const
const PROPERTY_FIELDS = [
  'kind', 'default', 'category', 'bindable', 'localizable', 'editor', 'type_converter', 'design_time', 'root_only', 'aliases',
] as const
const EVENT_FIELDS = ['category', 'args_type', 'args_chain', 'cancelable', 'aliases', 'root_only'] as const

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Every difference between the web export and the desktop snapshot, unfiltered. */
export function diffRegistries(web: RegistryExportJson, desktop: DesktopSnapshot): Diff[] {
  const diffs: Diff[] = []
  const desktopByName = new Map(desktop.components.map(c => [c.name, c]))
  const webNames = new Set(web.components.map(c => c.name))

  for (const d of desktop.components) {
    if (!webNames.has(d.name)) diffs.push({ kind: 'element-missing-on-web', element: d.name })
  }

  for (const w of web.components) {
    const d = desktopByName.get(w.name)
    if (!d) { diffs.push({ kind: 'element-web-only', element: w.name }); continue }

    for (const field of ELEMENT_FIELDS) {
      if (!same(w[field], d[field])) diffs.push({ kind: 'element-mismatch', element: w.name, member: field, field, desktop: d[field], web: w[field] })
    }

    const { props, events } = desktopMembers(desktop, d)
    const webProps = new Map(w.properties.map(p => [p.name, p]))
    const webEvents = new Map(w.events.map(e => [e.name, e]))

    for (const [name, dp] of props) {
      const wp = webProps.get(name)
      if (!wp) { diffs.push({ kind: 'property-missing-on-web', element: w.name, member: name, level: dp.level }); continue }
      for (const field of PROPERTY_FIELDS) {
        if (!same(wp[field], dp[field])) {
          diffs.push({ kind: 'property-mismatch', element: w.name, member: name, level: dp.level, field, desktop: dp[field], web: wp[field] })
        }
      }
      if ((wp.doc_fr ?? '') !== (dp.doc_fr ?? '')) {
        diffs.push({ kind: 'doc-fr-differs', element: w.name, member: name, level: dp.level, desktop: dp.doc_fr, web: wp.doc_fr })
      }
    }
    for (const wp of w.properties) {
      if (!props.has(wp.name)) diffs.push({ kind: 'property-web-only', element: w.name, member: wp.name, level: wp.inherited_from })
    }

    for (const [name, de] of events) {
      const we = webEvents.get(name)
      if (!we) { diffs.push({ kind: 'event-missing-on-web', element: w.name, member: name, level: de.level }); continue }
      for (const field of EVENT_FIELDS) {
        if (!same(we[field], de[field])) {
          diffs.push({ kind: 'event-mismatch', element: w.name, member: name, level: de.level, field, desktop: de[field], web: we[field] })
        }
      }
      if ((we.doc_fr ?? '') !== (de.doc_fr ?? '')) {
        diffs.push({ kind: 'doc-fr-differs', element: w.name, member: name, level: de.level, desktop: de.doc_fr, web: we.doc_fr })
      }
    }
    for (const we of w.events) {
      if (!events.has(we.name)) diffs.push({ kind: 'event-web-only', element: w.name, member: we.name, level: we.inherited_from })
    }
  }
  return diffs
}

function matches(entry: AllowEntry, diff: Diff): boolean {
  const eq = (pattern: string | undefined, value: string | null | undefined) =>
    pattern === undefined || pattern === '*' || pattern === (value ?? '')
  return entry.kind === diff.kind
    && eq(entry.element, diff.element)
    && eq(entry.member, diff.member)
    && eq(entry.level, diff.level)
    && eq(entry.field, diff.field)
}

export interface ConformanceReport {
  desktop_source: DesktopSnapshot['source']
  web_version: string
  summary: {
    web_elements: number
    desktop_elements: number
    compared_elements: number
    failures: number
    allowlisted: number
    info: number
    unused_allowlist_entries: number
  }
  /** Differences no allowlist entry accepts: the test fails while this is not empty. */
  failures: Diff[]
  /** Accepted differences, each with the reason of the entry that accepts it. */
  allowlisted: Array<Diff & { reason: string }>
  /** Coverage and documentation differences (never fail). */
  info: Diff[]
  /** Allowlist entries that accept nothing any more: remove them (the test fails on them too). */
  unused_allowlist: AllowEntry[]
}

/** Classifies every difference and builds the JSON report. */
export function checkConformance(
  web: RegistryExportJson, desktop: DesktopSnapshot, allowlist: readonly AllowEntry[],
): ConformanceReport {
  const diffs = diffRegistries(web, desktop)
  const used = new Set<AllowEntry>()
  const failures: Diff[] = []
  const allowlisted: ConformanceReport['allowlisted'] = []
  const info: Diff[] = []
  for (const diff of diffs) {
    if (INFO_KINDS.has(diff.kind)) { info.push(diff); continue }
    const entry = allowlist.find(e => matches(e, diff))
    if (entry) { used.add(entry); allowlisted.push({ ...diff, reason: entry.reason }) } else failures.push(diff)
  }
  const unused = allowlist.filter(e => !used.has(e))
  const webNames = new Set(web.components.map(c => c.name))
  return {
    desktop_source: desktop.source,
    web_version: web.version,
    summary: {
      web_elements: web.components.length,
      desktop_elements: desktop.components.length,
      compared_elements: desktop.components.filter(c => webNames.has(c.name)).length,
      failures: failures.length,
      allowlisted: allowlisted.length,
      info: info.length,
      unused_allowlist_entries: unused.length,
    },
    failures,
    allowlisted,
    info,
    unused_allowlist: unused,
  }
}
