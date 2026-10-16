/**
 * Views and user controls, and where they live (vskubuno `docs/VIEWS-SPEC.md` §1.1 and §1.2, `docs/WEB-VIEWS.md` §23).
 *
 * A screen is a **view** (`.kbview`) when it stands on its own - a page rendered by a route, a window, a dialog or a
 * flyout - and a **user control** (`.kbcontrol`, root `<UserControl>`) when it is placed inside other components:
 * a pane, a section, a panel given to a host slot, a row or a card a list repeats. Its props are its properties and
 * its callbacks its events (`x:Props`).
 *
 * This module decides which one a component is, from how the project uses it (its importers, read with the
 * TypeScript parser), proposes the folder it belongs in, and moves files while keeping every relative import right:
 *
 * - {@link classify}: the role of each component of the project (views, and the React components around them);
 * - {@link planLayout}: the moves that put each one in the folder of its role;
 * - {@link relocate}: the moved files and the importers rewritten, as texts (nothing is written here);
 * - {@link toControlText} / {@link toViewText}: a view's markup turned into a user control's, and back.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

import { ts } from 'ts-morph'

export type Role = 'view' | 'control'

/** What a view or a user control is, more precisely: the folder it goes to follows from it. */
export type Kind =
  /** A view a route renders (or a registry the router reads, `ADMIN_SECTIONS`). */
  | 'page'
  /** A view shown above the page: a full-screen viewer, a floating window. */
  | 'window'
  /** A dialog or a wizard. */
  | 'dialog'
  /** A user control placed by one component only (a page's pane, a list's row). */
  | 'part'
  /** A user control placed by several components. */
  | 'shared'

/** How a file uses a component. */
export type UsageHow =
  /** Rendered by a route (`<Route element>`, `RouteRegistry.register`, a `routes` / `sections` table). */
  | 'route'
  /** Placed as a JSX element, or rendered by a view's `<ReactHost>`. */
  | 'jsx'
  /** Handed to a host as a value (a slot, an extension point, a registry): the host places it. */
  | 'host'
  /** Re-exported: whoever imports it from there places it. */
  | 'reexport'

export interface Usage {
  /** The file using the component. */
  file: string
  how: UsageHow
  /** 1-based line of the use. */
  line: number
}

/** The files of one component, by stem: the view, its code-behind and parts, or a React component's `.tsx`. */
export interface Unit {
  /** The component's name (the file stem). */
  stem: string
  dir: string
  /** The `.kbview` / `.kbcontrol`, when the component is a view. */
  view?: string
  /** The module importers import: the code-behind (`X.ts` / `X.tsx`) or the React component's `.tsx`. */
  module: string
  /** Every file of the unit (view, code-behind, parts, design data, tests, resources). */
  files: string[]
}

export interface Classified extends Unit {
  role: Role
  kind: Kind
  /** Why, in a few words (the report shows it). */
  reason: string
  usages: Usage[]
  /** The distinct components placing it (code-behind, parts and view of one view count as one). */
  hosts: string[]
}

/** The role folders (VIEWS-SPEC §1.2): reserved names at an app root and in a folder split by role. */
export const ROLE_FOLDERS = ['views', 'dialogs', 'pages', 'controls'] as const

/** The folder of each kind. */
export const FOLDER_OF: Readonly<Record<Kind, (typeof ROLE_FOLDERS)[number]>> = {
  page: 'views',
  window: 'views',
  dialog: 'dialogs',
  part: 'pages',
  shared: 'controls',
}

/** Elements that make a view a window or a dialog when they are its root (or the only child of a neutral root). */
const WINDOW_ELEMENTS = new Set(['FloatingWindow', 'Window'])
const DIALOG_ELEMENTS = new Set(['Dialog', 'ConfirmDialog', 'Modal', 'Sheet', 'Drawer', 'Flyout', 'PromptDialog'])
const DIALOG_NAME = /(Dialog|Modal|Wizard|Prompt)$/
const WINDOW_NAME = /(Window|Viewer|Player|Overlay|Editor)$/

// ── Files ───────────────────────────────────────────────────────────────────

const VIEW_EXT = /\.(kbview|kbcontrol)$/i
const SKIP_DIRS = new Set(['node_modules', '.kubuno', 'dist', '.git', 'obj', 'bin'])

/** Every file under `dir` (absolute, `/`-separated), the build and generated folders left out. */
export function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(d, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else out.push(slash(full))
    }
  }
  walk(dir)
  return out.sort()
}

export function slash(p: string): string {
  return p.split('\\').join('/')
}

