/**
 * The codemod: one `.tsx` screen → `X.kbview` + `X.ts` code-behind (+ `X.parts.tsx` for what stays React) + a report
 * (vskubuno docs/WEB-VIEWS.md §6.2, lot WV-11).
 *
 * The component's body becomes the code-behind class:
 *
 * | TSX | code-behind |
 * |---|---|
 * | `const [x, setX] = useState(init)` (static `init`) | `@bind accessor x = init`; `setX(v)` → `this.x = v`, `setX(f => …)` → `this.x = …` |
 * | other hooks (`useTranslation`, stores, `useEffect`, custom hooks) | moved verbatim into `use()`; the locals they declare become fields assigned there (`@bind` for data) |
 * | a derived constant (`const n = items.length`) | a getter (memoized when it builds an object) |
 * | a local function | a method |
 * | props (`{ a, b }: Props`) | `this.props.a`, the root's `x:Props` |
 *
 * and the JSX becomes markup: `@ui` components by reverse registry lookup, intrinsic elements as `Panel` / `Stack` /
 * `Label` (with their HTML tag when it is not a `div` / `p`, so the DOM - and the accessibility tree - stay the
 * same), classes mapped to properties where it is exact (`classes.ts`, the rest in `Class`), `t('k')` → `{Res k}`,
 * expressions → `{Binding …}` (a getter when not a plain path), `cond && <X/>` → `Visible`, `list.map(…)` →
 * `Repeater` over memoized rows, inline handlers → methods. What does not convert (a local component, a raw
 * `<input>`, an unmapped prop…) is cut out as a part - a component in `X.parts.tsx` rendered through
 * `<ReactHost Component=… Props=…/>` - so the screen still renders the same; each cut is a reason in the report.
 */
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { Node, ts, type JsxElement, type JsxSelfClosingElement, type Project, type SourceFile } from 'ts-morph'

import { isSafeLiteral, cleanJsxText, decodeEntities } from './jsxtext.js'
import { mapContainerClasses, mapLabelClasses, mapStackClasses, mapStaticStyle } from './classes.js'
import type { ElementInfo, Registry } from './registry.js'
import { attr, writeXml, type XNode } from './xml.js'
import { toControlText, type Role } from './layout.js'

export type Status = 'converted' | 'partial' | 'skipped'

export interface MigrateConfig {
  project: Project
  registry: Registry
  /** The project root (`core/web`), for relative paths in the report. */
  root: string
  /** i18next default namespace of the project (`core`). */
  defaultNs: string
  /** Whether `key` exists in namespace `ns`'s fallback-language bundle (a `{Res}` without it needs its default). */
  hasKey: (ns: string, key: string) => boolean
}

export interface MigrationStats {
  elements: number
  mapped: number
  classAttributes: number
  parts: number
  getters: number
  handlers: number
  bindings: number
  resources: number
}

export interface MigrationResult {
  file: string
  component?: string
  status: Status
  reasons: string[]
  stats: MigrationStats
  /** Files to write (path → text). */
  outputs: Record<string, string>
  /** Files to delete (the `.tsx`). */
  deletes: string[]
  /** Other files of the project rewritten (importers switched to the default export). */
  edits: Record<string, string>
  /** `{Res}` keys missing from the fallback bundle, with the `defaultValue` the TSX gave them. */
  defaults: Array<{ ns: string; key: string; value: string }>
}

type FnLike = Node & { getBody(): Node | undefined; getParameters(): Node[] }

const HOOK = /^use[A-Z0-9]/

/** What a component-scope name becomes in the class. */
type Kind = 'state' | 'setter' | 'hook-data' | 'hook-fn' | 'derived' | 'method' | 'prop' | 'props-object' | 'translate'

interface Local {
  name: string
  kind: Kind
  /** The class member it is reached through (`this.<member>`). */
  member: string
  /** For a setter: the state member. */
  state?: string
  decl: ts.Node
  /** TypeScript type text of the field (`@bind accessor x: T`). */
  type?: string
  init?: string
  /**
   * For a list, map or set filled by statements of the body (`const rows = []; walk(root)`): those statements, and
   * the local functions they call, run again in its getter.
   */
  fill?: ts.Node[]
  /** For `translate`: the namespace of its `useTranslation(ns)`. */
  ns?: string
}

interface Getter {
  name: string
  body: string
  /** It builds an object: memoized on the members it reads. */
  memo: boolean
  doc?: string
  type?: string
  /** Conditions (class expressions) under which the getter is read: outside them it returns undefined. */
  guards?: string[]
  /** Local constants the body reads (`const geom = this.geom`), after the guard: a narrowing holds in its callbacks. */
  prelude?: string[]
}

interface Method {
  name: string
  params: string
  body: string
  async: boolean
  doc?: string
  /** `<K extends …>` of a generic function. */
  typeParams?: string
  /** The declared return type (`: number`), as written. */
  ret?: string
}

interface Part {
  name: string
  /** Free variables passed as props: prop name → expression in the class (or row). */
  props: Array<{ name: string; expr: string; type?: string }>
  jsx: string
  rowScoped: boolean
}

/** A Repeater template scope: the map callback's parameters, and the row fields computed for it. */
interface RowScope {
  /** Getter producing the rows (`rows_1`). */
  getter: string
  /** Parameter names of the map callback (item, index). */
  params: string[]
  paramDecls: ts.Node[]
  /** Row fields: name → expression (in terms of the params and `this.*`). */
  fields: Map<string, string>
  key?: string
}

const VIEW_MEMBERS = new Set(['props', 'dataContext', 'use', 't', 'invalidate', 'component', 'constructor', 'memo'])

const INTRINSIC_CONTAINERS: Readonly<Record<string, string>> = {
  div: 'Div', section: 'Section', nav: 'Nav', header: 'Header', footer: 'Footer', main: 'Main', aside: 'Aside',
  form: 'Form', ul: 'Ul', ol: 'Ol', li: 'Li', fieldset: 'Fieldset', article: 'Article', figure: 'Figure',
  span: 'Span', p: 'P', label: 'Label', h1: 'H1', h2: 'H2', h3: 'H3', h4: 'H4', h5: 'H5', h6: 'H6', strong: 'Strong', em: 'Em', small: 'Small', code: 'Code',
}
const TEXT_TAGS: Readonly<Record<string, string>> = {
  p: 'P', span: 'Span', h1: 'H1', h2: 'H2', h3: 'H3', h4: 'H4', h5: 'H5', h6: 'H6', strong: 'Strong', em: 'Em', small: 'Small', label: 'Label', code: 'Code', div: 'Div', li: 'Li',
}
/** ARIA role → `AccessibleRole` (the inverse of the registry's container map, unambiguous entries). */
const ROLE_OF_ARIA: Readonly<Record<string, string>> = {
  dialog: 'Dialog', alert: 'Alert', menu: 'MenuPopup', menuitem: 'MenuItem', tooltip: 'ToolTip', group: 'Grouping',
  separator: 'Separator', toolbar: 'ToolBar', status: 'StatusBar', table: 'Table', row: 'Row', cell: 'Cell', link: 'Link',
  list: 'List', listitem: 'ListItem', tree: 'Outline', treeitem: 'OutlineItem', tab: 'PageTab', tabpanel: 'PropertyPage',
  img: 'Graphic', button: 'PushButton', checkbox: 'CheckButton', radio: 'RadioButton', tablist: 'PageTabList',
  region: 'Pane', none: 'None', presentation: 'None', banner: 'TitleBar', document: 'Document', application: 'Application',
}

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()
}
function pascal(s: string): string {
  return s.replace(/(^|[_\-\s]+)([a-zA-Z0-9])/g, (_, __, c: string) => c.toUpperCase())
}

/** The migration of one file. */
class Migration {
  readonly reasons: string[] = []
  readonly stats: MigrationStats = { elements: 0, mapped: 0, classAttributes: 0, parts: 0, getters: 0, handlers: 0, bindings: 0, resources: 0 }
  readonly locals = new Map<ts.Node, Local>()
  readonly byName = new Map<string, Local>()
  readonly getters: Getter[] = []
  readonly methods: Method[] = []
  readonly useBody: string[] = []
  /** The names each statement of `useBody` declares. */
  readonly useNames: string[][] = []
  /** The statements of `useBody` (rewritten again for `useHooks()`, where the names of `useStores()` are fields). */
  readonly useStmts: Array<{ node: ts.Statement; transform: (t: string) => string }> = []

  /** A statement of the hooks, with the names it declares. */
  addUse(text: string, statement: ts.Statement, transform: (t: string) => string = (t) => t): void {
    this.useBody.push(text)
    this.useStmts.push({ node: statement, transform })
    this.useNames.push(ts.isVariableStatement(statement) ? statement.declarationList.declarations.flatMap((d) => declaredNames(d.name).map((n) => n.name)) : [])
  }
  readonly parts: Part[] = []
  readonly defaults: Array<{ ns: string; key: string; value: string }> = []
  readonly members = new Set<string>()
  readonly imports = new Set<string>()
  readonly viewsTypes = new Set<string>()
  readonly checker: ts.TypeChecker
  readonly stem: string
  readonly dir: string
  propsType?: string
  propsTypeDecl?: string
  needsMemoize = false
  /** Fields holding the values of hooks the TSX called only to render again (every memo depends on them). */
  readonly rerenderMembers: string[] = []
  needsNavigate = false
  /** Getters already made for an expression text (same expression → same getter). */
  readonly gettersByExpr = new Map<string, string>()
  /** State setters used as values: each becomes a method. */
  readonly usedSetters = new Set<Local>()
  /** Local components of the file a ReactHost renders (exported by `X.parts.tsx`). */
  readonly exportedLocals = new Set<string>()
  /** Import lines the code-behind needs besides the TSX's (`Fragment`). */
  readonly extraImports = new Set<string>()
  /** Components defined in the file other than the converted one (used through parts). */
  readonly localComponents = new Set<string>()
  /** Types the component body declared, moved to the code-behind's module level. */
  readonly hoisted: string[] = []

  constructor(readonly cfg: MigrateConfig, readonly sf: SourceFile, readonly fn: FnLike, readonly name: string) {
    this.checker = cfg.project.getTypeChecker().compilerObject
    this.stem = basename(sf.getFilePath()).replace(/\.tsx?$/, '')
    this.dir = dirname(sf.getFilePath())
    for (const m of VIEW_MEMBERS) this.members.add(m)
  }

  reason(r: string): void {
    if (!this.reasons.includes(r)) this.reasons.push(r)
  }

  /** A class member name not used yet. */
  member(base: string): string {
    let name = base.replace(/[^A-Za-z0-9_$]/g, '_')
    if (!/^[A-Za-z_$]/.test(name)) name = '_' + name
    if (VIEW_MEMBERS.has(name)) name = name === 't' ? 'tr' : name + '_'
    let n = name
    for (let k = 2; this.members.has(n); k++) n = `${name}${k}`
    this.members.add(n)
    return n
  }

  typeText(node: ts.Node): string | undefined {
    try {
      const type = this.checker.getTypeAtLocation(node)
      // Seen from the file itself: a type it does not import is written `import("…").T`.
      let text = this.checker.typeToString(type, this.sf.compilerNode, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope)
      text = this.qualifyShadowed(type, text)
      // `import("/abs/path").X` → a path relative to the code-behind.
      text = text.replace(/import\("([^"]+)"\)/g, (_m, p: string) => {
        // A package specifier (`@kubuno/drive`) stays as written.
        if (!isAbsolute(p)) return _m
        let rel = relative(this.dir, p).split('\\').join('/')
        if (!rel.startsWith('.')) rel = './' + rel
        return `import(${JSON.stringify(rel)})`
      })
      if (text.includes('typeof ') && /typeof [a-z]/.test(text)) return undefined
      return text
    } catch {
      return undefined
    }
  }

  /**
   * A type printed by its bare name while the file names something else so (`Folder[]`, the `Folder` of
   * `@kubuno/drive`, in a file importing lucide's `Folder` icon): written `import("…").Folder` instead, from the
   * module the file imports it through when there is one, else from its declaration file.
   */
  private qualifyShadowed(type: ts.Type, text: string): string {
    const named = new Map<string, ts.Symbol[]>()
    const seen = new Set<ts.Type>()
    const collect = (t: ts.Type, depth: number): void => {
      if (depth > 8 || seen.has(t)) return
      seen.add(t)
      for (const s of [t.aliasSymbol, t.getSymbol()]) if (s) named.set(s.getName(), [...(named.get(s.getName()) ?? []), s])
      for (const a of t.aliasTypeArguments ?? []) collect(a, depth + 1)
      if (t.isUnionOrIntersection()) for (const u of t.types) collect(u, depth + 1)
      if (t.flags & ts.TypeFlags.Object && (t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
        for (const a of this.checker.getTypeArguments(t as ts.TypeReference)) collect(a, depth + 1)
      }
    }
    collect(type, 0)
    if (!named.size) return text
    const resolve = (s: ts.Symbol): ts.Symbol => this.checker.getExportSymbolOfSymbol(s.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(s) : s)
    const inScope = new Map<string, ts.Symbol>()
    for (const s of this.checker.getSymbolsInScope(this.sf.compilerNode, ts.SymbolFlags.Type | ts.SymbolFlags.Value | ts.SymbolFlags.Alias)) {
      if (!inScope.has(s.getName())) inScope.set(s.getName(), s)
    }
    const replacements = new Map<string, string>()
    for (const [name, cands] of named) {
      if (!new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(text.replace(/import\("[^"]*"\)\.[\w$.]+/g, ''))) continue
      const here = inScope.get(name)
      // A name the file does not have is the caller's business (it keeps or drops a type it cannot write); only a
      // name the file gives to something else is qualified.
      if (!here) continue
      const targets = cands.map(resolve)
      if (targets.includes(resolve(here))) continue
      const target = targets.find((t) => t.declarations?.length)
      if (!target) continue
      replacements.set(name, this.importTypeOf(target, name))
    }
    if (!replacements.size) return text
    // Outside the `import("…").X` already written and outside member names (`a.Folder`).
    return text.replace(/import\("[^"]*"\)\.[\w$.]+|[A-Za-z_$][\w$]*/g, (tok, offset: number, all: string) => {
      if (tok.startsWith('import(')) return tok
      if (offset > 0 && all[offset - 1] === '.') return tok
      return replacements.get(tok) ?? tok
    })
  }

  /** `import("<module>").Name` of a declared type: through one of the file's imports exporting it, else its file. */
  private importTypeOf(target: ts.Symbol, name: string): string {
    for (const imp of this.sf.getImportDeclarations()) {
      const mod = this.checker.getSymbolAtLocation(imp.getModuleSpecifier().compilerNode)
      if (!mod) continue
      for (const e of this.checker.getExportsOfModule(mod)) {
        const r = e.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(e) : e
        if (r === target) return `import(${JSON.stringify(imp.getModuleSpecifierValue())}).${e.getName()}`
      }
    }
    const file = target.declarations![0].getSourceFile().fileName.replace(/(\.d)?\.tsx?$/, '')
    return `import(${JSON.stringify(file)}).${name}`
  }

  isFunctionType(node: ts.Node): boolean {
    const type = this.checker.getTypeAtLocation(node)
    return type.getCallSignatures().length > 0 && !(type.flags & ts.TypeFlags.Object && type.getProperties().length > 4)
  }

  isBooleanType(node: ts.Node): boolean {
    const type = this.checker.getTypeAtLocation(node)
    const flags = type.flags
    if (flags & ts.TypeFlags.BooleanLike) return true
    if (type.isUnion()) return type.types.every((t) => !!(t.flags & ts.TypeFlags.BooleanLike))
    return false
  }

  // ── Locals ────────────────────────────────────────────────────────────────

  addLocal(local: Local): void {
    this.locals.set(local.decl, local)
    this.byName.set(local.name, local)
  }

  /** The `Local` a name at `id` refers to (through the checker), if it is one of the component's. */
  localOf(id: ts.Identifier): Local | undefined {
    let sym: ts.Symbol | undefined
    if (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) sym = this.checker.getShorthandAssignmentValueSymbol(id.parent)
    else sym = this.checker.getSymbolAtLocation(id)
    if (!sym) return undefined
    if (sym.flags & ts.SymbolFlags.Alias) return undefined
    for (const d of sym.declarations ?? []) {
      const l = this.locals.get(d)
      if (l) return l
    }
    return undefined
  }

  /**
   * The source of `node` with the component's locals rewritten for the class (`x` → `this.x`, `setX(v)` →
   * `this.x = v`, `t(…)` → `this.tr(…)`), `rows` maps a template's parameters to their row expressions.
   * `inUse`: the code stays in `use()`, where hook locals are still local variables.
   */
  rewrite(node: ts.Node, opts: { inUse?: boolean; rows?: Map<ts.Node, string>; localNames?: ReadonlySet<string>; bare?: ReadonlySet<Local> } = {}): string {
    const sfText = node.getSourceFile().text
    const start = node.getStart()
    const end = node.getEnd()
    const edits: Array<{ s: number; e: number; text: string }> = []
    const visit = (n: ts.Node): void => {
      // `setX(v)` / `setX(prev => …)` as a statement → an assignment of the state field.
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const l = this.localOf(n.expression)
        if (l?.kind === 'setter' && l.state && n.arguments.length === 1) {
          const arg = n.arguments[0]
          const field = `this.${l.state}`
          let value: string
          if ((ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && arg.parameters.length === 1 && ts.isIdentifier(arg.parameters[0].name)) {
            // `setX(prev => expr)`: `prev` is the current value.
            const p = arg.parameters[0]
            const inner = new Map(opts.rows ?? [])
            inner.set(p, field)
            const body = arg.body
            // A block keeps its parameter (called with the current value); an expression reads the field directly.
            value = ts.isBlock(body) ? `((${(p.name as ts.Identifier).text}) => ${this.rewrite(body, opts)})(${field})` : this.rewrite(body, { ...opts, rows: inner })
            if (!ts.isBlock(body) && ts.isObjectLiteralExpression(skipParens(body))) value = `(${value.replace(/^\((.*)\)$/s, '$1')})`
          } else {
            const t = this.checker.getTypeAtLocation(arg)
            value = t.getCallSignatures().length ? `((v) => (typeof v === 'function' ? v(${field}) : v))(${this.rewrite(arg, opts)})` : this.rewrite(arg, opts)
          }
          // A statement stays a statement (`this.x = v`, no parentheses: the line before has no semicolon); an
          // expression keeps its value (`(this.x = v)`).
          const statement = ts.isExpressionStatement(n.parent) || (ts.isArrowFunction(n.parent) && n.parent.body === n)
          edits.push({ s: n.getStart(), e: n.getEnd(), text: statement ? `${field} = ${value}` : `(${field} = ${value})` })
          return
        }
      }
      // `typeof user` in a type: the member's type, `X['user']` (`typeof this.user` is not allowed everywhere).
      if (ts.isTypeQueryNode(n) && ts.isIdentifier(n.exprName) && !(opts.inUse)) {
        const l = this.localOf(n.exprName)
        if (l) {
          const text = l.kind === 'prop' ? `${this.stem}['props']['${l.member}']` : l.kind === 'props-object' ? `${this.stem}['props']` : `${this.stem}['${l.member}']`
          edits.push({ s: n.getStart(), e: n.getEnd(), text })
          return
        }
      }
      if (ts.isIdentifier(n)) {
        const parent = n.parent
        // Property names, declarations' own names: not references.
        if ((ts.isPropertyAccessExpression(parent) && parent.name === n) || (ts.isPropertyAssignment(parent) && parent.name === n) ||
          (ts.isBindingElement(parent) && parent.propertyName === n) || ts.isJsxAttribute(parent) || (ts.isMethodDeclaration(parent) && parent.name === n)) return
        if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) {
          if (parent.tagName !== n) return
        }
        const rowParam = opts.rows && this.rowParamOf(n, opts.rows)
        if (rowParam !== undefined) {
          const text = ts.isShorthandPropertyAssignment(parent) && parent.name === n ? `${n.text}: ${rowParam}` : rowParam
          edits.push({ s: n.getStart(), e: n.getEnd(), text })
          return
        }
        const l = this.localOf(n)
        if (!l) return
        let text: string
        if (opts.bare?.has(l)) return
        if (opts.inUse && (l.kind === 'hook-data' || l.kind === 'hook-fn' || l.kind === 'translate') && (!opts.localNames || opts.localNames.has(l.name))) return
        switch (l.kind) {
          case 'setter':
            // A setter passed as a value: the generated method (`setForm(v)`), bound.
            this.usedSetters.add(l)
            text = boundRef(l.member)
            break
          case 'prop':
            text = `this.props.${l.name}`
            break
          case 'props-object':
            text = 'this.props'
            break
          case 'method': {
            // A method passed as a value keeps its `this`.
            const called = ts.isCallExpression(parent) && parent.expression === n
            text = called ? `this.${l.member}` : boundRef(l.member)
            break
          }
          default:
            text = `this.${l.member}`
        }
        if (ts.isShorthandPropertyAssignment(parent) && parent.name === n) text = `${n.text}: ${text}`
        edits.push({ s: n.getStart(), e: n.getEnd(), text })
        return
      }
      ts.forEachChild(n, visit)
    }
    visit(node)
    edits.sort((a, b) => b.s - a.s)
    let out = sfText.slice(start, end)
    for (const e of edits) out = out.slice(0, e.s - start) + e.text + out.slice(e.e - start)
    return out
  }

  /** The row expression of a template parameter `id` refers to, if any. */
  rowParamOf(id: ts.Identifier, rows: Map<ts.Node, string>): string | undefined {
    const sym = this.checker.getSymbolAtLocation(id)
    for (const d of sym?.declarations ?? []) {
      const r = rows.get(d)
      if (r !== undefined) return r
    }
    return undefined
  }

  /**
   * The members an expression reads (`this.a`, `this.b`): the memo inputs of a getter. Methods are left out (they do
   * not change); fields holding functions (`this.tr`) are inputs (a new language gives a new `t`).
   */
  deps(text: string): string[] {
    const methods = new Set([...this.methods.map((x) => x.name), ...[...this.usedSetters].map((l) => l.member)])
    const bodies = new Map(this.methods.map((x) => [x.name, x.body] as const))
    const deps = new Set<string>()
    // What a method the text calls reads counts too (`{body()}` re-renders when `isLoading` changes).
    const seen = new Set<string>()
    const scan = (t: string): void => {
      for (const m of t.matchAll(/this\.([A-Za-z_$][\w$]*)\b/g)) {
        if (!methods.has(m[1])) deps.add(m[1])
        else if (!seen.has(m[1])) {
          seen.add(m[1])
          scan(bodies.get(m[1]) ?? '')
        }
      }
    }
    scan(text)
    return [...deps]
  }

  /** A getter for `expr` (in class terms); returns its name. `memo`: it builds an object (memoized on its inputs). */
  getter(base: string, expr: string, opts: { memo?: boolean; doc?: string; type?: string; guards?: string[]; prelude?: string[] } = {}): string {
    const key = (opts.guards?.length ? opts.guards.join(' && ') + ' => ' : '') + (opts.prelude?.length ? opts.prelude.join('; ') + ' => ' : '') + expr
    const known = this.gettersByExpr.get(key)
    if (known) return known
    const name = this.member(base)
    this.getters.push({ name, body: expr, memo: !!opts.memo, doc: opts.doc, type: opts.type, guards: opts.guards?.length ? [...opts.guards] : undefined, prelude: opts.prelude?.length ? [...opts.prelude] : undefined })
    this.gettersByExpr.set(key, name)
    this.stats.getters++
    return name
  }

  /** Whether the value of `node` is an object (a getter returning it must memoize; strings, numbers, booleans need not). */
  isObjectValue(node: ts.Node): boolean {
    try {
      const t = this.checker.getTypeAtLocation(node)
      const prim = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.BigIntLike
      const parts = t.isUnion() ? t.types : [t]
      return parts.some((p) => !(p.flags & prim))
    } catch {
      return Migration.buildsObject(node)
    }
  }

  /** Whether an expression builds a new object / array / function each time (a getter returning it must memoize). */
  static buildsObject(node: ts.Node): boolean {
    const e = skipParens(node)
    if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e) || ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isNewExpression(e) || ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) return true
    if (ts.isCallExpression(e)) return true
    if (ts.isConditionalExpression(e)) return Migration.buildsObject(e.whenTrue) || Migration.buildsObject(e.whenFalse)
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) {
      return Migration.buildsObject(e.left) || Migration.buildsObject(e.right)
    }
    return false
  }
}

