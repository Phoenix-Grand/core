/**
 * Builds `kbview-registry.web.json` from the metadata tables: the exact JSON shape of the desktop
 * registry export (`kubuno-views` `registry::export`, served as `kubuno/registry`, read by
 * vskubuno's `ComponentRegistry.FromJson`) plus the web-only additions of VIEWS-SPEC §9:
 * top-level `schema`/`target`, and per component `design_defaults` and the `web` block.
 *
 * Pure functions over plain data: runs under `node` (type stripping) for `npm run build:registry`
 * and under vitest for the conformance test.
 */
import type {
  AnyElementMeta, EventMeta, PropKind, PropTarget, EventSource, DesignDefaults,
} from '../ui/kbview/types.ts'
import { EVENT_ARGS } from '../ui/kbview/types.ts'
import { INHERITED_LEVELS, VIEW_EVENTS, VIEW_PROPERTIES } from '../ui/kbview/levels.ts'
import { WEB_ELEMENTS } from './elements.ts'
import {
  WEB_FONT_FACES, WEB_FONT_FAMILIES, WEB_FONT_WEIGHTS, WEB_PAGE_TITLE, WEB_TEXT_ROLES,
} from '../ui/kbview/typography.ts'

/** Version of the registry JSON schema (VIEWS-SPEC §9). Bumped on an incompatible change only. */
export const REGISTRY_SCHEMA = 1

// ── JSON shapes (snake_case: vskubuno's `RegistryJsonOptions` uses a snake-case policy) ──

export type PropKindJson = PropKind

export interface PropertyJson {
  name: string
  kind: PropKindJson
  default: string
  doc: string
  doc_fr: string | null
  category: string | null
  browsable: boolean
  bindable: boolean
  localizable: boolean
  serialization: string | null
  editor: string | null
  type_converter: string | null
  inherited_from: string | null
  root_only: boolean
  design_time: boolean
  aliases: string[]
}

export interface EventJson {
  name: string
  display_name: string
  doc: string
  doc_fr: string | null
  category: string
  args_type: string
  args_chain: string[]
  /** The handler's args type: on the web, the `@kubuno/views` TypeScript type (same name as `args_type`). */
  args_rust_type: string
  args_mut: boolean
  cancelable: boolean
  routing: string
  aliases: string[]
  browsable: boolean
  root_only: boolean
  common: boolean
  inherited_from: string | null
}

/** The web block (VIEWS-SPEC §9.3): read by the web compiler, runtime and designer only. */
export interface WebBlockJson {
  module: string | null
  export: string | null
  dom_root: string
  /** `.kbview` property → how it reaches the component (snake_case of `PropTarget`). */
  prop_map: Record<string, Record<string, unknown>>
  /** `.kbview` event → its source (snake_case of `EventSource`). */
  event_map: Record<string, Record<string, unknown>>
  children_to_prop: Record<string, unknown> | null
  content: string | null
  slots: Record<string, string>
  /** Components that replace the main one for some property values (snake_case of `AlternateBinding`). */
  alternates: Array<Record<string, unknown>>
  item_of: string[]
  fixed: Record<string, unknown>
  /** Members present on the web only (each one is allowlisted by the conformance test). */
  web_only: string[]
  /** The children are an item template (`Repeater`): present only when true. */
  template?: boolean
}

export interface ComponentJson {
  name: string
  doc: string
  doc_fr: string | null
  family: string
  icon: string
  children: string
  allowed_children: string[]
  layout_kind: string | null
  properties: PropertyJson[]
  events: EventJson[]
  default_event: string | null
  base_chain: string[]
  origin: string
  kind: string
  non_visual: boolean
  linked: boolean
  extends: string | null
  crate_name: string | null
  toolbox_category: string | null
  toolbox_icon: string | null
  browsable: boolean
  default_property: string | null
  view_path: string | null
  source_file: string | null
  source_line: number | null
  design_size: [number, number] | null
  // ── web additions (ignored by the desktop consumers) ──
  design_defaults: { attributes: Record<string, string>; size: [number, number] | null }
  web: WebBlockJson
}

/** The target's typography (VIEWS-SPEC §7): what the design surface must load to render like production. */
export interface TypographyJson {
  faces: Array<{ family: string; style: string; weight: string; file: string; license: string; license_file: string | null }>
  families: { sans: string[]; mono: string[] }
  roles: Record<string, { token: string; size: number }>
  page_title: { token: string; size: number; admin_size: number }
  weights: { body: number; medium: number; button: number }
}

export interface RegistryExportJson {
  schema: number
  target: 'web'
  version: string
  typography: TypographyJson
  components: ComponentJson[]
}