/** The stem a file belongs to (`X.parts.tsx`, `X.kbview.design.json`, `X.test.tsx`, `X.fr.kbres` → `X`). */
export function stemOf(file: string): string {
  const name = basename(file)
  const m = /^(.+?)(\.parts\.tsx|\.(kbview|kbcontrol)\.design\.json|\.(kbview|kbcontrol)|\.(test|spec)\.tsx?|\.[a-z]{2}(-[A-Za-z]+)?\.kbres|\.kbres|\.tsx?)$/.exec(name)
  return m ? m[1] : name.replace(/\.[^.]+$/, '')
}

/** The files of `stem` in `dir`, from the folder's listing. */
function unitFiles(dirFiles: readonly string[], stem: string): string[] {
  return dirFiles.filter((f) => stemOf(f) === stem && basename(f).startsWith(stem + '.'))
}

const PASCAL = /^[A-Z][A-Za-z0-9]*$/

/**
 * The units of the project under `dirs`: every view (with its code-behind and parts), and - with `components` -
 * every React component file (`X.tsx`, PascalCase, rendering JSX) that is no view's code-behind or parts.
 */
export function unitsOf(files: readonly string[], opts: { components?: boolean; exclude?: readonly string[] } = {}): Unit[] {
  const excluded = (f: string): boolean => (opts.exclude ?? []).some((x) => f === slash(x) || f.startsWith(slash(x).replace(/\/?$/, '/')))
  const byDir = new Map<string, string[]>()
  for (const f of files) {
    if (excluded(f)) continue
    const d = dirname(f)
    byDir.set(d, [...(byDir.get(d) ?? []), f])
  }
  const units: Unit[] = []
  for (const [dir, list] of byDir) {
    const views = list.filter((f) => VIEW_EXT.test(f))
    const taken = new Set<string>()
    for (const v of views) {
      const stem = basename(v).replace(VIEW_EXT, '')
      const module = [`${stem}.ts`, `${stem}.tsx`].map((n) => `${dir}/${n}`).find((p) => list.includes(p)) ?? v
      units.push({ stem, dir, view: v, module, files: unitFiles(list, stem) })
      taken.add(stem)
    }
    if (!opts.components) continue
    for (const f of list) {
      if (!f.endsWith('.tsx') || /\.(parts|test|spec)\.tsx$/.test(f)) continue
      const stem = basename(f, '.tsx')
      if (taken.has(stem) || !PASCAL.test(stem)) continue
      const text = readFileSync(f, 'utf8')
      if (!/<[A-Za-z]/.test(text) || !new RegExp(`\\b(function|const)\\s+${stem}\\b`).test(text)) continue
      units.push({ stem, dir, module: f, files: unitFiles(list, stem) })
      taken.add(stem)
    }
  }
  return units.sort((a, b) => a.module.localeCompare(b.module))
}

// ── Module resolution (relative specifiers only: a module's own files) ─────

const CODE_EXT = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs']

/** The file a relative specifier names, among `exists`, or undefined (a package, an alias, a missing file). */
export function resolveSpecifier(from: string, spec: string, exists: (p: string) => boolean): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const base = slash(resolve(dirname(from), spec))
  const candidates = [base, ...CODE_EXT.map((e) => base + e), ...['/index.ts', '/index.tsx', '/index.js'].map((e) => base + e)]
  // `./x.js` written for `./x.ts` (ESM style).
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'))
  return candidates.find((c) => exists(c))
}

interface Specifier {
  /** The string literal's text range (quotes excluded). */
  start: number
  end: number
  value: string
  kind: 'import' | 'export' | 'dynamic' | 'mock'
  /** For `import` declarations: the local name of the default import, and the named imports. */
  def?: string
  named: Array<{ imported: string; local: string }>
  node: ts.Node
}

/** The module specifiers of a file: imports, re-exports, `import()`, `vi.mock()` / `vi.importActual()`. */
function specifiersOf(sf: ts.SourceFile): Specifier[] {
  const out: Specifier[] = []
  const lit = (s: ts.StringLiteralLike, kind: Specifier['kind'], node: ts.Node, def?: string, named: Specifier['named'] = []): void => {
    out.push({ start: s.getStart(sf) + 1, end: s.getEnd() - 1, value: s.text, kind, def, named, node })
  }
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)) {
      const c = n.importClause
      const named = c?.namedBindings && ts.isNamedImports(c.namedBindings)
        ? c.namedBindings.elements.map((e) => ({ imported: (e.propertyName ?? e.name).text, local: e.name.text }))
        : []
      lit(n.moduleSpecifier, 'import', n, c?.name?.text, named)
      return
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) {
      lit(n.moduleSpecifier, 'export', n)
      return
    }
    if (ts.isCallExpression(n) && n.arguments.length && ts.isStringLiteralLike(n.arguments[0])) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) lit(n.arguments[0], 'dynamic', n)
      else if (/^(vi|jest)\.(mock|doMock|unmock|importActual|importMock)$/.test(n.expression.getText(sf))) lit(n.arguments[0], 'mock', n)
    }
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) lit(n.argument.literal, 'import', n)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