function skipParens(n: ts.Node): ts.Node {
  let e = n
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression
  return e
}

// ── Finding the component ────────────────────────────────────────────────────

interface FoundComponent {
  name: string
  fn: FnLike
  exported: 'named' | 'default' | 'both'
}

function returnsJsx(fn: Node): boolean {
  let found = false
  fn.forEachDescendant((d, t) => {
    if (Node.isFunctionDeclaration(d) || Node.isArrowFunction(d) || Node.isFunctionExpression(d)) {
      if (d !== fn) t.skip()
      return
    }
    if (Node.isReturnStatement(d)) {
      const e = d.getExpression()
      // `return cond ? <A/> : <B/>` and `return x && <A/>` return JSX too.
      if (e && (Node.isJsxElement(skip(e)) || Node.isJsxSelfClosingElement(skip(e)) || Node.isJsxFragment(skip(e)) || Node.isParenthesizedExpression(e) || ((Node.isConditionalExpression(e) || Node.isBinaryExpression(e)) && containsJsx(e.compilerNode)))) found = true
    }
  })
  if (Node.isArrowFunction(fn)) {
    const b = fn.getBody()
    if (Node.isJsxElement(skip(b)) || Node.isJsxSelfClosingElement(skip(b)) || Node.isJsxFragment(skip(b))) found = true
  }
  return found
}

function skip(n: Node): Node {
  let e = n
  while (Node.isParenthesizedExpression(e)) e = e.getExpression()
  return e
}

/** Every PascalCase function component of the file, the exported ones flagged. */
export function componentsOf(sf: SourceFile): Array<FoundComponent & { exportedAt: boolean }> {
  const out: Array<FoundComponent & { exportedAt: boolean }> = []
  for (const f of sf.getFunctions()) {
    const name = f.getName()
    if (!name || !/^[A-Z]/.test(name) || !returnsJsx(f)) continue
    const isDefault = f.isDefaultExport()
    out.push({ name, fn: f as unknown as FnLike, exported: isDefault ? 'default' : 'named', exportedAt: f.isExported() })
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer()
    const name = v.getName()
    if (!init || !/^[A-Z]/.test(name)) continue
    if (!(Node.isArrowFunction(init) || Node.isFunctionExpression(init)) || !returnsJsx(init)) continue
    const stmt = v.getVariableStatement()
    out.push({ name, fn: init as unknown as FnLike, exported: 'named', exportedAt: !!stmt?.isExported() })
  }
  // `export default X` of a local component.
  const def = sf.getExportAssignment((e) => !e.isExportEquals())
  if (def) {
    const e = def.getExpression()
    if (Node.isIdentifier(e)) {
      const c = out.find((o) => o.name === e.getText())
      if (c) {
        c.exported = c.exportedAt ? 'both' : 'default'
        c.exportedAt = true
      }
    }
  }
  return out
}

// ── The migration of the component's body ───────────────────────────────────

function isHookCall(e: ts.Node | undefined): boolean {
  if (!e) return false
  const x = skipParens(e)
  if (ts.isAwaitExpression(x)) return false
  if (!ts.isCallExpression(x)) return false
  const callee = x.expression
  if (ts.isIdentifier(callee)) return HOOK.test(callee.text)
  if (ts.isPropertyAccessExpression(callee)) return HOOK.test(callee.name.text)
  return false
}

/** Whether `e` calls a hook anywhere outside a nested function (its value then comes from a hook: React's rules apply). */
function containsHookCall(e: ts.Node): boolean {
  if (isHookCall(e)) return true
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isFunctionDeclaration(e)) return false
  return !!ts.forEachChild(e, (c) => containsHookCall(c) || undefined)
}

/** Names declared by a binding pattern / identifier, with their declaration nodes. */
function declaredNames(name: ts.BindingName): Array<{ name: string; decl: ts.Node }> {
  if (ts.isIdentifier(name)) return [{ name: name.text, decl: name.parent }]
  const out: Array<{ name: string; decl: ts.Node }> = []
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue
    if (ts.isIdentifier(el.name)) out.push({ name: el.name.text, decl: el })
    else out.push(...declaredNames(el.name))
  }
  return out
}

function staticInit(e: ts.Node): boolean {
  let ok = true
  const visit = (n: ts.Node): void => {
    if (!ok) return
    if (ts.isIdentifier(n)) {
      const p = n.parent
      if ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n)) return
      if (['undefined', 'null', 'true', 'false', 'NaN', 'Infinity'].includes(n.text)) return
      ok = false
      return
    }
    if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      ok = false
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(e)
  return ok
}

/**
 * Converts one TSX screen. `opts.role` is what the screen is (VIEWS-SPEC §1.1, `classify` in `layout.ts`): a view
 * (`X.kbview`, the default) or a user control (`X.kbcontrol`, its markup inside a `<UserControl>` carrying `x:Props`).
 */
export function migrateFile(cfg: MigrateConfig, sf: SourceFile, wanted?: string, opts: { role?: Role } = {}): MigrationResult {
  const file = sf.getFilePath()
  const result: MigrationResult = {
    file,
    status: 'skipped',
    reasons: [],
    stats: { elements: 0, mapped: 0, classAttributes: 0, parts: 0, getters: 0, handlers: 0, bindings: 0, resources: 0 },
    outputs: {},
    deletes: [],
    edits: {},
    defaults: [],
  }
  const comps = componentsOf(sf)
  const stem = basename(file).replace(/\.tsx?$/, '')
  const exported = comps.filter((c) => c.exportedAt)
  const target = (wanted ? comps.find((c) => c.name === wanted) : undefined) ?? exported.find((c) => c.name === stem) ?? (exported.length === 1 ? exported[0] : undefined)
  if (!target) {
    result.reasons.push(exported.length ? `several exported components (${exported.map((c) => c.name).join(', ')}): name one` : 'no exported function component')
    return result
  }
  result.component = target.name
  if (exported.length > 1) {
    result.reasons.push(`the file also exports ${exported.filter((c) => c !== target).map((c) => c.name).join(', ')}: they stay in X.parts.tsx`)
  }
  const m = new Migration(cfg, sf, target.fn, target.name)
  for (const c of comps) if (c !== target) m.localComponents.add(c.name)
  try {
    const out = convert(m, target)
    result.outputs = opts.role === 'control' ? asControl(out.outputs, m.stem) : out.outputs
    result.edits = out.edits
    // The .tsx goes, unless the code-behind took its very name (a code-behind with JSX is a .tsx).
    result.deletes = Object.keys(out.outputs).some((p) => resolve(p) === resolve(file)) ? [] : [file]
  } catch (e) {
    result.reasons.push(...m.reasons, `stopped: ${(e as Error).message}`)
    result.stats = m.stats
    return result
  }
  result.reasons.push(...m.reasons)
  result.stats = m.stats
  if (m.stats.elements > 0 && m.stats.mapped === 0) {
    // Nothing of it maps to a `.kbview` element: a view would only wrap the same React in a ReactHost. It stays TSX.
    result.reasons.push('no element maps to a .kbview element (the view would only host the TSX): left as it is')
    result.outputs = {}
    result.edits = {}
    result.deletes = []
    return result
  }
  result.defaults = m.defaults
  result.status = m.stats.parts > 0 || m.reasons.length > 0 ? 'partial' : 'converted'
  return result
}

class Stop extends Error {}

/** An element that cannot be converted: the caller rolls back what it started and cuts it out as a part. */
class NeedsPart extends Error {}

interface Snapshot {
  getters: number
  methods: number
  reasons: number
  defaults: number
  members: Set<string>
  usedSetters: Set<Local>
  viewsTypes: Set<string>
  exportedLocals: Set<string>
  extraImports: Set<string>
  gettersByExpr: Map<string, string>
  stats: MigrationStats
  needsNavigate: boolean
  rowFields?: Map<string, string>
}

function snapshot(m: Migration, ctx: JsxCtx): Snapshot {
  return {
    getters: m.getters.length, methods: m.methods.length, reasons: m.reasons.length, defaults: m.defaults.length,
    members: new Set(m.members), usedSetters: new Set(m.usedSetters), viewsTypes: new Set(m.viewsTypes),
    exportedLocals: new Set(m.exportedLocals), extraImports: new Set(m.extraImports), gettersByExpr: new Map(m.gettersByExpr), stats: { ...m.stats },
    needsNavigate: m.needsNavigate, rowFields: ctx.row ? new Map(ctx.row.fields) : undefined,
  }
}

function rollback(m: Migration, s: Snapshot, ctx: JsxCtx): void {
  m.getters.length = s.getters
  m.methods.length = s.methods
  m.reasons.length = s.reasons
  m.defaults.length = s.defaults
  const reset = <T>(target: Set<T>, from: Set<T>): void => {
    target.clear()
    for (const x of from) target.add(x)
  }
  reset(m.members, s.members)
  reset(m.usedSetters, s.usedSetters)
  reset(m.viewsTypes, s.viewsTypes)
  reset(m.exportedLocals, s.exportedLocals)
  reset(m.extraImports, s.extraImports)
  m.gettersByExpr.clear()
  for (const [k, v] of s.gettersByExpr) m.gettersByExpr.set(k, v)
  Object.assign(m.stats, s.stats)
  m.needsNavigate = s.needsNavigate
  if (ctx.row && s.rowFields) {
    ctx.row.fields.clear()
    for (const [k, v] of s.rowFields) ctx.row.fields.set(k, v)
  }
}

