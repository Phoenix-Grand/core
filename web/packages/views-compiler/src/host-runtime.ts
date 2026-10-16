/**
 * The host runtime of a module project's design page (vskubuno docs/WEB-VIEWS.md §18): `@kubuno/host-runtime`.
 *
 * A module's code imports the host's shared specifiers (`react`, `@ui`, `@kubuno/sdk`, `@kubuno/views`, …). In
 * production they are `external` and the host's import map gives every module the host's single instances. On the
 * Visual Studio design page served by the module's own dev server (`/__kubuno_design__/`) there is no host: the page
 * is `@kubuno/host-runtime`'s project-mode entry, and that package also ships the host's shared modules, built
 * together with the page (one React, one `@ui`, the real sdk, drive and views runtime, i18next with the core's
 * translations). In `vite serve`, for a project whose design entry is the default one, the plugin resolves each
 * shared specifier to the package's module of the same name - the dev-server twin of the production import map -
 * and keeps those exact specifiers external in Vite's dependency pre-bundling (which would make copies of them).
 *
 * The package describes itself in `dist/project/shared.json` (`HostRuntimeManifest`); nothing here hard-codes its
 * layout or the list of shared specifiers. Paths go through `node:path`, URLs are always `/`-separated.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The package that provides the design page of module projects. */
export const HOST_RUNTIME_PACKAGE = '@kubuno/host-runtime'

/** Its manifest, relative to the package root. */
export const HOST_RUNTIME_MANIFEST = 'dist/project/shared.json'

/** `@kubuno/host-runtime/dist/project/shared.json`. */
export interface HostRuntimeManifest {
  /** The manifest's format. */
  version: 1
  /** The package's version. */
  hostRuntime: string
  /** The project-mode design entry, relative to the package root. */
  entry: string
  /** The Kubuno themes folder (`<id>/theme.json`), relative to the package root. */
  themes?: string
  /** Shared specifier → its module, relative to the package root. */
  shared: Record<string, string>
}

/** An installed host runtime, with absolute paths. */
export interface HostRuntime {
  /** The package root. */
  dir: string
  version: string
  /** The project-mode design entry. */
  entry: string
  /** The themes folder, or null when the package ships none. */
  themes: string | null
  /** Shared specifier → module file. */
  shared: ReadonlyMap<string, string>
}

/** Reads and checks a manifest; throws with a readable message when it is not one. */
export function parseHostRuntimeManifest(dir: string, text: string): HostRuntime {
  let m: Partial<HostRuntimeManifest>
  try {
    m = JSON.parse(text) as Partial<HostRuntimeManifest>
  } catch (err) {
    throw new Error(`${HOST_RUNTIME_MANIFEST}: ${(err as Error).message}`)
  }
  if (m.version !== 1) throw new Error(`${HOST_RUNTIME_MANIFEST}: unsupported format ${String(m.version)} (expected 1)`)
  if (typeof m.entry !== 'string' || !m.entry) throw new Error(`${HOST_RUNTIME_MANIFEST}: no entry`)
  if (!m.shared || typeof m.shared !== 'object') throw new Error(`${HOST_RUNTIME_MANIFEST}: no shared modules`)
  const inside = (rel: string, what: string): string => {
    const file = resolve(dir, rel)
    if (isAbsolute(rel) || (file !== dir && !file.startsWith(dir + sep))) throw new Error(`${HOST_RUNTIME_MANIFEST}: ${what} is outside the package (${rel})`)
    return file
  }
  const shared = new Map<string, string>()
  for (const [spec, rel] of Object.entries(m.shared)) {
    if (typeof rel !== 'string' || !rel) throw new Error(`${HOST_RUNTIME_MANIFEST}: shared module of '${spec}' is not a path`)
    shared.set(spec, inside(rel, `shared module of '${spec}'`))
  }
  return {
    dir,
    version: typeof m.hostRuntime === 'string' ? m.hostRuntime : '0.0.0',
    entry: inside(m.entry, 'entry'),
    themes: typeof m.themes === 'string' && m.themes ? inside(m.themes, 'themes') : null,
    shared,
  }
}

/**
 * The host runtime installed for the project at `root` (resolved like the project's own imports, from its
 * `package.json`), or null when the package is not installed. Throws when it is installed but its manifest is
 * missing or malformed (a package from before project mode, or a broken install).
 */