// ── Classification ──────────────────────────────────────────────────────────

/** The source of the project: path → text (the code files read from disk, plus any pending outputs). */
export type Sources = Map<string, string>

/** Reads the TypeScript files of `files` (`.ts`, `.tsx`, not `.d.ts`). */
export function readSources(files: readonly string[]): Sources {
  const out: Sources = new Map()
  for (const f of files) if (/\.(ts|tsx|mts)$/.test(f) && !f.endsWith('.d.ts')) out.set(f, readFileSync(f, 'utf8'))
  return out
}

const ROUTE_CALL = /route/i
const ROUTE_TABLE = /(routes?|sections?|screens?)$/i
const ROUTE_PROP = new Set(['element', 'Component', 'component'])

/** How the identifier `id` (a use of an imported component) uses it. */
export function usageOf(id: ts.Node, sf: ts.SourceFile): UsageHow {
  const parent = id.parent
  const isTag = (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) && parent.tagName === id
  // Next to other elements (`<><Notice/><div><Panel/></div></>`), it is a part of what they compose, wherever that
  // goes.
  if (isTag && composed(ts.isJsxSelfClosingElement(parent) ? parent : parent.parent)) return 'jsx'
  /** The name of the nearest object property holding the use (`Component` in `{ path, Component: X }`). */
  let prop: string | undefined
  for (let p: ts.Node | undefined = parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (prop === undefined && ts.isPropertyAssignment(p)) prop = p.name.getText(sf)
    // `<Route path=… element={<X/>}/>`, `<Route Component={X}/>`.
    if (ts.isJsxAttribute(p) && ROUTE_PROP.has(p.name.getText(sf))) {
      const owner = p.parent.parent
      if ((ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner)) && /(^|\.)Route$/.test(owner.tagName.getText(sf))) return 'route'
    }
    // `RouteRegistry.register('drive/settings', X)`, `registerRoute(…)`, `createBrowserRouter([...])`.
    if (ts.isCallExpression(p) && ROUTE_CALL.test(p.expression.getText(sf)) && p.arguments.some((a) => a.pos <= id.pos && id.end <= a.end)) return 'route'
    // `{ path: '/x', element: <X/> }` (not `{ path, Icon: X }`).
    if (ts.isObjectLiteralExpression(p) && prop && ROUTE_PROP.has(prop) && p.properties.some((q) => q.name && q.name.getText(sf) === 'path')) return 'route'
    // `const ADMIN_SECTIONS = { users: { Component: X } }`, `export const routes = [...]` (a table, not a component).
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && ROUTE_TABLE.test(p.name.text) && p.initializer &&
      (ts.isObjectLiteralExpression(p.initializer) || ts.isArrayLiteralExpression(p.initializer))) return 'route'
    // A component body (a function declaration, a function given to a variable, a class member) is where the
    // use is placed; an inline render function given as a value (`Panel: () => <X/>`) is part of the table.
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isClassDeclaration(p)) break
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && p.parent.initializer === p) break
  }
  if (isTag) return 'jsx'
  // A value: returned by a view's getter (`<ReactHost Component="{Binding X}"/>`) or used in a component body →
  // placed; given to a call or an object (a slot, an extension point) → its host places it.
  for (let p: ts.Node | undefined = parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isGetAccessorDeclaration(p) || ts.isMethodDeclaration(p)) return 'jsx'
    if (ts.isCallExpression(p) || ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) return 'host'
    if (ts.isFunctionDeclaration(p) || ts.isArrowFunction(p) || ts.isFunctionExpression(p)) return 'jsx'
  }
  return 'host'
}

function isElementChild(c: ts.JsxChild): boolean {
  if (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c) || ts.isJsxFragment(c)) return true
  if (ts.isJsxExpression(c) && c.expression) {
    let found = false
    const visit = (n: ts.Node): void => {
      if (found) return
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) found = true
      else if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit)
    }
    visit(c.expression)
    return found
  }
  return false
}

/** Whether a JSX element sits among other elements (up its JSX ancestors, `{cond && …}` and `a ? b : c` included). */
function composed(el: ts.Node): boolean {
  let cur: ts.Node = el
  for (let p: ts.Node | undefined = el.parent; p; cur = p, p = p.parent) {
    if (ts.isJsxElement(p) || ts.isJsxFragment(p)) {
      if (p.children.some((c) => c !== cur && isElementChild(c))) return true
      continue
    }
    if (ts.isJsxExpression(p) && !ts.isJsxAttribute(p.parent)) continue
    if (ts.isParenthesizedExpression(p) || ts.isConditionalExpression(p) || ts.isBinaryExpression(p)) continue
    return false
  }
  return false
}

