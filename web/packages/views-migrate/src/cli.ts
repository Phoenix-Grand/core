/**
 * `kbview-migrate` - converts TSX screens of a web project to `.kbview` views (WEB-VIEWS.md §6.2, WV-11).
 *
 *   kbview-migrate [--project <dir>] [--write] [--report <file.json>] [--component <Name>] [--layout --app-root <dir>] <file.tsx>…
 *   kbview-migrate --relayout [--project <dir>] [--write] [--report <file.json>] [--app-root <dir>]… [--exclude <dir>]…
 *                  [--split <n>] [--components] [--place <view-or-component>=<dir>]… [--rename <view>=<Name>]…
 *                  [--move <from>=<to>]…
 *
 * Each screen is classified first (VIEWS-SPEC §1.1, `layout.ts`): a page a route renders, a window or a dialog becomes
 * a view (`X.kbview`); a component other components place becomes a user control (`X.kbcontrol`, root
 * `<UserControl x:Props>`). With `--layout` the converted files then move to the folder of their role under the app
 * root(s) given by `--app-root` (VIEWS-SPEC §1.2). `--relayout` does both for the views a project already has (and,
 * with `--components`, for its React components): extensions, roots, folders (`git mv`), importers.
 *
 * Without `--write` nothing is written: the report says what each file would become (converted, partial with the
 * reasons, or skipped). With `--write` the view, code-behind and parts are written next to the `.tsx`, the `.tsx` is
 * deleted, importers are switched to the default export, and the `defaultValue`s of strings missing from the
 * fallback bundle are written into it (`locales/en/<ns>.json`, or a module's catalogue `src/i18n.data.json`, whose
 * `i18n.ts` is then generated again); only what fits in neither goes to `<project>/src/views-defaults.json`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { openProject } from './project.js'
import { migrateFile, rewriteImporters, targetComponent, type MigrationResult } from './migrate.js'
import { splitFile } from './split.js'
import { classify, listFiles, slash, type Role } from './layout.js'
import { applyRelayout, planRelayout, relayoutReport } from './relayout.js'

/** Every value of a repeatable flag (`--app-root a --app-root b`). */
function flags(argv: readonly string[], name: string): string[] {
  return argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []))
}

