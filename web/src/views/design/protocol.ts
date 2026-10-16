/**
 * The wire protocol between the Visual Studio web designer (host, `WebDesignSurfaceHost`) and the design page
 * (vskubuno docs/WEB-VIEWS.md §4.4): the desktop surface's shapes (`DesignSurfaceProtocol`,
 * `DesignSurfaceDragDropProtocol`, `DesignSurfaceContextMenuProtocol`) plus the web additions.
 *
 * Transport: page → host with `window.chrome.webview.postMessage(obj)`; host → page as `message` events of
 * `window.chrome.webview` (`e.data` is the object - a JSON string is accepted too). Without WebView2 (a browser,
 * tests), `window.__kbDesign = { send(msg), outbox }`: `send` delivers a host message, `outbox` collects what the
 * page posts. A message that is not an object with a known `type`, or whose fields have the wrong types, is
 * ignored (never an error): a stale or malformed message must not break the surface.
 *
 * Coordinates are CSS px of the page, relative to its viewport (`clientX` / `clientY`).
 */
import type { Diagnostic } from '../../../packages/views-compiler/dist/browser.js'

// ── Shapes ──

export interface WireRect {
  left: number
  top: number
  right: number
  bottom: number
}

export type EditOp =
  | { kind: 'setAttribute'; elementId: string; name: string; value: string }
  | { kind: 'removeElement'; elementId: string }
  | { kind: 'insertChild'; elementId: ''; parentId: string; index: number; xml: string }
  | { kind: 'moveElement'; elementId: string; newParentId: string; index: number }

export type BatchOp = Extract<EditOp, { kind: 'setAttribute' | 'removeElement' }>

export interface WireDropTarget {
  valid: boolean
  parentId: string
  index: number
  marker: WireRect
  xy?: [number, number]
}

export interface WireDiagnostic {
  line: number
  column: number
  endLine: number
  endColumn: number
  message: string
  code: string
  element?: string
  syntax: boolean
}

/** A user control of the project (`<WaffleMenu/>` for `WaffleMenu.kbcontrol`), rendered by `module`'s default export. */
export interface UserControlInfo {
  name: string
  /** Project-root-relative module (`/src/core/shell/menus/WaffleMenu`). */
  module: string
}

/** A `<view>.design.json`: sample props (and `dataContext`) the view is rendered with in the designer. */
export interface DesignData {
  props?: Record<string, unknown>
  dataContext?: unknown
  /** Designer-only chrome around the view (the popover a host would give a user control). */
  frame?: { background?: string; cornerRadius?: number; border?: boolean }
}

export interface DocumentInfo {
  /** Project-root-relative posix path (`src/core/shell/menus/WaffleMenu.kbcontrol`). */
  file: string
  /** The code-behind as imported from the view's folder (`./WaffleMenu`), or null. */
  codeBehind: string | null
  className: string | null
  userControls: UserControlInfo[]
  designData: DesignData | null
}

/** A registry entry (`kbview-controls.json` / `kbview-registry.web.json` `components[]`). */
export type ComponentEntry = Record<string, unknown> & { name: string }

export type HostMessage =
  | ({ type: 'setDocumentInfo' } & DocumentInfo)
  | { type: 'projectComponents'; components: ComponentEntry[] }
  | { type: 'setHostRegistry'; text: string }
  | { type: 'setText'; text: string; baseDir: string | null }
  | { type: 'setDesignMode'; on: boolean }
  | { type: 'select'; id: string | null }
  | { type: 'selectMany'; ids: string[]; primary: string | null }
  | { type: 'setDesignOptions'; containerOutlines: boolean }
  | { type: 'setCanvasBackground'; color: string }
  | { type: 'setVsTheme'; mode: 'dark' | 'light'; colors: Record<string, string> }
  | { type: 'setZoom'; zoom: number }
  | { type: 'setResources'; culture: string | null }
  | { type: 'format'; command: string }
  | { type: 'dragEnter'; component: string }
  | { type: 'dragOver'; x: number; y: number }
  | { type: 'drop'; x: number; y: number }
  | { type: 'dragLeave' }
  | { type: 'setViewport'; width: number | 'design' | 'fit' }
  | { type: 'setKubunoTheme'; mode: 'light' | 'dark' }
  | { type: 'setLanguage'; lang: string }