function convert(m: Migration, target: FoundComponent): { outputs: Record<string, string>; edits: Record<string, string> } {
  const fn = target.fn.compilerNode as unknown as ts.FunctionLikeDeclaration
  // ── Props ──
  const p0 = fn.parameters[0]
  if (p0) {
    if (ts.isObjectBindingPattern(p0.name)) {
      for (const el of p0.name.elements) {
        if (!ts.isIdentifier(el.name) || el.dotDotDotToken) throw new Stop('props destructured with a rest element or nested pattern')
        const propName = (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text)
        if (el.initializer) {
          // `{ a = 1 }`: a getter applying the default.
          const g = m.member(el.name.text)
          m.addLocal({ name: el.name.text, kind: 'derived', member: g, decl: el })
          m.getters.push({ name: g, body: `this.props.${propName} ?? ${el.initializer.getText()}`, memo: false })
        } else {
          m.addLocal({ name: el.name.text, kind: 'prop', member: propName, decl: el })
        }
      }
    } else if (ts.isIdentifier(p0.name)) {
      m.addLocal({ name: p0.name.text, kind: 'props-object', member: 'props', decl: p0 })
    }
    const t = p0.type
    if (t) {
      if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) m.propsType = t.typeName.text
      else m.propsTypeDecl = t.getText()
      if (!m.propsType) m.propsType = `${target.name}Props`
    } else if (ts.isObjectBindingPattern(p0.name)) {
      // `({ name = 'x', selected = false })`: the props TypeScript inferred from the defaults.
      const inferred = writableType(m, m.typeText(p0))
      if (inferred) {
        m.propsTypeDecl = inferred
        m.propsType = `${target.name}Props`
      }
    }
  }

  // ── Body ──
  const body = fn.body
  if (!body) throw new Stop('no body')
  let jsx: ts.Expression
  const statements: ts.Statement[] = []
  if (ts.isBlock(body)) {
    const last = body.statements[body.statements.length - 1]
    if (!last || !ts.isReturnStatement(last) || !last.expression) throw new Stop('the body does not end with `return <jsx>`')
    jsx = last.expression
    statements.push(...body.statements.slice(0, -1))
  } else {
    jsx = body
  }
  // `if (cond) return <A/>` before the main JSX: alternative screens, each shown when its condition holds and none of
  // the earlier ones did (the main screen when none holds).
  // `outer`: the condition of the block the return sits in (`if (!scoped) { …; if (n === 0) return null; … }`).
  const branches: Array<{ cond: ts.Expression; jsx: ts.Expression; outer?: ts.Expression }> = []
  const branchesBefore = new Map<ts.Statement, number>()
  // Constants of a branch's own block (`if (outcome) { const n = …; return <A/> }`): computed only under its condition.
  const ownBranch = new Map<ts.Statement, ts.Expression>()
  const simpleReturn = (st: ts.Statement): ts.Expression | undefined => {
    if (!ts.isIfStatement(st) || st.elseStatement) return undefined
    const then = ts.isBlock(st.thenStatement) && st.thenStatement.statements.length === 1 ? st.thenStatement.statements[0] : st.thenStatement
    return ts.isReturnStatement(then) && then.expression ? then.expression : undefined
  }
  for (let k = 0; k < statements.length; k++) {
    const s = statements[k]
    if (ts.isIfStatement(s) && !s.elseStatement && ts.isBlock(s.thenStatement) && s.thenStatement.statements.length > 1) {
      const inner = s.thenStatement.statements
      const last = inner[inner.length - 1]
      if (ts.isReturnStatement(last) && last.expression && inner.slice(0, -1).every((x) => ts.isVariableStatement(x) || !!simpleReturn(x))) {
        const before = branches.length
        const locals = inner.slice(0, -1).filter((x) => ts.isVariableStatement(x))
        // Its own early returns first (each under the block's condition too), then the block's final return.
        for (const x of inner.slice(0, -1)) {
          const r = simpleReturn(x)
          if (r) branches.push({ cond: (x as ts.IfStatement).expression, jsx: r, outer: s.expression })
        }
        branches.push({ cond: s.expression, jsx: last.expression })
        for (const v of locals) {
          branchesBefore.set(v, before)
          ownBranch.set(v, s.expression)
        }
        for (const later of statements.slice(k + 1)) branchesBefore.set(later, branches.length)
        statements.splice(k, 1, ...locals)
        k += locals.length - 1
        continue
      }
    }
    if (ts.isIfStatement(s) && !s.elseStatement) {
      const then = ts.isBlock(s.thenStatement) && s.thenStatement.statements.length === 1 ? s.thenStatement.statements[0] : s.thenStatement
      if (ts.isReturnStatement(then) && then.expression) {
        branches.push({ cond: s.expression, jsx: then.expression })
        // The statements after it ran only when it did not return.
        for (const later of statements.slice(k + 1)) branchesBefore.set(later, branches.length)
        statements.splice(k--, 1)
        continue
      }
    }
    let early = false
    const find = (n: ts.Node): void => {
      if (ts.isFunctionLike(n)) return
      if (ts.isReturnStatement(n)) early = true
      ts.forEachChild(n, find)
    }
    ts.forEachChild(s, find)
    if (early) throw new Stop('a `return` inside a statement of the component body (not a plain `if (cond) return <jsx>`): convert by hand')
  }

  // Pass 1: declare the locals.
  const pending: Array<() => void> = []
  for (const s of statements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        const init = d.initializer
        // useState
        if (init && ts.isCallExpression(skipParens(init)) && isHookCall(init) && /^useState$/.test(((skipParens(init) as ts.CallExpression).expression as ts.Identifier).text ?? '') && ts.isArrayBindingPattern(d.name)) {
          const call = skipParens(init) as ts.CallExpression
          const [v, set] = d.name.elements
          if (!v || ts.isOmittedExpression(v) || !ts.isIdentifier(v.name)) throw new Stop('useState without a value name')
          const arg = call.arguments[0]
          const member = m.member(v.name.text)
          const typeArg = call.typeArguments?.[0]?.getText()
          const isStatic = !arg || staticInit(arg)
          const type = typeArg
          if (isStatic) {
            m.addLocal({ name: v.name.text, kind: 'state', member, decl: v, type, init: arg ? arg.getText() : 'undefined' })
            if (set && !ts.isOmittedExpression(set) && ts.isIdentifier(set.name)) {
              const setter = m.member(set.name.text)
              m.addLocal({ name: set.name.text, kind: 'setter', member: setter, state: member, decl: set })
            }
          } else {
            // A computed initial value: React keeps the state; the field mirrors it (`use()` assigns it).
            m.addLocal({ name: v.name.text, kind: 'hook-data', member, decl: v, type })
            if (set && !ts.isOmittedExpression(set) && ts.isIdentifier(set.name)) {
              m.addLocal({ name: set.name.text, kind: 'hook-fn', member: m.member(set.name.text), decl: set, type: m.typeText(set) })
            }
            // Its type written out when it can be (the hooks type would otherwise depend on itself through the getters
            // the initial value reads).
            const written = typeArg ?? printableType(m, v)
            const typed = (t: string): string => (typeArg || !written ? t : t.replace(/\buseState\(/, `useState<${written}>(`))
            pending.push(() => m.addUse(typed(m.rewrite(s, { inUse: true })), s, typed))
          }
          continue
        }
        if (init && containsHookCall(init)) {
          // (A hook inside an expression - `useLocation().pathname`, `useStore(sel) ?? fallback` - is a hook statement too.)
          const callee = isHookCall(init) ? (skipParens(init) as ts.CallExpression).expression : undefined
          const hookName = !callee ? '' : ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
          for (const n of declaredNames(d.name)) {
            if (hookName === 'useTranslation' && n.name === 't') {
              const nsArg = (skipParens(init) as ts.CallExpression).arguments[0]
              const ns = nsArg && ts.isStringLiteral(nsArg) ? nsArg.text : undefined
              m.addLocal({ name: n.name, kind: 'translate', member: m.member('tr'), decl: n.decl, ns })
              continue
            }
            const isFn = m.isFunctionType(n.decl)
            m.addLocal({ name: n.name, kind: isFn ? 'hook-fn' : 'hook-data', member: m.member(n.name), decl: n.decl, type: m.typeText(n.decl) })
          }
          pending.push(() => m.addUse(m.rewrite(s, { inUse: true }), s))
          continue
        }
        if (init && (ts.isArrowFunction(skipParens(init)) || ts.isFunctionExpression(skipParens(init))) && ts.isIdentifier(d.name)) {
          m.addLocal({ name: d.name.text, kind: 'method', member: m.member(d.name.text), decl: d })
          continue
        }
        if (init && ts.isIdentifier(d.name)) {
          m.addLocal({ name: d.name.text, kind: 'derived', member: m.member(d.name.text), decl: d, type: d.type ? d.type.getText() : undefined })
          continue
        }
        if (init && !ts.isIdentifier(d.name)) {
          // `const { a, b } = expr` (not a hook): each name a getter reading the destructured expression.
          for (const n of declaredNames(d.name)) m.addLocal({ name: n.name, kind: 'derived', member: m.member(n.name), decl: n.decl, type: m.typeText(n.decl) })
          continue
        }
        throw new Stop(`\`${d.getText()}\`: a declaration without a value`)
      }
      if (!(s.declarationList.flags & ts.NodeFlags.Const)) m.reason('a `let` in the component body became a getter/field: check that it is never reassigned')
      continue
    }
    if (ts.isFunctionDeclaration(s) && s.name) {
      m.addLocal({ name: s.name.text, kind: 'method', member: m.member(s.name.text), decl: s })
      continue
    }
    if (ts.isExpressionStatement(s) && containsHookCall(s.expression)) {
      // A hook whose value the TSX dropped (`useModulesStore((s) => s.loadedVersion)`) was there to render the screen
      // again when it changes - so that what the body computes from a registry or a store is computed again: its value
      // is kept in a field every memoized getter depends on.
      const callee = isHookCall(s.expression) ? (skipParens(s.expression) as ts.CallExpression).expression : undefined
      const hookName = !callee ? '' : ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      // (A store read through a selector - `useXStore(sel)` - not a hook run for its effects: those give nothing to follow.)
      if (/^use[A-Z]\w*Store$/.test(hookName) && (skipParens(s.expression) as ts.CallExpression).arguments.length > 0) {
        const member = m.member(`rerender${m.rerenderMembers.length + 1}`)
        m.rerenderMembers.push(member)
        const transform = (t: string): string => `this.${member} = ${t.trim().replace(/;$/, '')}`
        pending.push(() => m.addUse(transform(m.rewrite(s, { inUse: true })), s, transform))
        continue
      }
      pending.push(() => m.addUse(m.rewrite(s, { inUse: true }), s))
      continue
    }
    // A statement filling a list, a map or a set declared before it (`if (root) walk(root, 0)`, `flatten(units, …, out)`):
    // it runs, with the local functions it calls, inside that collection's getter.
    if (ts.isExpressionStatement(s) || ts.isIfStatement(s) || ts.isForOfStatement(s) || ts.isForStatement(s) || ts.isForInStatement(s)) {
      const touched = new Set<Local>()
      const fns: ts.Node[] = []
      const seen = new Set<ts.Node>()
      const scan = (n: ts.Node): void => {
        if (ts.isIdentifier(n)) {
          const l = m.localOf(n)
          if (l?.kind === 'derived' && ts.isVariableDeclaration(l.decl) && l.decl.initializer && isCollectionInit(l.decl.initializer)) touched.add(l)
          if (l?.kind === 'method' && !seen.has(l.decl)) {
            seen.add(l.decl)
            const st = ts.isVariableDeclaration(l.decl) ? l.decl.parent.parent : l.decl
            fns.push(st)
            scan(st)
          }
        }
        ts.forEachChild(n, scan)
      }
      scan(s)
      if (touched.size) {
        for (const l of touched) l.fill = [...(l.fill ?? []), ...fns.filter((x) => !(l.fill ?? []).includes(x)), s]
        continue
      }
    }
    // A type declared in the body (`interface Report {…}`): a module-level type of the code-behind.
    if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) {
      m.hoisted.push(s.getText())
      continue
    }
    throw new Stop(`unsupported statement in the component body: \`${s.getText().slice(0, 60)}…\``)
  }

  // Pass 2: fill in `use()`, the getters and the methods, now that every local is known.
  // A constant declared after an early return was only computed when it did not return: its getter is guarded alike.
  const branchConds = branches.map((b) => (b.outer ? `(${m.rewrite(b.outer)}) && (${m.rewrite(b.cond)})` : m.rewrite(b.cond)))
  const guardsOf = (decl: ts.Node): string[] | undefined => {
    let st: ts.Node | undefined = decl
    while (st && !ts.isVariableStatement(st) && !(ts.isFunctionDeclaration(st) && st.parent === body)) st = st.parent
    const n = st ? branchesBefore.get(st as ts.Statement) ?? 0 : 0
    const own = st ? ownBranch.get(st as ts.Statement) : undefined
    const g = [...branchConds.slice(0, n).map((c) => `!(${c})`), ...(own !== undefined ? [`!!(${m.rewrite(own)})`] : [])]
    return g.length ? g : undefined
  }
  for (const p of pending) p()
  for (const l of [...m.locals.values()]) {
    if (l.kind === 'derived' && ts.isVariableDeclaration(l.decl) && l.decl.initializer) {
      const init = l.decl.initializer
      if (ts.isIdentifier(l.decl.name)) {
        const bare = nestedNullables(m, init)
        // An aliased condition (`const snapshot = previous == null` then `!snapshot && previous > 0`): TypeScript
        // narrows `previous` through `snapshot` only between constants, so both are local constants of the getter.
        const condPre: string[] = []
        const condBare = new Set<Local>()
        const direct = (n: ts.Node): Set<Local> => {
          const out = new Set<Local>()
          const v = (x: ts.Node): void => {
            if (ts.isIdentifier(x) && !(ts.isPropertyAccessExpression(x.parent) && x.parent.name === x)) {
              const o = m.localOf(x)
              if (o && (o.kind === 'derived' || o.kind === 'state' || o.kind === 'prop' || o.kind === 'hook-data')) out.add(o)
            }
            ts.forEachChild(x, v)
          }
          v(n)
          return out
        }
        const reads = direct(init)
        for (const r of reads) {
          if (r.kind !== 'derived' || !ts.isVariableDeclaration(r.decl) || !r.decl.initializer || !m.isBooleanType(r.decl.initializer)) continue
          const shared = [...direct(r.decl.initializer)].filter((s) => reads.has(s) && s !== r)
          if (!shared.length) continue
          for (const s of shared) if (!condBare.has(s) && !bare.has(s)) { condBare.add(s); condPre.push(`const ${s.name} = ${refText(m, s)}`) }
          condPre.push(`const ${r.name} = ${m.rewrite(r.decl.initializer, { bare: new Set(shared) })}`)
          condBare.add(r)
        }
        for (const x of condBare) bare.add(x)
        let body = m.rewrite(init, { bare })
        if (l.fill?.length) {
          // Filled by statements: they run here, in their order, on a fresh collection (the other collections they
          // fill too, each getter computing its own).
          const others = [...m.locals.values()].filter((o) => o !== l && o.fill?.some((x) => l.fill!.includes(x)))
          // The collections and the local functions stay local names there.
          const fnLocals = [...m.locals.values()].filter((o) => o.kind === 'method' && l.fill!.some((x) => x === o.decl || x === o.decl.parent?.parent))
          const bare = new Set<Local>([l, ...others, ...fnLocals])
          const decls = [l, ...others].map((o) => `const ${m.rewrite(o.decl, { bare })}`)
          const order = [...l.fill].sort((a, b) => a.getStart() - b.getStart())
          body = `(() => {\n      ${[...decls, ...order.map((x) => m.rewrite(x, { bare }))].join('\n      ')}\n      return ${l.name}\n    })()`
        }
        // Its type written out (the TSX inferred it): a getter typed from hooks typed from getters would otherwise
        // depend on itself.
        // A written annotation is rewritten too (`typeof state` → `X['state']`).
        const inferred = (l.decl.type ? m.rewrite(l.decl.type) : undefined) ?? l.type ?? declaredType(m, l.decl.name)
        m.getters.push({ name: l.member, body, memo: m.isObjectValue(init), type: inferred, guards: guardsOf(l.decl), prelude: bare.size && !l.fill?.length ? [...condPre, ...[...bare].filter((x) => !condBare.has(x)).map((x) => `const ${x.name} = ${refText(m, x)}`)] : undefined })
        m.stats.getters++
      }
    } else if (l.kind === 'derived' && ts.isBindingElement(l.decl)) {
      // Destructured: read the property of the destructured expression.
      let decl: ts.Node = l.decl
      const path: string[] = []
      while (ts.isBindingElement(decl)) {
        const el = decl as ts.BindingElement
        const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : ''
        if (ts.isArrayBindingPattern(el.parent)) path.unshift(`[${el.parent.elements.indexOf(el)}]`)
        else path.unshift(`.${key}`)
        decl = el.parent.parent
      }
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        const src = m.rewrite(decl.initializer)
        m.getters.push({ name: l.member, body: `(${src})${path.join("")}`, memo: m.isObjectValue(l.decl), guards: guardsOf(decl) })
        m.stats.getters++
      }
    } else if (l.kind === 'method') {
      const d = l.decl
      let f: ts.FunctionLikeDeclaration | undefined
      if (ts.isVariableDeclaration(d) && d.initializer) f = skipParens(d.initializer) as ts.FunctionLikeDeclaration
      else if (ts.isFunctionDeclaration(d)) f = d
      if (!f || !f.body) continue
      const params = f.parameters.map((p) => m.rewrite(p)).join(', ')
      const isAsync = !!f.modifiers?.some((x) => x.kind === ts.SyntaxKind.AsyncKeyword)
      // A function declared after an early return existed only when it did not return: its body starts with the same
      // conditions (what the TSX narrowed - `data` after `if (!data) return …` - stays narrowed).
      const guards = guardsOf(d)
      // A value the body reads inside a callback, nullable by its declaration: read through a local constant (the
      // narrowing of `this.x` stops at a callback, a constant's does not - as in the TSX).
      const paramNames = new Set(f.parameters.map((p) => p.name.getText()))
      const bare = new Set([...nestedNullables(m, f.body)].filter((x) => !paramNames.has(x.name)))
      const prelude = [
        ...(guards?.length ? [`    if (${guards.map((g) => `!(${g})`).join(' || ')}) return undefined as never`] : []),
        ...[...bare].map((x) => `    const ${x.name} = ${refText(m, x)}`),
      ]
      // An expression body that only acts (a setter call, an assignment) returns nothing: the method can be an event
      // handler as it is (a handler returns `void`).
      let b = ts.isBlock(f.body) ? m.rewrite(f.body, { bare }) : `{
    ${actsOnly(m, f.body) ? '' : 'return '}${m.rewrite(f.body, { bare })}
  }`
      if (prelude.length) b = b.replace(/^\{/, `{\n${prelude.join('\n')}`)
      const typeParams = f.typeParameters?.length ? `<${f.typeParameters.map((t) => m.rewrite(t)).join(', ')}>` : undefined
      m.methods.push({ name: l.member, params, body: b, async: isAsync, typeParams, ret: f.type ? `: ${m.rewrite(f.type)}` : undefined })
    }
  }
  // Hook results land in fields at the end of `use()`.

  // ── The markup ──
  let root: XNode
  if (!branches.length) root = convertRoot(m, jsx)
  else {
    // A layout-neutral root holding every alternative, each with its Visible condition.
    root = { el: 'Panel', attrs: [{ name: 'Class', value: 'contents' }], children: [] }
    const earlier: string[] = []
    const show = (own: string | undefined, base: string): string => {
      const parts = [...earlier.map((c) => `!(${c})`), ...(own ? [`!!(${own})`] : [])]
      return `{Binding ${m.getter(base, parts.join(' && ') || 'true')}}`
    }
    branches.forEach((b, k) => {
      const cond = branchConds[k]
      const vis = show(cond, `show_case_${k + 1}`)
      for (const n of convertBranch(m, b.jsx, { guards: [...earlier.map((c) => `!(${c})`), cond] })) root.children.push(withVisible(m, n, vis, {}))
      earlier.push(cond)
    })
    const vis = show(undefined, 'show_main')
    for (const n of convertBranch(m, jsx, { guards: earlier.map((c) => `!(${c})`) })) root.children.push(withVisible(m, n, vis, {}))
    // One element in all (the other cases render nothing, `if (!x) return null`): it is the root itself - a wrapper,
    // even a `display: contents` one, would take its place among its parent's children (`divide-y` draws the line
    // on it, where nothing shows).
    if (root.children.length === 1) root = root.children[0]
    else m.stats.classAttributes++
  }
  if (m.propsType) attr(root, 'x:Props', m.propsType)
  dropDefaults(m, root)

  // ── Outputs ──
  const viewFile = join(m.dir, `${m.stem}.kbview`)
  const outputs: Record<string, string> = {}
  outputs[viewFile] = writeXml(root, `${m.name} - converted from ${m.stem}.tsx by @kubuno/views-migrate${m.reasons.length ? ' (partial: see the TODO comments and the report)' : ''}.`)
  // A code-behind holding JSX (a derived element, a handler building one, a helper component it keeps) is a `.tsx`.
  const codeText = codeBehind(m, target, outputs[viewFile])
  const hasJsx = containsJsx(ts.createSourceFile('code.tsx', codeText, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX))
  outputs[join(m.dir, `${m.stem}.${hasJsx ? 'tsx' : 'ts'}`)] = codeText
  if (m.parts.length || m.exportedLocals.size) outputs[join(m.dir, `${m.stem}.parts.tsx`)] = partsFile(m)
  const edits: Record<string, string> = {}
  return { outputs, edits }
}

// ── JSX → markup ────────────────────────────────────────────────────────────

interface JsxCtx {
  /** The innermost Repeater scope. */
  row?: RowScope
  /** Template parameters → row expressions (`e.row.x`) for code-behind rewriting inside templates. */
  rows?: Map<ts.Node, string>
  /** The parent intrinsic element's classes (a `Label` inside a flex box stays a block). */
  parentFlex?: boolean
  /** The conditions the subtree is shown under (`cond && <X/>`, an early return): its getters are read only then. */
  guards?: string[]
}

function convertRoot(m: Migration, expr: ts.Expression): XNode {
  const e = skipParens(expr)
  const nodes = convertChild(m, e, {})
  if (nodes.length === 1) return nodes[0]
  // A fragment of several elements: a layout-neutral root.
  return { el: 'Panel', attrs: [{ name: 'Class', value: 'contents' }], children: nodes }
}

/** The value of an expression as an attribute value: a literal, a `{Res}`, a `{Binding}` (a getter if needed). */
function valueOf(m: Migration, e: ts.Expression, ctx: JsxCtx, base: string, kind: 'text' | 'bool' | 'any' = 'any'): string {
  const x = skipParens(e)
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) {
    if (isSafeLiteral(x.text)) return x.text
  }
  if (ts.isNumericLiteral(x)) return x.text
  if (x.kind === ts.SyntaxKind.TrueKeyword) return 'true'
  if (x.kind === ts.SyntaxKind.FalseKeyword) return 'false'
  const res = resOf(m, x, ctx)
  if (res) return res
  // A plain member path on a field or the row (`error`, `form.name`, `theme.name`).
  const path = pathOf(m, x, ctx)
  if (path && (kind !== 'bool' || m.isBooleanType(x))) {
    m.stats.bindings++
    return `{Binding ${path}}`
  }
  const bare = ctx.row ? new Set<Local>() : nestedNullables(m, x)
  let text = m.rewrite(x, { rows: ctx.rows, bare })
  if (kind === 'bool' && !m.isBooleanType(x)) text = `!!(${text})`
  return binding(m, x, text, ctx, base, [...bare].map((l) => `const ${l.name} = ${refText(m, l)}`))
}

/** A computed class name `e` followed by the static classes `extra`: a getter (or row field) building both. */
function classWith(m: Migration, e: ts.Expression, ctx: JsxCtx, base: string, extra: string): string {
  const x = skipParens(e)
  const bare = ctx.row ? new Set<Local>() : nestedNullables(m, x)
  const text = m.rewrite(x, { rows: ctx.rows, bare })
  // A template literal takes the classes at its end, as written by hand; anything else is joined to them.
  const combined = ts.isTemplateExpression(x) || ts.isNoSubstitutionTemplateLiteral(x)
    ? `${text.slice(0, -1)} ${extra.replace(/[`\\$]/g, '\\$&')}\``
    : `[${text}, ${JSON.stringify(extra)}].filter(Boolean).join(' ')`
  return binding(m, x, combined, ctx, base, [...bare].map((l) => `const ${l.name} = ${refText(m, l)}`))
}

/** A `{Binding}` to a getter (page) or a row field (template) computing `text`. */
function binding(m: Migration, node: ts.Node, text: string, ctx: JsxCtx, base: string, prelude?: string[], memo?: boolean): string {
  m.stats.bindings++
  if (ctx.row && /\b__row\b/.test(text)) {
    // A row field (the rows getter computes it).
    let name = snake(base) || 'value'
    for (let k = 2; ctx.row.fields.has(name); k++) name = `${snake(base)}${k}`
    // Under a condition, the row field is computed only when it holds (the TSX did not evaluate it otherwise).
    const guards = ctx.guards ?? []
    ctx.row.fields.set(name, guards.length ? `(${guards.map((g) => `(${g})`).join(' && ')}) ? (${text}) : undefined` : text)
    return `{Binding ${name}}`
  }
  const g = m.getter(snake(base) || 'value', text, { memo: memo ?? m.isObjectValue(node), guards: (ctx.guards ?? []).filter((c) => !/\b__row\b/.test(c)), prelude })
  return `{Binding ${g}}`
}

/**
 * Whether reading `a.b.c` goes through a value its declared type allows to be null (`status` of `status.remaining`
 * under `status && …`): the TSX read it narrowed; a binding path is typed from the declarations, so it would not
 * type-check - such a path is read by a (guarded) getter instead.
 */
function throughNullable(m: Migration, e: ts.Node): boolean {
  let x = skipParens(e)
  const inner: ts.Expression[] = []
  while (ts.isPropertyAccessExpression(x)) {
    inner.push(x.expression)
    x = skipParens(x.expression)
  }
  const declaredNullable = (n: ts.Expression): boolean => {
    const sym = ts.isPropertyAccessExpression(n) ? m.checker.getSymbolAtLocation(n.name) : m.checker.getSymbolAtLocation(n)
    if (!sym) return false
    let t: ts.Type
    try {
      t = m.checker.getTypeOfSymbol(sym)
    } catch {
      return false
    }
    return (t.isUnion() ? t.types : [t]).some((p) => !!(p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)))
  }
  return inner.some((n) => declaredNullable(skipParens(n) as ts.Expression))
}

/** `a.b.c` relative to the view (a field) or the row (a template parameter), when `e` is such a plain path. */
function pathOf(m: Migration, e: ts.Node, ctx: JsxCtx): string | undefined {
  const segs: string[] = []
  let x = skipParens(e)
  while (ts.isPropertyAccessExpression(x) && !x.questionDotToken) {
    segs.unshift(x.name.text)
    x = skipParens(x.expression)
  }
  if (!ts.isIdentifier(x)) return undefined
  if (segs.length && throughNullable(m, e)) return undefined
  if (ctx.rows) {
    const r = m.rowParamOf(x, ctx.rows)
    if (r !== undefined) {
      // `__row.theme` → the row field `theme`.
      const name = r.replace(/^__row\./, '')
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined
      return [name, ...segs].join('.')
    }
  }
  const l = m.localOf(x)
  if (!l) return undefined
  if (l.kind === 'state' || l.kind === 'hook-data' || l.kind === 'derived') return [l.member, ...segs].join('.')
  if (l.kind === 'prop') return ['props', l.member, ...segs].join('.')
  if (l.kind === 'props-object') return ['props', ...segs].join('.')
  return undefined
}

/** `t('key')`, `t('key', { defaultValue, count, x })` with the component's `t` → `{Res key[, Source=ns][, Args]}`. */
function resOf(m: Migration, e: ts.Node, ctx: JsxCtx): string | undefined {
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return undefined
  const l = m.localOf(e.expression)
  if (l?.kind !== 'translate') return undefined
  const [k, opts] = e.arguments
  if (!k || !(ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k))) return undefined
  let key = k.text
  let ns = l.ns
  const colon = key.indexOf(':')
  if (colon > 0 && !key.slice(0, colon).includes('.')) {
    ns = key.slice(0, colon)
    key = key.slice(colon + 1)
  }
  const args: string[] = []
  let defaultValue: string | undefined
  if (opts) {
    if (!ts.isObjectLiteralExpression(opts)) return undefined
    for (const p of opts.properties) {
      let name: string
      let value: ts.Expression
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
        name = p.name.text
        value = p.initializer
      } else if (ts.isShorthandPropertyAssignment(p)) {
        name = p.name.text
        value = p.name
      } else return undefined
      if (name === 'defaultValue') {
        if (!(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) return undefined
        defaultValue = value.text
        continue
      }
      if (['ns', 'lng', 'context', 'returnObjects'].includes(name)) return undefined
      const argName = name === 'count' ? 'Count' : name.charAt(0).toUpperCase() + name.slice(1)
      const x = skipParens(value)
      if (ts.isStringLiteral(x) || ts.isNumericLiteral(x)) {
        if (/[,{}'"]/.test(x.text)) return undefined
        args.push(`${argName}=${x.text}`)
      } else {
        const path = pathOf(m, x, ctx)
        if (path) args.push(`${argName}={Binding ${path}}`)
        else {
          const inner = binding(m, x, m.rewrite(x, { rows: ctx.rows }), ctx, `${key.split('.').pop()}_${name}`)
          args.push(`${argName}=${inner}`)
        }
      }
    }
  }
  const effectiveNs = ns ?? m.cfg.defaultNs
  if (!m.cfg.hasKey(effectiveNs, key)) {
    if (defaultValue === undefined) m.reason(`\`${key}\` is in no ${effectiveNs} bundle and has no defaultValue: the view shows the key, like the TSX did`)
    else m.defaults.push({ ns: effectiveNs, key, value: defaultValue })
  }
  m.stats.resources++
  const parts = [`Res ${key}`]
  if (ns && ns !== m.cfg.defaultNs) parts.push(`Source=${ns}`)
  parts.push(...args)
  return `{${parts.join(', ')}}`
}

/** One JSX child → markup nodes (none for whitespace, several for a fragment). */
function convertChild(m: Migration, e: ts.Node, ctx: JsxCtx): XNode[] {
  const x = skipParens(e)
  if (ts.isJsxText(x)) {
    const text = decodeEntities(cleanJsxText(x.text))
    if (!text) return []
    return [textRun(m, text, ctx)]
  }
  if (ts.isJsxExpression(x)) {
    if (!x.expression) return []
    return convertChild(m, x.expression, ctx)
  }
  if (ts.isJsxFragment(x)) return x.children.flatMap((c) => convertChild(m, c, ctx))
  if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x)) return [convertElement(m, x, ctx)]
  // `cond && <X/>`
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && isJsxLike(x.right)) {
    const vis = valueOf(m, x.left, ctx, nameFor(x.left, 'show'), 'bool')
    const cond = m.rewrite(x.left, { rows: ctx.rows })
    return convertChild(m, x.right, guarded(ctx, cond)).map((n) => withVisible(m, n, vis, ctx))
  }
  // `cond ? <A/> : <B/>` (either side may be null)
  if (ts.isConditionalExpression(x) && (isJsxLike(x.whenTrue) || isJsxLike(x.whenFalse))) {
    const yes = valueOf(m, x.condition, ctx, nameFor(x.condition, 'show'), 'bool')
    const condText = m.rewrite(x.condition, { rows: ctx.rows })
    const no = binding(m, x.condition, `!(${condText})`, ctx, nameFor(x.condition, 'show_not'))
    return [
      ...convertBranch(m, x.whenTrue, guarded(ctx, condText)).map((n) => withVisible(m, n, yes, ctx)),
      ...convertBranch(m, x.whenFalse, guarded(ctx, `!(${condText})`)).map((n) => withVisible(m, n, no, ctx)),
    ]
  }
  // `list.map((item) => <X/>)`
  if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'map') {
    const cb = x.arguments[0]
    if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) return [repeater(m, x.expression.expression, cb, ctx, x)]
  }
  // Text-valued expression (a string, a number, a `t()`): a text run.
  return [textRun(m, undefined, ctx, x as ts.Expression)]
}

