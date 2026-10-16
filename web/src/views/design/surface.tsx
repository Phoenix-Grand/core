/**
 * The design surface of `.kbview` / `.kbcontrol` web views in Visual Studio (vskubuno docs/WEB-VIEWS.md §4.2–§4.6,
 * lots WV-9b / WV-10): the page a WebView2 document pane shows.
 *
 * - It compiles the unsaved buffer (`setText`) with the in-browser compiler (`design: true`: `d:` values and
 *   `DesignWidth` / `DesignHeight` kept) and renders the plan with `@kubuno/views` in design mode, through a design
 *   class (`designApi.ts`) over the view's code-behind (dev-server mode: getters and `use()` run, handlers never) or
 *   over the generated base alone. Project controls are imported through the dev server and registered under the
 *   specifier the plan names; in bundled mode, or when an import fails, a labelled placeholder stands in.
 * - A view that does not compile keeps the last good plan on screen (dimmed); `renderStatus` reports every compile.
 * - The overlay neutralises input in design mode (widgets never get a click, focus or a key), keeps a layout map of
 *   every `[data-kb-id]` of the document (portals included), hit-tests (deepest element, reverse paint order) and
 *   draws the adorners; gestures become edit intents for the host (selection, move / resize, reorder / reparent,
 *   Toolbox drops, keyboard).
 *
 * Popovers: a popover's content is a user control designed on its own surface (`WaffleMenu`, `AccountMenu`);
 * `ContextMenu` / `ToolTip` / `DropDownMenu` are tray components and never open in design mode (input never reaches
 * the elements that open them). Something opened in Run mode stays open when switching back to Design (the view
 * instance is kept) and is selectable: the layout map covers every `[data-kb-id]` of the document, in a `<body>`
 * portal or not, and no pointer event of the page reaches it while the overlay is up.
 */
import { Component, createElement, type ErrorInfo, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

import { KbView, registerElements, tokenColor } from '@kubuno/views'
import { designClass, setDesignDataContext, setDesignPlan } from '../designApi'
import type { ViewPlan } from '../plan'
import { CELL, type ViewClass } from '../view'
import { loadBrowserCompiler, type CompileOutput, type ViewCompiler } from '../../../packages/views-compiler/dist/browser.js'

import { applyKubunoTheme, DESIGN_LANGUAGES, i18n, RTL_LANGUAGES, type KubunoThemeMode } from './bootstrap'
import { computeDropTarget, dropSize, isNoOpMove, type DragSubject, type DropContext, type DropTarget } from './drop'
import { insertMessage, keyMessages, moveOps, resizableHandles, resizeOps, skeletonXml, toolboxComponentOf, type Placement } from './edits'
import {
  DRAG_THRESHOLD,
  boundsOf,
  buildLayoutMap,
  childEntries,
  contains,
  domMeasures,
  handleAt,
  hitTest,
  isAncestorOrSelf,
  makeLayoutMap,
  parentIdOf,
  rect,
  resizeRect,
  selectionFrame,
  topLevelIds,
  translate,
  visibleRect,
  type Handle,
  type LayoutMap,
  type Rect,
} from './geometry'
import { Catalog, containerKind, designDocumentKind, indexPlan, isAbsoluteChild, literalNumber, moduleOfCodeBehind, planModules, type NodeInfo } from './model'
import { drawAdorners, handleCursor, type Label, type OutlineAdorner, type SelectedAdorner } from './overlay'
import { makePlaceholder } from './placeholder'
import {
  languageOfCulture,
  openChannel,
  wireDiagnostic,
  wireRect,
  withHostRegistry,
  type Channel,
  type ComponentEntry,
  type DesignData,
  type DocumentInfo,
  type HostMessage,
  type PageMessage,
  type UserControlInfo,
} from './protocol'
import { createToolbar, DEVICE_FRAMES, type DeviceChoice, type ToolbarState, type WidthChoice } from './toolbar'
import './surface.css'

/** `GET /__kubuno_design__/project.json` (dev-server mode). */
export interface ProjectInfo {
  root: string
  hostRegistry: string
  registries: { path: string; text: string }[]
  userControls: UserControlInfo[]
  viewsAbi: number
  compiler: string
  themes?: string[]
  /** Project modules imported before the first render (`design.setup`: the project's stylesheet, translations). */
  setup?: string[]
}

export interface SurfaceConfig {
  readonly mode: 'project' | 'bundled'
  /** `@kubuno/ui`'s version (the host's elements). */
  readonly uiVersion: string
  /** `@kubuno/host-runtime`'s version when the page is that package's build. */
  readonly hostRuntime: string | null
  readonly wasmUrl: string
  /** Where `<id>/theme.json` of the Kubuno themes are served. */
  readonly themesBase: string
  /** The device form factor the host is editing for (`mobile`: the viewport shows a device frame, not a web page,
   *  and the responsive-width presets are hidden). Set from the `?ff=` query of the bundled host URL. */
  readonly formFactor?: 'mobile' | null
  /** Dev-server mode: the project description. */
  readonly loadProject?: () => Promise<ProjectInfo>
  /** Bundled mode: the host registry's text. */
  readonly hostRegistry?: string
  /** Dev-server mode: imports a project module through the dev server. */
  readonly importModule?: (specifier: string) => Promise<Record<string, unknown>>
}

const HOST_SPECIFIERS = new Set(['@ui', '@kubuno/sdk', '@kubuno/drive', '@kubuno/views', 'lucide-react'])
const PREFS_KEY = 'kubuno.designer.viewport.v1'
const DEFAULT_WIDTH = 800

interface Prefs {
  width: WidthChoice
  theme: KubunoThemeMode
  lang: string | null
  device: DeviceChoice
  landscape: boolean
}

function readPrefs(): Prefs {
  const fallback: Prefs = { width: 'design', theme: 'light', lang: null, device: null, landscape: false }
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return fallback
    const p = JSON.parse(raw) as Partial<Prefs>
    return {
      width: p.width === 'fit' || p.width === 'design' || (typeof p.width === 'number' && p.width > 0) ? p.width : 'design',
      theme: p.theme === 'dark' ? 'dark' : 'light',
      lang: typeof p.lang === 'string' && (DESIGN_LANGUAGES as readonly string[]).includes(p.lang) ? p.lang : null,
      device: p.device === 'phone' || p.device === 'tablet' ? p.device : null,
      landscape: p.landscape === true,
    }
  } catch {
    return fallback
  }
}

function writePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