/** Whether a JSX element is all its function returns (`return mustChange ? <Change/> : <App/>`). */
function returnedAlone(el: ts.Node): boolean {
  for (let p: ts.Node | undefined = el.parent; p; p = p.parent) {
    if (ts.isParenthesizedExpression(p) || ts.isConditionalExpression(p) || ts.isBinaryExpression(p)) continue
    if (ts.isJsxFragment(p) && p.children.filter(isElementChild).length === 1) continue
    if (ts.isJsxExpression(p) && ts.isJsxFragment(p.parent)) continue
    return ts.isReturnStatement(p) || ts.isArrowFunction(p)
  }
  return false
}

/**
 * The names a file binds to the component `stem` of a module: the default import or the named import of that name,
 * and the `lazy(() => import('./X'))` constants.
 */
function localNames(spec: Specifier, stem: string): string[] {
  if (spec.kind === 'import') return [...(spec.def ? [spec.def] : []), ...spec.named.filter((n) => n.imported === stem).map((n) => n.local)]
  if (spec.kind !== 'dynamic') return []
  // `const X = lazy(() => import('./X'))`, `const X = lazy(() => import('./X').then(m => ({ default: m.X })))`.
  for (let p: ts.Node | undefined = spec.node.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return [p.name.text]
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) break
  }
  return []
}

/** The identifiers of `sf` named `name`, outside import declarations and declarations of that name. */
function usesOf(sf: ts.SourceFile, name: string): ts.Identifier[] {
  const out: ts.Identifier[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) return
    if (ts.isIdentifier(n) && n.text === name) {
      const p = n.parent
      const declared = (ts.isVariableDeclaration(p) && p.name === n) || (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) || (ts.isJsxAttribute(p) && p.name === n) || ts.isJsxClosingElement(p) ||
        (ts.isQualifiedName(p) && p.right === n) || ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p) ||
        (ts.isGetAccessorDeclaration(p) && p.name === n) || (ts.isMethodDeclaration(p) && p.name === n) || (ts.isPropertyDeclaration(p) && p.name === n)
      if (!declared) out.push(n)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** The first element of a view's markup, the comments skipped, and that element's start tag. */
function rootTag(xml: string): { name: string; tag: string; start: number; end: number } | undefined {
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<([A-Za-z][\w.:]*)\b/g
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (!m[1]) continue
    const end = tagEnd(xml, m.index)
    return { name: m[1], tag: xml.slice(m.index, end), start: m.index, end }
  }
  return undefined
}

/** The index after the `>` closing the start tag at `start` (quoted attribute values skipped). */
function tagEnd(xml: string, start: number): number {
  let quote = ''
  for (let i = start; i < xml.length; i++) {
    const c = xml[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i + 1
  }
  return xml.length
}

/** The elements directly under the root (names), comments skipped. */
function rootChildren(xml: string, root: { end: number; tag: string }): string[] {
  if (root.tag.endsWith('/>')) return []
  const out: string[] = []
  let depth = 0
  const re = /<!--[\s\S]*?-->|<\/([A-Za-z][\w.:]*)\s*>|<([A-Za-z][\w.:]*)\b/g
  re.lastIndex = root.end
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[1]) {
      if (depth === 0) break
      depth--
      continue
    }
    if (!m[2]) continue
    const end = tagEnd(xml, m.index)
    if (depth === 0) out.push(m[2])
    if (!xml.slice(m.index, end).endsWith('/>')) depth++
    re.lastIndex = end
  }
  return out
}

/** Window or dialog, from a view's markup: its root element, a full-screen overlay, a modal surface. */
export function surfaceOfView(xml: string, stem: string): 'window' | 'dialog' | undefined {
  const root = rootTag(xml)
  if (!root) return undefined
  const named: 'window' | 'dialog' | undefined = DIALOG_NAME.test(stem) ? 'dialog' : WINDOW_NAME.test(stem) ? 'window' : undefined
  // The root, or the first element of a plain root (`<Panel x:Props OnMouseDown><FloatingWindow …>`); a part the
  // codemod could not convert keeps the element's name in its TODO comment.
  const els = [root.name]
  if (root.name === 'Panel') {
    const first = rootChildren(xml, root)[0]
    const todo = /^\s*<!--\s*TODO\(views-migrate\): <(\w+)>/.exec(xml.slice(root.end))?.[1]
    if (first) els.push(todo ?? first)
  }
  if (els.some((e) => DIALOG_ELEMENTS.has(e))) return 'dialog'
  // A floating window is a dialog (a picker, a form) unless named as a window or a viewer.
  if (els.some((e) => WINDOW_ELEMENTS.has(e))) return named === 'window' ? 'window' : 'dialog'
  if (/AccessibleModal="true"/.test(root.tag) || (/\bfixed\b/.test(root.tag) && /\binset-0\b/.test(root.tag))) return named ?? 'window'
  // A name alone makes a dialog (`…Dialog`, `…Wizard`), never a window: an editor or a viewer may be a pane.
  return named === 'dialog' ? named : undefined
}