function convertBranch(m: Migration, e: ts.Expression, ctx: JsxCtx): XNode[] {
  const x = skipParens(e)
  if (x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined') || x.kind === ts.SyntaxKind.FalseKeyword) return []
  if (ts.isStringLiteral(x) && x.text === '') return []
  return convertChild(m, x, ctx)
}

function isJsxLike(e: ts.Node): boolean {
  const x = skipParens(e)
  if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x) || ts.isJsxFragment(x)) return true
  if (ts.isConditionalExpression(x)) return isJsxLike(x.whenTrue) || isJsxLike(x.whenFalse)
  if (x.kind === ts.SyntaxKind.NullKeyword) return false
  return false
}

function withVisible(m: Migration, n: XNode, value: string, ctx: JsxCtx): XNode {
  const existing = n.attrs.find((a) => a.name === 'Visible')
  if (!existing) {
    attr(n, 'Visible', value)
    return n
  }
  // Nested conditions: both must hold.
  const a = existing.value.replace(/^\{Binding (.*)\}$/, '$1')
  const b = value.replace(/^\{Binding (.*)\}$/, '$1')
  const ref = (p: string): string => (ctx.row && ctx.row.fields.has(p) ? `__row.${p}` : `this.${p}`)
  const g = binding(m, ts.factory.createTrue(), `${ref(a)} && ${ref(b)}`, ctx, 'visible')
  attr(n, 'Visible', g)
  return n
}

/** A run of text (JSX text or a text-valued expression) on its own: a `<span>` `Label`. */
function textRun(m: Migration, text: string | undefined, ctx: JsxCtx, expr?: ts.Expression): XNode {
  m.stats.elements++
  // An expression holding elements (`{icon}`, a derived `<Badge/>`): rendered as it is, through a Fragment.
  if (expr && !isTextValue(m, expr) && !resText(m, expr, ctx)) {
    m.stats.parts++
    m.reason('an expression child holding elements (rendered through a ReactHost Fragment)')
    m.extraImports.add("import { Fragment } from 'react'")
    const comp = m.getter('Fragment', 'Fragment', { doc: '`React.Fragment`: renders the elements an expression holds.' })
    const n: XNode = { el: 'ReactHost', attrs: [], children: [], comment: 'TODO(views-migrate): elements held in an expression' }
    attr(n, 'Component', `{Binding ${comp}}`)
    attr(n, 'Props', binding(m, ts.factory.createObjectLiteralExpression(), `{ children: ${m.rewrite(expr, { rows: ctx.rows })} }`, ctx, nameFor(expr, 'content')))
    return n
  }
  m.stats.mapped++
  const n: XNode = { el: 'Label', attrs: [], children: [] }
  attr(n, 'HtmlTag', 'Span')
  attr(n, 'InheritFontSize', 'true')
  attr(n, 'Overflow', 'Wrap')
  attr(n, 'Text', text !== undefined ? (isSafeLiteral(text) ? text : `{Binding ${m.getter('text', JSON.stringify(text))}}`) : valueOf(m, expr!, ctx, 'text', 'text'))
  return n
}

function tagName(e: JsxElement | JsxSelfClosingElement | ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxTagNameExpression {
  return ts.isJsxElement(e as ts.Node) ? (e as ts.JsxElement).openingElement.tagName : (e as ts.JsxSelfClosingElement).tagName
}
function attributesOf(e: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes {
  return ts.isJsxElement(e) ? e.openingElement.attributes : e.attributes
}
function childrenOf(e: ts.JsxElement | ts.JsxSelfClosingElement): readonly ts.JsxChild[] {
  return ts.isJsxElement(e) ? e.children : []
}

/** Whether the element's children are only text and text-valued expressions (no elements). */
function textOnly(children: readonly ts.JsxChild[], m?: Migration): boolean {
  // An expression holding elements (`{icon}`) is no text, even without JSX syntax.
  return children.every((c) => ts.isJsxText(c) || (ts.isJsxExpression(c) && (!c.expression || (!containsJsx(c.expression) && (!m || isTextValue(m, c.expression) || !!resText(m, c.expression, {}))))))
}
function containsJsx(n: ts.Node): boolean {
  let found = false
  const v = (x: ts.Node): void => {
    if (found) return
    if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x) || ts.isJsxFragment(x)) {
      found = true
      return
    }
    ts.forEachChild(x, v)
  }
  v(n)
  return found
}

/** The text of text-only children as one attribute value. */
/**
 * The text of an element's children. `runs`: the element renders its `Text` as React children (a `Label`, a
 * `LinkLabel`), and several runs with a value among them (`{used} / {quota}`) stay several text nodes, as React
 * rendered them - one list of runs rather than one string: the page's text and its accessibility tree are the TSX's.
 */
function textValue(m: Migration, children: readonly ts.JsxChild[], ctx: JsxCtx, base: string, runs = false): string {
  const parts: Array<{ text?: string; expr?: ts.Expression }> = []
  for (const c of children) {
    if (ts.isJsxText(c)) {
      const t = decodeEntities(cleanJsxText(c.text))
      if (t) parts.push({ text: t })
    } else if (ts.isJsxExpression(c) && c.expression) parts.push({ expr: c.expression })
  }
  if (parts.length === 0) return ''
  if (parts.length === 1) {
    const p = parts[0]
    if (p.text !== undefined) return isSafeLiteral(p.text) ? p.text : `{Binding ${m.getter(base, JSON.stringify(p.text))}}`
    return valueOf(m, p.expr!, ctx, base, 'text')
  }
  if (runs && parts.some((p) => p.expr)) {
    // Several runs, one text node each: a list (memoized: a new list on every read would render without end), in
    // which a value React prints nothing for (`null`, `undefined`, a boolean) is `null`.
    const items = parts.map((p) => {
      if (p.text !== undefined) return JSON.stringify(p.text)
      const res = resText(m, p.expr!, ctx)
      if (res) return res
      const v = m.rewrite(p.expr!, { rows: ctx.rows })
      return `((v: unknown) => (v == null || typeof v === 'boolean' ? null : String(v)))(${v})`
    })
    // Typed as the text it renders (`Text` is a String property; the element renders it as React children).
    return binding(m, children[0], `[${items.join(', ')}] as unknown as string`, ctx, base, undefined, true)
  }
  // Several runs: one string built by a getter (the `{Res}` parts read through `this.t`).
  // `?? ''` only after a value that can be null or undefined (React prints nothing for them; TypeScript refuses an
  // unreachable `??`).
  const nullable = (e: ts.Expression): boolean => {
    const t = m.checker.getTypeAtLocation(e)
    return (t.isUnion() ? t.types : [t]).some((x) => !!(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Any | ts.TypeFlags.Unknown)))
  }
  const pieces = parts.map((p) => {
    if (p.text !== undefined) return JSON.stringify(p.text)
    const res = resText(m, p.expr!, ctx)
    if (res) return res
    const v = m.rewrite(p.expr!, { rows: ctx.rows })
    // React prints nothing for a boolean (`{busy && ' · busy'}` when false): neither does the text.
    const t = m.checker.getTypeAtLocation(p.expr!)
    if ((t.isUnion() ? t.types : [t]).some((x) => !!(x.flags & ts.TypeFlags.BooleanLike))) return `((v: unknown) => (v == null || typeof v === 'boolean' ? '' : String(v)))(${v})`
    return nullable(p.expr!) ? `String(${v} ?? '')` : `String(${v})`
  })
  return binding(m, children[0], pieces.join(' + '), ctx, base)
}

/** `t('k', …)` as an expression of the class (`this.tr('k', …)`), keeping i18next's behaviour. */
function resText(m: Migration, e: ts.Expression, ctx: JsxCtx): string | undefined {
  const x = skipParens(e)
  if (!ts.isCallExpression(x) || !ts.isIdentifier(x.expression)) return undefined
  const l = m.localOf(x.expression)
  if (l?.kind !== 'translate') return undefined
  return m.rewrite(x, { rows: ctx.rows })
}

function jsxAttr(e: ts.JsxElement | ts.JsxSelfClosingElement, name: string): ts.JsxAttribute | undefined {
  return attributesOf(e).properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name)
}

function staticString(a: ts.JsxAttribute | undefined): string | undefined {
  if (!a) return undefined
  const init = a.initializer
  if (!init) return 'true'
  if (ts.isStringLiteral(init)) return init.text
  if (ts.isJsxExpression(init) && init.expression) {
    const x = skipParens(init.expression)
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text
  }
  return undefined
}

/** The class string of `className`: static, or `undefined` when computed. */
function classValue(a: ts.JsxAttribute | undefined): string | undefined {
  const s = staticString(a)
  return s === undefined ? undefined : s.replace(/\s+/g, ' ').trim()
}

function convertElement(m: Migration, e: ts.JsxElement | ts.JsxSelfClosingElement, ctx: JsxCtx): XNode {
  const snap = snapshot(m, ctx)
  try {
    return convertElementOrThrow(m, e, ctx)
  } catch (x) {
    if (!(x instanceof NeedsPart)) throw x
    rollback(m, snap, ctx)
    m.stats.elements++
    return part(m, e, ctx, x.message)
  }
}

function convertElementOrThrow(m: Migration, e: ts.JsxElement | ts.JsxSelfClosingElement, ctx: JsxCtx): XNode {
  m.stats.elements++
  const tag = tagName(e)
  const tagText = tag.getText()
  const attrs = attributesOf(e)
  if (attrs.properties.some((p) => ts.isJsxSpreadAttribute(p))) {
    // A component given spread props (`<ConfirmDialog {...confirmState} onConfirm={…}/>`): a ReactHost rendering it
    // with the same props object (an HTML element with spread props stays a part).
    if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) return hostComponent(m, e, ctx, `<${tagText} {...spread}> (spread props)`)
    throw new NeedsPart(`<${tagText} {...spread}> (spread props)`)
  }
  // Intrinsic elements.
  if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) return intrinsic(m, e, tag.text, ctx)
  // Components.
  const imported = importOf(m, tag)
  if (imported?.module === 'lucide-react') return icon(m, e, imported.name, ctx)
  if (imported?.module === 'react-router-dom' && imported.name === 'Link') return routerLink(m, e, ctx)
  const info = imported ? m.cfg.registry.element(imported.module, imported.name) : undefined
  if (info) return component(m, e, info, ctx)
  // A dynamic icon of a row (`<c.Icon size={16}/>`): an Icon bound to the component.
  if (ts.isPropertyAccessExpression(tag) && ctx.rows && iconLike(m, tag)) return dynamicIcon(m, e, tag, ctx)
  return hostComponent(m, e, ctx, `<${tagText}> is no .kbview element (${imported ? `${imported.module}#${imported.name}` : 'a local or dynamic component'})`)
}

function iconLike(m: Migration, tag: ts.Expression): boolean {
  const t = m.checker.typeToString(m.checker.getTypeAtLocation(tag))
  return /LucideIcon|ForwardRefExoticComponent<.*LucideProps/.test(t)
}

/** Where a JSX tag name is imported from (`@ui#Button`, `lucide-react#Check`). */
function importOf(m: Migration, tag: ts.JsxTagNameExpression): { module: string; name: string } | undefined {
  if (!ts.isIdentifier(tag)) return undefined
  const sym = m.checker.getSymbolAtLocation(tag)
  const d = sym?.declarations?.[0]
  if (!d) return undefined
  if (ts.isImportSpecifier(d)) {
    const decl = d.parent.parent.parent
    let module = (decl.moduleSpecifier as ts.StringLiteral).text
    // `import { FloatingWindow } from '@ui/FloatingWindow'`: the same export as `@ui`'s.
    if (/^@ui\/[\w-]+$/.test(module)) module = '@ui'
    return { module, name: (d.propertyName ?? d.name).text }
  }
  if (ts.isImportClause(d)) {
    const module = (d.parent.moduleSpecifier as ts.StringLiteral).text
    // `import Button from '@ui/Button'` → `@ui#Button`
    const m2 = /^@ui\/(\w+)$/.exec(module)
    return m2 ? { module: '@ui', name: m2[1] } : { module, name: 'default' }
  }
  return undefined
}

// ── Elements ────────────────────────────────────────────────────────────────

interface Handled {
  node: XNode
  /** Attribute names of the JSX element already turned into markup. */
  done: Set<string>
}

/** The common attributes of any element: `key`, `className`, `style`, aria, `title`, `role`, `tabIndex`, events. */
function commonAttrs(m: Migration, e: ts.JsxElement | ts.JsxSelfClosingElement, h: Handled, ctx: JsxCtx, info?: ElementInfo): void {
  for (const p of attributesOf(e).properties) {
    if (!ts.isJsxAttribute(p)) continue
    const name = p.name.getText()
    if (h.done.has(name)) continue
    const init = p.initializer
    const expr = init && ts.isJsxExpression(init) ? init.expression : undefined
    const str = staticString(p)
    switch (name) {
      case 'key':
        h.done.add(name)
        continue
      case 'aria-label':
        attr(h.node, 'AccessibleName', expr ? valueOf(m, expr, ctx, 'accessible_name', 'text') : str ?? '')
        h.done.add(name)
        continue
      case 'title':
        attr(h.node, 'ToolTip', expr ? valueOf(m, expr, ctx, 'tooltip', 'text') : str ?? '')
        // ToolTip renders the element's `title` (the shell draws the Kubuno bubble): the same accessible name as before.
        h.done.add(name)
        continue
      case 'role': {
        const r = str !== undefined ? ROLE_OF_ARIA[str] : undefined
        if (r && (!info || info.propertyNames.has('AccessibleRole'))) {
          attr(h.node, 'AccessibleRole', r)
          h.done.add(name)
        }
        continue
      }
      case 'aria-hidden':
      case 'aria-modal': {
        const prop = name === 'aria-hidden' ? 'AccessibleHidden' : 'AccessibleModal'
        if (info && !info.propertyNames.has(prop)) continue
        attr(h.node, prop, expr ? valueOf(m, expr, ctx, snake(prop), 'bool') : str === undefined || str === 'true' ? 'true' : 'false')
        h.done.add(name)
        continue
      }
      case 'tabIndex':
        if (expr) attr(h.node, 'TabIndex', valueOf(m, expr, ctx, 'tab_index'))
        else if (str !== undefined) attr(h.node, 'TabIndex', str)
        h.done.add(name)
        continue
    }
    const ev = /^on[A-Z]/.test(name) ? domEvent(name) : undefined
    if (ev && expr && (!info || info.eventNames.has(ev))) {
      attr(h.node, ev, handler(m, expr, ctx, h.node, ev, { dom: true }))
      h.done.add(name)
    }
  }
}

/** React DOM event prop → `.kbview` event (the DOM events every element has, `event_map` `dom`). */
function domEvent(prop: string): string | undefined {
  const map: Record<string, string> = {
    onClick: 'OnClick', onDoubleClick: 'OnDoubleClick', onMouseDown: 'OnMouseDown', onMouseUp: 'OnMouseUp',
    onMouseMove: 'OnMouseMove', onMouseEnter: 'OnMouseEnter', onMouseLeave: 'OnMouseLeave', onKeyDown: 'OnKeyDown',
    onKeyUp: 'OnKeyUp', onKeyPress: 'OnKeyPress', onFocus: 'OnGotFocus', onBlur: 'OnLostFocus', onSubmit: 'OnSubmit',
    onDragEnter: 'OnDragEnter', onDragOver: 'OnDragOver', onDragLeave: 'OnDragLeave', onDrop: 'OnDragDrop', onWheel: 'OnMouseWheel',
  }
  return map[prop]
}

/** The DOM event type of a `.kbview` DOM event (a handler on an HTML element gets the native event). */
const DOM_EVENT_TYPES: Readonly<Record<string, string>> = {
  OnClick: 'MouseEvent', OnDoubleClick: 'MouseEvent', OnMouseDown: 'MouseEvent', OnMouseUp: 'MouseEvent', OnMouseMove: 'MouseEvent',
  OnMouseEnter: 'MouseEvent', OnMouseLeave: 'MouseEvent', OnKeyDown: 'KeyboardEvent', OnKeyUp: 'KeyboardEvent', OnKeyPress: 'KeyboardEvent',
  OnGotFocus: 'FocusEvent', OnLostFocus: 'FocusEvent', OnSubmit: 'SubmitEvent', OnDragEnter: 'DragEvent', OnDragOver: 'DragEvent',
  OnDragLeave: 'DragEvent', OnDragDrop: 'DragEvent', OnMouseWheel: 'WheelEvent',
}

/** Where an event comes from: an HTML element's DOM event, or a component callback (`args`: the registry adapter). */
interface EventFrom {
  dom?: boolean
  args?: string
}

/** How many parameters a function value takes (0 when not a function). */
function arity(m: Migration, e: ts.Expression): number {
  const sig = m.checker.getTypeAtLocation(e).getNonNullableType().getCallSignatures()[0]
  return sig ? sig.parameters.length : 0
}

/** The handler of an event attribute: a method of the class (created from an inline function). */
function handler(m: Migration, expr: ts.Expression, ctx: JsxCtx, node: XNode, event: string, from: EventFrom = {}): string {
  m.stats.handlers++
  m.viewsTypes.add('EventArgs')
  let x = skipParens(expr)
  // `cond ? (e) => … : undefined`: the function, run only while the condition holds (its own narrowing kept).
  let only: ts.Expression | undefined
  if (ts.isConditionalExpression(x) && isNullishLiteral(skipParens(x.whenFalse) as ts.Expression)) {
    const fn = skipParens(x.whenTrue)
    if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) { only = x.condition; x = fn }
  }
  const base = `${snake(node.attrs.find((a) => a.name === 'x:Name')?.value ?? node.el)}_${snake(event.replace(/^On/, ''))}`
  // The template's row as locals, then the conditions the element is shown under (the event only fires then: the
  // TSX handler read the values those conditions narrowed).
  const rowDestructure = (ctx.row ? rowPrelude(ctx, x.getText()) : '') + guardPrelude(ctx)
  const preArgs = /\bargs\b/.test(rowDestructure)
  // What the TSX handler received: the DOM event of an HTML element, the value of a value callback, else the
  // component's (React) event.
  const received = from.args === 'value' ? 'args.value' : 'args.native'
  const receivedType = from.dom ? DOM_EVENT_TYPES[event] ?? 'Event' : undefined
  // The method's own parameters: `(_sender, args)`.
  const argsType = from.args === 'value' ? 'ValueChangedEventArgs' : from.args === 'mouse' || DOM_EVENT_TYPES[event] === 'MouseEvent' ? 'MouseEventArgs' : 'EventArgs'
  m.viewsTypes.add(argsType)
  const params = (usesArgs: boolean): string => `_sender: unknown, ${usesArgs ? 'args' : '_args'}: ${argsType}`
  if (ts.isIdentifier(x)) {
    const l = m.localOf(x)
    // A component method passed as is (`onClick={copy}`): bound directly when it takes no event.
    if (l?.kind === 'method' && !ctx.row) {
      const f = methodFn(l)
      if (f && f.parameters.length === 0) return l.member
      const name = m.member(base)
      m.methods.push({ name, params: params(true), body: `{\n    return this.${l.member}(${received} as never)\n  }`, async: false })
      return name
    }
    if (l && (l.kind === 'prop' || l.kind === 'hook-fn' || l.kind === 'setter')) {
      const name = m.member(base)
      const callee = l.kind === 'prop' ? `this.props.${l.member}?.` : l.kind === 'setter' ? `this.${refText(m, l).replace(/\.bind\(this\)$/, '')}` : `this.${l.member}`
      const takes = arity(m, x) > 0
      m.methods.push({ name, params: params(takes || preArgs), body: `{\n${rowDestructure}    ${callee}(${takes ? `${received} as never` : ''})\n  }`, async: false })
      return name
    }
  }
  if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) {
    const name = m.member(base)
    const isAsync = !!x.modifiers?.some((k) => k.kind === ts.SyntaxKind.AsyncKeyword)
    let prelude = rowDestructure
    if (only) prelude += `    if (!(${m.rewrite(only, { rows: rowParamsAsLocals(ctx, new Map(ctx.rows ?? [])) })})) return undefined as never
`
    const p = x.parameters[0]
    if (p) {
      if (!ts.isIdentifier(p.name)) throw new NeedsPart(`a handler destructuring its event (${x.getText().slice(0, 40)}…)`)
      // The parameter keeps its written type; else the DOM event type, else the type TypeScript inferred when it can be
      // written here, else `any` (the TSX's own code then type-checks as before).
      // (React's event type when it is the one inferred: an HTML element's handler gets React's synthetic event.)
      const inferred = !p.type ? printableType(m, p) : undefined
      const t = p.type ? p.type.getText() : (inferred && (!receivedType || inferred.startsWith('React.')) ? inferred : receivedType ?? inferred ?? 'any')
      prelude += `    const ${p.name.text} = ${received} as ${t}\n`
    }
    const inner = m.rewrite(x.body, { rows: rowParamsAsLocals(ctx, new Map(ctx.rows ?? [])) })
    const body = ts.isBlock(x.body) ? `{\n${prelude}${inner.replace(/^\{\n?/, '')}` : `{\n${prelude}    ${needsReturn(x.body) ? 'return ' : ''}${inner}\n  }`
    m.methods.push({ name, params: params(!!p || preArgs), body, async: isAsync })
    return name
  }
  // Any other expression (a call returning a handler…): evaluate it and call the result.
  const name = m.member(base)
  const fnText = m.rewrite(x, { rows: rowParamsAsLocals(ctx, new Map(ctx.rows ?? [])) })
  // The event is passed on only to a function that takes it (`onClick={stepper.prev}`, a function of no parameter).
  const takes = arity(m, x as ts.Expression) > 0
  m.methods.push({ name, params: params(takes || preArgs), body: `{\n${rowDestructure}    return (${fnText})?.(${takes ? `${received} as never` : ''})\n  }`, async: false })
  return name
}