export type PageMessage =
  | { type: 'surfaceInfo'; version: 1; target: 'web'; views: string; ui: string; hostRuntime: string | null; mode: 'project' | 'bundled' }
  | { type: 'ready' }
  | { type: 'selectionChanged'; id: string | null; ids: string[]; bounds: { x: number; y: number; width: number; height: number } | null }
  | { type: 'editRequest'; op: EditOp }
  | { type: 'editRequests'; gesture: 'move' | 'resize' | 'delete'; ops: BatchOp[] }
  | { type: 'dropTargetChanged'; target: WireDropTarget | null }
  | { type: 'contextMenu'; x: number; y: number; screenX: 0; screenY: 0; elementId: string | null }
  | { type: 'doubleClick'; elementId: string }
  | { type: 'command'; name: 'copy' | 'cut' | 'paste' | 'duplicate'; elementId: string | null }
  | { type: 'renderStatus'; state: 'clean' | 'stale' | 'empty'; diagnostics: WireDiagnostic[] }
  | { type: 'focusState'; editing: boolean }
  | { type: 'unhandledKey'; key: string; ctrl: boolean; shift: boolean; alt: boolean }
  | { type: 'toolboxDragDetected' }
  | { type: 'log'; message: string }
  | { type: 'surfaceError'; message: string; line: number; column: number }
  | { type: 'viewportChanged'; width: number; theme: 'light' | 'dark'; lang: string; mode: 'design' | 'run' }