const stemOf = (file: string): string => (file.split('/').pop() ?? file).replace(/\.(kbview|kbcontrol)$/i, '')
class Boundary extends Component<{ children?: ReactNode; onError: (e: Error) => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError(error)
  }
  render(): ReactNode {
    if (this.state.error) return createElement('div', { className: 'kbd-frame-error' }, `La vue n'a pas pu être affichée :\n${this.state.error.message}`)
    return this.props.children
  }
}

type Drag =
  | { kind: 'move'; ids: string[]; x: number; y: number; dx: number; dy: number; confirmed: boolean }
  | { kind: 'resize'; id: string; handle: Handle; x: number; y: number; before: Rect; after: Rect; confirmed: true }
  | { kind: 'reorder'; id: string; x: number; y: number; confirmed: boolean; target: DropTarget | null }

export class DesignSurface {
  private readonly channel: Channel
  private ready = false
  private readonly queue: HostMessage[] = []

  // DOM
  private readonly toolbar: ReturnType<typeof createToolbar>
  private readonly canvas: HTMLElement
  private readonly stage: HTMLElement
  private readonly zoomBox: HTMLElement
  private readonly frame: HTMLElement
  private readonly overlay: HTMLElement
  private readonly root: Root
  private readonly queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  // Project
  private compiler: ViewCompiler | null = null
  private registryTexts: string[] = []
  private projectComponents: ComponentEntry[] | null = null
  private projectUserControls: UserControlInfo[] = []
  private projectLoaded = false
  private catalog = new Catalog([])
  private readonly loadedModules = new Map<string, 'real' | 'placeholder'>()

  // Document
  private doc: DocumentInfo | null = null
  private text: string | null = null
  private plan: ViewPlan | null = null
  private nodes: Map<string, NodeInfo> = new Map()
  /** Element id → `x:Name`, from the plan (its `names` is the reverse map). */
  private names: Map<string, string> = new Map()
  private stale = false
  private generation = 0
  private codeBehind: { module: string; cls: ViewClass } | null = null
  private designCls: ViewClass | null = null
  private designBase: ViewClass | null = null
  private viewKey = 0

  // Surface state
  private designOn = true
  private selection: string[] = []
  private hover: string | null = null
  private map: LayoutMap = makeLayoutMap([])
  private containerOutlines = true
  private zoomPref = 1
  // An explicit zoom (the toolbar's Zoom menu or Ctrl+wheel) wins everywhere, including a device frame
  // (which otherwise fits the pane). Reset when the device changes, so switching device fits again.
  private zoomExplicit = false
  private prefs: Prefs = readPrefs()
  private langChosen: boolean
  private drag: Drag | null = null
  private dropFeedback: DropTarget | null = null
  private hostDrag: string | null = null
  private dragDetected = false
  private previews: { el: HTMLElement; translate: string }[] = []
  private previewTimer: ReturnType<typeof setTimeout> | null = null
  private mapScheduled = false
  private editing = false

  constructor(private readonly config: SurfaceConfig) {
    this.channel = openChannel(window)
    this.langChosen = this.prefs.lang !== null
    // A mobile view opens as a device straight away (a phone frame, not a responsive page), unless the viewer already
    // chose a device for it.
    if (config.formFactor === 'mobile' && this.prefs.device === null) this.prefs = { ...this.prefs, device: 'phone' }
    this.channel.post({
      type: 'surfaceInfo', version: 1, target: 'web', views: '1', ui: config.uiVersion,
      hostRuntime: config.hostRuntime, mode: config.mode,
    })
    this.channel.listen((m) => (this.ready ? this.handle(m) : void this.queue.push(m)))

    const d = document
    d.documentElement.classList.add('kbd-page')
    this.toolbar = createToolbar(d, DESIGN_LANGUAGES, {
      width: (w) => this.setWidth(w, true),
      theme: (t) => void this.setTheme(t, true),
      lang: (l) => this.setLanguage(l, true),
      design: (on) => this.setDesignMode(on, true),
      device: (d) => this.setDevice(d, true),
      rotate: () => this.rotateDevice(true),
    }, { mobile: config.formFactor === 'mobile' })
    this.canvas = d.createElement('div')
    this.canvas.className = 'kbd-canvas'
    this.stage = d.createElement('div')
    this.stage.className = 'kbd-stage'
    this.zoomBox = d.createElement('div')
    this.zoomBox.className = 'kbd-zoom'
    this.frame = d.createElement('div')
    this.frame.className = 'kbd-frame'
    this.frame.setAttribute('data-kb-frame', '')
    this.overlay = d.createElement('div')
    this.overlay.className = 'kbd-overlay'
    this.overlay.tabIndex = 0
    this.overlay.setAttribute('aria-label', 'Surface de conception')
    this.overlay.dataset.design = 'true'
    this.zoomBox.appendChild(this.frame)
    this.stage.appendChild(this.zoomBox)
    this.canvas.appendChild(this.stage)
    const host = d.getElementById('kb-design') ?? d.body
    host.append(this.toolbar.el, this.canvas, this.overlay)
    this.root = createRoot(this.frame)
    this.wireDom()
    this.applyLanguage(this.prefs.lang ?? (DESIGN_LANGUAGES as readonly string[]).find((l) => i18n.language?.startsWith(l)) ?? 'fr')
    this.layoutOverlay()
    this.refreshToolbar()
    this.renderView()
  }

  // ── Start ──

  async start(): Promise<void> {
    try {
      if (this.config.loadProject) {
        try {
          const p = await this.config.loadProject()
          this.registryTexts = [p.hostRegistry, ...p.registries.map((r) => r.text)]
          this.projectUserControls = p.userControls
          this.projectLoaded = true
          await this.importSetup(p.setup ?? [])
        } catch (err) {
          this.log(`project.json unavailable (${(err as Error).message}): host elements only`)
        }
      }
      if (!this.projectLoaded && this.config.hostRegistry) this.registryTexts = [this.config.hostRegistry]
      await this.setTheme(this.prefs.theme, false)
      await this.openCompiler()
    } catch (err) {
      const e = err as Error
      this.channel.post({ type: 'surfaceError', message: e.message || String(e), line: 0, column: 0 })
      this.showMessage(`Le concepteur n'a pas pu démarrer :\n${e.message || String(e)}`, true)
    }
    this.ready = true
    this.channel.post({ type: 'ready' })
    this.channel.post({ type: 'focusState', editing: false })
    for (const m of this.queue.splice(0)) this.handle(m)
  }

  /** Imports the project's setup modules in order; one that fails is logged and the others still load. */
  private async importSetup(setup: readonly string[]): Promise<void> {
    if (!this.config.importModule) return
    for (const spec of setup) {
      try {
        await this.config.importModule(spec)
      } catch (err) {
        this.log(`setup module ${spec} not loaded (${(err as Error).message})`)
      }
    }
  }