/** TypeScript's type of `node` when it can be written in the code-behind without an import (primitives, DOM, React). */
function printableType(m: Migration, node: ts.Node): string | undefined {
  let text: string
  try {
    text = m.checker.typeToString(m.checker.getTypeAtLocation(node), undefined, ts.TypeFormatFlags.NoTruncation)
  } catch {
    return undefined
  }
  if (/import\(|\bany\b/.test(text)) return undefined
  const allowed = /^(string|number|boolean|null|undefined|void|never|unknown|object|true|false|Element|Event|HTMLElement|SVGElement|EventTarget|Date|Array|ReadonlyArray|Record|Partial|Readonly|React|[A-Z][A-Za-z]*Event|HTML[A-Za-z]*Element)$/
  const names = text.replace(/"[^"]*"|'[^']*'/g, '').match(/[A-Za-z_$][\w$]*/g) ?? []
  const imported = new Set(m.sf.getImportDeclarations().flatMap((i) => i.getNamedImports().map((n) => n.getAliasNode()?.getText() ?? n.getName())))
  const props = new Set((text.match(/[A-Za-z_$][\w$]*\??:/g) ?? []).map((s) => s.replace(/\??:$/, '')))
  if (names.every((n) => allowed.test(n) || imported.has(n) || props.has(n))) {
    // React's synthetic events are written `React.X` in a module without the React import.
    return text.replace(/\b(ChangeEvent|MouseEvent|KeyboardEvent|FormEvent|FocusEvent|SyntheticEvent|DragEvent|PointerEvent|WheelEvent)</g, 'React.$1<')
  }
  return undefined
}

function isNullishLiteral(e: ts.Expression): boolean {
  return e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')
}

/**
 * Indents every line of `code` but the lines inside a template literal (their spaces belong to the string: the text
 * of a `<pre>` would change).
 */
export function indentCode(code: string, pad: string): string {
  const sf = ts.createSourceFile('part.tsx', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  const inside: Array<[number, number]> = []
  const visit = (n: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) inside.push([n.getStart(sf), n.getEnd()])
    else ts.forEachChild(n, visit)
  }
  visit(sf)
  let out = ''
  for (let k = 0; k < code.length; k++) {
    out += code[k]
    if (code[k] === '\n' && !inside.some(([s, e]) => k > s && k < e)) out += pad
  }
  return out
}

function needsReturn(body: ts.Node): boolean {
  return !ts.isCallExpression(skipParens(body)) && !ts.isBinaryExpression(skipParens(body)) && !ts.isAwaitExpression(skipParens(body)) && !ts.isVoidExpression(skipParens(body))
}

function methodFn(l: Local): ts.FunctionLikeDeclaration | undefined {
  if (ts.isVariableDeclaration(l.decl) && l.decl.initializer) return skipParens(l.decl.initializer) as ts.FunctionLikeDeclaration
  if (ts.isFunctionDeclaration(l.decl)) return l.decl
  return undefined
}

/**
 * `if (!(cond)) return`: the conditions an element is shown under, at the start of its handlers (a row's own
 * conditions read through `args.row`).
 */
function guardPrelude(ctx: JsxCtx): string {
  const guards = ctx.guards ?? []
  if (!guards.length) return ''
  const ROW = new RegExp('\\b__row\\.', 'g')
  const text = guards.map((g) => (ctx.row ? g.replace(ROW, `(args.row as RowOf_${ctx.row.getter}).`) : g))
  if (text.some((g) => /\b__row\b/.test(g))) return ''
  return `    if (${text.map((g) => `!(${g})`).join(' || ')}) return undefined as never\n`
}
/** In a handler of a template: `const { theme, i } = args.row as Row` - the template's parameters, as locals again. */
function rowPrelude(ctx: JsxCtx, body: string): string {
  const r = ctx.row!
  // Only the parameters the body reads (`noUnusedLocals`).
  const used = r.params.filter((p) => new RegExp(`(^|[^\\w$.])${p}(?![\\w$])`).test(body))
  return used.length ? `    const { ${used.join(', ')} } = args.row as ${'RowOf_' + r.getter}\n` : ''
}
function rowParamsAsLocals(ctx: JsxCtx, rows: Map<ts.Node, string>): Map<ts.Node, string> {
  if (!ctx.row) return rows
  // Inside a handler the row parameters are local constants (see rowPrelude): no rewriting.
  for (const d of ctx.row.paramDecls) rows.delete(d)
  return rows
}

function intrinsic(m: Migration, e: ts.JsxElement | ts.JsxSelfClosingElement, tag: string, ctx: JsxCtx): XNode {
  // A computed className: a Class bound to a getter (or a row field) building the same string.
  const cls = jsxAttr(e, 'className')
  const clsExpr = cls?.initializer && ts.isJsxExpression(cls.initializer) ? cls.initializer.expression : undefined
  // The classes a static `style={{…}}` becomes (`[background:#fff]`) join the computed ones: one `Class` holds both
  // (the computed `Class` would otherwise replace them and the style be lost).
  const styleClasses = cls && classValue(cls) === undefined && clsExpr ? (styleOf(m, e)?.classes ?? []) : []
  const dynClass = cls && classValue(cls) === undefined && clsExpr
    ? (styleClasses.length ? classWith(m, clsExpr, ctx, `${tag}_class`, styleClasses.join(' ')) : valueOf(m, clsExpr, ctx, `${tag}_class`, 'text'))
    : undefined
  const node = intrinsicInner(m, e, tag, ctx)
  if (dynClass) {
    attr(node, 'Class', dynClass)
    m.stats.classAttributes++
    // A size utility in the computed classes: the text has its own size.
    if (/(^|[\s'"`])text-(xs|sm|base|lg|[2-9]?xl|\[)/.test(cls!.getText())) node.attrs = node.attrs.filter((a) => a.name !== 'InheritFontSize')
  }
  dataAttributes(m, e, tag, node, ctx)
  return node
}

/**
 * `data-*` attributes of an HTML element → the container's `DataAttributes` (`app-chrome; module=drive`): a literal
 * when every value is written, else a getter building the same list (a value `undefined` or `null` leaves its
 * attribute out, as React does).
 */
function dataAttributes(m: Migration, e: ts.JsxElement | ts.JsxSelfClosingElement, tag: string, node: XNode, ctx: JsxCtx): void {
  const attrs = attributesOf(e).properties.filter((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText().startsWith('data-'))
  if (!attrs.length) return
  if (node.el !== 'Panel' && node.el !== 'Stack') throw new NeedsPart(`<${tag} ${attrs.map((a) => a.name.getText()).join(' ')}>: data attributes on a text`)
  const parts: { name: string; value?: string; expr?: ts.Expression }[] = attrs.map((a) => {
    const name = a.name.getText().slice('data-'.length)
    if (!a.initializer) return { name }
    const str = staticString(a)
    if (str !== undefined) return { name, value: str }
    const expr = ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined
    if (!expr) throw new NeedsPart(`<${tag} data-${name}>: a value that is not an expression`)
    return { name, expr }
  })
  if (parts.some((p) => /[;=]/.test(p.value ?? ''))) throw new NeedsPart(`<${tag}>: a data attribute value with ; or =`)
  const literal = (p: { name: string; value?: string }): string => (p.value === undefined ? p.name : `${p.name}=${p.value}`)
  if (parts.every((p) => !p.expr)) {
    attr(node, 'DataAttributes', parts.map(literal).join('; '))
    return
  }
  const bare = new Set<Local>()
  const items = parts.map((p) => {
    if (!p.expr) return JSON.stringify(literal(p))
    if (!ctx.row) for (const l of nestedNullables(m, p.expr)) bare.add(l)
    const text = m.rewrite(skipParens(p.expr) as ts.Expression, { rows: ctx.rows, bare })
    return `((v: unknown) => (v === undefined || v === null ? '' : ${JSON.stringify(`${p.name}=`)} + String(v)))(${text})`
  })
  const text = `[${items.join(', ')}].filter(Boolean).join('; ')`
  const first = parts.find((p) => p.expr)!.expr!
  attr(node, 'DataAttributes', binding(m, first, text, ctx, `${tag}_data`, [...bare].map((l) => `const ${l.name} = ${refText(m, l)}`)))
}

function intrinsicInner(m: Migration, e: ts.JsxElement | ts.JsxSelfClosingElement, tag: string, ctx: JsxCtx): XNode {
  const children = childrenOf(e)
  const cls = jsxAttr(e, 'className')
  const className = classValue(cls)
  const unsupported = attributesOf(e).properties.filter((p): p is ts.JsxAttribute => ts.isJsxAttribute(p)).map((p) => p.name.getText())
    .filter((n) => !['key', 'className', 'style', 'aria-label', 'aria-hidden', 'aria-modal', 'title', 'role', 'tabIndex', 'type', 'href', 'disabled'].includes(n) && !n.startsWith('data-') && !(/^on[A-Z]/.test(n) && domEvent(n)))
  if (['input', 'select', 'textarea', 'img', 'svg', 'canvas', 'video', 'audio', 'iframe', 'table', 'tbody', 'thead', 'tr', 'td', 'th', 'hr', 'br', 'pre'].includes(tag)) {
    throw new NeedsPart(`<${tag}> has no .kbview element yet`)
  }
  if (unsupported.length) throw new NeedsPart(`<${tag} ${unsupported.join(' ')}>: attribute(s) without a .kbview property`)
  // `<label><input type="checkbox"/>Text</label>`: the input would become a part and the text a `<span>` of the view,
  // and a label whose text sits in a span is exposed as LabelText + StaticText instead of the label's own text. The
  // label stays whole in React, its text a bare text node as before.
  if (tag === 'label' && containsFormControl(e)) throw new NeedsPart('<label> around an <input>/<select>/<textarea> (its text stays a bare text node of the label)')
  const style = styleOf(m, e)
  if (style === null) throw new NeedsPart(`<${tag}> with a computed style`)
  const type = staticString(jsxAttr(e, 'type'))
  const h: Handled = { node: { el: 'Panel', attrs: [], children: [] }, done: new Set(['className', 'style', 'type']) }
  // A link.
  if (tag === 'a') {
    const href = jsxAttr(e, 'href')
    if (!href) throw new NeedsPart('<a> without href')
    const hv = staticString(href) ?? (href.initializer && ts.isJsxExpression(href.initializer) && href.initializer.expression ? valueOf(m, href.initializer.expression, ctx, 'href', 'text') : '')
    h.done.add('href')
    if (textOnly(children, m)) {
      h.node.el = 'LinkLabel'
      attr(h.node, 'Text', textValue(m, children, ctx, 'link_text', true))
      attr(h.node, 'Href', hv)
      labelLike(m, h.node, className, style, true)
    } else {
      attr(h.node, 'Href', hv)
      containerClasses(m, h.node, className, style)
      h.node.children = convertChildren(m, children, ctx, isFlexBox(className))
    }
    m.stats.mapped++
    commonAttrs(m, e, h, ctx)
    return h.node
  }
  if (tag === 'button') {
    if (type === 'submit') throw new NeedsPart('<button type="submit"> (submits its form)')
    attr(h.node, 'AccessibleRole', 'PushButton')
    // Sized like the native button it was (a push-button container otherwise fills its line).
    attr(h.node, 'AutoSize', 'true')
    if (jsxAttr(e, 'disabled')) {
      const d = jsxAttr(e, 'disabled')!
      attr(h.node, 'Enabled', d.initializer && ts.isJsxExpression(d.initializer) && d.initializer.expression ? invertExpr(m, d.initializer.expression, ctx, nameFor(d.initializer.expression, 'enabled_unless')) : 'false')
      h.done.add('disabled')
    }
    containerClasses(m, h.node, className, style)
    h.node.children = convertChildren(m, children, ctx, isFlexBox(className))
    m.stats.mapped++
    commonAttrs(m, e, h, ctx)
    return h.node
  }
  if (!INTRINSIC_CONTAINERS[tag]) throw new NeedsPart(`<${tag}> has no .kbview element yet`)
  // A text element: a Label.
  if (TEXT_TAGS[tag] && textOnly(children, m) && children.length > 0) {
    h.node.el = 'Label'
    if (TEXT_TAGS[tag] !== 'P') attr(h.node, 'HtmlTag', TEXT_TAGS[tag])
    attr(h.node, 'Text', textValue(m, children, ctx, `${tag}_text`, true))
    labelLike(m, h.node, className, style, false)
    m.stats.mapped++
    commonAttrs(m, e, h, ctx)
    return h.node
  }
  // A container.
  const stack = tag === 'div' && className && !style.classes.length ? mapStackClasses(className) : undefined
  if (stack) {
    h.node.el = 'Stack'
    for (const [k, v] of Object.entries(stack.props)) attr(h.node, k, v)
    for (const [k, v] of Object.entries(style.props)) attr(h.node, k, v)
    if (stack.rest.length) {
      attr(h.node, 'Class', stack.rest.join(' '))
      m.stats.classAttributes++
    }
  } else {
    if (tag !== 'div') attr(h.node, 'HtmlTag', INTRINSIC_CONTAINERS[tag])
    containerClasses(m, h.node, className, style)
  }
  m.stats.mapped++
  commonAttrs(m, e, h, ctx)
  h.node.children = convertChildren(m, children, { ...ctx, parentFlex: !!stack }, !!stack || isFlexBox(className))
  return h.node
}

/** Whether an element holds an HTML form control (`<input>`, `<select>`, `<textarea>`) at any depth. */
function containsFormControl(e: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      if (ts.isIdentifier(n.tagName) && ['input', 'select', 'textarea'].includes(n.tagName.text)) {
        found = true
        return
      }
    }
    ts.forEachChild(n, visit)
  }
  childrenOf(e).forEach(visit)
  return found
}

/** `style={{…}}` → properties / arbitrary classes; `null` when computed. */
function styleOf(m: Migration, e: ts.JsxElement | ts.JsxSelfClosingElement): { props: Record<string, string>; classes: string[] } | null {
  const a = jsxAttr(e, 'style')
  if (!a) return { props: {}, classes: [] }
  const init = a.initializer
  if (!init || !ts.isJsxExpression(init) || !init.expression || !ts.isObjectLiteralExpression(init.expression)) return null
  const obj: Record<string, string | number> = {}
  for (const p of init.expression.properties) {
    if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return null
    const v = skipParens(p.initializer)
    if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) obj[p.name.text] = v.text
    else if (ts.isNumericLiteral(v)) obj[p.name.text] = Number(v.text)
    else return null
  }
  const mapped = mapStaticStyle(obj)
  if (!mapped) return null
  void m
  return mapped
}

function containerClasses(m: Migration, n: XNode, className: string | undefined, style: { props: Record<string, string>; classes: string[] }): void {
  const mapped = className ? mapContainerClasses(className) : { props: {}, rest: [] }
  for (const [k, v] of Object.entries({ ...mapped.props, ...style.props })) attr(n, k, v)
  const rest = [...mapped.rest, ...style.classes]
  if (rest.length) {
    attr(n, 'Class', rest.join(' '))
    m.stats.classAttributes++
  }
}

function labelLike(m: Migration, n: XNode, className: string | undefined, style: { props: Record<string, string>; classes: string[] }, link: boolean): void {
  const mapped = mapLabelClasses(className ?? '')
  for (const [k, v] of Object.entries(mapped.props)) {
    if (link && (k === 'Overflow' || k === 'TextAlign')) continue
    attr(n, k, v)
  }
  for (const [k, v] of Object.entries(style.props)) attr(n, k, v)
  if (!mapped.hasSize) attr(n, 'InheritFontSize', 'true')
  const rest = [...mapped.rest, ...style.classes]
  if (link && !className?.split(/\s+/).includes('truncate')) {
    // A LinkLabel has no Overflow: it never truncates.
  }
  if (rest.length) {
    attr(n, 'Class', rest.join(' '))
    m.stats.classAttributes++
  }
}

/** A Lucide icon (`<Check size={14} className="…"/>`) → `<Icon Name="Check" Size="14" …/>`. */
function icon(m: Migration, e: ts.JsxElement | ts.JsxSelfClosingElement, name: string, ctx: JsxCtx): XNode {
  const h: Handled = { node: { el: 'Icon', attrs: [{ name: 'Name', value: name }], children: [] }, done: new Set() }
  for (const p of attributesOf(e).properties) {
    if (!ts.isJsxAttribute(p)) continue
    const n = p.name.getText()
    if (n === 'size') {
      const v = staticString(p) ?? (p.initializer && ts.isJsxExpression(p.initializer) && p.initializer.expression ? valueOf(m, p.initializer.expression, ctx, 'icon_size') : undefined)
      if (v !== undefined) attr(h.node, 'Size', v)
      h.done.add(n)
    } else if (n === 'className') {
      const c = classValue(p)
      if (c === undefined) throw new NeedsPart('an icon with a computed className')
      // The class goes on the glyph itself (Icon renders `<span class="contents"><svg class=…/></span>`).
      if (c) {
        attr(h.node, 'Class', c)
        m.stats.classAttributes++
      }
      h.done.add(n)
    } else if (n === 'key') h.done.add(n)
    else if (n === 'aria-hidden') h.done.add(n)
    else throw new NeedsPart(`<${name} ${n}>: an icon attribute without a property`)
  }
  if (!h.node.attrs.some((a) => a.name === 'Size')) attr(h.node, 'Size', '24')
  m.stats.mapped++
  return h.node
}

/** `<c.Icon size={16}/>` in a template: an Icon whose `Name` is a row field holding `{ c: Component }`. */
function dynamicIcon(m: Migration, e: ts.JsxElement | ts.JsxSelfClosingElement, tag: ts.PropertyAccessExpression, ctx: JsxCtx): XNode {
  const comp = m.rewrite(tag, { rows: ctx.rows })
  // The runtime takes an icon value `{ c: Component }` for `Name` (the type of the property is a name).
  const field = binding(m, tag, `{ c: ${comp} } as unknown as string`, ctx, 'icon')
  const n = icon(m, e, 'X', ctx)
  if (n.el !== 'Icon') return n
  attr(n, 'Name', field)
  return n
}

/** `<Link to=… className=…>` → a `LinkLabel` (text) or a `Panel Href` (content), navigating with the router. */
function routerLink(m: Migration, e: ts.JsxElement | ts.JsxSelfClosingElement, ctx: JsxCtx): XNode {
  const to = jsxAttr(e, 'to')
  const unsupported = attributesOf(e).properties.filter((p): p is ts.JsxAttribute => ts.isJsxAttribute(p)).map((p) => p.name.getText()).filter((n) => !['to', 'className', 'key', 'title', 'aria-label', 'onClick'].includes(n))
  if (!to || unsupported.length) throw new NeedsPart(`<Link ${unsupported.join(' ')}>`)
  const toExpr = to.initializer && ts.isJsxExpression(to.initializer) && to.initializer.expression ? to.initializer.expression : undefined
  const href = toExpr ? valueOf(m, toExpr, ctx, 'href', 'text') : staticString(to) ?? ''
  const children = childrenOf(e)
  const className = classValue(jsxAttr(e, 'className'))
  const h: Handled = { node: { el: textOnly(children, m) ? 'LinkLabel' : 'Panel', attrs: [], children: [] }, done: new Set(['to', 'className', 'onClick']) }
  attr(h.node, 'Href', href)
  if (h.node.el === 'LinkLabel') {
    attr(h.node, 'Text', textValue(m, children, ctx, 'link_text', true))
    labelLike(m, h.node, className, { props: {}, classes: [] }, true)
  } else {
    containerClasses(m, h.node, className, { props: {}, classes: [] })
    h.node.children = convertChildren(m, children, ctx, isFlexBox(className))
  }
  // A plain click stays in the app: navigate like <Link> does.
  m.needsNavigate = true
  const name = m.member(`${snake(h.node.el)}_click`)
  const target = toExpr ? m.rewrite(toExpr, { rows: rowParamsAsLocals(ctx, new Map(ctx.rows ?? [])) }) : JSON.stringify(staticString(to) ?? '')
  const prelude = ctx.row ? rowPrelude(ctx, target) : ''
  m.methods.push({ name, params: `_sender: unknown, ${prelude ? 'args' : '_args'}: MouseEventArgs`, body: `{
${prelude}    this.navigate(${target})
  }`, async: false })
  m.viewsTypes.add('MouseEventArgs')
  attr(h.node, 'OnClick', name)
  m.stats.handlers++
  m.stats.mapped++
  commonAttrs(m, e, h, ctx)
  return h.node
}

/** An `@ui` / project component with a registry element. */
function component(m: Migration, e: ts.JsxElement | ts.JsxSelfClosingElement, info: ElementInfo, ctx: JsxCtx): XNode {
  const h: Handled = { node: { el: info.name, attrs: [], children: [] }, done: new Set() }
  const children = childrenOf(e).filter((c) => !(ts.isJsxText(c) && !c.text.trim()))
  // Two-way binding: `value={x}` + `onChange={(e) => setX(e.target.value)}` (or `(v) => setX(v)`, `onChange={setX}`)
  // on a state field → `Text="{Binding x, Mode=TwoWay}"`, no handler.
  for (const [prop, target] of info.props) {
    if (!target.change) continue
    const valueAttr = jsxAttr(e, prop)
    const ev = [...info.events].find(([, x]) => x.name === target.change)
    const changeAttr = ev ? jsxAttr(e, ev[0]) : undefined
    const valueExpr = valueAttr?.initializer && ts.isJsxExpression(valueAttr.initializer) ? valueAttr.initializer.expression : undefined
    const changeExpr = changeAttr?.initializer && ts.isJsxExpression(changeAttr.initializer) ? changeAttr.initializer.expression : undefined
    if (!valueExpr || !changeExpr || !ts.isIdentifier(skipParens(valueExpr))) continue
    const state = m.localOf(skipParens(valueExpr) as ts.Identifier)
    if (state?.kind !== 'state') continue
    const setter = [...m.locals.values()].find((l) => l.kind === 'setter' && l.state === state.member)
    if (!setter || !isPlainSetterCall(m, changeExpr, setter, ev![1].args)) continue
    attr(h.node, target.name, `{Binding ${state.member}, Mode=TwoWay}`)
    m.stats.bindings++
    h.done.add(prop)
    h.done.add(ev![0])
  }
  // Object props fed field by field (`action={{ label: t('x'), onClick: go }}` → `ActionLabel` + `OnAction`).
  for (const [prop, fields] of info.fields) {
    const a = jsxAttr(e, prop)
    if (!a) continue
    const init = a.initializer
    const obj = init && ts.isJsxExpression(init) && init.expression ? skipParens(init.expression) : undefined
    if (!obj || !ts.isObjectLiteralExpression(obj)) throw new NeedsPart(`<${info.name}> ${prop}: an object prop that is not an object literal`)
    // The fields, flattened to dotted paths (`actions={{ confirm: { label } }}` → `confirm.label`).
    const flat: Array<{ key: string; value: ts.Expression }> = []
    const walk = (o: ts.ObjectLiteralExpression, prefix: string): void => {
      for (const f of o.properties) {
        let key: string
        let value: ts.Expression
        if (ts.isPropertyAssignment(f) && (ts.isIdentifier(f.name) || ts.isStringLiteral(f.name))) {
          key = prefix + f.name.text
          value = f.initializer
        } else if (ts.isShorthandPropertyAssignment(f)) {
          key = prefix + f.name.text
          value = f.name
        } else throw new NeedsPart(`<${info.name}> ${prop}: a field the codemod cannot read`)
        const inner = skipParens(value)
        if (!fields.has(key) && ts.isObjectLiteralExpression(inner) && [...fields.keys()].some((k) => k.startsWith(key + '.'))) walk(inner, key + '.')
        else flat.push({ key, value })
      }
    }
    walk(obj, '')
    for (const { key, value } of flat) {
      const target = fields.get(key)
      if (!target) throw new NeedsPart(`<${info.name}> ${prop}.${key}: no .kbview property`)
      if (target.kind === 'event') {
        attr(h.node, target.name, handler(m, value, ctx, h.node, target.name, { args: target.args }))
        continue
      }
      const x = skipParens(value)
      let v: string
      if ((ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && target.values) {
        if (!target.values.has(x.text)) throw new NeedsPart(`<${info.name} ${prop}.${key}="${x.text}">: no .kbview value`)
        v = target.values.get(x.text)!
      }
      else if (target.convert === 'invert') v = invertExpr(m, value, ctx, nameFor(value, 'enabled_unless'))
      else if (target.convert) throw new NeedsPart(`<${info.name}> ${prop}.${key}: a value the property converts (${target.convert})`)
      else if (!isTextValue(m, x as ts.Expression)) throw new NeedsPart(`<${info.name}> ${prop}.${key}: an object value for a text property`)
      else v = valueOf(m, value, ctx, target.name, kindOfProp(info, target.name))
      attr(h.node, target.name, v)
    }
    h.done.add(prop)
  }
  // Props holding elements that the element shows in a place of its own (`<Card actions={<Button…/>}>`): property
  // elements (`<Card.Actions><Button…/></Card.Actions>`), their content converted like children.
  const slotNodes: XNode[] = []
  for (const [prop, propName] of info.slots) {
    const a = jsxAttr(e, prop)
    if (!a) continue
    const v = a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression ? skipParens(a.initializer.expression) : undefined
    if (!v || !(isJsxLike(v) || (ts.isBinaryExpression(v) && v.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && isJsxLike(v.right)))) {
      throw new NeedsPart(`<${info.name}> ${prop}: elements held in an expression`)
    }
    const content = convertBranch(m, v as ts.Expression, ctx)
    if (content.length) slotNodes.push({ el: `${info.name}.${propName}`, attrs: [], children: content })
    h.done.add(prop)
  }
  // `t={t}` given to an `@ui` element only for strings it shows in a case the element is not in (a Callout without
  // its close button, an EmptyState without its documentation link): it changes nothing, it is left out.
  const tAttr = jsxAttr(e, 't')
  if (tAttr && translatorUnused(info.name, e)) h.done.add('t')
  else if (tAttr && info.props.get('t')?.convert === 'host-t') {
    // `t={t}` with the screen's own `t` (the host's default namespace): `HostStrings`, the runtime passes the same.
    const x = tAttr.initializer && ts.isJsxExpression(tAttr.initializer) && tAttr.initializer.expression ? skipParens(tAttr.initializer.expression) : undefined
    const l = x && ts.isIdentifier(x) ? m.localOf(x) : undefined
    if (l?.kind !== 'translate' || (l.ns !== undefined && l.ns !== m.cfg.defaultNs)) throw new NeedsPart(`<${info.name}> t: a translator other than the screen's own`)
    attr(h.node, info.props.get('t')!.name, 'true')
    h.done.add('t')
  }
  for (const p of attributesOf(e).properties) {
    if (ts.isJsxAttribute(p) && h.done.has(p.name.getText())) continue
    if (!ts.isJsxAttribute(p)) continue
    const name = p.name.getText()
    if (['key'].includes(name)) {
      h.done.add(name)
      continue
    }
    const target = info.props.get(name)
    const event = info.events.get(name)
    const init = p.initializer
    const expr = init && ts.isJsxExpression(init) ? init.expression : undefined
    if (target) {
      let value: string
      // A bare boolean attribute (`disabled`) is true: inverted for `Enabled`.
      if (!init) value = target.convert === 'invert' ? 'false' : 'true'
      else if (ts.isStringLiteral(init)) {
        // A value the element has no name for (`type="date"` on a TextField): the element stays React.
        if (target.values && !target.values.has(init.text)) throw new NeedsPart(`<${info.name} ${name}="${init.text}">: no .kbview value`)
        value = target.values ? target.values.get(init.text)! : init.text
      }
      else if (expr) {
        const x = skipParens(expr)
        if ((ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && target.values) {
          if (!target.values.has(x.text)) throw new NeedsPart(`<${info.name} ${name}="${x.text}">: no .kbview value`)
          value = target.values.get(x.text)!
        }
        else if (target.convert === 'invert') value = invertExpr(m, expr, ctx, nameFor(expr, 'enabled_unless'))
        else if (target.convert === 'icon-node' || target.convert === 'icon-component') {
          // An icon: a Lucide element or component becomes its name (`icon={<Plus size={16}/>}` → `Icon="Plus"`).
          const name = lucideName(m, x)
          if (!name) throw new NeedsPart(`<${info.name} ${name ?? target.name}>: an icon that is not a Lucide icon`)
          value = name
          // `icon={<RefreshCw size={14}/>}`: its size is the element's `IconSize` (its own default otherwise).
          if (ts.isJsxSelfClosingElement(x)) {
            for (const a of x.attributes.properties) {
              if (!ts.isJsxAttribute(a)) throw new NeedsPart(`<${info.name} ${target.name}>: an icon with spread props`)
              const an = a.name.getText()
              if (an === 'size') {
                const sz = staticString(a) ?? (a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression && ts.isNumericLiteral(skipParens(a.initializer.expression)) ? (skipParens(a.initializer.expression) as ts.NumericLiteral).text : undefined)
                if (sz === undefined || !info.propertyNames.has('IconSize')) throw new NeedsPart(`<${info.name} ${target.name}>: an icon size the element cannot take`)
                attr(h.node, 'IconSize', sz)
              } else if (an === 'className') {
                // A theme colour alone (`text-primary`) is the element's `IconColor` (the glyph's colour either way).
                const color = iconColorOf(classValue(a))
                if (!color || !info.propertyNames.has('IconColor')) throw new NeedsPart(`<${info.name} ${target.name}>: an icon with classes`)
                attr(h.node, 'IconColor', color)
              } else if (an !== 'aria-hidden' && an !== 'key') throw new NeedsPart(`<${info.name} ${target.name}>: an icon with ${an}`)
            }
          }
        } else if (target.convert && target.convert !== 'items-source' && !isTextValue(m, x as ts.Expression)) throw new NeedsPart(`<${info.name}> ${p.name.getText()}: a value the property converts (${target.convert})`)
        else if (!info.objectProps.has(target.name) && target.convert !== 'items-source' && !isTextValue(m, x as ts.Expression) && !(ts.isArrowFunction(x) || ts.isFunctionExpression(x))) throw new NeedsPart(`<${info.name}> ${p.name.getText()}: an object value for a text property`)
        else if (target.values && !isStringValued(m, x as ts.Expression)) {
          // A boolean or a number for an enum property (`indeterminate={some}` → `CheckState`): its `.kbview` value,
          // looked up by a getter (the runtime maps `.kbview` names, a raw `true` would reach the component as text).
          const table = JSON.stringify(Object.fromEntries(target.values))
          value = binding(m, x, `(${table} as Record<string, string>)[String(${m.rewrite(x, { rows: ctx.rows })})]`, ctx, target.name)
        } else value = valueOf(m, expr, ctx, target.name, kindOfProp(info, target.name))
      } else continue
      attr(h.node, target.name, value)
      // `checked={mode === 'a'}` on a radio (`SelectedValue`, checked when it equals `Value`): the condition's value
      // against `Value="true"`.
      if (target.convert === 'equals-value' && !jsxAttr(e, 'value')) attr(h.node, 'Value', 'true')
      h.done.add(name)
      continue
    }
    if (event && expr) {
      attr(h.node, event.name, handler(m, expr, ctx, h.node, event.name, { args: event.args }))
      h.done.add(name)
    }
  }
  commonAttrs(m, e, h, ctx, info)
  const left = attributesOf(e).properties.filter((p): p is ts.JsxAttribute => ts.isJsxAttribute(p)).map((p) => p.name.getText()).filter((n) => !h.done.has(n) && n !== 'className')
  if (left.length) throw new NeedsPart(`<${info.name}> ${left.join(', ')}: no .kbview property`)
  const cls = jsxAttr(e, 'className')
  if (cls && !h.done.has('className')) {
    const c = classValue(cls)
    if (c === undefined) throw new NeedsPart(`<${info.name}> with a computed className`)
    if (c && info.propertyNames.has('Class')) {
      attr(h.node, 'Class', c)
      m.stats.classAttributes++
    } else if (c) throw new NeedsPart(`<${info.name} className>: the element has no Class`)
  }
  // Children: text → the element's text property; elements → content.
  if (children.length) {
    const textProp = [...info.props.values()].find((t) => info.props.get('children') === t)
    if (textProp && textOnly(children, m)) attr(h.node, textProp.name, textValue(m, children, ctx, `${snake(info.name)}_text`))
    else if (info.content && info.children !== 'None') h.node.children = children.flatMap((c) => convertChild(m, c, ctx))
    else throw new NeedsPart(`<${info.name}> with element children`)
  }
  // An element holding one child (`Card`, `FloatingWindow`) given several: one layout-neutral panel around them (the
  // component renders its children in one place either way).
  if (info.children === 'SingleWidget' && h.node.children.length > 1) {
    m.stats.classAttributes++
    h.node.children = [{ el: 'Panel', attrs: [{ name: 'Class', value: 'contents' }], children: h.node.children }]
  }
  if (slotNodes.length) h.node.children = [...slotNodes, ...h.node.children]
  m.stats.mapped++
  return h.node
}

/**
 * Whether an `@ui` element's `t` prop is read by nothing it renders here: `Callout` translates only its close button
 * (`dismissible`), `EmptyState` only the default label of its documentation link (`docHref` without `docLabel`).
 */
function translatorUnused(element: string, e: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  const off = (name: string): boolean => {
    const a = jsxAttr(e, name)
    if (!a) return true
    const v = a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression ? skipParens(a.initializer.expression) : undefined
    return !!v && (v.kind === ts.SyntaxKind.FalseKeyword || v.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(v) && v.text === 'undefined'))
  }
  switch (element) {
    case 'Callout': return off('dismissible')
    case 'EmptyState': return off('docHref') || !off('docLabel')
    default: return false
  }
}

function kindOfProp(info: ElementInfo, name: string): 'text' | 'bool' | 'any' {
  const d = info.defaults.get(name)
  if (d === 'true' || d === 'false') return 'bool'
  return 'any'
}

/** `list.map((item, i) => <Row/>)` → a Repeater over a memoized rows getter. */
function repeater(m: Migration, list: ts.Expression, cb: ts.ArrowFunction | ts.FunctionExpression, ctx: JsxCtx, call: ts.CallExpression): XNode {
  m.stats.elements++
  if (ctx.row) return part(m, call, ctx, 'a list inside a list (nested Repeater)')
  const body = ts.isBlock(cb.body) ? undefined : skipParens(cb.body)
  if (!body || !(ts.isJsxElement(body) || ts.isJsxSelfClosingElement(body))) {
    // A block body with derived constants before the JSX.
    if (ts.isBlock(cb.body)) {
      const stmts = cb.body.statements
      const last = stmts[stmts.length - 1]
      if (last && ts.isReturnStatement(last) && last.expression && stmts.slice(0, -1).every((s) => ts.isVariableStatement(s))) {
        return repeaterWithLocals(m, list, cb, stmts, ctx, call)
      }
    }
    return part(m, call, ctx, 'a list whose item is not a single element')
  }
  return buildRepeater(m, list, cb, [], skipParens(body) as ts.JsxElement, ctx, call)
}

function repeaterWithLocals(m: Migration, list: ts.Expression, cb: ts.ArrowFunction | ts.FunctionExpression, stmts: readonly ts.Statement[], ctx: JsxCtx, call: ts.CallExpression): XNode {
  const ret = stmts[stmts.length - 1] as ts.ReturnStatement
  const el = skipParens(ret.expression!)
  if (!(ts.isJsxElement(el) || ts.isJsxSelfClosingElement(el))) return part(m, call, ctx, 'a list whose item is not a single element')
  return buildRepeater(m, list, cb, stmts.slice(0, -1) as ts.VariableStatement[], el, ctx, call)
}

function buildRepeater(m: Migration, list: ts.Expression, cb: ts.ArrowFunction | ts.FunctionExpression, locals: ts.VariableStatement[], el: ts.JsxElement | ts.JsxSelfClosingElement, ctx: JsxCtx, call: ts.CallExpression): XNode {
  const params: string[] = []
  const paramDecls: ts.Node[] = []
  for (const p of cb.parameters) {
    if (!ts.isIdentifier(p.name)) return part(m, call, ctx, 'a list callback destructuring its item')
    params.push(p.name.text)
    paramDecls.push(p)
  }
  const listName = ts.isIdentifier(skipParens(list)) ? (skipParens(list) as ts.Identifier).text : ts.isPropertyAccessExpression(skipParens(list)) ? (skipParens(list) as ts.PropertyAccessExpression).name.text : 'items'
  const getterName = m.member(`rows_${snake(listName) || 'items'}`)
  const scope: RowScope = { getter: getterName, params, paramDecls, fields: new Map() }
  const rows = new Map<ts.Node, string>(ctx.rows ?? [])
  // Inside the template, a parameter is a row field of the same name.
  for (const d of paramDecls) rows.set(d, `__row.${(d as ts.ParameterDeclaration).name.getText()}`)
  // Locals of the callback (`const isActive = …`): row fields.
  for (const s of locals) {
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) return part(m, call, ctx, 'a list callback with a destructuring local')
      rows.set(d, `__row.${d.name.text}`)
      scope.fields.set(d.name.text, m.rewrite(d.initializer, { rows }))
      params.push(d.name.text)
      paramDecls.push(d)
    }
  }
  const inner: JsxCtx = { ...ctx, row: scope, rows }
  const keyAttr = jsxAttr(el, 'key')
  const keyExpr = keyAttr?.initializer && ts.isJsxExpression(keyAttr.initializer) && keyAttr.initializer.expression ? keyAttr.initializer.expression : undefined
  const tmpl = convertChild(m, el, inner)
  const rep: XNode = { el: 'Repeater', attrs: [], children: tmpl }
  // The rows: one object per item with the parameters and every row field.
  // `list?.map(…)`: no list, no rows.
  const optional = ts.isPropertyAccessExpression(call.expression) && !!call.expression.questionDotToken
  const listText = optional ? `(${m.rewrite(list, { rows: ctx.rows })} ?? [])` : m.rewrite(list, { rows: ctx.rows })
  const fieldLines = [...scope.fields].filter(([k]) => !cb.parameters.some((p) => p.name.getText() === k) || !locals.length).map(([k, v]) => `${k}: ${v.replace(/__row\./g, '')}`)
  // Row fields reference the parameters and earlier locals by name: compute them in order inside the callback.
  const p0 = params[0] ?? 'item'
  const idx = cb.parameters[1] ? cb.parameters[1].name.getText() : undefined
  const localDecls = locals.flatMap((s) => s.declarationList.declarations.map((d) => `const ${d.name.getText()} = ${m.rewrite(d.initializer!, { rows: new Map(ctx.rows ?? []) })}`))
  const own = fieldLines.filter((l) => !locals.some((s) => s.declarationList.declarations.some((d) => l.startsWith(d.name.getText() + ':'))))
  const objectFields = [p0, ...(idx ? [idx] : []), ...locals.flatMap((s) => s.declarationList.declarations.map((d) => d.name.getText())), ...own]
  if (keyExpr) {
    // The row object carries its key (`ItemKey` names a field of the row) - under another name when a parameter or a
    // local of the template is called `key`.
    const taken = new Set(objectFields.map((f) => f.split(':')[0].trim()))
    let keyField = 'key'
    for (let k = 2; taken.has(keyField); k++) keyField = k === 2 ? 'rowKey' : `rowKey${k}`
    objectFields.push(`${keyField}: ${m.rewrite(keyExpr, { rows: new Map(ctx.rows ?? []) })}`)
    attr(rep, 'ItemKey', keyField)
  }
  const mapper = `(${[p0, idx].filter(Boolean).join(', ')}) => {${localDecls.map((d) => `\n      ${d}`).join('')}\n      return { ${objectFields.join(', ')} }\n    }`
  const body = `${listText}.map(${mapper})`
  m.getters.push({ name: getterName, body, memo: true, doc: `The rows of the Repeater over \`${list.getText().replace(/\s+/g, ' ')}\`.`, guards: (ctx.guards ?? []).filter((c) => !/\b__row\b/.test(c)) })
  m.needsMemoize = true
  m.stats.getters++
  attr(rep, 'ItemsSource', `{Binding ${getterName}}`)
  return rep
}

/** What does not convert: a component of `X.parts.tsx`, rendered through `<ReactHost>`. */
function part(m: Migration, node: ts.Node, ctx: JsxCtx, why: string): XNode {
  m.stats.parts++
  m.reason(why)
  const name = m.member(`Part${m.parts.length + 1}`)
  // Free variables: the component's locals and the template parameters it reads.
  const free = new Map<string, { expr: string; type?: string }>()
  // A property the TSX narrowed where the part sits (`menu.pos && <Menu pos={menu.pos}/>`): passed as a prop of its
  // own, with its narrowed type (passing `menu` would lose the narrowing of `menu.pos`).
  const edits: Array<{ s: number; e: number; text: string }> = []
  const visit = (n: ts.Node): void => {
    const tagPosition = (ts.isJsxOpeningElement(n.parent) || ts.isJsxSelfClosingElement(n.parent) || ts.isJsxClosingElement(n.parent)) && n.parent.tagName === n
    if (ts.isPropertyAccessExpression(n) && !(ts.isCallExpression(n.parent) && n.parent.expression === n)) {
      let root: ts.Expression = n
      while (ts.isPropertyAccessExpression(root)) root = root.expression
      const l = ts.isIdentifier(root) ? m.localOf(root) : undefined
      // A template parameter too (`reading.trash` of a row).
      const rowRoot = !l && ctx.rows && ctx.row && ts.isIdentifier(root) && m.rowParamOf(root, ctx.rows) !== undefined ? root.text : undefined
      if (((l && l.kind !== 'method' && l.kind !== 'setter') || rowRoot) && !n.questionDotToken) {
        const sym = m.checker.getSymbolAtLocation(n.name)
        let declared: ts.Type | undefined
        try { declared = sym ? m.checker.getTypeOfSymbol(sym) : undefined } catch { declared = undefined }
        const here = m.checker.getTypeAtLocation(n)
        const isNull = (t: ts.Type): boolean => (t.isUnion() ? t.types : [t]).some((x) => !!(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)))
        // Its type: as TypeScript writes it when that can be imported-free, else reached from the member's type.
        const indexed = (): string => {
          const segs: string[] = []
          for (let x: ts.Expression = n; ts.isPropertyAccessExpression(x); x = x.expression) segs.unshift(x.name.text)
          let t = !l ? `NonNullable<${m.stem}['${ctx.row!.getter}']>[number]['${rowRoot}']` : l.kind === 'prop' ? `${m.stem}['props']['${l.member}']` : l.kind === 'props-object' ? `${m.stem}['props']` : `${m.stem}['${l.member}']`
          for (const seg of segs) t = `NonNullable<${t}>['${seg}']`
          return `NonNullable<${t}>`
        }
        const type = declared && isNull(declared) && !isNull(here) ? (writableType(m, m.typeText(n)) ?? indexed()) : undefined
        if (type) {
          // A component written as a tag (`<config.Body />`) keeps a capital: JSX reads a lower-case tag as an HTML element.
          const flat = n.getText().replace(/[^A-Za-z0-9_$]+/g, '_')
          const propName = tagPosition ? flat.charAt(0).toUpperCase() + flat.slice(1) : flat
          // Read with `?.`: the narrowing may come from inside the part (`{data && <a href={data.href}/>}`), where it is only used once it holds.
          const segs: string[] = []
          for (let x: ts.Expression = n; ts.isPropertyAccessExpression(x); x = x.expression) segs.unshift(x.name.text)
          free.set(propName, { expr: `${m.rewrite(root, { rows: ctx.rows })}${segs.map((g) => `?.${g}`).join('')}`, type })
          edits.push({ s: n.getStart(), e: n.getEnd(), text: propName })
          return
        }
      }
    }
    if (ts.isIdentifier(n)) {
      const p = n.parent
      if ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || ts.isJsxAttribute(p)) return
      if (ctx.rows) {
        const r = m.rowParamOf(n, ctx.rows)
        if (r !== undefined) {
          free.set(n.text, { expr: r, type: `NonNullable<${m.stem}['${ctx.row!.getter}']>[number]['${n.text}']` })
          return
        }
      }
      const l = m.localOf(n)
      if (l) {
        // Narrowed where the part sits (`x && <Part {...x}/>`): NonNullable of the member.
        const base = l.kind === 'prop' ? `${m.stem}['props']['${l.member}']` : l.kind === 'props-object' ? `${m.stem}['props']` : `${m.stem}['${l.member}']`
        const here = m.checker.getTypeAtLocation(n)
        const nullable = (here.isUnion() ? here.types : [here]).some((t) => !!(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)))
        free.set(n.text, { expr: refText(m, l), type: nullable || l.kind === 'method' ? base : `NonNullable<${base}>` })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  const props = [...free].map(([n, v]) => ({ name: n, expr: v.expr, type: v.type }))
  // A list or an expression is wrapped in a fragment (a part renders one element).
  let text = node.getText()
  for (const e of edits.sort((a, b) => b.s - a.s)) text = text.slice(0, e.s - node.getStart()) + e.text + text.slice(e.e - node.getStart())
  const jsx = ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node) ? text : `<>{${text}}</>`
  m.parts.push({ name, props, jsx, rowScoped: !!ctx.row })
  // The props object: a memoized getter (page) or a row field (template).
  const obj = `{ ${props.map((p) => `${p.name}: ${p.expr}`).join(', ')} }`
  const value = props.length ? binding(m, ts.factory.createObjectLiteralExpression(), obj, ctx, `${name}_props`) : undefined
  const n: XNode = { el: 'ReactHost', attrs: [], children: [], comment: `TODO(views-migrate): ${why}` }
  // Under a condition, the component is guarded like its props: a ReactHost renders nothing while the condition fails
  // (the designer shows hidden elements; their props getters give nothing then).
  const partGuards = props.length ? (ctx.guards ?? []).filter((c) => !/\b__row\b/.test(c)) : []
  m.getters.push({ name, body: `__parts.${name}`, memo: false, doc: `A part of the screen still written in React (${why}).`, guards: partGuards.length ? partGuards : undefined })
  attr(n, 'Component', `{Binding ${name}}`)
  if (value) attr(n, 'Props', value)
  return n
}