/** `--relayout`: classify the project's views again and move them into the layout. */
function relayoutMain(argv: readonly string[]): number {
  const root = resolve(flags(argv, '--project')[0] ?? process.cwd())
  const split = flags(argv, '--split')[0]
  const plan = planRelayout({
    root,
    appRoots: flags(argv, '--app-root').length ? flags(argv, '--app-root') : undefined,
    exclude: flags(argv, '--exclude'),
    split: split ? Number(split) : undefined,
    components: argv.includes('--components'),
    rename: flags(argv, '--rename').map((m) => {
      const [unit, stem] = m.split('=')
      return { unit, stem }
    }),
    place: flags(argv, '--place').map((m) => {
      const [unit, dir] = m.split('=')
      return { unit, dir }
    }),
    extraMoves: flags(argv, '--move').map((m) => {
      const [from, to] = m.split('=')
      return { from, to }
    }),
  })
  const report = relayoutReport(root, plan)
  for (const line of report.lines) console.log(line)
  const reportFile = flags(argv, '--report')[0]
  if (reportFile) writeFileSync(reportFile, JSON.stringify(report.json, null, 2) + '\n')
  if (argv.includes('--write')) applyRelayout(root, plan)
  return 0
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--relayout')) return relayoutMain(argv)
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const write = argv.includes('--write')
  const root = resolve(flag('--project') ?? process.cwd())
  const reportFile = flag('--report')
  const component_ = flag('--component')
  const outDir = flag('--out')
  const skipNext = new Set(['--project', '--report', '--component', '--out', '--app-root', '--exclude', '--split'])
  const layout = argv.includes('--layout')
  const split = argv.includes('--split')
  let files = argv.filter((a, i) => !a.startsWith('--') && !skipNext.has(argv[i - 1] ?? '')).map((f) => resolve(f))
  if (!files.length) {
    console.error('usage: kbview-migrate [--project <dir>] [--write] [--split] [--report <file.json>] [--component <Name>] <file.tsx>…')
    return 2
  }
  const ctx = openProject(root, files)
  const results: MigrationResult[] = []
  // --split: the files exporting several components are cut into one file per component first (in memory, then on
  // disk with --write); the new files join the batch.
  const splitWrites: Record<string, string> = {}
  const splitDeletes: string[] = []
  if (split) {
    const next: string[] = []
    for (const f of files) {
      const sf = ctx.project.getSourceFile(f)
      const s = sf && splitFile(ctx.config, sf)
      if (!s) {
        next.push(f)
        continue
      }
      for (const [p, text] of Object.entries(s.created)) {
        ctx.project.createSourceFile(p, text, { overwrite: true })
        splitWrites[p] = text
        next.push(p)
      }
      Object.assign(splitWrites, s.edits)
      splitDeletes.push(...s.deleted)
      if (s.deleted.some((d) => resolve(d) === resolve(f))) ctx.project.getSourceFile(f)?.delete()
      else next.push(f)
      console.log(`SPLIT     ${relative(root, f)} → ${s.moved.map((x) => relative(root, x.file)).join(', ')}`)
    }
    files = next
  }
  const same = (a: string, b: string): boolean => resolve(a) === resolve(b)
  // What each screen is (a view or a user control), from how the project uses it, before anything changes.
  const roles = new Map<string, Role>()
  {
    const sources = new Map(ctx.project.getSourceFiles().map((sf) => [slash(sf.getFilePath()), sf.getFullText()] as [string, string]))
    const units = files.map((f) => ({ stem: basename(f).replace(/\.tsx?$/, ''), dir: slash(dirname(f)), module: slash(f), files: [slash(f)] }))
    for (const c of classify(units, sources, listFiles(join(root, 'src')))) {
      roles.set(resolve(c.module), c.role)
      console.log(`${c.role === 'view' ? 'VIEW   ' : 'CONTROL'}   ${relative(root, c.module)}: ${c.reason}`)
    }
  }
  // The screens nothing of which maps to a view element stay TSX: known first, so that their importers keep them.
  const leftAsIs = new Map<string, MigrationResult>()
  for (const f of files) {
    const sf = ctx.project.getSourceFile(f)
    if (!sf) continue
    const r = migrateFile(ctx.config, sf, component_, { role: roles.get(resolve(f)) })
    if (r.status === 'skipped' && r.stats.elements > 0 && r.stats.mapped === 0) leftAsIs.set(f, r)
  }
  // The importers of every component of the batch switch to its default export first (see rewriteImporters).
  const targets = files.flatMap((f) => {
    if (leftAsIs.has(f)) return []
    const sf = ctx.project.getSourceFile(f)
    const component = sf && targetComponent(sf, component_)
    return sf && component ? [{ sf, component }] : []
  })
  const importerEdits = rewriteImporters(ctx.config, targets)
  for (const f of files) {
    const sf = ctx.project.getSourceFile(f)
    if (!sf) {
      results.push({ file: f, status: 'skipped', reasons: ['not found in the project'], stats: { elements: 0, mapped: 0, classAttributes: 0, parts: 0, getters: 0, handlers: 0, bindings: 0, resources: 0 }, outputs: {}, deletes: [], edits: {}, defaults: [] })
      continue
    }
    const r = leftAsIs.get(f) ?? migrateFile(ctx.config, sf, component_, { role: roles.get(resolve(f)) })
    results.push(r)
    const rel = relative(root, f)
    console.log(`${r.status.toUpperCase().padEnd(9)} ${rel}${r.component ? ` (${r.component})` : ''}: ${r.stats.mapped}/${r.stats.elements} elements, ${r.stats.parts} part(s), ${r.stats.classAttributes} Class, ${r.stats.getters} getter(s), ${r.stats.handlers} handler(s)`)
    for (const reason of r.reasons) console.log(`          - ${reason}`)
    if (outDir && r.status !== 'skipped') {
      // A dry run that keeps the result: everything mirrored under --out (the project untouched).
      for (const [p, text] of Object.entries({ ...r.outputs, ...r.edits })) {
        const target = join(outDir, relative(root, p))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, text)
      }
    }
    if (write && r.status !== 'skipped') {
      for (const [p, text] of Object.entries(r.outputs)) {
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, text)
      }
      for (const [p, text] of Object.entries(r.edits)) writeFileSync(p, text)
      for (const p of r.deletes) rmSync(p, { force: true })
    }
  }
  // The split files and their importers (before the importers' own conversion edits, which win).
  for (const [p, text] of Object.entries(splitWrites)) {
    if (Object.keys(importerEdits).some((q) => same(q, p)) || results.some((r) => r.deletes.some((q) => same(q, p)) || Object.keys(r.outputs).some((q) => same(q, p)))) continue
    if (write) {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, text)
    }
    if (outDir) {
      const target = join(outDir, relative(root, p))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text)
    }
  }
  if (write) for (const p of splitDeletes) rmSync(p, { force: true })
  // The importers of the converted components (outside the batch).
  for (const [p, text] of Object.entries(importerEdits)) {
    if (write) writeFileSync(p, text)
    if (outDir) {
      const target = join(outDir, relative(root, p))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text)
    }
  }
  if (write) {
    const done = storeDefaults(root, results.flatMap((r) => r.defaults))
    for (const line of done.log) console.log(line)
  }
  // --layout: the converted screens go to the folders of their roles (and their importers follow).
  if (write && layout) {
    const converted = new Set(results.flatMap((r) => Object.keys(r.outputs).map((p) => slash(resolve(p)))))
    const plan = planRelayout({
      root,
      appRoots: flags(argv, '--app-root').length ? flags(argv, '--app-root') : undefined,
      exclude: flags(argv, '--exclude'),
      only: (u) => u.files.some((f) => converted.has(f)),
    })
    for (const line of relayoutReport(root, plan).lines) console.log(line)
    applyRelayout(root, plan)
  }
  if (reportFile) writeFileSync(reportFile, JSON.stringify(summary(root, results), null, 2) + '\n')
  const s = summary(root, results)
  console.log(`\n${s.converted} converted, ${s.partial} partial, ${s.skipped} skipped (of ${results.length}); elements mapped ${s.elementsMapped}/${s.elements} (${s.elements ? Math.round((100 * s.elementsMapped) / s.elements) : 0} %), ${s.parts} part(s), ${s.classAttributes} Class attribute(s)`)
  return 0
}