/** Window or dialog, from a React component's source: the element its body returns first. */
export function surfaceOfComponent(text: string, stem: string): 'window' | 'dialog' | undefined {
  const named: 'window' | 'dialog' | undefined = DIALOG_NAME.test(stem) ? 'dialog' : WINDOW_NAME.test(stem) ? 'window' : undefined
  const sf = parse(`${stem}.tsx`, text)
  let first: ts.JsxOpeningLikeElement | undefined
  const findComponent = (n: ts.Node): ts.Node | undefined => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === stem) return n
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === stem) return n
    return ts.forEachChild(n, findComponent)
  }
  const comp = findComponent(sf)
  const visit = (n: ts.Node): void => {
    if (first) return
    if (ts.isReturnStatement(n) || ts.isArrowFunction(n)) {
      const e = ts.isReturnStatement(n) ? n.expression : ts.isBlock(n.body) ? undefined : n.body
      const jsx = e && firstJsx(e)
      if (jsx) {
        first = jsx
        return
      }
    }
    ts.forEachChild(n, visit)
  }
  if (comp) visit(comp)
  // A React component's overlay is often portalled or built by a helper, out of sight here: its name counts
  // (`…Viewer`, `…Player`, `…Overlay`).
  if (!first) return named
  const tag = first.tagName.getText(sf).replace(/^.*\./, '')
  const attrs = first.attributes.getText(sf)
  if (DIALOG_ELEMENTS.has(tag) || /role="dialog"|aria-modal/.test(attrs)) return 'dialog'
  if (WINDOW_ELEMENTS.has(tag)) return named === 'window' ? 'window' : 'dialog'
  if (/\bfixed\b/.test(attrs) && /\binset-0\b/.test(attrs)) return named ?? 'window'
  return named
}

function firstJsx(e: ts.Node): ts.JsxOpeningLikeElement | undefined {
  let x = e
  while (ts.isParenthesizedExpression(x)) x = x.expression
  if (ts.isJsxElement(x)) return x.openingElement
  if (ts.isJsxSelfClosingElement(x)) return x
  if (ts.isJsxFragment(x)) {
    const kids = x.children.filter((c) => !ts.isJsxText(c) || c.text.trim())
    return kids.length === 1 ? firstJsx(kids[0]) : undefined
  }
  if (ts.isConditionalExpression(x)) return firstJsx(x.whenTrue) ?? firstJsx(x.whenFalse)
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return firstJsx(x.right)
  return undefined
}

/** The host a use counts for: the view behind a code-behind or parts file, else the file itself. */
function hostKey(file: string): string {
  return `${dirname(file)}/${stemOf(file)}`
}

/**
 * The role of every unit (VIEWS-SPEC §1.1), from how `sources` use it:
 * 1. a view whose root is already `<UserControl>` stays a user control;
 * 2. a window or a dialog (its root element, a full-screen overlay, its name) is a view;
 * 3. a component a route renders (alone: not next to other elements), or the application's root component renders
 *    in place of the routes, is a view (a page);
 * 4. a component other components place (JSX, a `<ReactHost>`, a host's slot) is a user control - `shared` when
 *    several components place it;
 * 5. a component nothing uses is a view when named like one (`…Page`, `…Screen`), else a user control.
 */
