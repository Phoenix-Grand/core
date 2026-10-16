/**
 * `kbres-convert`: the existing i18next dictionaries of a web module → `.kbres` sets (WEB-VIEWS.md §6.2, lot WV-6).
 *
 * Two sources, the two shapes the Kubuno web code has:
 *
 * - **`locales/<lang>/<ns>.json`** folders (the core's `core.json`): `readJsonLocales(dir, ns)`;
 * - **`i18n.ts` modules** calling `registerModuleTranslations(ns, { en, fr, … })`, the languages written inline
 *   (`const en = { … }`), imported from `./locales/en` (`export default { … }`) or from JSON files:
 *   `readI18nModule(file)` evaluates them **statically** with the TypeScript parser - object and string literals,
 *   constants, imports, spreads - and refuses anything else (a computed value would be silently lost).
 *
 * The output keeps every key, value and key order: compiling the written set back (`compileKbresSet`, the Vite
 * plugin's path) gives the same bundles, which `kbres-convert --check` and the tests verify.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import { bundlesToKbres, compileKbresSet, type I18nBundle, type KbresCodec } from './kbres.js'

type TS = typeof import('typescript')
type Bundles = Record<string, Record<string, unknown>>

/** `<dir>/<lang>/<ns>.json` for every language folder of `dir`. */
export function readJsonLocales(dir: string, ns: string): Bundles {
  const out: Bundles = {}
  for (const lang of readdirSync(dir).sort()) {
    const file = join(dir, lang, `${ns}.json`)
    if (statSync(join(dir, lang)).isDirectory() && existsSync(file)) out[lang] = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  }
  return out
}

/** Loads TypeScript from `fromDir`'s project (the converter never bundles its own). */
export function loadTypeScript(fromDir: string): TS {
  const require = createRequire(join(resolve(fromDir), 'package.json'))
  return require('typescript') as TS
}

class StaticError extends Error {}

/** A static evaluator of the literal subset i18n modules are written in. */
class Evaluator {
  private readonly sources = new Map<string, import('typescript').SourceFile>()

  constructor(private readonly ts: TS) {}

  private source(file: string): import('typescript').SourceFile {
    let sf = this.sources.get(file)
    if (!sf) {
      sf = this.ts.createSourceFile(file, readFileSync(file, 'utf8'), this.ts.ScriptTarget.Latest, true)
      this.sources.set(file, sf)
    }
    return sf
  }

