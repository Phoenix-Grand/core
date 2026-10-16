import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'

import { migrateFile, type MigrationResult } from '../src/migrate.js'
import { openProject } from '../src/project.js'
import { summary } from '../src/cli.js'
import { cleanJsxText } from '../src/jsxtext.js'
import { mapLabelClasses, mapStackClasses } from '../src/classes.js'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FRONTEND = resolve(PKG, '..', '..')
const SAMPLE = join(PKG, 'test', 'fixtures', 'Sample.tsx')

let result: MigrationResult
let view = ''
let code = ''
let parts = ''

beforeAll(() => {
  const { project, config } = openProject(FRONTEND, [SAMPLE])
  result = migrateFile(config, project.getSourceFileOrThrow(SAMPLE))
  const out = (suffix: string) => Object.entries(result.outputs).find(([p]) => p.endsWith(suffix))?.[1] ?? ''
  view = out('Sample.kbview')
  code = out('Sample.ts') || out('Sample.tsx')
  parts = out('Sample.parts.tsx')
}, 120_000)

describe('kbview-migrate on a sample screen', () => {
  it('converts it, reporting what it left to React (a local component, used twice)', () => {
    expect(result.component).toBe('Sample')
    expect(result.status).toBe('partial')
    expect(result.reasons).toEqual(['<Badge> is no .kbview element (a local or dynamic component)'])
    expect(result.stats.parts).toBe(2)
    // ts-morph paths use forward slashes on every OS.
    expect(result.deletes.map((p) => p.split('\\').join('/'))).toEqual([SAMPLE.split('\\').join('/')])
    const s = summary(FRONTEND, [result])
    expect(s.partial).toBe(1)
    expect(s.elementsMapped).toBeGreaterThan(10)
  })

  it('writes the markup with the registry elements, HTML tags, roles and colours', () => {
    expect(view).toMatch(/^<!-- Sample - converted from Sample\.tsx/)
    expect(view).toContain('<Panel x:Props="SampleProps" Class="max-w-md space-y-4">')
    // A heading keeps its level; text-lg stays a class, font-medium and the colour become properties.
    expect(view).toMatch(/<Label HtmlTag="H2"[^>]*Text="\{Binding props\.title\}"[^>]*FontWeight="Medium"[^>]*ForeColor="TextPrimary"[^>]*Class="text-lg"/s)
    // t() with a count → {Res} with its argument (the role Body of text-sm is the default, left out).
    expect(view).toContain('Text="{Res sample.count, Count={Binding done}}"')
    // A flex row → a Stack with the gap in px.
    expect(view).toContain('<Stack Direction="LeftToRight" CrossAlign="Center">') // gap-2 = 8 px, the Stack's default
    // @ui Input → TextField.
    // value + onChange writing a state field → a two-way binding, no handler.
    expect(view).toContain('<TextField Text="{Binding name, Mode=TwoWay}" Label="{Res sample.name}"/>')
    expect(view).toContain('<Button Enabled="{Binding enabled_unless_name}" Text="{Res common.add}" OnClick="add"/>')
    // cond && <p/> → Visible; list.map → Repeater over memoized rows, keyed.
    expect(view).toMatch(/<Label Text="\{Res sample\.empty\}"[^>]*Visible="\{Binding show_items\}"/s)
    expect(view).toMatch(/<Panel HtmlTag="Ul" Class="space-y-1">\s*<Repeater ItemKey="key" ItemsSource="\{Binding rows_items\}">/)
    expect(view).toMatch(/<Icon Name="Check" Size="14" Visible="\{Binding item\.done\}" Class="text-success"\/>/)
    // A <button> → a PushButton container sized like a native button; title → ToolTip (rendered as the title).
    expect(view).toMatch(/<Panel AccessibleRole="PushButton"\s+AutoSize="true"\s+ToolTip="\{Res sample\.copy\}"/)
    // <Link> → LinkLabel with the router navigation.
    expect(view).toMatch(/<LinkLabel Href="\/settings"\s+Text="\{Res sample\.settings\}"\s+ForeColor="Primary"[^>]*OnClick="link_label_click"\/>/)
    // The local component → a ReactHost rendering it, from the parts file.
    expect(view).toContain('<ReactHost Component="{Binding Badge}" Props="{Binding badge_props}"/>')
    expect(view).toContain('<!-- TODO(views-migrate): <Badge> is no .kbview element (a local or dynamic component) -->')
  })

  it('writes a code-behind class: state as @bind fields, hooks in useStores() / useHooks(), getters, methods', () => {
    expect(code).toContain("import { bind, type MouseEventArgs } from '@kubuno/views'")
    expect(code).toContain("import { ViewBase } from './Sample.kbview'")
    expect(code).toContain('export class Sample extends ViewBase {')
    expect(code).toContain('@bind accessor items: Item[] = []')
    expect(code).toContain("@bind accessor name = ''")
    expect(code).toContain('@bind accessor copied = false')
    // A hook reading nothing of the class: in useStores().
    expect(code).toMatch(/useStores\(\) \{\s*const \{ t \} = useTranslation\(\)\s*return \{ t \}\s*\}/)
    // Every string is a {Res}: the hooks' `t` needs no field.
    expect(code).not.toContain('tr!:')
    // A derived constant → a getter; an object getter → View.memo.
    expect(code).toMatch(/get done\(\)(: \w+)? \{\s*return this\.items\.filter\(\(i\) => i\.done\)\.length/)
    expect(code).toMatch(/get rows_items\(\) \{\s*return this\.memo\('rows_items', \[this\.items\]/)
    // A setter call → an assignment; a functional update reads the current value.
    expect(code).toMatch(/add\(\) \{\s*this\.items = \[\.\.\.this\.items, \{ id: String\(this\.items\.length\), label: this\.name, done: false \}\]\s*this\.name = ''/)
    expect(code).toContain("export type SampleStores = ReturnType<Sample['useStores']>")
    expect(code).toContain('export default Sample.component()')
    // The code-behind is valid TypeScript (syntax).
    const out = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve } })
    expect(out.diagnostics ?? []).toEqual([])
    // A component shown under a condition: its getter and its props' getter are guarded alike, and the props' memo
    // depends on what the guard reads (computed while it failed, it is computed again once it holds).
    expect(code).toMatch(/get Badge2\(\) \{\s*if \(!\(this\.copied\)\) return undefined as never\s*return __parts\.Badge/)
    expect(code).toMatch(/get badge_props2\(\) \{\s*return this\.memo\('badge_props2', \[this\.name, this\.copied\]/)
    // A top-level statement declaring nothing (a registration) is kept, after the class.
    expect(code).toMatch(/export default Sample\.component\(\)\s+console\.debug\('sample loaded'\)/)
    expect(parts).toContain('export { Badge }')
  })
})

describe('helpers', () => {
  it('cleans JSX text as React does', () => {
    expect(cleanJsxText('\n    Hello\n    world  \n  ')).toBe('Hello world')
    expect(cleanJsxText(' a ')).toBe(' a ')
  })

  it('maps Tailwind classes to properties only where exact', () => {
    expect(mapLabelClasses('text-sm font-medium text-text-primary mb-3')).toMatchObject({ props: { Role: 'Body', FontWeight: 'Medium', ForeColor: 'TextPrimary', Overflow: 'Wrap' }, rest: ['mb-3'] })
    // A hover variant of the colour keeps the colour a class (an inline colour would beat the hover).
    expect(mapLabelClasses('text-primary hover:text-primary-hover').props.ForeColor).toBeUndefined()
    expect(mapStackClasses('flex flex-col gap-3 items-center')).toMatchObject({ props: { Direction: 'TopDown', Gap: '12', CrossAlign: 'Center' }, rest: [] })
    // Responsive flex classes: not a Stack (its inline layout would override them).
    expect(mapStackClasses('flex flex-col sm:flex-row')).toBeUndefined()
  })
})