/**
 * The component's values a function body reads inside a nested function (a callback, a `.then`) whose declared type
 * allows null or undefined: the TSX narrowed them as constants; the class reads them through local constants too.
 */
function nestedNullables(m: Migration, body: ts.Node): Set<Local> {
  const out = new Set<Local>()
  const visit = (n: ts.Node, depth: number): void => {
    if (n !== body && ts.isFunctionLike(n)) {
      ts.forEachChild(n, (c) => visit(c, depth + 1))
      return
    }
    if (ts.isIdentifier(n) && depth > 0) {
      const p = n.parent
      const isName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isBindingElement(p) && p.propertyName === n) || ts.isJsxAttribute(p)
      const l = isName ? undefined : m.localOf(n)
      if (l && (l.kind === 'state' || l.kind === 'hook-data' || l.kind === 'derived' || l.kind === 'prop') && !out.has(l)) {
        const sym = m.checker.getSymbolAtLocation(n)
        let t: ts.Type | undefined
        try {
          t = sym ? m.checker.getTypeOfSymbol(sym) : undefined
        } catch {
          t = undefined
        }
        if (t && (t.isUnion() ? t.types : [t]).some((x) => !!(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)))) out.add(l)
      }
    }
    ts.forEachChild(n, (c) => visit(c, depth))
  }
  visit(body, 0)
  return out
}