  private where(node: import('typescript').Node): string {
    const sf = node.getSourceFile()
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart())
    return `${sf.fileName}(${line + 1},${character + 1})`
  }

  private fail(node: import('typescript').Node, what: string): never {
    throw new StaticError(`${this.where(node)}: ${what} - kbres-convert only reads literal dictionaries (objects, strings, constants, imports)`)
  }

  /** A module file of `spec` imported from `from` (`.ts`, `.tsx`, `.js`, `/index.*`, `.json`). */
  private resolveModule(from: string, spec: string, node: import('typescript').Node): string {
    if (!spec.startsWith('.')) this.fail(node, `the import \`${spec}\` is not a relative module`)
    const base = resolve(dirname(from), spec)
    for (const f of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, join(base, 'index.ts'), join(base, 'index.js')]) {
      if (existsSync(f) && statSync(f).isFile()) return f
    }
    return this.fail(node, `cannot find the module \`${spec}\``)
  }

  /** The value an imported binding names: `default` or a named export of `file`. */
  private exported(file: string, name: string, node: import('typescript').Node): unknown {
    if (file.endsWith('.json')) {
      if (name !== 'default') this.fail(node, `a JSON module has no export \`${name}\``)
      return JSON.parse(readFileSync(file, 'utf8')) as unknown
    }
    const ts = this.ts
    const sf = this.source(file)
    for (const st of sf.statements) {
      if (name === 'default' && ts.isExportAssignment(st) && !st.isExportEquals) return this.value(st.expression)
      if (ts.isVariableStatement(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return this.value(d.initializer)
        }
      }
    }
    return this.fail(node, `\`${file}\` has no literal export \`${name}\``)
  }

  /** The value of identifier `id`: a constant of its file, or an import. */
  private identifier(id: import('typescript').Identifier): unknown {
    const ts = this.ts
    const sf = id.getSourceFile()
    for (const st of sf.statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === id.text) {
            if (!(st.declarationList.flags & ts.NodeFlags.Const) || !d.initializer) this.fail(id, `\`${id.text}\` is not a constant`)
            return this.value(d.initializer)
          }
        }
      }
      if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
        const clause = st.importClause
        const spec = st.moduleSpecifier.text
        if (clause.name?.text === id.text) return this.exported(this.resolveModule(sf.fileName, spec, id), 'default', id)
        const bindings = clause.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if (el.name.text === id.text) return this.exported(this.resolveModule(sf.fileName, spec, id), (el.propertyName ?? el.name).text, id)
          }
        }
      }
    }
    return this.fail(id, `\`${id.text}\` is not declared in its file`)
  }

  value(node: import('typescript').Expression): unknown {
    const ts = this.ts
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) {
      return this.value(node.expression)
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isIdentifier(node)) return this.identifier(node)
    if (ts.isObjectLiteralExpression(node)) {
      const out: Record<string, unknown> = {}
      for (const p of node.properties) {
        if (ts.isPropertyAssignment(p)) {
          const k = p.name
          let name: string
          if (ts.isIdentifier(k) || ts.isStringLiteral(k) || ts.isNumericLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) name = k.text
          else if (ts.isComputedPropertyName(k)) name = String(this.value(k.expression))
          else return this.fail(p, 'an unsupported key')
          out[name] = this.value(p.initializer)
        } else if (ts.isShorthandPropertyAssignment(p)) {
          out[p.name.text] = this.identifier(p.name)
        } else if (ts.isSpreadAssignment(p)) {
          const v = this.value(p.expression)
          if (!v || typeof v !== 'object') this.fail(p, 'a spread of a non-object')
          Object.assign(out, v)
        } else {
          return this.fail(p, 'a method or accessor in a dictionary')
        }
      }
      return out
    }
    return this.fail(node, `an unsupported expression (${ts.SyntaxKind[node.kind]})`)
  }

  /** Every `registerModuleTranslations(ns, bundles)` call of `file`. */
  registrations(file: string): Array<{ ns: string; bundles: Bundles }> {
    const ts = this.ts
    const out: Array<{ ns: string; bundles: Bundles }> = []
    const visit = (n: import('typescript').Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
        if (name === 'registerModuleTranslations' && n.arguments.length >= 2) {
          const ns = this.value(n.arguments[0])
          const bundles = this.value(n.arguments[1])
          if (typeof ns !== 'string') this.fail(n.arguments[0], 'the namespace is not a string')
          if (!bundles || typeof bundles !== 'object') this.fail(n.arguments[1], 'the bundles are not an object')
          out.push({ ns, bundles: bundles as Bundles })
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(this.source(resolve(file)))
    return out
  }
}

/** The dictionaries an `i18n.ts`-style module registers, by namespace (statically evaluated). */
export function readI18nModule(ts: TS, file: string): Array<{ ns: string; bundles: Bundles }> {
  return new Evaluator(ts).registrations(file)
}

/** Deep comparison that also requires the same key order (a converted set must be byte-for-byte the same JSON). */
export function sameBundles(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** What `writeKbresSet` wrote. */
export interface ConvertedSet {
  neutral: string
  files: string[]
}

/**
 * Writes the `.kbres` set of `bundles` at `outFile` (the neutral file; satellites `stem.<lang>.kbres` beside it),
 * then reads it back and throws unless every language gives the very same bundle (keys, values, order).
 */
export function writeKbresSet(codec: KbresCodec, bundles: Bundles, outFile: string, neutral: string): ConvertedSet {
  const texts = bundlesToKbres(codec, bundles, neutral, outFile)
  const stem = outFile.replace(/\.kbres$/i, '')
  mkdirSync(dirname(outFile), { recursive: true })
  const files = [outFile]
  writeFileSync(outFile, texts.neutral)
  for (const [lang, text] of Object.entries(texts.satellites)) {
    const f = `${stem}.${lang}.kbres`
    writeFileSync(f, text)
    files.push(f)
  }
  verifyKbresSet(codec, bundles, outFile)
  return { neutral, files }
}

/** Reads the set at `file` back and throws on the first language whose bundle differs from `bundles`. */
export function verifyKbresSet(codec: KbresCodec, bundles: Bundles, file: string): Record<string, I18nBundle> {
  const back = compileKbresSet(codec, file)
  if (back.errors.length) throw new Error(back.errors.join('\n'))
  const langs = new Set([...Object.keys(bundles), ...Object.keys(back.bundles)])
  for (const lang of langs) {
    if (!sameBundles(bundles[lang], back.bundles[lang])) {
      throw new Error(`${file}: the ${lang} bundle does not round-trip (${firstDifference(bundles[lang], back.bundles[lang])})`)
    }
  }
  return back.bundles
}

function firstDifference(a: unknown, b: unknown, path = ''): string {
  if (typeof a !== typeof b || (a && typeof a === 'object') !== (b && typeof b === 'object')) return `${path || '(root)'}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b as object)
    if (ka.join('\u0000') !== kb.join('\u0000')) {
      const missing = ka.filter((k) => !kb.includes(k))
      const extra = kb.filter((k) => !ka.includes(k))
      return `${path || '(root)'}: keys differ${missing.length ? `, lost ${missing.slice(0, 3).join(', ')}` : ''}${extra.length ? `, added ${extra.slice(0, 3).join(', ')}` : ''}${!missing.length && !extra.length ? ' in order' : ''}`
    }
    for (const k of ka) {
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k)
      if (d) return d
    }
    return ''
  }
  return a === b ? '' : `${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`
}