  private userControls(): UserControlInfo[] {
    return this.doc?.userControls.length ? this.doc.userControls : this.projectUserControls
  }

  /** (Re)opens a compiler session over the current registries and user controls. */
  private async openCompiler(): Promise<void> {
    const texts = [...this.registryTexts]
    if (!this.projectLoaded && this.projectComponents) {
      // The host's list may carry the user controls too (the language server's registry): they are declared once,
      // through setUserControls below, never as registry entries as well.
      const userControls = new Set(this.userControls().map((u) => u.name))
      const components = this.projectComponents.filter((c) => !userControls.has(String((c as { name?: unknown }).name)))
      texts.push(JSON.stringify({ schema: 1, target: 'web', version: 'project', components }))
    }
    const compiler = await loadBrowserCompiler(this.config.wasmUrl)
    texts.forEach((t, k) => compiler.addRegistry(t, k === 0 ? 'host' : `project-${k}`, k === 0))
    compiler.setUserControls(this.userControls())
    this.compiler?.dispose()
    this.compiler = compiler
    this.catalog = Catalog.fromTexts(texts, this.userControls())
  }

  // ── Host messages ──

  private handle(m: HostMessage): void {
    switch (m.type) {
      case 'setDocumentInfo': {
        const prev = this.doc
        this.doc = { file: m.file, codeBehind: m.codeBehind, className: m.className, userControls: m.userControls, designData: m.designData }
        const ucChanged = JSON.stringify(prev?.userControls ?? []) !== JSON.stringify(m.userControls)
        if (prev?.file !== m.file || prev?.codeBehind !== m.codeBehind || prev?.className !== m.className) {
          this.codeBehind = null
          this.designCls = null
        }
        void (ucChanged ? this.openCompiler() : Promise.resolve()).then(() => this.update())
        break
      }
      case 'projectComponents':
        this.projectComponents = m.components
        if (!this.projectLoaded) void this.openCompiler().then(() => this.update())
        break
      case 'setHostRegistry': {
        // Bundled mode: compile with the project's own `@kubuno/ui` registry (the one `kbview-tsc` uses).
        const texts = withHostRegistry(this.registryTexts, this.projectLoaded, m.text)
        if (texts) {
          this.registryTexts = texts
          this.log('host registry: the project\'s (sent by the designer)')
          void this.openCompiler().then(() => this.update())
        }
        break
      }
      case 'setText':
        this.text = m.text
        void this.update()
        break
      case 'setDesignMode':
        this.setDesignMode(m.on, false)
        break
      case 'select':
        this.selection = m.id === null ? [] : [m.id]
        this.redraw()
        break
      case 'selectMany': {
        const primary = m.primary !== null && m.ids.includes(m.primary) ? m.primary : m.ids[0]
        this.selection = primary === undefined ? [] : [primary, ...m.ids.filter((id) => id !== primary)]
        this.redraw()
        break
      }
      case 'setDesignOptions':
        this.containerOutlines = m.containerOutlines
        this.redraw()
        break
      case 'setCanvasBackground':
        this.canvas.style.setProperty('--kbd-canvas-bg', m.color)
        break
      case 'setVsTheme':
        document.documentElement.dataset.vsTheme = m.mode
        for (const [k, v] of Object.entries(m.colors)) document.documentElement.style.setProperty(`--vs-${k}`, v)
        break
      case 'setZoom':
        this.zoomPref = m.zoom
        this.zoomExplicit = m.zoom > 0
        this.applyFrameSize()
        break
      case 'setResources': {
        const lang = languageOfCulture(m.culture, DESIGN_LANGUAGES)
        if (lang && !this.langChosen) this.applyLanguage(lang)
        break
      }
      case 'format':
        this.log(`format ${m.command}: not supported on the web surface yet`)
        break
      case 'dragEnter':
        this.hostDrag = m.component
        this.dragDetected = false
        break
      case 'dragOver': {
        if (this.hostDrag === null) break
        const t = this.dropTargetAt({ kind: 'new', component: this.hostDrag }, m.x, m.y)
        this.showDrop(t)
        this.channel.post({ type: 'dropTargetChanged', target: t ? this.wireTarget(t) : null })
        break
      }
      case 'drop': {
        if (this.hostDrag !== null) this.dropNew(this.hostDrag, m.x, m.y)
        this.endToolboxDrag()
        break
      }
      case 'dragLeave':
        this.endToolboxDrag()
        break
      case 'setViewport':
        this.setWidth(m.width, false)
        break
      case 'setKubunoTheme':
        void this.setTheme(m.mode, false)
        break
      case 'setLanguage': {
        const lang = languageOfCulture(m.lang, DESIGN_LANGUAGES)
        if (lang) this.applyLanguage(lang)
        break
      }
    }
  }

  private post(m: PageMessage): void {
    this.channel.post(m)
  }

  private log(message: string): void {
    this.post({ type: 'log', message })
  }

  // ── Compile and render ──

  private async update(): Promise<void> {
    const gen = ++this.generation
    if (!this.compiler || this.text === null) return
    const text = this.text.replace(/^﻿/, '')
    if (text.trim() === '') {
      this.plan = null
      this.nodes = new Map()
      this.names = new Map()
      this.designCls = null
      this.stale = false
      this.renderView()
      this.post({ type: 'renderStatus', state: 'empty', diagnostics: [] })
      return
    }
    const file = this.doc?.file || 'view.kbview'
    let out: CompileOutput
    try {
      out = this.compiler.compile(text, { file, code_behind: this.doc?.codeBehind ?? null, class_name: this.doc?.className ?? null, design: true })
    } catch (err) {
      this.stale = true
      this.frame.dataset.stale = 'true'
      this.post({ type: 'renderStatus', state: 'stale', diagnostics: [{ line: 1, column: 1, endLine: 1, endColumn: 1, message: (err as Error).message, code: 'compiler', syntax: false }] })
      return
    }
    const diagnostics = out.diagnostics.filter((d) => d.severity !== 'info').map(wireDiagnostic)
    const errors = out.diagnostics.some((d) => d.severity === 'error')
    // Errors: the last good plan stays (a first, broken text still shows what compiled of it).
    const next = out.plan && (!errors || !this.plan) ? (out.plan as unknown as ViewPlan) : null
    if (next) {
      await this.loadModules(next)
      await this.loadCodeBehind()
      if (gen !== this.generation) return
      this.show(next)
    }
    if (gen !== this.generation) return
    this.stale = errors
    this.frame.dataset.stale = String(errors)
    this.post({ type: 'renderStatus', state: errors ? 'stale' : this.plan ? 'clean' : 'empty', diagnostics })
  }