type Default = MigrationResult['defaults'][number]

/** Sets `key` (dotted) in a nested bundle unless it holds a text already; `false` when a text sits on its path. */
function setNested(doc: Record<string, unknown>, key: string, value: string): boolean {
  const path = key.split('.')
  let o = doc
  for (const seg of path.slice(0, -1)) {
    const next = o[seg]
    if (next === undefined) o = (o[seg] = {}) as Record<string, unknown>
    else if (next && typeof next === 'object') o = next as Record<string, unknown>
    else return false
  }
  if (o[path[path.length - 1]] === undefined) o[path[path.length - 1]] = value
  return true
}

/**
 * Writes the `defaultValue`s of `t('k', { defaultValue })` whose key no bundle has (the TSX showed the default in
 * every language) where the project's strings are loaded from, in the fallback language every language falls back to -
 * so the view shows the same text:
 *  1. `src/**\/locales/<lang>/<ns>.json` (the core's bundles);
 *  2. else a module's catalogue `src/i18n.data.json` (`{ <lang>: { … } }`) when its `src/i18n.ts` registers `ns`
 *     (`registerModuleTranslations('<ns>', …)`); `i18n.ts` is generated from it, so its generator
 *     (`src/gen_i18n.mjs`) runs again - without one, the log says to regenerate it;
 *  3. else `src/views-defaults.json`, which nothing loads: the log says so, to move by hand.
 */