/**
 * A method or setter passed as a value: bound once per view (the same function on every render - a new one would
 * change a `ref` callback or an effect dependency each time, and `ref={setNode}` would update without end).
 */
function boundRef(member: string): string {
  return `this.memo(${JSON.stringify(member + ':bound')}, [], () => this.${member}.bind(this))`
}

/** How a component-scope name is reached from the class (a part's prop, a row field). */
function refText(m: Migration, l: Local): string {
  switch (l.kind) {
    case 'prop': return `this.props.${l.member}`
    case 'props-object': return 'this.props'
    case 'method': return boundRef(l.member)
    case 'setter':
      m.usedSetters.add(l)
      return boundRef(l.member)
    default: return `this.${l.member}`
  }
}

/**
 * A component that is no `.kbview` element (another screen, a local helper component) used without children: a
 * `<ReactHost>` rendering that very component with its props - no wrapper part. A local component of the file
 * moves to `X.parts.tsx`. With children, or a spread, it becomes a part.
 */
function hostComponent(m: Migration, e: ts.JsxElement | ts.JsxSelfClosingElement, ctx: JsxCtx, why: string): XNode {
  const tag = tagName(e)
  const children = childrenOf(e).filter((c) => !(ts.isJsxText(c) && !c.text.trim()))
  if (!ts.isIdentifier(tag) || children.length) throw new NeedsPart(why)
  const local = m.localComponents.has(tag.text)
  const imported = !local && importOf(m, tag)
  if (!local && !imported) throw new NeedsPart(why)
  m.stats.parts++
  m.reason(why)
  const entries: string[] = []
  // Nullable values its inline callbacks read: local constants of the props getter (page level only).
  const hostBare = ctx.row ? new Set<Local>() : nestedNullables(m, attributesOf(e))
  for (const p of attributesOf(e).properties) {
    if (ts.isJsxSpreadAttribute(p)) {
      entries.push(`...${m.rewrite(p.expression, { rows: ctx.rows, bare: hostBare })}`)
      continue
    }
    if (!ts.isJsxAttribute(p)) throw new NeedsPart(why)
    const name = p.name.getText()
    if (name === 'key') continue
    const init = p.initializer
    let value: string
    if (!init) value = 'true'
    else if (ts.isStringLiteral(init)) value = JSON.stringify(init.text)
    else if (ts.isJsxExpression(init) && init.expression) value = m.rewrite(init.expression, { rows: ctx.rows, bare: hostBare })
    else throw new NeedsPart(why)
    entries.push(`${/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)}: ${value}`)
  }
  if (local) m.exportedLocals.add(tag.text)
  // One getter per component, however many times it is used (`gettersByExpr`).
  // One getter per component and condition: guarded like its props (see `part`).
  const hostGuards = entries.length ? (ctx.guards ?? []).filter((c) => !/__row/.test(c)) : []
  const comp = m.getter(tag.text, local ? `__parts.${tag.text}` : tag.text, { doc: `\`<${tag.text}>\`, rendered by a ReactHost.`, guards: hostGuards })
  const n: XNode = { el: 'ReactHost', attrs: [], children: [], comment: `TODO(views-migrate): ${why}` }
  attr(n, 'Component', `{Binding ${comp}}`)
  // Typed as the component's props, so its inline callbacks get their parameter types as in the TSX.
  const hasCallback = attributesOf(e).properties.some((p) => ts.isJsxAttribute(p) && !!p.initializer && ts.isJsxExpression(p.initializer) && !!p.initializer.expression && (ts.isArrowFunction(skipParens(p.initializer.expression)) || ts.isFunctionExpression(skipParens(p.initializer.expression))))
  const propsText = `{ ${entries.join(', ')} }${hasCallback ? ` as React.ComponentProps<typeof ${local ? `__parts.${tag.text}` : tag.text}>` : ''}`
  if (entries.length) attr(n, 'Props', binding(m, ts.factory.createObjectLiteralExpression(), propsText, ctx, `${snake(tag.text)}_props`, [...hostBare].map((l) => `const ${l.name} = ${refText(m, l)}`)))
  return n
}

// ── Output files ─────────────────────────────────────────────────────────────

/** Whether `name` is used as an identifier in `text` (not as a property `x.name`). */
function mentions(name: string, text: string): boolean {
  return namesIn(text).has(name)
}

const namesCache = new Map<string, Set<string>>()

/**
 * The names `text` refers to: its identifiers, read by TypeScript's parser - so neither comments (a getter's doc names
 * the component it renders), nor string contents (`'/api/x'` names no `api`), nor JSX text count, while the
 * expressions of a template literal do (`url('${absUrl(v.url)}')` uses `absUrl`, though it sits between quotes of the
 * CSS the template writes). The name of a member access (`x.api`) is no reference either.
 */