  /** Registers every project module the plan names (imported, or a placeholder). */
  private async loadModules(plan: ViewPlan): Promise<void> {
    for (const [spec, exports] of planModules(plan)) {
      if (HOST_SPECIFIERS.has(spec)) continue
      let mod: Record<string, unknown> | null = null
      let reason = this.config.mode === 'bundled' ? 'Runtime intégré : contrôle du projet non chargé' : ''
      // Project modules are project-root-relative (`/src/x`) once the registry is read from the project; entries
      // received with `projectComponents` keep their registry-relative `./x` and are never imported.
      if (this.loadedModules.get(spec) !== 'real' && this.config.importModule && spec.startsWith('/')) {
        try {
          mod = await this.config.importModule(spec)
          registerElements(spec, mod)
          this.loadedModules.set(spec, 'real')
        } catch (err) {
          reason = `Échec du chargement de ${spec} : ${(err as Error).message}`
          this.log(reason)
        }
      }
      if (this.loadedModules.get(spec) === 'real') continue
      const placeholders: Record<string, unknown> = {}
      for (const x of exports) placeholders[x] = makePlaceholder(this.elementName(spec, x), reason || `${spec} (${x})`)
      registerElements(spec, placeholders)
      this.loadedModules.set(spec, 'placeholder')
    }
  }

  private elementName(spec: string, exp: string): string {
    const uc = this.userControls().find((u) => u.module === spec)
    if (uc && exp === 'default') return uc.name
    return exp === 'default' ? stemOf(spec) : exp
  }

  /** Dev-server mode: the code-behind class of the document (its latest version after an HMR update). */
  private async loadCodeBehind(): Promise<void> {
    const doc = this.doc
    if (!doc?.codeBehind || !this.config.importModule) {
      this.codeBehind = null
      return
    }
    const module = moduleOfCodeBehind(doc.file, doc.codeBehind)
    if (this.codeBehind?.module === module) {
      const latest = this.codeBehind.cls[CELL]?.latest
      if (latest && latest !== this.codeBehind.cls) this.codeBehind = { module, cls: latest }
      return
    }
    try {
      const mod = await this.config.importModule(module)
      const cls = mod[doc.className || stemOf(doc.file)] as ViewClass | undefined
      if (typeof cls !== 'function' || !cls[CELL]) throw new Error(`${module} exports no view class '${doc.className || stemOf(doc.file)}'`)
      this.codeBehind = { module, cls: cls[CELL]?.latest ?? cls }
    } catch (err) {
      this.codeBehind = null
      this.log(`code-behind not loaded (${(err as Error).message}): the view is shown without it`)
    }
  }

  /** The modules of the document changed on disk (Vite HMR): pick up the latest code-behind / controls. */
  async modulesUpdated(paths: readonly string[]): Promise<void> {
    let relevant = false
    for (const p of paths) {
      const spec = p.split('?')[0].replace(/\.(tsx?|jsx?)$/, '')
      if (this.codeBehind && spec === this.codeBehind.module) relevant = true
      if (this.loadedModules.has(spec)) relevant = true
    }
    if (!relevant) return
    // Fast Refresh patches the controls in place; the code-behind gets a new class: rebuild the design class.
    await this.loadCodeBehind()
    if (this.plan) this.show(this.plan)
  }

  private dataContextFor(base: ViewClass | null, data: DesignData | null | undefined): unknown {
    if (data?.dataContext !== undefined) return data.dataContext
    // Without a code-behind the bindings have no getters: the sample props stand in as the data context.
    return base ? undefined : data?.props
  }

  private show(plan: ViewPlan): void {
    const base = this.codeBehind?.cls ?? null
    if (!this.designCls || this.designBase !== base) {
      this.designCls = designClass(plan, base)
      this.designBase = base
      this.viewKey++
    } else {
      setDesignPlan(this.designCls, plan)
    }
    setDesignDataContext(this.designCls, this.dataContextFor(base, this.doc?.designData))
    this.plan = plan
    this.nodes = indexPlan(plan)
    this.names = new Map(Object.entries(plan.names).map(([name, id]) => [id, name]))
    this.clearPreviews()
    this.applyFrameSize()
    this.refreshToolbar()
    this.renderView()
  }

  private renderView(): void {
    let content: ReactNode
    if (this.designCls) {
      const props = this.doc?.designData?.props ?? {}
      content = createElement(Boundary, { key: this.viewKey, onError: (e) => this.log(`render error: ${e.message}`) },
        createElement(KbView, { ...props, key: this.viewKey, view: this.designCls, design: this.designOn }))
    } else {
      content = createElement('div', { className: 'kbd-frame-empty' }, this.text === null ? 'En attente de la vue…' : 'La vue est vide.')
    }
    this.root.render(
      createElement(QueryClientProvider, { client: this.queryClient },
        createElement(MemoryRouter, null, content)),
    )
    this.scheduleMap()
  }

  private showMessage(text: string, error: boolean): void {
    this.root.render(createElement('div', { className: error ? 'kbd-frame-error' : 'kbd-frame-empty' }, text))
  }

  // ── Viewport: width, height, zoom, theme, language ──

  private designSize(): [number | null, number | null] {
    const s = this.plan?.design_size
    return [s?.[0] ?? null, s?.[1] ?? null]
  }

  /** The device frame's size (oriented), or null when the view is shown as a responsive page. */
  private deviceSize(): [number, number] | null {
    if (!this.prefs.device) return null
    const f = DEVICE_FRAMES[this.prefs.device]
    return this.prefs.landscape ? [f.h, f.w] : [f.w, f.h]
  }

  private frameWidth(): number {
    const device = this.deviceSize()
    if (device) return device[0]
    const [dw] = this.designSize()
    const w = this.prefs.width
    if (w === 'fit') return Math.max(240, this.canvas.clientWidth - 64)
    if (w === 'design') return dw ?? DEFAULT_WIDTH
    return w
  }

  private zoom(): number {
    // An explicit zoom (the Zoom menu or Ctrl+wheel) wins everywhere. Otherwise a device frame fits the pane
    // (it is tall - 844 px for a phone - so a fixed 100 % would overflow), and a responsive page honours the
    // chosen zoom, falling back to fit-to-pane when none is set (zoomPref 0).
    if (this.zoomExplicit && this.zoomPref > 0) return this.zoomPref
    if (this.zoomPref > 0 && !this.prefs.device) return this.zoomPref
    const w = this.frameWidth()
    const h = this.frame.offsetHeight || 1
    return Math.max(0.1, Math.min(1, (this.canvas.clientWidth - 64) / w, (this.canvas.clientHeight - 64) / h))
  }