const kebabToCamel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** A compiler diagnostic in the desktop's `renderStatus` shape. */
export function wireDiagnostic(d: Diagnostic): WireDiagnostic {
  const out: WireDiagnostic = {
    line: d.line, column: d.column, endLine: d.end_line, endColumn: d.end_column,
    message: d.message, code: kebabToCamel(d.code), syntax: d.code === 'syntax',
  }
  const el = /element `([^`]+)`/.exec(d.message)
  if (d.code === 'unknown-element' && el) out.element = el[1]
  return out
}

// ── Decoding host messages ──

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const strOrNull = (v: unknown): string | null | undefined => (v === null || v === undefined ? null : isStr(v) ? v : undefined)

function userControls(v: unknown): UserControlInfo[] {
  if (!Array.isArray(v)) return []
  return v.filter((u): u is UserControlInfo => isObj(u) && isStr(u.name) && isStr(u.module)).map((u) => ({ name: u.name, module: u.module }))
}

/** A host message, or `null` when `data` is not one this page understands. */
export function decodeHostMessage(data: unknown): HostMessage | null {
  let m = data
  if (isStr(m)) {
    try {
      m = JSON.parse(m)
    } catch {
      return null
    }
  }
  if (!isObj(m) || !isStr(m.type)) return null
  switch (m.type) {
    case 'setDocumentInfo': {
      if (!isStr(m.file)) return null
      const codeBehind = strOrNull(m.codeBehind)
      const className = strOrNull(m.className)
      if (codeBehind === undefined || className === undefined) return null
      const designData = isObj(m.designData) ? (m.designData as DesignData) : null
      return { type: 'setDocumentInfo', file: m.file, codeBehind, className, userControls: userControls(m.userControls), designData }
    }
    case 'projectComponents':
      if (!Array.isArray(m.components)) return null
      return { type: 'projectComponents', components: m.components.filter((c): c is ComponentEntry => isObj(c) && isStr(c.name)) }
    case 'setHostRegistry':
      return isStr(m.text) && m.text.trim() ? { type: 'setHostRegistry', text: m.text } : null
    case 'setText': {
      if (!isStr(m.text)) return null
      const baseDir = strOrNull(m.baseDir)
      return { type: 'setText', text: m.text, baseDir: baseDir ?? null }
    }
    case 'setDesignMode':
      return typeof m.on === 'boolean' ? { type: 'setDesignMode', on: m.on } : null
    case 'select': {
      const id = strOrNull(m.id)
      return id === undefined ? null : { type: 'select', id }
    }
    case 'selectMany': {
      if (!Array.isArray(m.ids) || !m.ids.every(isStr)) return null
      const primary = strOrNull(m.primary)
      return { type: 'selectMany', ids: m.ids as string[], primary: primary ?? null }
    }
    case 'setDesignOptions':
      return { type: 'setDesignOptions', containerOutlines: m.containerOutlines !== false }
    case 'setCanvasBackground':
      return isStr(m.color) ? { type: 'setCanvasBackground', color: m.color } : null
    case 'setVsTheme': {
      const mode = m.mode === 'light' ? 'light' : m.mode === 'dark' ? 'dark' : null
      if (!mode) return null
      const colors: Record<string, string> = {}
      if (isObj(m.colors)) for (const [k, v] of Object.entries(m.colors)) if (isStr(v)) colors[k] = v
      return { type: 'setVsTheme', mode, colors }
    }
    case 'setZoom':
      return isNum(m.zoom) && m.zoom >= 0 ? { type: 'setZoom', zoom: m.zoom } : null
    case 'setResources': {
      const culture = strOrNull(m.culture)
      return culture === undefined ? null : { type: 'setResources', culture }
    }
    case 'format':
      return isStr(m.command) ? { type: 'format', command: m.command } : null
    case 'dragEnter':
      return isStr(m.component) && m.component ? { type: 'dragEnter', component: m.component } : null
    case 'dragOver':
    case 'drop':
      return isNum(m.x) && isNum(m.y) ? { type: m.type, x: m.x, y: m.y } : null
    case 'dragLeave':
      return { type: 'dragLeave' }
    case 'setViewport': {
      const w = m.width
      if (w === 'design' || w === 'fit') return { type: 'setViewport', width: w }
      return isNum(w) && w > 0 ? { type: 'setViewport', width: w } : null
    }
    case 'setKubunoTheme':
      return m.mode === 'light' || m.mode === 'dark' ? { type: 'setKubunoTheme', mode: m.mode } : null
    case 'setLanguage':
      return isStr(m.lang) && m.lang ? { type: 'setLanguage', lang: m.lang } : null
    default:
      return null
  }
}

/** `{left, top, right, bottom}` rounded to 1/100 px (the wire keeps numbers short). */
export function wireRect(r: { left: number; top: number; right: number; bottom: number }): WireRect {
  const q = (n: number): number => Math.round(n * 100) / 100
  return { left: q(r.left), top: q(r.top), right: q(r.right), bottom: q(r.bottom) }
}

/** The language a culture names, when it is one the designer offers (`fr-FR` → `fr`). */
export function languageOfCulture(culture: string | null | undefined, offered: readonly string[]): string | null {
  if (!culture) return null
  const lang = culture.toLowerCase().split(/[-_]/)[0]
  return offered.includes(lang) ? lang : null
}

// ── Transport ──

interface WebView {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void
}

export interface DesignTestHook {
  /** Delivers a host message to the page. */
  send(message: unknown): void
  /** Everything the page posted, in order. */
  outbox: PageMessage[]
}

declare global {
  interface Window {
    chrome?: { webview?: WebView }
    __kbDesign?: DesignTestHook
  }
}

export interface Channel {
  post(message: PageMessage): void
  /** Subscribes to the host's messages (decoded; unknown ones are dropped). */
  listen(handler: (message: HostMessage) => void): void
  /** Whether the page runs inside the WebView2 host. */
  readonly hosted: boolean
}

/** The channel of this page: WebView2 when hosted, else `window.__kbDesign`. */
export function openChannel(win: Window = window): Channel {
  const webview = win.chrome?.webview
  const handlers: ((m: HostMessage) => void)[] = []
  const deliver = (data: unknown): void => {
    const m = decodeHostMessage(data)
    if (!m) return
    for (const h of handlers) h(m)
  }
  if (webview) {
    webview.addEventListener('message', (e) => deliver(e.data))
    return {
      hosted: true,
      post: (message) => webview.postMessage(message),
      listen: (h) => void handlers.push(h),
    }
  }
  const hook: DesignTestHook = win.__kbDesign ?? { send: () => {}, outbox: [] }
  hook.send = deliver
  hook.outbox ??= []
  win.__kbDesign = hook
  return {
    hosted: false,
    post: (message) => void hook.outbox.push(message),
    listen: (h) => void handlers.push(h),
  }
}

/**
 * The registry texts a page compiles with once the designer sent the project's host registry (`setHostRegistry`):
 * the bundled page (no `project.json`) replaces the host registry it was built with - older than the project's
 * whenever the project upgraded `@kubuno/ui` after the extension was built, which made the designer report
 * « `Label` has no property `HtmlTag` » where `kbview-tsc` compiles clean - and keeps the project registries.
 * `null` when nothing changes (the project-mode page already has the project's registry, or the same text).
 */
export function withHostRegistry(texts: readonly string[], projectLoaded: boolean, host: string): string[] | null {
  if (projectLoaded || texts[0] === host) return null
  return [host, ...texts.slice(1)]
}