export function findHostRuntime(root: string): HostRuntime | null {
  let pkg: string
  try {
    pkg = createRequire(join(resolve(root), 'package.json')).resolve(`${HOST_RUNTIME_PACKAGE}/package.json`)
  } catch {
    return null
  }
  const dir = dirname(pkg)
  const manifest = join(dir, HOST_RUNTIME_MANIFEST)
  if (!existsSync(manifest)) throw new Error(`${HOST_RUNTIME_PACKAGE} (${dir}) has no ${HOST_RUNTIME_MANIFEST}: it predates project mode, update it`)
  return parseHostRuntimeManifest(dir, readFileSync(manifest, 'utf8'))
}

/** Whether a project's design page is the host runtime's (no `design.entry` of its own). */
export function usesHostRuntime(design: { entry?: string } | undefined): boolean {
  return !design?.entry
}

/** The id prefix of the CommonJS facade of a shared specifier in pre-bundled dependencies. */
export const CJS_FACADE_PREFIX = '\0kubuno-shared-cjs:'

/** What `prebundleExternals` returns: a Rolldown plugin, structurally (no dependency on Rolldown's types). */
export interface PrebundlePlugin {
  name: string
  resolveId(id: string, importer: string | undefined, options: { kind?: string }): { id: string; external?: boolean } | null
  load(id: string): string | null
}

/**
 * The plugin given to Vite's dependency pre-bundling (`optimizeDeps.rolldownOptions.plugins`): a pre-bundled
 * dependency (`lucide-react`, `@react-three/fiber`, …) keeps every shared specifier as an import, which the dev server
 * then resolves to the host runtime's module like the project's own imports, instead of bundling a copy (a second
 * React). Only the exact specifiers are kept out: `zustand/traditional` or `react-dom/server` are not shared, and are
 * bundled as usual (`optimizeDeps.exclude` would also drop their subpaths from pre-bundling and serve CommonJS files
 * as they are). A `require()` of a shared specifier (CommonJS code) gets an ES facade, as Vite does for its excluded
 * dependencies.
 */
export function prebundleExternals(rt: HostRuntime): PrebundlePlugin {
  return {
    name: 'kubuno-host-runtime-shared',
    resolveId(id, _importer, options) {
      if (!rt.shared.has(id)) return null
      if (options?.kind === 'require-call') return { id: CJS_FACADE_PREFIX + id }
      return { id, external: true }
    },
    load(id) {
      if (!id.startsWith(CJS_FACADE_PREFIX)) return null
      const spec = JSON.stringify(id.slice(CJS_FACADE_PREFIX.length))
      return `import * as m from ${spec};\nmodule.exports = { ...m };\n`
    },
  }
}

/**
 * The resolution of a specifier through the host runtime in the dev server: its shared module's file (and the
 * package's `/entry`), or null when it is not one of them. While Vite scans the project for dependencies to
 * pre-bundle (`scan`), a shared specifier is reported as external, so that it is never pre-bundled.
 */
export function resolveShared(rt: HostRuntime, id: string, scan = false): string | { id: string; external: true } | null {
  if (id === `${HOST_RUNTIME_PACKAGE}/entry`) return rt.entry
  const file = rt.shared.get(id)
  if (!file) return null
  return scan ? { id, external: true } : file
}

/**
 * Removes the shared specifiers from an `optimizeDeps.include` list, in place (`@vitejs/plugin-react` adds `react`,
 * `react-dom` and the JSX runtimes there; pre-bundled, they would be copies of the host runtime's). Returns how many
 * entries were removed.
 */
export function dropShared(include: string[] | undefined, rt: HostRuntime): number {
  if (!include) return 0
  let removed = 0
  for (let k = include.length - 1; k >= 0; k--) {
    if (rt.shared.has(include[k]) || include[k] === HOST_RUNTIME_PACKAGE || include[k].startsWith(HOST_RUNTIME_PACKAGE + '/')) {
      include.splice(k, 1)
      removed++
    }
  }
  return removed
}

/**
 * The dev-server URL of a file: root-relative inside the project (`/node_modules/…`, as Vite writes the imports it
 * resolves there), `/@fs/<absolute path>` outside it (`/@fs/C:/…` on Windows).
 */
export function devServerUrl(root: string, file: string): string {
  const rel = relative(resolve(root), resolve(file))
  if (rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) return '/' + rel.split(sep).join('/')
  return '/@fs/' + resolve(file).split(sep).join('/').replace(/^\/+/, '')
}