  private applyFrameSize(): void {
    const device = this.deviceSize()
    const [, dh] = this.designSize()
    const w = this.frameWidth()
    this.frame.style.width = `${w}px`
    // A device frame fixes the height to the device (phone/tablet proportions); otherwise DesignHeight when the view
    // declares one, else the height follows the content (a responsive page).
    const fixedHeight = device ? device[1] : dh;
    if (fixedHeight) {
      this.frame.style.height = `${fixedHeight}px`
      this.frame.dataset.autoHeight = 'false'
    } else {
      this.frame.style.height = ''
      this.frame.dataset.autoHeight = 'true'
    }
    this.frame.dataset.device = device ? 'true' : 'false'
    // A device frame sits on a neutral stage (not the white page canvas), so the empty space around a narrow phone
    // reads as a backdrop rather than unused page.
    this.canvas.dataset.device = device ? 'true' : 'false'
    this.canvas.dataset.document = designDocumentKind(this.doc?.file, this.plan)
    const chrome = this.doc?.designData?.frame
    const isControl = this.plan?.kind === 'control'
    this.frame.style.background = chrome?.background ? tokenColor(chrome.background) : (isControl ? 'var(--color-surface-0)' : 'var(--body-bg, var(--color-surface-0))')
    this.frame.style.borderRadius = chrome?.cornerRadius ? `${chrome.cornerRadius}px` : ''
    this.frame.style.border = chrome?.border ? '1px solid var(--color-border)' : ''
    const z = this.zoom()
    this.frame.style.transform = z === 1 ? '' : `scale(${z})`
    this.zoomBox.style.width = `${w * z}px`
    this.zoomBox.style.height = `${(this.frame.offsetHeight || dh || 0) * z}px`
    this.refreshToolbar()
    this.scheduleMap()
  }

  private setWidth(w: WidthChoice, fromToolbar: boolean): void {
    this.prefs = { ...this.prefs, width: w }
    writePrefs(this.prefs)
    this.applyFrameSize()
    if (fromToolbar) this.viewportChanged()
  }

  private setDevice(d: DeviceChoice, fromToolbar: boolean): void {
    this.prefs = { ...this.prefs, device: d }
    writePrefs(this.prefs)
    // Changing the device fits the new frame to the pane again (drop any Ctrl+wheel / menu zoom).
    this.zoomExplicit = false
    this.applyFrameSize()
    if (fromToolbar) this.viewportChanged()
  }

  private rotateDevice(fromToolbar: boolean): void {
    if (!this.prefs.device) return
    this.prefs = { ...this.prefs, landscape: !this.prefs.landscape }
    writePrefs(this.prefs)
    this.applyFrameSize()
    if (fromToolbar) this.viewportChanged()
  }

  private async setTheme(t: KubunoThemeMode, fromToolbar: boolean): Promise<void> {
    this.prefs = { ...this.prefs, theme: t }
    writePrefs(this.prefs)
    this.refreshToolbar()
    const ok = await applyKubunoTheme(this.config.themesBase, t)
    if (!ok) this.log(`theme ${t} not available at ${this.config.themesBase}`)
    this.scheduleMap()
    if (fromToolbar) this.viewportChanged()
  }

  private applyLanguage(lang: string): void {
    void i18n.changeLanguage(lang)
    this.frame.dir = RTL_LANGUAGES.has(lang) ? 'rtl' : 'ltr'
    this.frame.lang = lang
    this.prefs = { ...this.prefs, lang: this.langChosen ? lang : this.prefs.lang }
    this.refreshToolbar()
    this.scheduleMap()
  }

  private setLanguage(lang: string, fromToolbar: boolean): void {
    if (fromToolbar) this.langChosen = true
    this.applyLanguage(lang)
    this.prefs = { ...this.prefs, lang }
    writePrefs(this.prefs)
    if (fromToolbar) this.viewportChanged()
  }

  private setDesignMode(on: boolean, fromToolbar: boolean): void {
    if (this.designOn === on) return
    this.designOn = on
    this.overlay.dataset.design = String(on)
    this.cancelDrag()
    this.hover = null
    this.renderView()
    this.refreshToolbar()
    this.post({ type: 'focusState', editing: on ? false : this.editing })
    if (on) this.overlay.focus({ preventScroll: true })
    if (fromToolbar) this.viewportChanged()
  }

  private currentLang(): string {
    return this.frame.lang || 'fr'
  }

  private viewportChanged(): void {
    this.post({ type: 'viewportChanged', width: this.frameWidth(), theme: this.prefs.theme, lang: this.currentLang(), mode: this.designOn ? 'design' : 'run' })
  }

  private refreshToolbar(): void {
    const data = this.doc?.designData
    const hasDesignValues = [...this.nodes.values()].some((n) => n.node.design?.length)
    const sample = !!data || hasDesignValues
    const s: ToolbarState = {
      width: this.prefs.width,
      designWidth: this.designSize()[0] ?? DEFAULT_WIDTH,
      theme: this.prefs.theme,
      lang: this.currentLang(),
      design: this.designOn,
      device: this.prefs.device,
      landscape: this.prefs.landscape,
      sample,
      sampleTitle: sample
        ? `Données d'exemple : ${data ? `${stemOf(this.doc?.file ?? '')}.design.json` : ''}${data && hasDesignValues ? ' + ' : ''}${hasDesignValues ? 'attributs d:' : ''}`
        : "Pas de données d'exemple (ajoutez <vue>.design.json ou des attributs d:)",
      zoom: this.ready || this.plan ? this.zoom() : 1,
      note: this.config.mode === 'bundled' ? 'Runtime intégré : les contrôles du projet sont des espaces réservés' : null,
    }
    this.toolbar.update(s)
  }

  // ── Layout map and adorners ──

  private layoutOverlay(): void {
    const r = this.canvas.getBoundingClientRect()
    const o = this.overlay.style
    o.left = `${r.left}px`
    o.top = `${r.top}px`
    o.width = `${this.canvas.clientWidth}px`
    o.height = `${this.canvas.clientHeight}px`
  }

  private scheduleMap(): void {
    if (this.mapScheduled) return
    this.mapScheduled = true
    requestAnimationFrame(() => {
      this.mapScheduled = false
      this.rebuildMap()
    })
  }

  private rebuildMap(): void {
    const z = this.zoom()
    const h = this.frame.offsetHeight
    const zoomBoxHeight = `${h * z}px`
    if (this.zoomBox.style.height !== zoomBoxHeight) this.zoomBox.style.height = zoomBoxHeight
    this.layoutOverlay()
    if (!this.designOn) {
      this.map = makeLayoutMap([])
      return
    }
    const isContainer = (id: string): boolean => {
      const n = this.nodes.get(id)
      const c = n ? this.catalog.get(n.el) : undefined
      return !!c && c.children !== 'None'
    }
    this.map = buildLayoutMap(document, domMeasures(window), isContainer)
    this.redraw()
  }

