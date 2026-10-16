/**
 * The design surface's dev-server route (vskubuno docs/WEB-VIEWS.md §4.2, lot WV-9b): in `vite serve`, the
 * project's own dev server also serves the page the Visual Studio web designer (WebView2) shows.
 *
 * - `GET /__kubuno_design__/` - an HTML page that loads the design entry, passed through
 *   `server.transformIndexHtml` (so the Vite client and the React refresh preamble are injected). The entry is
 *   `kubuno.views.json` → `design.entry` (a project-root-relative file, e.g. the core's
 *   `src/views/design/entry.tsx`), else `@kubuno/host-runtime/entry` (module projects: the package's project-mode
 *   entry, loaded at its own URL so that its relative URLs resolve; see `host-runtime.ts`).
 * - `GET /__kubuno_design__/project.json` - what the page's in-browser compiler needs, read exactly as
 *   `ViewProject` reads it: the host registry's text, the project registries (project-local modules rewritten to
 *   project-root-relative specifiers, `/src/x`), the user controls, the plan ABI and the compiler's version; and the
 *   URLs of the project modules the page imports before it renders (`design.setup`: the project's stylesheet, its
 *   translations).
 * - `GET /__kubuno_design__/themes/<id>/<file>` - the Kubuno themes the page can apply (`design.themes`, a folder
 *   of `<id>/theme.json` + its CSS, else the host runtime's; only `.json` and `.css` files are served).
 * - While the server listens, `<root>/.kubuno/design-server.json` tells Visual Studio where the page is
 *   (`{version, urls, designPath, pid, root}`); it is removed when the server closes or the process exits.
 *
 * Paths go through `node:path`; URLs are always `/`-separated, so the route behaves the same on Linux, Windows
 * and macOS.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path'

import type { ViteDevServer } from 'vite'

import { devServerUrl, type HostRuntime } from './host-runtime.js'
import { projectPath, projectRegistryJson, readProjectConfig, userControlsOf, type ViewProject } from './project.js'

/** The route of the design page (with its trailing slash: the page's relative URLs resolve under it). */
export const DESIGN_PATH = '/__kubuno_design__/'

/** The design entry of a project that names none (a module: the host runtime package's page). */
export const DEFAULT_DESIGN_ENTRY = '@kubuno/host-runtime/entry'

/** Where the running server is announced, under the project root (git-ignored). */
export const DESIGN_SERVER_FILE = '.kubuno/design-server.json'

/** `kubuno.views.json` → `design`. */
export interface DesignConfig {
  /** The page's entry module: a project-root-relative file, or a bare specifier. */
  entry?: string
  /** A folder of Kubuno themes (`<id>/theme.json`), relative to the project root. */
  themes?: string
  /**
   * Project modules the page imports, in order, before it renders a view: what the project's own entry would load
   * in the host (its stylesheet, its translations). Project-root-relative files (`src/index.css`), or bare
   * specifiers.
   */
  setup?: string[]
}

/** `.kubuno/design-server.json`. */
export interface DesignServerInfo {
  version: 1
  urls: string[]
  designPath: string
  pid: number
  root: string
}

/** What `GET /__kubuno_design__/project.json` returns. */
export interface DesignProjectInfo {
  root: string
  hostRegistry: string
  registries: { path: string; text: string }[]
  userControls: { name: string; module: string }[]
  viewsAbi: number
  compiler: string
  themes: string[]
  /** `design.setup` as dev-server URLs (`/src/index.css`, `/@id/pkg`). */
  setup: string[]
}

/** The URL the page's `<script type="module">` loads for a design entry. */
export function designEntryUrl(entry: string | undefined): string {
  const e = (entry ?? DEFAULT_DESIGN_ENTRY).replace(/\\/g, '/')
  // A bare specifier (a package): Vite serves it through `/@id/`.
  if (!e.startsWith('.') && !e.startsWith('/') && !/\.(m?[jt]sx?)$/.test(e)) return '/@id/' + e
  return '/' + posix.normalize(e.replace(/^\/+/, ''))
}

/**
 * The dev-server URLs of `design.setup`: a file that exists under the project root → its root-relative URL
 * (`src/index.css` → `/src/index.css`); anything else is taken for a bare specifier (`/@id/<spec>`). Entries that are
 * not strings, empty, or that leave the project root are skipped.
 */
