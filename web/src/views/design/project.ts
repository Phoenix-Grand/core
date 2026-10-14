/**
 * The design page in **project** (dev-server) mode, shared by its two entries: the core's own (`entry.tsx`, served
 * from source by the core's dev server) and a module project's (`entry.module.ts`, built into `@kubuno/host-runtime`
 * and served by the module's dev server). The registries, user controls and setup modules come from
 * `/__kubuno_design__/project.json` (`@kubuno/views-compiler`'s route); the project's controls and the view's
 * code-behind are imported through the dev server by `importModule`, which each entry defines in a module the dev
 * server transforms (so that its dynamic imports and HMR work).
 */
import uiPackage from '../../ui/package.json'
import { startSurface, type DesignSurface, type ProjectInfo } from './surface'

/** The route of the design page on a dev server. */
export const DESIGN_PATH = '/__kubuno_design__/'

/** `GET /__kubuno_design__/project.json`. */
export async function loadDesignProject(): Promise<ProjectInfo> {
  const r = await fetch(`${DESIGN_PATH}project.json`, { cache: 'no-store' })
  if (!r.ok) throw new Error(`${DESIGN_PATH}project.json: HTTP ${r.status}`)
  return (await r.json()) as ProjectInfo
}

export interface ProjectDesignOptions {
  /** `@kubuno/host-runtime`'s version when the page is that package's build, else null. */
  readonly hostRuntime: string | null
  /** The URL of the compiler's WebAssembly. */
  readonly wasmUrl: string
  /** Imports a project module through the dev server (`/src/x`). */
  readonly importModule: (specifier: string) => Promise<Record<string, unknown>>
}

/** Starts the surface in project mode. */
export function startProjectSurface(options: ProjectDesignOptions): DesignSurface {
  return startSurface({
    mode: 'project',
    uiVersion: uiPackage.version,
    hostRuntime: options.hostRuntime,
    wasmUrl: options.wasmUrl,
    themesBase: `${DESIGN_PATH}themes`,
    loadProject: loadDesignProject,
    importModule: options.importModule,
  })
}