  private placement(id: string): Placement {
    const n = this.nodes.get(id)?.node
    return { X: literalNumber(n, 'X'), Y: literalNumber(n, 'Y'), Width: literalNumber(n, 'Width'), Height: literalNumber(n, 'Height') }
  }

  private isRtl(id: string): boolean {
    return this.map.byId.get(id)?.[0]?.rtl ?? this.frame.dir === 'rtl'
  }

  private absolute(id: string): boolean {
    return isAbsoluteChild(this.nodes, this.catalog, id)
  }

  /** The part of an element its clipping ancestors leave visible (adorners are drawn around it), `null` when none. */
  private shown(id: string): Rect | null {
    const e = this.map.byId.get(id)?.[0]
    return e ? visibleRect(e) : null
  }

  private resizable(id: string): Set<Handle> {
    if (id === '') return new Set()
    return resizableHandles(this.absolute(id), this.placement(id), this.isRtl(id))
  }

  /** The identity shown on a control's corner tag: its element type and `x:Name` (the root is named for its kind). */
  private labelFor(id: string): Label {
    if (id === '') return { type: this.plan?.kind === 'control' ? 'UserControl' : 'View' }
    const n = this.nodes.get(id)
    if (!n) return { type: id }
    return { type: n.el, name: n.node.name ?? this.names.get(id) }
  }

  private redraw(): void {
    if (!this.designOn) return
    const origin = this.overlay.getBoundingClientRect()
    const outlines: OutlineAdorner[] = []
    if (this.containerOutlines) {
      for (const e of this.map.entries) {
        const v = e.bare && e.id !== '' ? visibleRect(e) : null
        if (v) outlines.push({ rect: v, depth: e.id.split('.').length })
      }
    }
    const selected: SelectedAdorner[] = []
    this.selection.forEach((id, k) => {
      const b = this.shown(id)
      if (b) selected.push({ bounds: b, primary: k === 0, resizable: this.resizable(id), label: this.labelFor(id) })
    })
    const primary = this.selection[0]
    const parentId = primary !== undefined ? parentIdOf(primary) : null
    const parentRect = parentId !== null && parentId !== '' ? this.shown(parentId) : null
    const parent = parentRect && parentId !== null ? { rect: parentRect, label: this.labelFor(parentId) } : null
    const hoverId = this.hover
    const hoverRect = hoverId !== null && hoverId !== '' && !this.selection.includes(hoverId) ? this.shown(hoverId) : null
    const hover = hoverRect && hoverId !== null ? { rect: hoverRect, label: this.labelFor(hoverId) } : null
    const d = this.drag
    let ghost: Rect | null = null
    let tip: { x: number; y: number; text: string } | null = null
    if (d?.kind === 'resize') {
      ghost = d.after
      const z = this.zoom()
      tip = { x: d.after.right, y: d.after.bottom, text: `${Math.round((d.after.right - d.after.left) / z)} × ${Math.round((d.after.bottom - d.after.top) / z)}` }
    }
    const fb = this.dropFeedback
    drawAdorners(this.overlay, origin, {
      outlines,
      hover,
      parent,
      selected,
      marker: fb ? { rect: fb.marker, kind: fb.markerKind, valid: fb.valid } : null,
      band: fb?.band ?? null,
      ghost,
      tip,
    })
  }

  // ── Selection ──

  private postSelection(): void {
    const primary = this.selection[0]
    const b = primary !== undefined ? boundsOf(this.map, primary) : null
    this.post({
      type: 'selectionChanged',
      id: primary ?? null,
      ids: [...this.selection],
      bounds: b ? { x: Math.round(b.left * 100) / 100, y: Math.round(b.top * 100) / 100, width: Math.round((b.right - b.left) * 100) / 100, height: Math.round((b.bottom - b.top) * 100) / 100 } : null,
    })
  }

  /** The element under a page point: the deepest `[data-kb-id]`, the view itself (`""`) over the canvas. */
  private elementAt(x: number, y: number): string | null {
    const hit = hitTest(this.map, x, y)
    if (hit) return hit.id
    if (!this.plan) return null
    const canvas = this.canvas.getBoundingClientRect()
    return contains(rect(canvas.left, canvas.top, canvas.right, canvas.bottom), x, y) ? '' : null
  }

  private select(id: string | null, mods: { ctrl: boolean; shift: boolean }): void {
    if (id === null) {
      this.selection = []
      return
    }
    const has = this.selection.includes(id)
    if (id === '' || this.selection[0] === '') {
      // The view itself is never part of a multi-selection.
      this.selection = [id]
    } else if (mods.ctrl) {
      this.selection = has ? this.selection.filter((s) => s !== id) : [id, ...this.selection]
    } else if (mods.shift) {
      this.selection = [id, ...this.selection.filter((s) => s !== id)]
    } else {
      this.selection = has ? [id, ...this.selection.filter((s) => s !== id)] : [id]
    }
  }

  // ── Input ──

  private dropContext(): DropContext {
    const f = this.frame.getBoundingClientRect()
    return { map: this.map, nodes: this.nodes, catalog: this.catalog, zoom: this.zoom(), frame: rect(f.left, f.top, f.right, f.bottom) }
  }

  private dropTargetAt(subject: DragSubject, x: number, y: number): DropTarget | null {
    if (!this.designOn || !this.plan) return null
    return computeDropTarget(this.dropContext(), subject, x, y)
  }

  private wireTarget(t: DropTarget): { valid: boolean; parentId: string; index: number; marker: ReturnType<typeof wireRect>; xy?: [number, number] } {
    return { valid: t.valid, parentId: t.parentId, index: t.index, marker: wireRect(t.marker), ...(t.xy ? { xy: [t.xy[0], t.xy[1]] as [number, number] } : {}) }
  }

  private showDrop(t: DropTarget | null): void {
    this.dropFeedback = t
    this.redraw()
  }

  private dropNew(component: string, x: number, y: number): void {
    const t = this.dropTargetAt({ kind: 'new', component }, x, y)
    if (!t || !t.valid) return
    const info = this.catalog.get(component)
    const xml = skeletonXml(component, t.xy ?? null, dropSize(this.catalog, component), info?.nonVisual ?? false)
    this.post(insertMessage(t.parentId, t.index, xml))
  }

  private endToolboxDrag(): void {
    const was = this.hostDrag !== null || this.dropFeedback !== null
    this.hostDrag = null
    this.dragDetected = false
    this.showDrop(null)
    if (was) this.post({ type: 'dropTargetChanged', target: null })
  }

