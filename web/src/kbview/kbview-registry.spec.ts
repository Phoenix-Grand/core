/// <reference types="node" />
/**
 * The web `.kbview` element registry (VIEWS-SPEC §9, §10):
 *  - its JSON has the desktop export's exact shape (so vskubuno's `ComponentRegistry.FromJson`
 *    reads it unchanged) plus the web additions;
 *  - the committed `src/ui/kbview-registry.web.json` is up to date;
 *  - it conforms to the desktop registry (same names and semantics), every difference being
 *    allowlisted with a reason. The JSON diff report is written to `KBVIEW_CONFORMANCE_REPORT`
 *    (default: `kbview-conformance-report.json` in the OS temp directory).
 *
 * The desktop side is the committed snapshot of the real export, or - `KUBUNO_DESKTOP_REGISTRY=<path>` -
 * a fresh full export (`view_embed --export-registry`).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildWebRegistry, webRegistryText, type ComponentJson } from './export.ts'
import { checkConformance, normalizeDesktopExport, type DesktopSnapshot } from './conformance.ts'
import { KBVIEW_ALLOWLIST } from './allowlist.ts'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// The key sets of the desktop export (`kubuno-views` `registry/export.rs`, its own key-set test).
const COMPONENT_KEYS = [
  'name', 'doc', 'doc_fr', 'family', 'icon', 'children', 'allowed_children', 'layout_kind', 'properties', 'events',
  'default_event', 'base_chain', 'origin', 'kind', 'non_visual', 'linked', 'extends', 'crate_name', 'toolbox_category',
  'toolbox_icon', 'browsable', 'default_property', 'view_path', 'source_file', 'source_line', 'design_size',
]
const WEB_COMPONENT_KEYS = ['design_defaults', 'web']
const PROPERTY_KEYS = [
  'name', 'kind', 'default', 'doc', 'doc_fr', 'category', 'browsable', 'bindable', 'localizable', 'serialization',
  'editor', 'type_converter', 'inherited_from', 'root_only', 'design_time', 'aliases',
]
const EVENT_KEYS = [
  'name', 'display_name', 'doc', 'doc_fr', 'category', 'args_type', 'args_chain', 'args_rust_type', 'args_mut',
  'cancelable', 'routing', 'aliases', 'browsable', 'root_only', 'common', 'inherited_from',
]
const sorted = (keys: Iterable<string>) => [...keys].sort()

function desktopSnapshot(): DesktopSnapshot {
  const fresh = process.env.KUBUNO_DESKTOP_REGISTRY
  if (fresh) {
    const text = readFileSync(fresh, 'utf8').replace(/^﻿/, '')
    const line = text.split(/\r?\n/).find(l => l.trimStart().startsWith('{"version"')) ?? text
    return normalizeDesktopExport(JSON.parse(line), `view_embed --export-registry (${fresh})`)
  }
  return JSON.parse(readFileSync(here('./__fixtures__/desktop-registry.snapshot.json'), 'utf8')) as DesktopSnapshot
}

describe('kbview registry - JSON shape', () => {
  const registry = buildWebRegistry()
  const byName = new Map(registry.components.map(c => [c.name, c]))

  it('is a schema-1 web export with unique element names', () => {
    expect(registry.schema).toBe(1)
    expect(registry.target).toBe('web')
    expect(registry.version).toMatch(/^[0-9a-f]{16}$/)
    expect(byName.size).toBe(registry.components.length)
  })

  it.each(registry.components.map(c => [c.name, c] as const))('%s has the desktop key sets', (_name, c: ComponentJson) => {
    expect(sorted(Object.keys(c))).toEqual(sorted([...COMPONENT_KEYS, ...WEB_COMPONENT_KEYS]))
    for (const p of c.properties) expect(sorted(Object.keys(p)), p.name).toEqual(sorted(PROPERTY_KEYS))
    for (const e of c.events) expect(sorted(Object.keys(e)), e.name).toEqual(sorted(EVENT_KEYS))
  })

  it.each(registry.components.map(c => [c.name, c] as const))('%s has valid values, French docs and a web mapping for every member', (_name, c: ComponentJson) => {
    expect(c.doc_fr, 'element doc_fr').toBeTruthy()
    const propNames = new Set<string>()
    for (const p of c.properties) {
      expect(propNames.has(p.name), `duplicate property ${p.name}`).toBe(false)
      propNames.add(p.name)
      expect(p.doc_fr, `${p.name} doc_fr`).toBeTruthy()
      if (p.kind === 'Bool') expect(['true', 'false'], `${p.name} default`).toContain(p.default)
      else if (p.kind === 'F32') expect(p.default === '' || Number.isFinite(Number(p.default)), `${p.name} default`).toBe(true)
      else if (typeof p.kind === 'object') expect(p.kind.Enum, `${p.name} default`).toContain(p.default)
      expect(c.web.prop_map[p.name], `${p.name} has no prop_map entry`).toBeDefined()
      const values = c.web.prop_map[p.name].values as Record<string, unknown> | undefined
      if (values) {
        const allowed = p.kind === 'Bool' ? ['true', 'false'] : typeof p.kind === 'object' ? p.kind.Enum : []
        for (const key of Object.keys(values)) expect(allowed, `${p.name}: value table key ${key}`).toContain(key)
      }
    }
    const eventNames = new Set<string>()
    for (const e of c.events) {
      expect(eventNames.has(e.name), `duplicate event ${e.name}`).toBe(false)
      eventNames.add(e.name)
      expect(e.name.startsWith('On'), e.name).toBe(true)
      expect(e.doc_fr, `${e.name} doc_fr`).toBeTruthy()
      expect(e.args_chain.at(-1)).toBe('EventArgs')
      expect(c.web.event_map[e.name], `${e.name} has no event_map entry`).toBeDefined()
    }
    if (c.default_event) expect(eventNames, 'default_event').toContain(c.default_event)
    if (c.children === 'None') expect(c.web.children_to_prop).toBeNull()
  })

  it('maps alternate components only onto members the element has', () => {
    for (const c of registry.components) {
      const props = new Set(c.properties.map(p => p.name))
      const events = new Set(c.events.map(e => e.name))
      for (const alt of c.web.alternates as Array<{ when: Record<string, string>; prop_map: object; event_map: object }>) {
        for (const [prop, value] of Object.entries(alt.when)) {
          const p = c.properties.find(x => x.name === prop)
          expect(p, `${c.name}: alternate selector ${prop}`).toBeDefined()
          if (p && typeof p.kind === 'object') expect(p.kind.Enum).toContain(value)
        }
        for (const k of Object.keys(alt.prop_map)) expect(props, `${c.name} alternate property ${k}`).toContain(k)
        for (const k of Object.keys(alt.event_map)) expect(events, `${c.name} alternate event ${k}`).toContain(k)
      }
    }
  })

  it('wires every item element to a parent adapter that names it', () => {
    for (const c of registry.components.filter(c => c.web.module === null)) {
      expect(c.web.item_of.length, c.name).toBeGreaterThan(0)
      for (const parent of c.web.item_of) {
        const p = byName.get(parent)
        expect(p, `${c.name}: parent ${parent}`).toBeDefined()
        expect(p!.allowed_children, `${parent} allows ${c.name}`).toContain(c.name)
        const adapter = p!.web.children_to_prop as { item: string | string[] } | null
        const items = adapter ? [adapter.item].flat() : []
        // A nested item (MenuItem in MenuItem) is consumed through the root adapter's `nested` field.
        if (parent !== c.name) expect(items, `${parent} adapter consumes ${c.name}`).toContain(c.name)
      }
    }
  })
})

describe('kbview registry - typography matches the host CSS', () => {
  const typography = buildWebRegistry().typography
  const indexCss = readFileSync(here('../index.css'), 'utf8')
  const themeCss = readFileSync(here('../theme.css'), 'utf8')
  const publicFile = (path: string) => here(`../../public/${path}`)

  it('lists exactly the @font-face rules of index.css, with their files', () => {
    const faces = [...indexCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(m => {
      const body = m[1]
      return {
        family: /font-family:\s*"([^"]+)"/.exec(body)?.[1],
        style: /font-style:\s*([a-z]+)/.exec(body)?.[1],
        weight: /font-weight:\s*([0-9 ]+?)\s*;/.exec(body)?.[1],
        file: /url\("\/([^"]+)"\)/.exec(body)?.[1],
      }
    })
    expect(typography.faces.map(f => ({ family: f.family, style: f.style, weight: f.weight, file: f.file }))).toEqual(faces)
    for (const f of typography.faces) {
      expect(() => readFileSync(publicFile(f.file)), f.file).not.toThrow()
      if (f.license_file) expect(() => readFileSync(publicFile(f.license_file!)), f.license_file).not.toThrow()
    }
  })

  it('has the family stacks, role sizes and weights of the CSS', () => {
    const sans = /--font-family-sans:\s*([^;!]+?)\s*!important;/.exec(indexCss)?.[1]
    const mono = /--font-family-mono:\s*([^;]+);/.exec(themeCss)?.[1]
    const stack = (css: string | undefined) => (css ?? '').split(',').map(s => s.trim().replace(/^"|"$/g, ''))
    expect(typography.families.sans).toEqual(stack(sans))
    expect(typography.families.mono).toEqual(stack(mono))
    for (const role of Object.values(typography.roles)) {
      const declared = new RegExp(`${role.token}:\\s*([0-9.]+)px`).exec(themeCss)?.[1]
      expect(Number(declared), role.token).toBe(role.size)
    }
    expect(Number(new RegExp(`${typography.page_title.token}:\\s*([0-9.]+)px`).exec(themeCss)?.[1])).toBe(typography.page_title.size)
    expect(/body\s*\{[^}]*font-weight:\s*(\d+)/.exec(indexCss)?.[1]).toBe(String(typography.weights.body))
    expect(/--font-weight-medium:\s*(\d+)\s*!important/.exec(indexCss)?.[1]).toBe(String(typography.weights.medium))
    expect(/button\s*\{\s*font-weight:\s*(\d+)\s*!important/.exec(indexCss)?.[1]).toBe(String(typography.weights.button))
  })
})

describe('kbview registry - committed file', () => {
  it('src/ui/kbview-registry.web.json is up to date (npm run build:registry)', () => {
    const committed = readFileSync(here('../ui/kbview-registry.web.json'), 'utf8')
    expect(committed === webRegistryText(), 'run `npm run build:registry`').toBe(true)
  })
})

describe('kbview registry - conformance with the desktop export', () => {
  it('has no difference outside the allowlist, and no stale allowlist entry', () => {
    const report = checkConformance(buildWebRegistry(), desktopSnapshot(), KBVIEW_ALLOWLIST)
    const out = process.env.KBVIEW_CONFORMANCE_REPORT ?? join(tmpdir(), 'kbview-conformance-report.json')
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
    // Every web element is compared, except the new ones the desktop does not have yet (allowlisted, with a reason).
    const webOnly = KBVIEW_ALLOWLIST.filter(e => e.kind === 'element-web-only').length
    expect(report.summary.compared_elements).toBe(report.summary.web_elements - webOnly)
    expect(report.failures, `see ${out}`).toEqual([])
    expect(report.unused_allowlist, `see ${out}`).toEqual([])
  })

  it('reports an unlisted difference as a failure', () => {
    const web = buildWebRegistry()
    const button = web.components.find(c => c.name === 'Button')!
    const tampered = {
      ...web,
      components: [{ ...button, properties: button.properties.map(p => (p.name === 'Size' ? { ...p, default: 'Lg' } : p)) }],
    }
    const report = checkConformance(tampered, desktopSnapshot(), KBVIEW_ALLOWLIST)
    expect(report.failures).toContainEqual(expect.objectContaining({ kind: 'property-mismatch', element: 'Button', member: 'Size', field: 'default' }))
  })
})