/** The typography block, from `typography.ts` (checked against the host CSS by the registry test). */
export function typographyJson(): TypographyJson {
  return {
    faces: WEB_FONT_FACES.map(f => ({
      family: f.family, style: f.style, weight: f.weight, file: f.file, license: f.license, license_file: f.licenseFile,
    })),
    families: { sans: [...WEB_FONT_FAMILIES.sans], mono: [...WEB_FONT_FAMILIES.mono] },
    roles: Object.fromEntries(Object.entries(WEB_TEXT_ROLES).map(([k, v]) => [k, { token: v.token, size: v.size }])),
    page_title: { token: WEB_PAGE_TITLE.token, size: WEB_PAGE_TITLE.size, admin_size: WEB_PAGE_TITLE.adminSize },
    weights: { ...WEB_FONT_WEIGHTS },
  }
}

// ── Helpers ──

/** `"TextField"` → `"text-field"`, as the desktop export derives `icon`. */
export function kebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (c, i: number) => (i > 0 ? '-' : '') + c.toLowerCase())
}

/** 64-bit FNV-1a, hex - the desktop export's `version` algorithm (a cache key, not a checksum). */
export function fnv1aHex(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

function snakeKey(key: string): string {
  return key.replace(/[A-Z]/g, c => '_' + c.toLowerCase())
}

/**
 * Recursively converts an object's keys to snake_case (`propMap` entries, adapters) - except the
 * keys of a `values` table, which are `.kbview` enum values and stay as written.
 */
function snake(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snake)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [snakeKey(k), k === 'values' ? v : snake(v)]))
  }
  return value
}