export function classify(units: readonly Unit[], sources: Sources, extraFiles: readonly string[] = [], opts: { appComponents?: readonly string[] } = {}): Classified[] {
  // The application's root component (`App`): what it renders in place of the routes is a page.
  const app = new Set(opts.appComponents ?? ['App'])
  const known = new Set<string>([...sources.keys(), ...extraFiles])
  const exists = (p: string): boolean => known.has(p)
  const byModule = new Map<string, Unit>()
  for (const u of units) byModule.set(u.module, u)
  const usages = new Map<Unit, Usage[]>()
  for (const [file, text] of sources) {
    const sf = parse(file, text)
    for (const spec of specifiersOf(sf)) {
      const target = resolveSpecifier(file, spec.value, exists)
      const unit = target && byModule.get(target)
      if (!unit || unit.files.includes(file)) continue
      const list = usages.get(unit) ?? usages.set(unit, []).get(unit)!
      const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
      if (spec.kind === 'export') {
        list.push({ file, how: 'reexport', line: line(spec.node) })
        continue
      }
      if (spec.kind === 'mock') continue
      // Only the component itself counts (`import X, { helper } from './X'`).
      for (const name of localNames(spec, unit.stem)) {
        for (const id of usesOf(sf, name)) {
          let how = usageOf(id, sf)
          const p = id.parent
          if (how === 'jsx' && app.has(stemOf(file)) && (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && returnedAlone(ts.isJsxSelfClosingElement(p) ? p : p.parent)) how = 'route'
          list.push({ file, how, line: line(id) })
        }
      }
    }
  }
  return units.map((u) => {
    const list = usages.get(u) ?? []
    const hosts = [...new Set(list.filter((x) => x.how === 'jsx' || x.how === 'host').map((x) => hostKey(x.file)))].sort()
    const base = { ...u, usages: list, hosts }
    const viewText = u.view ? readFileSync(u.view, 'utf8') : undefined
    if (viewText && rootTag(viewText)?.name === 'UserControl') return { ...base, role: 'control' as Role, kind: kindOfControl(hosts), reason: 'its root is UserControl' }
    const surface = viewText ? surfaceOfView(viewText, u.stem) : surfaceOfComponent(sources.get(u.module) ?? '', u.stem)
    if (surface) return { ...base, role: 'view' as Role, kind: surface, reason: surface === 'dialog' ? 'a dialog' : 'a window above the page' }
    const route = list.find((x) => x.how === 'route')
    if (route) return { ...base, role: 'view' as Role, kind: 'page' as Kind, reason: `rendered by a route (${basename(route.file)}:${route.line})` }
    if (list.length) {
      const how = hosts.length ? `placed by ${hosts.map((h) => basename(h)).join(', ')}` : `re-exported (${list.map((x) => basename(x.file)).join(', ')})`
      return { ...base, role: 'control' as Role, kind: kindOfControl(hosts), reason: how }
    }
    if (/(Page|Screen)$/.test(u.stem)) return { ...base, role: 'view' as Role, kind: 'page' as Kind, reason: 'used nowhere; named as a page' }
    return { ...base, role: 'control' as Role, kind: 'part' as Kind, reason: 'used nowhere' }
  })
}

function kindOfControl(hosts: readonly string[]): Kind {
  return hosts.length > 1 ? 'shared' : 'part'
}

// ── Layout ──────────────────────────────────────────────────────────────────

export interface LayoutOptions {
  /** The app roots: their own components go to role folders (`src` of a module, `src/core` of the core). */
  roots: readonly string[]
  /** A folder holding more than this many views directly is split by role too (default 12). */
  split?: number
  /** Folders left as they are (a gallery of samples). */
  exclude?: readonly string[]
  /** Units placed by hand (a feature folder): the unit's view or module → its folder. */
  place?: ReadonlyMap<string, string>
  /** Units renamed (a user control whose name another one, or a host element, already has): view or module → stem. */
  rename?: ReadonlyMap<string, string>
  /** The application's root component, which stays where it is (default `App`). */
  appComponents?: readonly string[]
}

export interface Move {
  from: string
  to: string
}

/**
 * Where each unit goes (VIEWS-SPEC §1.2): at an app root, and in a folder past `split` views, the role folders -
 * `views/` (pages, windows), `dialogs/`, `pages/` (user controls one component places: panes, sections, rows) and
 * `controls/` (user controls several components place). A feature folder below keeps its views and user controls
 * side by side. A view changing kind changes extension (`.kbview` ↔ `.kbcontrol`), its design data with it.
 */
export function planLayout(units: readonly Classified[], opts: LayoutOptions): Move[] {
  const roots = new Set(opts.roots.map((r) => slash(resolve(r))))
  const split = opts.split ?? 12
  const excluded = (d: string): boolean => (opts.exclude ?? []).some((x) => d === slash(resolve(x)) || d.startsWith(slash(resolve(x)) + '/'))
  const viewsIn = new Map<string, number>()
  for (const u of units) if (u.view) viewsIn.set(u.dir, (viewsIn.get(u.dir) ?? 0) + 1)
  const isRoleFolder = (d: string): boolean => (ROLE_FOLDERS as readonly string[]).includes(basename(d))
  /** The folder whose role folders `dir` uses, if any. */
  const areaOf = (dir: string): string | undefined => {
    if (roots.has(dir)) return dir
    // A role folder of an area (an app root, a folder split by role): its units are placed again by role.
    const parent = dirname(dir)
    if (isRoleFolder(dir) && (roots.has(parent) || (viewsIn.get(parent) ?? 0) > split || units.some((u) => dirname(u.dir) === parent && isRoleFolder(u.dir) && u.dir !== dir))) return parent
    return (viewsIn.get(dir) ?? 0) > split ? dir : undefined
  }
  const moves: Move[] = []
  const targets = new Map<string, string>()
  const app = new Set(opts.appComponents ?? ['App'])
  for (const u of units) {
    if (excluded(u.dir) || (!u.view && app.has(u.stem))) continue
    const area = areaOf(u.dir)
    const placed = opts.place?.get(u.view ?? u.module)
    const dir = placed ? slash(resolve(placed)) : area ? `${area}/${FOLDER_OF[u.kind]}` : u.dir
    const ext = u.role === 'control' ? 'kbcontrol' : 'kbview'
    const stem = opts.rename?.get(u.view ?? u.module) ?? u.stem
    for (const f of u.files) {
      let name = stem + basename(f).slice(u.stem.length)
      if (u.view) name = name.replace(/\.(kbview|kbcontrol)(\.design\.json)?$/, `.${ext}$2`)
      const to = `${dir}/${name}`
      if (to === f) continue
      const prev = targets.get(to)
      if (prev) throw new Error(`layout: ${f} and ${prev} would both become ${to}`)
      targets.set(to, f)
      moves.push({ from: f, to })
    }
  }
  return moves
}

// ── Relocation ──────────────────────────────────────────────────────────────

export interface Relocation {
  /** The files to write at their new place (moved files, with their imports rewritten). */
  moved: Map<string, string>
  /** The files rewritten in place (their imports name moved files). */
  edited: Map<string, string>
}

function specifierFor(fromFile: string, target: string, original: string): string {
  let rel = slash(relative(dirname(fromFile), target))
  if (!rel.startsWith('.')) rel = './' + rel
  // Keep the way it was written: without the extension, through the folder's index.
  const ext = extname(target)
  if (!extname(original) || /\.js$/.test(original)) {
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) rel = rel.slice(0, -ext.length) + (/\.js$/.test(original) ? '.js' : '')
    if (/\/index(\.js)?$/.test(rel) && !/\/index(\.js)?$/.test(original) && !/^\.\/?index/.test(basename(original))) rel = rel.replace(/\/index(\.js)?$/, '$1') || '.'
  }
  return rel
}