export function designSetupUrls(root: string, setup: unknown): string[] {
  if (!Array.isArray(setup)) return []
  const base = resolve(root)
  const urls: string[] = []
  for (const s of setup) {
    if (typeof s !== 'string' || !s.trim()) continue
    const spec = s.trim().replace(/\\/g, '/')
    const file = resolve(base, spec.replace(/^\/+/, ''))
    const insideRoot = file.startsWith(base + sep)
    if (insideRoot && existsSync(file)) {
      urls.push('/' + posix.normalize(spec.replace(/^\/+/, '').replace(/^\.\//, '')))
    } else if (!spec.startsWith('.') && !spec.startsWith('/') && !isAbsolute(spec)) {
      urls.push('/@id/' + spec)
    }
  }
  return urls
}

/** The design page's HTML, before `transformIndexHtml`. */
export function designPageHtml(entryUrl: string): string {
  return [
    '<!doctype html>',
    '<html lang="fr">',
    '<head>',
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '<title>Concepteur Kubuno</title>',
    '</head>',
    '<body>',
    '<div id="kb-design"></div>',
    `<script type="module" src="${entryUrl}"></script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/** The ids of the themes of a themes folder (sub-folders holding a `theme.json`), sorted. */
export function themeIds(dir: string | null): string[] {
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'theme.json')))
    .sort()
}

/** The project description the design page loads (registries as `ViewProject` loads them). */
export function designProjectInfo(project: ViewProject, themesDir: string | null, setup: string[] = []): DesignProjectInfo {
  const version = project.compiler.version()
  return {
    root: project.root,
    hostRegistry: readFileSync(project.hostRegistry, 'utf8'),
    registries: project.registries.map((file) => ({ path: projectPath(project.root, file), text: projectRegistryJson(project.root, file) })),
    userControls: userControlsOf(project.root, project.views),
    viewsAbi: version.abi,
    compiler: version.compiler,
    themes: themeIds(themesDir),
    setup,
  }
}

/**
 * The URL of the page's entry module: the project's `design.entry`, else the host runtime's project-mode entry at
 * its own dev-server URL (so that the URLs it computes from `import.meta.url` resolve), else the default specifier
 * (which fails to load: the server warned that `@kubuno/host-runtime` is missing).
 */
export function designPageEntryUrl(root: string, design: DesignConfig, hostRuntime: HostRuntime | null): string {
  if (design.entry) return designEntryUrl(design.entry)
  if (hostRuntime) return devServerUrl(root, hostRuntime.entry)
  return designEntryUrl(undefined)
}

/** The themes folder the route serves: `design.themes`, else the host runtime's for a project using its page. */
export function designThemesDir(root: string, design: DesignConfig, hostRuntime: HostRuntime | null): string | null {
  if (design.themes) return isAbsolute(design.themes) ? design.themes : resolve(root, design.themes)
  return !design.entry && hostRuntime ? hostRuntime.themes : null
}

/**
 * The file of a themes folder a request names, or `null` when it is not one the route serves (outside the folder,
 * not `.json` / `.css`, missing).
 */
export function themeFile(dir: string, requestPath: string): string | null {
  let rel: string
  try {
    rel = decodeURIComponent(requestPath)
  } catch {
    return null
  }
  if (rel.includes('\0') || !/\.(json|css)$/i.test(rel)) return null
  const base = resolve(dir)
  const file = resolve(base, '.' + posix.normalize('/' + rel.replace(/\\/g, '/')))
  if (!file.startsWith(base + sep)) return null
  try {
    return statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

/** Writes the announcement file (and its folder). */
export function writeDesignServerInfo(root: string, urls: readonly string[]): string {
  const file = join(root, DESIGN_SERVER_FILE)
  const info: DesignServerInfo = { version: 1, urls: [...urls], designPath: DESIGN_PATH, pid: process.pid, root: resolve(root) }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(info, null, 2) + '\n')
  return file
}

/** Removes the announcement file when this process wrote it. */
export function removeDesignServerInfo(root: string): void {
  const file = join(root, DESIGN_SERVER_FILE)
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as Partial<DesignServerInfo>
    if (info.pid === process.pid) unlinkSync(file)
  } catch {
    // Already gone, or another server's.
  }
}

/** Installs the route on a dev server, and the announcement file while it listens. */
export function installDesignServer(server: ViteDevServer, project: ViewProject, hostRuntime: HostRuntime | null = null): void {
  const root = project.root
  const design: DesignConfig = readProjectConfig(root).design ?? {}
  const themesDir = designThemesDir(root, design, hostRuntime)
  const entryUrl = designPageEntryUrl(root, design, hostRuntime)
  const base = DESIGN_PATH.slice(0, -1)

  server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    const url = req.url ?? ''
    const path = url.split('?')[0]
    if (path !== base && !path.startsWith(DESIGN_PATH)) return next()
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (path === base) {
      res.statusCode = 302
      res.setHeader('Location', DESIGN_PATH)
      res.end()
      return
    }
    const rest = path.slice(DESIGN_PATH.length)
    if (rest === '' || rest === 'index.html') {
      server
        .transformIndexHtml(DESIGN_PATH, designPageHtml(entryUrl),(req as IncomingMessage & { originalUrl?: string }).originalUrl)
        .then((html) => send(res, 200, 'text/html; charset=utf-8', html))
        .catch((err: unknown) => next(err))
      return
    }
    if (rest === 'project.json') {
      try {
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(designProjectInfo(project, themesDir, designSetupUrls(root, readProjectConfig(root).design?.setup))))
      } catch (err) {
        send(res, 500, 'text/plain; charset=utf-8', `@kubuno/views-compiler: ${(err as Error).message}`)
      }
      return
    }
    if (rest.startsWith('themes/') && themesDir) {
      const file = themeFile(themesDir, rest.slice('themes/'.length))
      if (!file) return send(res, 404, 'text/plain; charset=utf-8', 'not found')
      send(res, 200, file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/json; charset=utf-8', readFileSync(file, 'utf8'))
      return
    }
    send(res, 404, 'text/plain; charset=utf-8', 'not found')
  })

  if (!server.httpServer) return
  // Announce the server once it listens (its resolved URLs are known only then).
  const listen = server.listen.bind(server)
  server.listen = async (...args: Parameters<ViteDevServer['listen']>) => {
    const result = await listen(...args)
    const urls = [...(server.resolvedUrls?.local ?? []), ...(server.resolvedUrls?.network ?? [])]
    try {
      writeDesignServerInfo(root, urls)
    } catch (err) {
      server.config.logger.warn(`@kubuno/views-compiler: cannot write ${DESIGN_SERVER_FILE}: ${(err as Error).message}`)
    }
    return result
  }
  const cleanup = (): void => removeDesignServerInfo(root)
  const close = server.close.bind(server)
  server.close = async () => {
    cleanup()
    return close()
  }
  server.httpServer.once('close', cleanup)
  process.once('exit', cleanup)
}