export function storeDefaults(root: string, defaults: readonly Default[], lang = 'en'): { files: string[]; left: Default[]; log: string[] } {
  const log: string[] = []
  const files: string[] = []
  const left: Default[] = []
  if (!defaults.length) return { files, left, log }
  const byNs = new Map<string, Default[]>()
  for (const d of defaults) byNs.set(d.ns, [...(byNs.get(d.ns) ?? []), d])
  const data = join(root, 'src', 'i18n.data.json')
  const reg = join(root, 'src', 'i18n.ts')
  const catalogueNs = existsSync(data) && existsSync(reg) ? /registerModuleTranslations\(\s*['"]([^'"]+)['"]/.exec(readFileSync(reg, 'utf8'))?.[1] : undefined
  let catalogueChanged = false
  for (const [ns, list] of byNs) {
    const file = fallbackBundle(root, ns, lang)
    if (file) {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      for (const d of list) if (!setNested(doc, d.key, d.value)) left.push(d)
      writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
      files.push(file)
      continue
    }
    if (ns === catalogueNs) {
      const all = JSON.parse(readFileSync(data, 'utf8')) as Record<string, Record<string, unknown>>
      const doc = (all[lang] ??= {})
      for (const d of list) if (!setNested(doc, d.key, d.value)) left.push(d)
      writeFileSync(data, JSON.stringify(all, null, 2) + '\n')
      if (!files.includes(data)) files.push(data)
      catalogueChanged = true
      continue
    }
    left.push(...list)
  }
  if (catalogueChanged) {
    const gen = join(root, 'src', 'gen_i18n.mjs')
    if (existsSync(gen)) {
      const r = spawnSync(process.execPath, [gen], { cwd: root, encoding: 'utf8' })
      if (r.status === 0) {
        log.push(`defaults: ${relative(root, data)} (${lang}), ${relative(root, reg)} generated again`)
        files.push(reg)
      } else log.push(`defaults: ${relative(root, data)} (${lang}) - ${relative(root, gen)} FAILED (${(r.stderr || r.error?.message || '').trim()}): generate ${relative(root, reg)} again by hand`)
    } else log.push(`defaults: ${relative(root, data)} (${lang}) - generate ${relative(root, reg)} again from it (no src/gen_i18n.mjs)`)
  }
  if (left.length) {
    const file = join(root, 'src', 'views-defaults.json')
    const prev = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string>>) : {}
    for (const d of left) (prev[d.ns] ??= {})[d.key] = d.value
    writeFileSync(file, JSON.stringify(prev, null, 2) + '\n')
    files.push(file)
    log.push(`defaults: ${left.length} text(s) in ${relative(root, file)}, which NOTHING LOADS - move them into the bundles (no ${lang} bundle or catalogue for ${[...new Set(left.map((d) => d.ns))].join(', ')})`)
  }
  return { files, left, log }
}

/** `src/**\/locales/<fallback>/<ns>.json` of the project (the first found), the bundle every language falls back to. */
function fallbackBundle(root: string, ns: string, lang = 'en'): string | undefined {
  const walk = (dir: string): string | undefined => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.kubuno', 'dist', '.git'].includes(name)) continue
      const full = join(dir, name)
      if (!statSync(full).isDirectory()) continue
      if (name === 'locales' && existsSync(join(full, lang, `${ns}.json`))) return join(full, lang, `${ns}.json`)
      const found = walk(full)
      if (found) return found
    }
    return undefined
  }
  return existsSync(join(root, 'src')) ? walk(join(root, 'src')) : undefined
}

export function summary(root: string, results: MigrationResult[]) {
  const sum = (k: keyof MigrationResult['stats']) => results.reduce((n, r) => n + r.stats[k], 0)
  return {
    converted: results.filter((r) => r.status === 'converted').length,
    partial: results.filter((r) => r.status === 'partial').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    elements: sum('elements'),
    elementsMapped: sum('mapped'),
    parts: sum('parts'),
    classAttributes: sum('classAttributes'),
    files: results.map((r) => ({
      file: relative(root, r.file).split('\\').join('/'),
      component: r.component,
      status: r.status,
      reasons: r.reasons,
      stats: r.stats,
      outputs: Object.keys(r.outputs).map((p) => relative(root, p).split('\\').join('/')),
      defaults: r.defaults.length,
    })),
  }
}