function propertyJson(
  p: AnyElementMeta['properties'][number], inheritedFrom: string | null, rootOnly: boolean,
): PropertyJson {
  return {
    name: p.name,
    kind: p.kind,
    default: p.default,
    doc: p.doc,
    doc_fr: p.docFr || null,
    category: p.category,
    browsable: p.browsable ?? true,
    bindable: p.bindable ?? false,
    localizable: p.localizable ?? false,
    serialization: p.serialization ?? null,
    editor: p.editor ?? null,
    type_converter: p.typeConverter ?? null,
    inherited_from: inheritedFrom,
    root_only: rootOnly,
    design_time: p.designTime ?? false,
    aliases: [...(p.aliases ?? [])],
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function eventJson(e: EventMeta<any>, opts: { common: boolean; rootOnly: boolean; inheritedFrom: string | null }): EventJson {
  const args = EVENT_ARGS[e.args]
  return {
    name: e.name,
    display_name: e.name.startsWith('On') ? e.name.slice(2) : e.name,
    doc: e.doc,
    doc_fr: e.docFr || null,
    category: e.category,
    args_type: e.args,
    args_chain: [...args.chain],
    args_rust_type: e.args,
    args_mut: args.mutable,
    cancelable: args.cancelable,
    routing: e.routing ?? 'Direct',
    aliases: [...(e.aliases ?? [])],
    browsable: e.browsable ?? true,
    root_only: opts.rootOnly,
    common: opts.common,
    inherited_from: opts.inheritedFrom,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTarget = PropTarget<any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySource = EventSource<any>

function targetJson(t: AnyTarget): Record<string, unknown> {
  return snake(t) as Record<string, unknown>
}

function sourceJson(s: AnySource): Record<string, unknown> {
  return snake(s) as Record<string, unknown>
}

function designDefaultsJson(d: DesignDefaults | undefined): ComponentJson['design_defaults'] {
  return {
    attributes: { ...(d?.attributes ?? {}) },
    size: d?.size ? [d.size[0], d.size[1]] : null,
  }
}

/** One element → its export entry (own members, then inherited levels, then the view's). */
export function componentJson(meta: AnyElementMeta, origin: 'builtin' | 'project' = 'builtin'): ComponentJson {
  const properties: PropertyJson[] = []
  const events: EventJson[] = []
  const propMap: WebBlockJson['prop_map'] = {}
  const eventMap: WebBlockJson['event_map'] = {}
  const webOnly: string[] = []
  const inheritedMap: Record<string, AnyTarget> = { ...(meta.inheritedMap ?? {}) }

  for (const p of meta.properties) {
    properties.push(propertyJson(p, null, false))
    propMap[p.name] = targetJson(p.to)
    if (p.webOnly) webOnly.push(p.name)
  }
  for (const e of meta.events) {
    events.push(eventJson(e, { common: false, rootOnly: false, inheritedFrom: null }))
    eventMap[e.name] = sourceJson(e.from)
  }

  // Inherited levels, nearest first, as the desktop's `all_properties()` lists them.
  const own = new Set(properties.map(p => p.name))
  const ownEvents = new Set(events.map(e => e.name))
  for (const level of meta.baseChain.slice(1)) {
    const table = INHERITED_LEVELS[level]
    if (!table) continue
    for (const p of table.properties) {
      if (own.has(p.name)) continue
      own.add(p.name)
      properties.push(propertyJson(p, level, false))
      propMap[p.name] = targetJson(inheritedMap[p.name] ?? p.to)
      if (p.webOnly) webOnly.push(p.name)
    }
    for (const e of table.events) {
      if (ownEvents.has(e.name)) continue
      ownEvents.add(e.name)
      events.push(eventJson(e, { common: true, rootOnly: false, inheritedFrom: level }))
      eventMap[e.name] = sourceJson(e.from)
    }
  }

  // A control can be the root of a view: it then takes the view's own members.
  const isControl = meta.baseChain.includes('Control')
  if (isControl) {
    for (const p of VIEW_PROPERTIES) {
      if (own.has(p.name)) continue
      properties.push(propertyJson(p, 'View', true))
      propMap[p.name] = targetJson(p.to)
    }
    for (const e of VIEW_EVENTS) {
      events.push(eventJson(e, { common: false, rootOnly: true, inheritedFrom: 'View' }))
      eventMap[e.name] = sourceJson(e.from)
      if (e.name === 'OnUnload') webOnly.push(e.name)
    }
  }

  const web = meta.web
  const nonVisual = meta.kind === 'component'
  return {
    name: meta.name,
    doc: meta.doc,
    doc_fr: meta.docFr || null,
    family: meta.family,
    icon: kebabCase(meta.name),
    children: meta.children,
    allowed_children: [...(meta.allowedChildren ?? [])],
    layout_kind: meta.layoutKind ?? null,
    properties,
    events,
    default_event: meta.defaultEvent ?? null,
    base_chain: [...meta.baseChain],
    origin,
    kind: nonVisual ? 'component' : 'control',
    non_visual: nonVisual,
    linked: false,
    extends: null,
    crate_name: null,
    toolbox_category: null,
    toolbox_icon: null,
    browsable: true,
    default_property: null,
    view_path: null,
    source_file: null,
    source_line: null,
    design_size: null,
    design_defaults: designDefaultsJson(meta.designDefaults),
    web: {
      module: web.module,
      export: web.export,
      dom_root: web.domRoot,
      prop_map: propMap,
      event_map: eventMap,
      children_to_prop: web.childrenToProp ? (snake(web.childrenToProp) as Record<string, unknown>) : null,
      content: web.content ?? null,
      slots: { ...(web.slots ?? {}) },
      alternates: (web.alternates ?? []).map(a => ({
        when: { ...a.when },
        module: a.module,
        export: a.export,
        dom_root: a.domRoot,
        prop_map: Object.fromEntries(Object.entries(a.propMap).map(([k, v]) => [k, targetJson(v)])),
        event_map: Object.fromEntries(Object.entries(a.eventMap).map(([k, v]) => [k, sourceJson(v)])),
        fixed: { ...(a.fixed ?? {}) },
      })),
      item_of: [...(web.itemOf ?? [])],
      fixed: { ...(web.fixed ?? {}) },
      web_only: webOnly,
      ...(web.template ? { template: true } : {}),
    },
  }
}

/** The whole `kbview-registry.web.json` document. Deterministic: no timestamp, stable order. */
export function buildWebRegistry(elements: readonly AnyElementMeta[] = WEB_ELEMENTS): RegistryExportJson {
  const components = elements.map((m) => componentJson(m))
  const typography = typographyJson()
  return {
    schema: REGISTRY_SCHEMA,
    target: 'web',
    // A cache key over everything a client reads (the desktop hashes its components only).
    version: fnv1aHex(JSON.stringify({ typography, components })),
    typography,
    components,
  }
}

/**
 * The file's exact text, shared by the build and the drift test: compact JSON with one component
 * per line (every element repeats its inherited members, as the desktop export does, so an
 * indented file would weigh several MB; one line per element keeps git diffs per element).
 */
export function webRegistryText(elements: readonly AnyElementMeta[] = WEB_ELEMENTS): string {
  const { components, ...head } = buildWebRegistry(elements)
  const lines = components.map(c => JSON.stringify(c))
  return JSON.stringify(head).slice(0, -1) + ',"components":[\n' + lines.join(',\n') + '\n]}\n'
}

/**
 * A project registry (a project's own custom controls, `kubuno.views.json` → `registries`): the same component
 * shape with `origin: "project"`, the `web.module` of each control relative to the registry file
 * (`./AppTileGrid`). No typography (the host's applies).
 */
export function projectRegistryText(elements: readonly AnyElementMeta[]): string {
  const components = elements.map((m) => componentJson(m, 'project'))
  const head = { schema: REGISTRY_SCHEMA, target: 'web', version: fnv1aHex(JSON.stringify(components)) }
  const lines = components.map(c => JSON.stringify(c))
  return JSON.stringify(head).slice(0, -1) + ',"components":[\n' + lines.join(',\n') + '\n]}\n'
}