/**
 * Applies `moves` to `sources` (code files, path → text): every relative specifier naming a moved file - or written
 * in a moved file - is rewritten, and the code-behind / parts headers follow a view's new extension. Files other than
 * code (views, design data, resources) are moved by the caller (`git mv`); `exists` tells which files there are.
 */
export function relocate(sources: Sources, moves: readonly Move[], exists: (p: string) => boolean): Relocation {
  const to = new Map(moves.map((m) => [m.from, m.to]))
  const moved = new Map<string, string>()
  const edited = new Map<string, string>()
  for (const [file, text] of sources) {
    const newFile = to.get(file) ?? file
    const sf = parse(file, text)
    const edits: Array<{ start: number; end: number; text: string }> = []
    for (const spec of specifiersOf(sf)) {
      const target = resolveSpecifier(file, spec.value, exists)
      if (!target) continue
      const newTarget = to.get(target) ?? target
      if (newTarget === target && newFile === file) continue
      const next = specifierFor(newFile, newTarget, spec.value)
      if (next !== spec.value) edits.push({ start: spec.start, end: spec.end, text: next })
    }
    let out = text
    for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
    // The headers the codemod wrote name the view file.
    const stem = stemOf(file)
    for (const m of moves) {
      if (stemOf(m.from) !== stem || dirname(m.from) !== dirname(file) || !VIEW_EXT.test(m.from)) continue
      const oldName = basename(m.from)
      const newName = basename(m.to)
      if (oldName !== newName) out = out.split('`' + oldName + '`').join('`' + newName + '`')
    }
    if (newFile !== file) moved.set(newFile, out)
    else if (out !== text) edited.set(file, out)
  }
  return { moved, edited }
}

// ── View ↔ user control ─────────────────────────────────────────────────────

/** Attributes of a view's root that belong to the file rather than to its root element. */
const FILE_ATTRS = /^(x:Props|x:Class|x:Inherits|xmlns(:\w+)?|DesignWidth|DesignHeight|d:\w+)$/

interface ParsedAttr {
  name: string
  text: string
}