function namesIn(text: string): Set<string> {
  const known = namesCache.get(text)
  if (known) return known
  const out = new Set<string>()
  const sf = ts.createSourceFile('mentions.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const p = n.parent
      // `x.name`, `A.B`'s `B`, and `import("…").Name` (a type named through its module, not through this file).
      let q: ts.Node = n
      while (q.parent && ts.isQualifiedName(q.parent) && q.parent.left === q) q = q.parent
      const member = p && ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isQualifiedName(p) && p.right === n) || (!!q.parent && ts.isImportTypeNode(q.parent) && q.parent.qualifier === q))
      if (!member) out.add(n.text)
    } else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxClosingElement(n)) {
      // `<Foo.Bar>` refers to `Foo`; `<Foo>` to `Foo`.
      let tag: ts.Node = n.tagName
      while (ts.isPropertyAccessExpression(tag)) tag = tag.expression
      if (ts.isIdentifier(tag)) out.add(tag.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  if (namesCache.size > 2000) namesCache.clear()
  namesCache.set(text, out)
  return out
}

/** The import lines of `sf` restricted to what `text` uses. */
function importsUsedBy(sf: SourceFile, text: string): string[] {
  const out: string[] = []
  for (const imp of sf.getImportDeclarations()) {
    const named = imp.getNamedImports().filter((n) => mentions(n.getAliasNode()?.getText() ?? n.getName(), text))
    const def = imp.getDefaultImport()
    const ns = imp.getNamespaceImport()
    const parts: string[] = []
    if (def && mentions(def.getText(), text)) parts.push(def.getText())
    if (ns && mentions(ns.getText(), text)) parts.push(`* as ${ns.getText()}`)
    if (named.length) parts.push(`{ ${named.map((n) => n.getText()).join(', ')} }`)
    if (parts.length) out.push(`import ${imp.isTypeOnly() ? 'type ' : ''}${parts.join(', ')} from ${JSON.stringify(imp.getModuleSpecifierValue())}`)
  }
  return out
}

function codeBehind(m: Migration, target: FoundComponent, xmlText: string): string {
  const sf = m.sf
  // State setters used as values (`onChange={setX}`, a setter given to a part): one method each.
  for (const l of m.usedSetters) {
    const state = [...m.locals.values()].find((x) => x.member === l.state)
    const t = state?.type ?? `${m.stem}['${l.state}']`
    m.methods.push({
      name: l.member,
      params: `value: ${t} | ((prev: ${t}) => ${t})`,
      body: `{\n    this.${l.state} = typeof value === 'function' ? (value as (prev: ${t}) => ${t})(this.${l.state}) : value\n  }`,
      async: false,
      doc: `\`${l.name}\` of the TSX: a value, or an update of the previous one.`,
    })
  }
  const body: string[] = []
  for (const h of m.hoisted) body.push(h, "")
  if (m.propsTypeDecl) body.push(`export type ${m.propsType} = ${m.propsTypeDecl}`, '')
  else if (m.propsType && !sf.getInterface(m.propsType)?.isExported() && !sf.getTypeAlias(m.propsType)?.isExported() && (sf.getInterface(m.propsType) || sf.getTypeAlias(m.propsType))) {
    body.push(`export type { ${m.propsType} }`, '')
  } else if (m.propsType && sf.getImportDeclarations().some((i) => i.getNamedImports().some((n) => (n.getAliasNode()?.getText() ?? n.getName()) === m.propsType))) {
    // Imported (from the file it was split from): exported again, the view's generated base reads it here.
    body.push(`export type { ${m.propsType} }`, '')
  }
  // The file's other statements (types, constants, helpers): kept when the code-behind uses them (see below).
  const helpers: Array<{ names: string[]; text: string; exported?: boolean }> = []
  // Statements declaring nothing (`Registry.register(…)` at the top level): side effects of importing the screen, kept
  // whatever the class uses, after it (as in the TSX, where they follow the component).
  const effects: string[] = []
  for (const st of sf.getStatements()) {
    if (Node.isImportDeclaration(st) || Node.isExportAssignment(st)) continue
    if (Node.isFunctionDeclaration(st) && (st.getName() === target.name || m.localComponents.has(st.getName() ?? ''))) continue
    if (Node.isVariableStatement(st) && st.getDeclarations().some((d) => d.getName() === target.name || m.localComponents.has(d.getName()))) continue
    const names = Node.isVariableStatement(st) ? st.getDeclarations().map((d) => d.getName()) : [((st as unknown as { getName?: () => string | undefined }).getName?.() ?? '')]
    if (names.every((n) => !n)) {
      effects.push(st.getText())
      continue
    }
    // An exported helper is part of the module's API (other files import it): always kept.
    helpers.push({ names, text: st.getText(), exported: Node.isExportable(st) && st.isExported() })
  }
  const cls: string[] = []
  cls.push(`export class ${m.stem} extends ViewBase {`)
  // The hooks run in `useHooks()`; what they give is typed from it (`<X>Hooks['name']`): no type to import.
  const hookLocals = [...m.locals.values()].filter((l) => l.kind === 'hook-data' || l.kind === 'hook-fn' || l.kind === 'translate')
  const members: string[] = []
  for (const l of m.locals.values()) {
    if (l.kind === 'state') members.push(`  @bind accessor ${l.member}${l.type ? `: ${l.type}` : ''} = ${l.init}`)
  }
  // The hooks split in two, in that order (a stable order for React): the ones that read nothing of the class (stores,
  // translations, queries on constants) in `useStores()`, then the ones reading its members (a state initialised from a
  // getter, an effect) - or what such a hook gave - in `useHooks()`. The first ones' results land in the fields before
  // the second ones run (their getters read fresh values), and each method types its fields (`XStores['user']`,
  // `XHooks['n']`) without one type depending on itself.
  const indep: number[] = []
  const dep: number[] = []
  const depNames = new Set<string>()
  m.useBody.forEach((s, k) => {
    const isDep = /\bthis\./.test(s) || [...depNames].some((n) => mentions(n, s))
    ;(isDep ? dep : indep).push(k)
    if (isDep) for (const n of m.useNames[k] ?? []) depNames.add(n)
  })
  // In useHooks(), what useStores() gave is read through local constants (`const data = this.data`), as the TSX's
  // closures read its constants: a narrowing (`if (!data) return`) holds inside the callbacks too.
  const storesNames = new Set(indep.flatMap((k) => m.useNames[k] ?? []))
  const hooksNames = new Set(dep.flatMap((k) => m.useNames[k] ?? []))
  // The class's own nullable values an effect reads in its callbacks (`if (root) … root.id` inside `useEffect`): local
  // constants declared just before the hook, so the narrowing holds there as in the TSX.
  const hookBare = (k: number): Set<Local> => new Set([...nestedNullables(m, m.useStmts[k].node)].filter((l) => l.kind === 'derived' || l.kind === 'state' || l.kind === 'prop'))
  const hooksText = (k: number): string => m.useStmts[k].transform(m.rewrite(m.useStmts[k].node, { inUse: true, localNames: new Set([...hooksNames, ...storesNames]), bare: hookBare(k) }))
  const aliased = new Set<Local>()
  const hookAliases = (k: number): string[] => {
    const out: string[] = []
    for (const l of hookBare(k)) {
      if (aliased.has(l)) continue
      aliased.add(l)
      out.push(`    const ${l.name} = ${refText(m, l)}`)
    }
    return out
  }
  // Which of them it reads (the checker's references: a callback parameter of the same name is not one).
  const asFields = dep.map((k) => m.rewrite(m.useStmts[k].node, { inUse: true, localNames: hooksNames })).join('\n')
  const storesInHooks = hookLocals.filter((l) => storesNames.has(l.name) && new RegExp(`this\\.${l.member}(?![\\w$])`).test(asFields))
  const reads = [xmlText, ...m.getters.map((g) => g.body), ...m.methods.map((x) => x.body)].join('\n')
  const used = hookLocals.filter((l) => new RegExp('(this\\.|Binding |[^\\w$])' + l.member + '(?![\\w$])').test(reads) || storesInHooks.includes(l))
  const groupOf = new Map<string, 'Stores' | 'Hooks'>()
  for (const k of indep) for (const n of m.useNames[k] ?? []) groupOf.set(n, 'Stores')
  for (const k of dep) for (const n of m.useNames[k] ?? []) groupOf.set(n, 'Hooks')
  const typeOf = (l: Local): string => `${m.stem}${groupOf.get(l.name) ?? 'Hooks'}['${l.name}']`
  for (const l of used) {
    // Plain fields: `publish()` sets them and notifies the view only when a value changed (shallowly).
    // Written out when it can be: a field typed from the hooks that read getters typed from fields can depend on itself.
    members.push(`  ${l.member}!: ${(l.kind !== 'translate' && writableType(m, l.type)) || typeOf(l)}`)
  }
  // The TSX's own `navigate` (useNavigate) serves the links too.
  const ownNavigate = [...used].some((l) => l.member === 'navigate')
  if (m.needsNavigate && !ownNavigate) members.push(`  navigate!: ReturnType<typeof useNavigate>`)
  for (const r of m.rerenderMembers) members.push(`  ${r}?: unknown`)
  if (members.length) cls.push(...members, '')
  // A statement keeps its own indentation, moved from its column in the TSX to the method's.
  const indent = (s: string, k: number): string => {
    const node = m.useStmts[k].node
    const text = node.getSourceFile().text
    const col = node.getStart() - (text.lastIndexOf('\n', node.getStart()) + 1)
    return s.split('\n').map((l, i) => '    ' + (i === 0 ? l.trimStart() : l.replace(new RegExp(`^ {0,${col}}`), ''))).join('\n')
  }
  const groups = [
    { method: 'useStores', ks: indep, doc: `The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them.` },
    { method: 'useHooks', ks: dep, doc: `The screen's hooks that read its members (run after the fields of \`useStores()\` are set).` },
  ].filter((g) => g.ks.length)
  for (const g of groups) {
    const names = g.ks.flatMap((k) => m.useNames[k] ?? [])
    const text = (k: number): string => (g.method === 'useHooks' ? hooksText(k) : m.useBody[k])
    const aliases = g.method === 'useHooks' ? storesInHooks.map((l) => `    const ${l.name} = this.${l.member}`) : []
    // In useHooks(), what a hook gives is published at once: a later hook's dependencies read getters that read it
    // (the TSX computed its constants in order).
    const publishNow = (k: number): string[] => {
      if (g.method !== 'useHooks') return []
      const mine = used.filter((l) => (m.useNames[k] ?? []).includes(l.name))
      return mine.length ? [`    this.publish({ ${mine.map((l) => (l.member === l.name ? l.name : `${l.member}: ${l.name}`)).join(', ')} })`] : []
    }
    cls.push(`  /** ${g.doc} React's rules apply: \`use()\` runs them on every render. */`, `  ${g.method}() {`, ...aliases, ...g.ks.flatMap((k) => [...(g.method === 'useHooks' ? hookAliases(k) : []), indent(text(k), k), ...publishNow(k)]))
    cls.push(`    return { ${names.join(', ')} }`, '  }', '')
  }
  if (groups.length || m.needsNavigate) {
    cls.push(`  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */`, '  use(): void {')
    for (const g of groups) {
      const mine = used.filter((l) => (groupOf.get(l.name) ?? 'Hooks') === (g.method === 'useStores' ? 'Stores' : 'Hooks'))
      const v = g.method === 'useStores' ? 's' : 'h'
      cls.push(mine.length ? `    const ${v} = this.${g.method}()` : `    this.${g.method}()`)
      if (mine.length) cls.push(`    this.publish({ ${mine.map((l) => (l.member === l.name ? `${l.name}: ${v}.${l.name}` : `${l.member}: ${v}.${l.name}`)).join(', ') } })`)
    }
    if (m.needsNavigate && !ownNavigate) cls.push('    this.navigate = useNavigate()')
    cls.push('  }', '')
  }
  // A memo depends on what its guard reads too: computed while the guard failed, it must be computed again once it holds.
  const depsOf = new Map(m.getters.filter((x) => x.memo).map((g) => [g.name, [...new Set([...m.deps([g.body, ...(g.guards ?? []), ...(g.prelude ?? [])].join(' ; ')), ...m.rerenderMembers])]] as const))
  for (const g of m.getters) {
    if (g.doc) cls.push(`  /** ${g.doc} */`)
    // A getter of an element shown under a condition is only read when it holds (as the TSX only rendered it then).
    const guard = g.guards?.length ? `    if (${g.guards.map((c) => `!(${c})`).join(' || ')}) return undefined as never\n` : ''
    const ret = g.type ? `: ${g.type}` : ''
    if (g.memo) {
      // An object literal returned by an arrow needs its parentheses; a guard goes inside the memoized function, where
      // it narrows what the body reads (TypeScript does not carry a narrowing of `this.x` into a callback).
      const value = g.body.trimStart().startsWith('{') ? `(${g.body})` : g.body
      const pre = (g.prelude ?? []).map((p) => `      ${p}\n`).join('')
      const fn = guard || pre ? `() => {\n${guard ? `  ${guard}` : ''}${pre}      return ${value}\n    }` : `() => ${value}`
      cls.push(`  get ${g.name}()${ret} {`, `    return this.memo('${g.name}', [${depsOf.get(g.name)!.map((d) => `this.${d}`).join(', ')}], ${fn})`, '  }', '')
    } else cls.push(`  get ${g.name}()${ret} {`, `${guard}${(g.prelude ?? []).map((p) => `    ${p}\n`).join('')}    return ${g.body}`, '  }', '')
  }
  for (const mt of m.methods) {
    if (mt.doc) cls.push(`  /** ${mt.doc} */`)
    cls.push(`  ${mt.async ? 'async ' : ''}${mt.name}${mt.typeParams ?? ''}(${mt.params})${mt.ret ?? ''} ${mt.body.trim()}`, '')
  }
  // Row types of the templates (for the handlers' `args.row`).
  const methodText = m.methods.map((x) => x.body).join('\n')
  const rowTypes = m.getters.filter((g) => /^rows_/.test(g.name) && methodText.includes(`RowOf_${g.name}`)).map((g) => `type RowOf_${g.name} = ${m.stem}['${g.name}'][number]`)
  cls.push('}')
  if (rowTypes.length) cls.push('', ...rowTypes)
  for (const g of groups) cls.push('', `/** What \`${g.method}()\` gives (the types of the fields it fills). */`, `export type ${m.stem}${g.method === 'useStores' ? 'Stores' : 'Hooks'} = ReturnType<${m.stem}['${g.method}']>`)
  cls.push('', `export default ${m.stem}.component()`, '')
  if (effects.length) cls.push(...effects.flatMap((e) => [e, '']))
  // Helpers the class uses (and the helpers those use), in file order.
  let code = body.join('\n') + cls.join('\n')
  const keep = new Set<number>(helpers.flatMap((h, k) => (h.exported ? [k] : [])))
  for (let changed = true; changed;) {
    changed = false
    const all = code + helpers.filter((_, k) => keep.has(k)).map((h) => h.text).join('\n')
    helpers.forEach((h, k) => {
      if (!keep.has(k) && h.names.some((n) => n && mentions(n, all))) {
        keep.add(k)
        changed = true
      }
    })
  }
  const helperText = helpers.filter((_, k) => keep.has(k)).map((h) => h.text + '\n')
  code = [...helperText, ...body, ...cls].join('\n')
  // Imports: the TSX's, as far as the code uses them, and what the generated code needs.
  const hasBind = [...m.locals.values()].some((l) => l.kind === 'state')
  const usedTypes = [...m.viewsTypes].filter((t) => mentions(t, code))
  const viewsNames = [...(hasBind ? ['bind'] : []), ...usedTypes.map((t) => `type ${t}`)]
  const imports = importsUsedBy(sf, code)
  const head: string[] = [`/**`, ` * Code-behind of \`${m.stem}.kbview\` (converted from \`${m.stem}.tsx\` by @kubuno/views-migrate).`, ` */`]
  if (viewsNames.length) head.push(`import { ${viewsNames.join(', ')} } from '@kubuno/views'`)
  if (m.needsNavigate && !imports.some((k) => /\buseNavigate\b/.test(k))) head.push(`import { useNavigate } from 'react-router-dom'`)
  head.push(...[...m.extraImports].filter((l) => !imports.includes(l)), ...imports, '', `import { ViewBase } from './${m.stem}.kbview'`)
  // The file's local components the code itself renders (a derived element, a table column's cell): imported by
  // name from the parts file, where they now live.
  const localUsed = [...m.localComponents].filter((n) => new RegExp(`<${n}[\\s/>]`).test(code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')))
  for (const n of localUsed) m.exportedLocals.add(n)
  if (m.parts.length || m.exportedLocals.size) head.push(`import * as __parts from './${m.stem}.parts'`)
  if (localUsed.length) head.push(`import { ${localUsed.join(', ')} } from './${m.stem}.parts'`)
  head.push('')
  return head.join('\n') + '\n' + code
}

function partsFile(m: Migration): string {
  const body: string[] = []
  // The file's local components (a part, or a ReactHost, renders them).
  for (const st of m.sf.getStatements()) {
    if (Node.isFunctionDeclaration(st) && m.localComponents.has(st.getName() ?? '')) body.push('', st.getText().replace(/^export\s+(default\s+)?/, ''), `export { ${st.getName()} }`)
    if (Node.isVariableStatement(st) && st.getDeclarations().some((d) => m.localComponents.has(d.getName()))) body.push('', st.getText().replace(/^export\s+/, ''), `export { ${st.getDeclarations().map((d) => d.getName()).join(', ')} }`)
  }
  for (const p of m.parts) {
    const typed = p.props.length ? `{ ${p.props.map((x) => x.name).join(', ')} }: { ${p.props.map((x) => `${x.name}: ${x.type ?? 'any'}`).join('; ')} }` : ''
    if (p.props.some((x) => !x.type)) body.push('', '// eslint-disable-next-line @typescript-eslint/no-explicit-any')
    else body.push('')
    body.push(`export function ${p.name}(${typed}) {`, `  return (`, `    ${indentCode(p.jsx, '    ')}`, `  )`, `}`)
  }
  let text = body.join('\n')
  // The other statements of the file the parts use (types, constants, helpers), then the imports they need.
  const uses = (name: string, t: string): boolean => mentions(name, t)
  // Every statement the parts use, and what those use in turn (`const QRCode = resolveQRCode(…)` needs
  // `resolveQRCode`), in file order.
  const candidates: Array<{ names: string[]; text: string }> = []
  for (const st of m.sf.getStatements()) {
    if (Node.isImportDeclaration(st) || Node.isExportAssignment(st)) continue
    if (Node.isFunctionDeclaration(st) && (st.getName() === m.name || m.localComponents.has(st.getName() ?? ''))) continue
    if (Node.isVariableStatement(st) && st.getDeclarations().some((d) => d.getName() === m.name || m.localComponents.has(d.getName()))) continue
    const names = Node.isVariableStatement(st) ? st.getDeclarations().map((d) => d.getName()) : 'getName' in st && typeof (st as { getName?: () => string | undefined }).getName === 'function' ? [(st as unknown as { getName(): string | undefined }).getName() ?? ''] : []
    candidates.push({ names, text: st.getText().replace(/^export\s+/, '') })
  }
  const kept = new Set<number>()
  const partProps = new Set(m.parts.flatMap((p) => p.props.map((x) => x.name)))
  for (let changed = true; changed;) {
    changed = false
    const all = text + '\n' + [...kept].map((k) => candidates[k].text).join('\n')
    candidates.forEach((c, k) => {
      // A part's prop of the same name shadows a module-level helper (`Bucket` the local component, `type Bucket`).
      if (!kept.has(k) && c.names.some((n) => n && !partProps.has(n) && uses(n, all))) {
        kept.add(k)
        changed = true
      }
    })
  }
  const helpers = candidates.filter((_, k) => kept.has(k)).map((c) => c.text)
  if (helpers.length) text = helpers.join('\n\n') + '\n' + text
  const imports: string[] = []
  for (const imp of m.sf.getImportDeclarations()) {
    const named = imp.getNamedImports().filter((n) => uses(n.getAliasNode()?.getText() ?? n.getName(), text))
    const def = imp.getDefaultImport()
    const ns = imp.getNamespaceImport()
    const parts: string[] = []
    if (def && uses(def.getText(), text)) parts.push(def.getText())
    if (ns && uses(ns.getText(), text)) parts.push(`* as ${ns.getText()}`)
    if (named.length) parts.push(`{ ${named.map((n) => n.getText()).join(', ')} }`)
    if (parts.length) imports.push(`import ${imp.isTypeOnly() ? 'type ' : ''}${parts.join(', ')} from ${JSON.stringify(imp.getModuleSpecifierValue())}`)
  }
  // The props of a part are typed from the code-behind (`X['field']`).
  if (m.parts.some((p) => p.props.length)) imports.push(`import type { ${m.stem} } from './${m.stem}'`)
  const head = [`/**`, ` * The parts of \`${m.stem}.kbview\` still written in React (the codemod could not convert them; see the`, ` * TODO comments in the view). Each is rendered by a \`<ReactHost>\` with the values it reads as props.`, ` */`, ...imports]
  return head.join('\n') + '\n' + text + '\n'
}

/** The outputs of a conversion as a user control's: `X.kbcontrol`, its root in a `<UserControl>`, the code-behind and parts naming it. */
function asControl(outputs: Record<string, string>, stem: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [p, text] of Object.entries(outputs)) {
    if (p.endsWith(`${stem}.kbview`)) out[p.replace(/\.kbview$/, '.kbcontrol')] = toControlText(text)
    else out[p] = text.split(`\`${stem}.kbview\``).join(`\`${stem}.kbcontrol\``).split(`'./${stem}.kbview'`).join(`'./${stem}.kbcontrol'`)
  }
  return out
}

/** The component a file's conversion targets (the exported one named like the file, or the only exported one). */
export function targetComponent(sf: SourceFile, wanted?: string): string | undefined {
  const comps = componentsOf(sf)
  const stem = basename(sf.getFilePath()).replace(/\.tsx?$/, '')
  const exported = comps.filter((c) => c.exportedAt)
  return ((wanted ? comps.find((c) => c.name === wanted) : undefined) ?? exported.find((c) => c.name === stem) ?? (exported.length === 1 ? exported[0] : undefined))?.name
}

/**
 * Switches the importers of the components about to be converted to the default export (the view's component; the
 * named export becomes the code-behind class). Run once for the whole batch BEFORE converting: a file converted in
 * the same batch then already imports its converted neighbours by default. Returns the other files changed (path →
 * text); the files of the batch are left out (they are replaced by their views).
 */
export function rewriteImporters(cfg: MigrateConfig, targets: ReadonlyArray<{ sf: SourceFile; component: string }>): Record<string, string> {
  const batch = new Set(targets.map((t) => t.sf.getFilePath()))
  const changed = new Set<SourceFile>()
  for (const { sf, component } of targets) {
    const comp = componentsOf(sf).find((c) => c.name === component)
    // Exported both ways: the importers using the name switch too (the name is now the code-behind class).
    if (!comp || comp.exported === 'default') continue
    const noExt = sf.getFilePath().replace(/\.tsx?$/, '')
    for (const other of cfg.project.getSourceFiles()) {
      if (other === sf) continue
      for (const imp of other.getImportDeclarations()) {
        const target2 = imp.getModuleSpecifierSourceFile()
        if (!target2 || target2.getFilePath().replace(/\.tsx?$/, '') !== noExt) continue
        const named = imp.getNamedImports().find((n) => n.getName() === component)
        if (!named) continue
        const local = named.getAliasNode()?.getText() ?? component
        named.remove()
        if (!imp.getDefaultImport()) imp.setDefaultImport(local)
        if (!imp.getNamedImports().length && imp.getImportClause()?.getNamedBindings()) imp.removeNamedImports()
        changed.add(other)
      }
      // A re-export (`export { Field } from '../inline-edit/Field'`): the view's component, under the same name.
      for (const exp of other.getExportDeclarations()) {
        const target2 = exp.getModuleSpecifierSourceFile()
        if (!target2 || target2.getFilePath().replace(/\.tsx?$/, '') !== noExt) continue
        const named = exp.getNamedExports().find((n) => n.getName() === component)
        if (!named) continue
        const alias = named.getAliasNode()?.getText() ?? component
        named.remove()
        exp.addNamedExport({ name: 'default', alias })
        changed.add(other)
      }
    }
  }
  const edits: Record<string, string> = {}
  for (const f of changed) if (!batch.has(f.getFilePath())) edits[f.getFilePath()] = f.getFullText()
  return edits
}

export { pascal }

/** A readable member name for an expression (`error` → `show_error`, `tab === 'profile'` → `show_tab_profile`). */
function nameFor(e: ts.Node, prefix: string): string {
  const words = (e.getText().match(/[A-Za-z][A-Za-z0-9]*/g) ?? []).filter((w) => !['this', 'props', 'true', 'false', 'null', 'undefined', 'length'].includes(w))
  const tail = snake(words.slice(0, 3).join('_'))
  return tail ? `${prefix}_${tail}`.slice(0, 48) : prefix
}

/** Leaves out the literal attributes equal to their property's default (`Role="Body"`, `Direction="TopDown"`). */
function dropDefaults(m: Migration, n: XNode): void {
  const info = m.cfg.registry.byElementName(n.el)
  if (info) n.attrs = n.attrs.filter((a) => a.value.startsWith('{') || info.defaults.get(a.name) !== a.value || a.name === 'Text')
  for (const c of n.children) dropDefaults(m, c)
}

/** Whether classes make a flex or grid box (its children are items: a text run of its own is an item too). */
function isFlexBox(className: string | undefined): boolean {
  return !!className && /(^|\s)(flex|inline-flex|grid|inline-grid)(\s|$)/.test(className)
}

/**
 * The children of an element. In a flex / grid box, adjacent text children (`<Icon/> {label}`: a space and a label)
 * form ONE anonymous item in the browser, so they become one text run (separate runs would be separate items, with
 * the box's gap between them); a run of spaces alone is no item there and is dropped.
 */
function convertChildren(m: Migration, children: readonly ts.JsxChild[], ctx: JsxCtx, flexBox: boolean): XNode[] {
  if (!flexBox) return children.flatMap((c) => convertChild(m, c, ctx))
  const out: XNode[] = []
  let run: ts.JsxChild[] = []
  const flush = (): void => {
    if (!run.length) return
    const text = run.every((c) => ts.isJsxText(c)) ? run.map((c) => decodeEntities(cleanJsxText((c as ts.JsxText).text))).join('') : undefined
    if (text !== undefined && !text.trim()) {
      run = []
      return
    }
    if (run.length === 1) out.push(...convertChild(m, run[0], ctx))
    else {
      m.stats.elements++
      m.stats.mapped++
      const n: XNode = { el: 'Label', attrs: [], children: [] }
      attr(n, 'HtmlTag', 'Span')
      attr(n, 'InheritFontSize', 'true')
      attr(n, 'Overflow', 'Wrap')
      attr(n, 'Text', textValue(m, run, ctx, 'text', true))
      out.push(n)
    }
    run = []
  }
  for (const c of children) {
    const textLike = ts.isJsxText(c) || (ts.isJsxExpression(c) && !!c.expression && !containsJsx(c.expression) && !isListOrCondition(c.expression) && (isTextValue(m, c.expression) || !!resText(m, c.expression, ctx)))
    if (textLike) run.push(c)
    else {
      flush()
      out.push(...convertChild(m, c, ctx))
    }
  }
  flush()
  return out
}

function isListOrCondition(e: ts.Expression): boolean {
  const x = skipParens(e)
  return ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'map'
}

/** The theme colour of an icon's classes when they are one text colour and nothing else (`text-primary` → `Primary`). */
function iconColorOf(className: string | undefined): string | undefined {
  if (!className || /\s/.test(className.trim()) || !className.startsWith('text-')) return undefined
  const mapped = mapLabelClasses(className)
  return mapped.rest.length === 0 ? mapped.props.ForeColor : undefined
}

/** `[]`, `new Map()`, `new Set()`, `{}`: a collection a later statement may fill. */
function isCollectionInit(e: ts.Expression): boolean {
  const x = skipParens(e)
  if (ts.isArrayLiteralExpression(x) && x.elements.length === 0) return true
  if (ts.isObjectLiteralExpression(x) && x.properties.length === 0) return true
  return ts.isNewExpression(x) && ts.isIdentifier(x.expression) && ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(x.expression.text)
}

/** The type of a declaration as the code-behind can write it (`import("./x").T` paths), when it is a reasonable one. */
function declaredType(m: Migration, node: ts.Node): string | undefined {
  return writableType(m, m.typeText(node))
}

/**
 * A type text the code-behind can write as it is: short, no \`any\`, and naming only what is in scope there - types
 * reached through \`import("…")\`, the file's imports, the global ones.
 */
function writableType(m: Migration, t: string | undefined): string | undefined {
  if (!t || t.length > 300 || /\bany\b|\(\.\.\.args|\bunique symbol\b/.test(t)) return undefined
  const bare = t.replace(/import\("[^"]*"\)\.[\w$.]+/g, ' ').replace(/"[^"]*"|'[^']*'/g, ' ').replace(/[\w$]+\??:/g, ' ')
  const names = bare.match(/[A-Za-z_$][\w$]*(\.[\w$]+)*/g) ?? []
  const imported = new Set(m.sf.getImportDeclarations().flatMap((i) => [...i.getNamedImports().map((n) => n.getAliasNode()?.getText() ?? n.getName()), ...(i.getDefaultImport() ? [i.getDefaultImport()!.getText()] : [])]))
  const local = new Set(m.sf.getStatements().flatMap((st) => (Node.isInterfaceDeclaration(st) || Node.isTypeAliasDeclaration(st) || Node.isClassDeclaration(st) || Node.isEnumDeclaration(st)) && st.getName() ? [st.getName()!] : []))
  const GLOBAL = /^(string|number|boolean|bigint|symbol|null|undefined|void|never|unknown|object|true|false|readonly|keyof|typeof|infer|extends|is|asserts|Array|ReadonlyArray|Record|Partial|Required|Readonly|Pick|Omit|NonNullable|Exclude|Extract|ReturnType|Parameters|Promise|Date|Map|Set|ReadonlyMap|ReadonlySet|WeakMap|Error|RegExp|URL|URLSearchParams|File|Blob|HTMLElement|HTML\w*Element|Event|\w+Event|React(\.\w+)*)$/
  for (const n of names) {
    const head = n.split('.')[0]
    if (!GLOBAL.test(n) && !GLOBAL.test(head) && !imported.has(head) && !local.has(head)) return undefined
  }
  return t
}

/** Whether an expression's value is a string (or a string literal union). */
function isStringValued(m: Migration, e: ts.Expression): boolean {
  const t = m.checker.getTypeAtLocation(e)
  return (t.isUnion() ? t.types : [t]).every((p) => !!(p.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined)))
}

/** Whether an expression's value is text (a string, a number, a boolean React prints nothing for). */
function isTextValue(m: Migration, e: ts.Expression): boolean {
  try {
    const t = m.checker.getTypeAtLocation(e)
    const text = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.BooleanLike | ts.TypeFlags.Any
    const parts = t.isUnion() ? t.types : [t]
    return parts.every((p) => !!(p.flags & text))
  } catch {
    return true
  }
}

/** The context of a subtree shown only when `cond` (a class expression) holds. */
function guarded(ctx: JsxCtx, cond: string): JsxCtx {
  return { ...ctx, guards: [...(ctx.guards ?? []), cond] }
}

/** The Lucide icon name of `<Plus size={16}/>` or `Plus` (imported from lucide-react), if it is one. */
function lucideName(m: Migration, e: ts.Node): string | undefined {
  const x = skipParens(e)
  const tag = ts.isJsxSelfClosingElement(x) ? x.tagName : ts.isIdentifier(x) ? x : undefined
  if (!tag || !ts.isIdentifier(tag)) return undefined
  const imp = importOf(m, tag)
  return imp?.module === 'lucide-react' ? imp.name.replace(/Icon$/, '') : undefined
}


/** The negation of a boolean expression as a value (`Enabled` from `disabled={busy}`): a literal, or one getter. */
function invertExpr(m: Migration, e: ts.Expression, ctx: JsxCtx, base: string): string {
  const x = skipParens(e)
  if (x.kind === ts.SyntaxKind.TrueKeyword) return 'false'
  if (x.kind === ts.SyntaxKind.FalseKeyword) return 'true'
  return binding(m, x, `!(${m.rewrite(x, { rows: ctx.rows })})`, ctx, base)
}

/**
 * Whether a change handler only writes the new value into `setter`'s state: `setX` itself, `(v) => setX(v)` for a value
 * callback, `(e) => setX(e.target.value)` (or `.checked`) for an event one.
 */
function isPlainSetterCall(m: Migration, e: ts.Expression, setter: Local, args: string | undefined): boolean {
  const x = skipParens(e)
  if (ts.isIdentifier(x)) return m.localOf(x) === setter
  if (!(ts.isArrowFunction(x) || ts.isFunctionExpression(x)) || x.parameters.length !== 1 || !ts.isIdentifier(x.parameters[0].name)) return false
  const p = x.parameters[0].name.text
  let body: ts.Node = x.body
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1 || !ts.isExpressionStatement(body.statements[0])) return false
    body = body.statements[0].expression
  }
  const call = skipParens(body)
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || m.localOf(call.expression) !== setter || call.arguments.length !== 1) return false
  const arg = call.arguments[0].getText().replace(/\s+/g, '')
  if (args === 'value') return arg === p
  return arg === `${p}.target.value` || arg === `${p}.target.checked` || arg === `${p}.currentTarget.value`
}

/**
 * Whether an arrow function's expression body only acts - a state setter call (an assignment in the class), an
 * assignment, a `void` expression - rather than computing a value its callers read.
 */
function actsOnly(m: Migration, body: ts.Node): boolean {
  const x = skipParens(body)
  if (ts.isVoidExpression(x)) return true
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true
  if (ts.isCallExpression(x) && ts.isIdentifier(x.expression)) return m.localOf(x.expression)?.kind === 'setter'
  return false
}