  private wireDom(): void {
    const ov = this.overlay
    ov.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    ov.addEventListener('pointermove', (e) => this.onPointerMove(e))
    ov.addEventListener('pointerup', (e) => this.onPointerUp(e))
    ov.addEventListener('pointercancel', () => this.cancelDrag())
    ov.addEventListener('pointerleave', () => {
      if (!this.drag && this.hover !== null) {
        this.hover = null
        this.redraw()
      }
    })
    ov.addEventListener('dblclick', (e) => {
      const id = this.elementAt(e.clientX, e.clientY)
      if (id !== null) this.post({ type: 'doubleClick', elementId: id })
    })
    ov.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const id = this.elementAt(e.clientX, e.clientY)
      if (id !== null && !this.selection.includes(id)) {
        this.selection = [id]
        this.redraw()
      }
      this.postSelection()
      this.post({ type: 'contextMenu', x: e.clientX, y: e.clientY, screenX: 0, screenY: 0, elementId: id })
    })
    ov.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })

    // Toolbox drags (WEB-VIEWS §11 "Hybrid"): Chromium only detects the drag; the host then drives it.
    const hasText = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('text/plain')
    document.addEventListener('dragenter', (e) => {
      if (!hasText(e) || !this.designOn) return
      e.preventDefault()
      if (!this.dragDetected) {
        this.dragDetected = true
        this.post({ type: 'toolboxDragDetected' })
      }
    })
    document.addEventListener('dragover', (e) => {
      if (!hasText(e) || !this.designOn) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      // The fallback HTML5 drag: the item is only readable at drop time.
      if (this.hostDrag === null) this.showDrop(this.dropTargetAt({ kind: 'new', component: null }, e.clientX, e.clientY))
    })
    document.addEventListener('dragleave', (e) => {
      if (this.hostDrag !== null) return
      if (e.relatedTarget === null && (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight)) {
        this.dragDetected = false
        this.showDrop(null)
      }
    })
    document.addEventListener('drop', (e) => {
      if (!hasText(e) || !this.designOn) return
      e.preventDefault()
      const name = toolboxComponentOf(e.dataTransfer?.getData('text/plain') ?? '')
      if (name && this.hostDrag === null) this.dropNew(name, e.clientX, e.clientY)
      this.dragDetected = false
      this.showDrop(null)
    })

    // Run mode: the page reports whether one of its text editors has the focus (key routing, WV-9a Q1).
    const editable = (el: Element | null): boolean =>
      !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable)
    const focusChanged = (): void => {
      const now = !this.designOn && editable(document.activeElement)
      if (now !== this.editing) {
        this.editing = now
        this.post({ type: 'focusState', editing: now })
      }
    }
    document.addEventListener('focusin', focusChanged)
    document.addEventListener('focusout', () => setTimeout(focusChanged, 0))

    // Design mode: every key of the page is the surface's (the overlay has the focus; a key typed before any click
    // reaches the body). Run mode: keys outside the view's editors still go to the host's routing.
    document.addEventListener('keydown', (e) => {
      if (e.target instanceof Node && this.toolbar.el.contains(e.target)) return
      if (this.designOn) {
        this.onKeyDown(e)
        return
      }
      if (e.defaultPrevented || editable(document.activeElement)) return
      if (e.ctrlKey || e.altKey || /^F\d+$/.test(e.key)) this.post({ type: 'unhandledKey', key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey })
    }, true)

    // The layout map follows commits, sizes and scrolling.
    const mo = new MutationObserver((records) => {
      if (records.some((r) => !this.overlay.contains(r.target) && !this.toolbar.el.contains(r.target))) this.scheduleMap()
    })
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    const ro = new ResizeObserver(() => {
      if (this.zoomPref === 0 || this.prefs.width === 'fit' || this.prefs.device) this.applyFrameSize()
      this.scheduleMap()
    })
    ro.observe(this.frame)
    ro.observe(this.canvas)
    document.addEventListener('scroll', () => this.scheduleMap(), true)
    window.addEventListener('resize', () => this.scheduleMap())
    void document.fonts?.ready.then(() => this.scheduleMap())
    window.addEventListener('error', (e) => this.log(`page error: ${e.message}`))
    window.addEventListener('unhandledrejection', (e) => this.log(`page error: ${String((e.reason as Error)?.message ?? e.reason)}`))
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.designOn || e.button !== 0) return
    this.overlay.focus({ preventScroll: true })
    this.overlay.setPointerCapture?.(e.pointerId)
    const x = e.clientX
    const y = e.clientY
    const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }
    const primary = this.selection[0]
    if (primary !== undefined && primary !== '' && !mods.ctrl) {
      const b = this.shown(primary)
      const h = b ? handleAt(selectionFrame(b), x, y) : null
      if (b && h && this.resizable(primary).has(h)) {
        const before = boundsOf(this.map, primary) ?? b
        this.drag = { kind: 'resize', id: primary, handle: h, x, y, before, after: before, confirmed: true }
        this.postSelection()
        this.redraw()
        return
      }
    }
    const id = this.elementAt(x, y)
    this.select(id, mods)
    this.postSelection()
    if (id !== null && id !== '' && !mods.ctrl && !mods.shift && this.selection.includes(id)) {
      if (this.absolute(id)) {
        const ids = topLevelIds(this.selection).filter((s) => this.absolute(s))
        this.drag = { kind: 'move', ids, x, y, dx: 0, dy: 0, confirmed: false }
      } else if (this.selection.length === 1) {
        this.drag = { kind: 'reorder', id, x, y, confirmed: false, target: null }
      }
    }
    this.redraw()
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.designOn) return
    const x = e.clientX
    const y = e.clientY
    const d = this.drag
    if (!d) {
      const primary = this.selection[0]
      const b = primary !== undefined && primary !== '' ? this.shown(primary) : null
      const h = b ? handleAt(selectionFrame(b), x, y) : null
      this.overlay.style.cursor = h && primary !== undefined && this.resizable(primary).has(h) ? handleCursor(h) : ''
      const id = this.elementAt(x, y)
      if (id !== this.hover) {
        this.hover = id
        this.redraw()
      }
      return
    }
    const dx = x - d.x
    const dy = y - d.y
    if (!d.confirmed) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      d.confirmed = true
    }
    if (d.kind === 'move') {
      d.dx = dx
      d.dy = dy
      const z = this.zoom()
      this.previewMove(d.ids, dx / z, dy / z)
      this.redrawShifted(d.ids, dx, dy)
      return
    }
    if (d.kind === 'resize') {
      d.after = resizeRect(d.before, d.handle, dx, dy)
      this.redraw()
      return
    }
    d.target = this.dropTargetAt({ kind: 'move', id: d.id }, x, y)
    this.showDrop(d.target)
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag
    this.drag = null
    this.overlay.releasePointerCapture?.(e.pointerId)
    if (!d || !d.confirmed) {
      this.redraw()
      return
    }
    const z = this.zoom()
    if (d.kind === 'move') {
      const ops = d.ids.flatMap((id) => moveOps(id, this.placement(id), d.dx, d.dy, z, this.isRtl(id)))
      if (ops.length) {
        this.post({ type: 'editRequests', gesture: 'move', ops })
        // The moved elements stay where they were dropped until the buffer comes back (3 s at most).
        this.holdPreviews()
      } else {
        this.clearPreviews()
      }
    } else if (d.kind === 'resize') {
      const ops = resizeOps(d.id, this.placement(d.id), d.before, d.after, d.handle, z, this.isRtl(d.id), this.absolute(d.id))
      if (ops.length) this.post({ type: 'editRequests', gesture: 'resize', ops })
    } else if (d.target && d.target.valid && !isNoOpMove(d.id, d.target)) {
      this.post({ type: 'editRequest', op: { kind: 'moveElement', elementId: d.id, newParentId: d.target.parentId, index: d.target.index } })
    }
    this.showDrop(null)
  }

  private cancelDrag(): void {
    if (!this.drag) return
    this.drag = null
    this.clearPreviews()
    this.showDrop(null)
  }

  /** Live preview of a move: the elements themselves follow the pointer (a CSS `translate`, view px). */
  private previewMove(ids: readonly string[], tx: number, ty: number): void {
    const value = `${tx}px ${ty}px`
    for (const id of ids) {
      for (const el of document.querySelectorAll<HTMLElement>(`[data-kb-id="${CSS.escape(id)}"]`)) {
        if (!this.previews.some((p) => p.el === el)) this.previews.push({ el, translate: el.style.translate })
        el.style.translate = value
      }
    }
  }

  private redrawShifted(ids: readonly string[], dx: number, dy: number): void {
    // The map is rebuilt from the DOM on the next frame; draw the frames at their new place meanwhile.
    const entries = this.map.entries.map((en) => (ids.some((id) => isAncestorOrSelf(id, en.id)) ? { ...en, bounds: translate(en.bounds, dx, dy) } : en))
    this.map = makeLayoutMap(entries)
    this.redraw()
  }

  private holdPreviews(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer)
    this.previewTimer = setTimeout(() => this.clearPreviews(), 3000)
  }

  private clearPreviews(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer)
    this.previewTimer = null
    for (const p of this.previews) p.el.style.translate = p.translate
    this.previews = []
    this.scheduleMap()
  }

  private onWheel(e: WheelEvent): void {
    if (!this.designOn) return
    e.preventDefault()
    // Ctrl+wheel zooms (centred on the pointer), like every other visual editor; the Zoom menu follows.
    if (e.ctrlKey) {
      const rect = this.canvas.getBoundingClientRect()
      const current = this.zoom()
      const next = Math.max(0.1, Math.min(4, current * Math.exp(-e.deltaY * 0.0015)))
      if (next !== current) {
        const ox = e.clientX - rect.left
        const oy = e.clientY - rect.top
        const cx = this.canvas.scrollLeft + ox
        const cy = this.canvas.scrollTop + oy
        const ratio = next / current
        this.zoomPref = next
        this.zoomExplicit = true
        this.applyFrameSize()
        this.canvas.scrollLeft = cx * ratio - ox
        this.canvas.scrollTop = cy * ratio - oy
      }
      return
    }
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
    const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY
    // Scroll what is under the pointer (a ScrollArea of the view), else the canvas.
    const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => !this.overlay.contains(el))
    for (let el: Element | null = under ?? null; el && el !== this.canvas; el = el.parentElement) {
      const s = getComputedStyle(el)
      const canY = dy !== 0 && /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight &&
        (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0)
      const canX = dx !== 0 && /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth
      if (canY || canX) {
        el.scrollBy({ left: dx, top: dy })
        return
      }
    }
    this.canvas.scrollBy({ left: dx, top: dy })
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.designOn) return
    if (e.key === 'Escape' && this.drag) {
      e.preventDefault()
      this.cancelDrag()
      return
    }
    if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && this.selection.length) {
      e.preventDefault()
      const b = boundsOf(this.map, this.selection[0])
      const x = b ? (b.left + b.right) / 2 : 0
      const y = b ? (b.top + b.bottom) / 2 : 0
      this.post({ type: 'contextMenu', x, y, screenX: 0, screenY: 0, elementId: this.selection[0] })
      return
    }
    const siblingsOf = (id: string): string[] => {
      const parent = id === '' ? '' : parentIdOf(id) ?? ''
      return childEntries(this.map, parent).map((en) => en.id)
    }
    const r = keyMessages(
      { key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey },
      {
        selection: this.selection,
        absolute: topLevelIds(this.selection).filter((id) => this.absolute(id)).map((id) => ({ id, at: this.placement(id), rtl: this.isRtl(id) })),
        parentOf: parentIdOf,
        siblingsOf,
      },
    )
    if (r.handled) e.preventDefault()
    for (const m of r.messages) this.post(m)
    if (r.select) {
      this.selection = [...r.select]
      this.postSelection()
      this.redraw()
    }
  }

  /** State for tests and diagnostics (`window.__kbDesignState()`). */
  debugState(): Record<string, unknown> {
    return {
      ready: this.ready,
      mode: this.config.mode,
      file: this.doc?.file ?? null,
      plan: this.plan?.file ?? null,
      kind: this.plan?.kind ?? null,
      stale: this.stale,
      design: this.designOn,
      selection: [...this.selection],
      entries: this.map.entries.length,
      ids: [...new Set(this.map.entries.map((e) => e.id))],
      zoom: this.zoom(),
      width: this.frameWidth(),
      lang: this.currentLang(),
      theme: this.prefs.theme,
      codeBehind: this.codeBehind?.module ?? null,
      modules: Object.fromEntries(this.loadedModules),
      catalog: this.catalog.size,
      containers: [...this.nodes.keys()].filter((id) => containerKind(this.nodes, this.catalog, id) !== 'leaf'),
    }
  }
}

/** Starts the surface (both entries). */
export function startSurface(config: SurfaceConfig): DesignSurface {
  const s = new DesignSurface(config)
  ;(window as unknown as { __kbDesignState?: () => Record<string, unknown> }).__kbDesignState = () => s.debugState()
  void s.start()
  return s
}