function attrsOf(tag: string): ParsedAttr[] {
  const out: ParsedAttr[] = []
  const re = /([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g
  const head = /^<[\w.:]+/.exec(tag)?.[0].length ?? 0
  re.lastIndex = head
  for (let m = re.exec(tag); m; m = re.exec(tag)) out.push({ name: m[1], text: m[0] })
  return out
}

/** Indents every line of `text` by `pad`, except the lines that start inside a quoted attribute value. */
function indentMarkup(text: string, pad: string): string {
  const lines = text.split('\n')
  let quote = ''
  let inTag = false
  let inComment = false
  return lines
    .map((line) => {
      const startsInside = !!quote
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (inComment) {
          if (line.startsWith('-->', i)) {
            inComment = false
            i += 2
          }
        } else if (quote) {
          if (c === quote) quote = ''
        } else if (inTag) {
          if (c === '"' || c === "'") quote = c
          else if (c === '>') inTag = false
        } else if (line.startsWith('<!--', i)) {
          inComment = true
          i += 3
        } else if (c === '<') inTag = true
      }
      return startsInside || !line.length ? line : pad + line
    })
    .join('\n')
}

/**
 * A view's markup as a user control's: the root element goes inside a `<UserControl>`, which takes the file's own
 * attributes (`x:Props`, `DesignWidth`, `DesignHeight`, namespaces). The runtime gives such a root (nothing of its own
 * but the file's attributes, one element) no box of its own: the control renders exactly as the view did.
 */
export function toControlText(xml: string): string {
  const root = rootTag(xml)
  if (!root || root.name === 'UserControl') return xml
  const attrs = attrsOf(root.tag)
  const fileAttrs = attrs.filter((a) => FILE_ATTRS.test(a.name))
  // The root's start tag without the file's attributes (the remaining ones keep their layout).
  let tag = root.tag
  for (const a of fileAttrs) {
    const i = tag.indexOf(a.text)
    // The attribute and the white space before it.
    let s = i
    while (s > 0 && /[ \t\r\n]/.test(tag[s - 1])) s--
    tag = tag.slice(0, s) + tag.slice(i + a.text.length)
  }
  // A start tag whose first attributes went keeps its next ones on their lines: join the first one back.
  tag = tag.replace(/^(<[\w.:]+)[ \t]*\r?\n[ \t]*/, '$1 ').replace(/^(<[\w.:]+) (\/?>)$/, '$1$2')
  const end = closingEnd(xml, root)
  const body = tag + xml.slice(root.end, end)
  const head = xml.slice(0, root.start)
  const tail = xml.slice(end)
  const open = `<UserControl${fileAttrs.length ? ' ' + fileAttrs.map((a) => a.text).join(' ') : ''}>`
  return `${head}${open}\n${indentMarkup(body, '  ')}\n</UserControl>${tail.startsWith('\n') ? tail : '\n' + tail.replace(/^\s*/, '')}`
}

/** The index after the root element (its end tag, or its self-closing start tag). */
function closingEnd(xml: string, root: { name: string; tag: string; start: number; end: number }): number {
  if (root.tag.endsWith('/>')) return root.end
  const re = new RegExp(`<!--[\\s\\S]*?-->|<(/?)${root.name.replace(/[.]/g, '\\.')}(?=[\\s/>])`, 'g')
  re.lastIndex = root.end
  let depth = 1
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[0].startsWith('<!--')) continue
    if (m[1]) {
      depth--
      if (depth === 0) return xml.indexOf('>', m.index) + 1
    } else {
      const e = tagEnd(xml, m.index)
      if (!xml.slice(m.index, e).endsWith('/>')) depth++
      re.lastIndex = e
    }
  }
  throw new Error(`no end tag for <${root.name}>`)
}

/**
 * A user control's markup as a view's: a `<UserControl>` root holding one element and nothing of its own gives its
 * attributes back to that element. Any other user control is left as it is (`undefined`): a view whose root docks
 * its children is written by hand.
 */
export function toViewText(xml: string): string | undefined {
  const root = rootTag(xml)
  if (!root) return undefined
  if (root.name !== 'UserControl') return xml
  const attrs = attrsOf(root.tag)
  if (attrs.some((a) => !FILE_ATTRS.test(a.name)) || rootChildren(xml, root).length !== 1) return undefined
  const end = closingEnd(xml, root)
  const inner = xml.slice(root.end, end).replace(/<\/UserControl>\s*$/, '')
  const child = rootTag(inner)
  if (!child) return undefined
  const childTag = child.tag.replace(/^(<[\w.:]+)/, `$1${attrs.length ? ' ' + attrs.map((a) => a.text).join(' ') : ''}`)
  const body = (inner.slice(0, child.start) + childTag + inner.slice(child.end)).replace(/^\n/, '').replace(/\s+$/, '')
  return xml.slice(0, root.start) + body.split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n') + '\n' + xml.slice(end).replace(/^\n/, '')
}

/**
 * The user controls whose element name is taken (VIEWS-SPEC §1.1: a user control is an element named after its
 * file, unique in the project and distinct from the host's elements): name → the files claiming it.
 */
export function nameCollisions(units: readonly Classified[], hostNames: ReadonlySet<string>, rename?: ReadonlyMap<string, string>): Map<string, string[]> {
  const byName = new Map<string, string[]>()
  for (const u of units) {
    if (u.role !== 'control' || !u.view) continue
    const name = rename?.get(u.view) ?? u.stem
    byName.set(name, [...(byName.get(name) ?? []), u.view])
  }
  const out = new Map<string, string[]>()
  for (const [name, files] of byName) if (files.length > 1 || hostNames.has(name)) out.set(name, files)
  return out
}

/** Whether a file exists among `files` or on disk. */
export function existsIn(files: Iterable<string>): (p: string) => boolean {
  const set = new Set(files)
  return (p) => set.has(p) || existsSync(p)
}
