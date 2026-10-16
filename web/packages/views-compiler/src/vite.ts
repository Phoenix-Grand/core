/**
 * The Vite plugin of `.kbview` web views (WEB-VIEWS §2.1, lot WV-2).
 *
 * - `X.kbview` / `X.kbcontrol` → an ES module (plan + precompiled accessors + `ViewBase`, source-mapped to the
 *   view); compiler errors fail the build and show in the dev overlay with file/line/column; warnings are
 *   printed.
 * - `.kubuno/views/**` → the generated declarations and check files, rewritten on every compile (and for
 *   every view at startup), so `tsc -b` / `kbview-tsc` and the editor see `ViewBase` without a running build.
 * - HMR: a view edit re-evaluates its module only; `@kubuno/views` swaps the new plan into the live views
 *   (state, `@bind` fields and handles kept). A code-behind edit re-evaluates the code-behind only (it is
 *   made self-accepting); the runtime moves the live instances onto the new class prototype. A view that does
 *   not compile keeps the last good one on screen, with the error overlay.
 * - Code-behinds use standard (TC39) decorators (`@bind accessor`): they are lowered with TypeScript before
 *   Vite's own transform, which leaves standard decorators as they are.
 * - `vite serve` also serves the Visual Studio design surface at `/__kubuno_design__/` (`design-server.ts`). For a
 *   project without a design entry of its own (a module), the page is `@kubuno/host-runtime`'s, and the host's
 *   shared specifiers (`react`, `@ui`, `@kubuno/sdk`, …) resolve to that package's modules - one instance each, for
 *   the page and the project's code alike - instead of the project's `node_modules` (`host-runtime.ts`).
 * - `X.kbres` (a string resource set: the neutral file and its `X.<lang>.kbres` satellites) → `export default` its
 *   i18next bundles by language (`kbres.ts`, WV-6), for `registerModuleTranslations(ns, bundles)`.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { Plugin, ResolvedConfig, UserConfig } from 'vite'

import { installDesignServer } from './design-server.js'
import { HOST_RUNTIME_PACKAGE, dropShared, findHostRuntime, prebundleExternals, resolveShared, usesHostRuntime, type HostRuntime } from './host-runtime.js'
import { emitViewModule } from './emit.js'
import { compileKbresSet, kbresModule, kbresSet, type KbresCodec } from './kbres.js'
import { codeBehindOf, isViewFile, loadNodeKbres, projectPath, readProjectConfig, viewOfCodeBehind, writeGenerated, ViewProject, type ProjectOptions } from './project.js'
import type { CompileOutput, Diagnostic } from './types.js'

export interface KbviewPluginOptions extends ProjectOptions {
  /** Write `.kubuno/views/**` (declarations, check files). Default `true`. */
  generateTypes?: boolean
  /** Specifier of the views runtime (default `@kubuno/views`). */
  runtime?: string
  /** Keep design-time values in the plans (the design surface's dev server). Default `false`. */
  design?: boolean
  /**
   * Serve the Visual Studio design surface at `/__kubuno_design__/` in `vite serve` and announce it in
   * `.kubuno/design-server.json` (see `design-server.ts`). Default `true`.
   */
  designServer?: boolean
  /** Language of a neutral `.kbres` file without a `Culture` attribute. Default `en`. */
  neutralCulture?: string
}

/** `file(line,col): severity code: message` - the format tsc, MSBuild and VS use. */
export function formatDiagnostic(file: string, d: Diagnostic): string {
  return `${file}(${d.line},${d.column}): ${d.severity} KBV-${d.code}: ${d.message}`
}

const DECORATOR = /^\s*@[A-Za-z_$][\w$]*(\([^)]*\))?\s+(accessor|static|readonly|private|protected|public|async|get|set|[A-Za-z_$][\w$]*\s*[(:=;!?])/m

/** The plugin. Add it to `plugins` (before `@vitejs/plugin-react`). */
export function kbview(options: KbviewPluginOptions = {}): Plugin {
  let config: ResolvedConfig
  let project: Promise<ViewProject> | null = null
  let serve = false
  let ts: typeof import('typescript') | null = null
  let kbres: Promise<KbresCodec> | null = null
  // `vite serve` of a project designed with `@kubuno/host-runtime`: its shared modules (null otherwise).
  let hostRuntime: HostRuntime | null = null
  let hostRuntimeProblem: string | null = null

  const getProject = (): Promise<ViewProject> => {
    project ??= ViewProject.open(config.root, options).then((p) => {
      if (options.generateTypes !== false) p.generateAll()
      return p
    })
    return project
  }

  const typescript = (): typeof import('typescript') => {
    if (!ts) {
      const require = createRequire(join(config.root, 'package.json'))
      ts = require('typescript') as typeof import('typescript')
    }
    return ts
  }

  return {
    name: 'kubuno-kbview',
    enforce: 'pre',

    // The design page of a module project (no `design.entry`): the host runtime's shared modules stand in for the
    // host's import map, and stay external in the pre-bundled dependencies (a pre-bundled `react` would be a second
    // React).
    config(user, env) {
      hostRuntime = null
      hostRuntimeProblem = null
      if (env.command !== 'serve' || options.designServer === false) return
      const root = resolve(user.root ?? process.cwd())
      let design: ReturnType<typeof readProjectConfig>['design']
      try {
        design = readProjectConfig(root).design
      } catch {
        return // A malformed kubuno.views.json is reported when the project opens.
      }
      if (!usesHostRuntime(design)) return
      try {
        hostRuntime = findHostRuntime(root)
        if (!hostRuntime) {
          hostRuntimeProblem = `${HOST_RUNTIME_PACKAGE} is not installed: add it as a devDependency to open this project's views in the Visual Studio designer`
        }
      } catch (err) {
        hostRuntimeProblem = (err as Error).message
      }
      if (!hostRuntime) return
      return { optimizeDeps: { rolldownOptions: { plugins: [prebundleExternals(hostRuntime)] } } } as UserConfig
    },

    configResolved(resolved) {
      config = resolved
      serve = resolved.command === 'serve'
      if (hostRuntime) {
        dropShared(resolved.optimizeDeps.include, hostRuntime)
        for (const env of Object.values(resolved.environments ?? {})) dropShared(env.optimizeDeps?.include, hostRuntime)
      }
    },

    resolveId(id, _importer, opts) {
      if (!hostRuntime || opts?.ssr) return null
      // `scan`: Vite looking for the dependencies to pre-bundle (an option Vite passes, not in its public type).
      return resolveShared(hostRuntime, id, (opts as { scan?: boolean } | undefined)?.scan === true)
    },

    async buildStart() {
      await getProject()
    },

    // `import strings from './strings.kbres'` → `{ en: {…}, fr: {…} }`: the set's i18next bundles (WV-6).
    async load(id) {
      const file = id.split('?')[0]
      if (!/\.kbres$/i.test(file)) return null
      kbres ??= loadNodeKbres()
      const set = compileKbresSet(await kbres, file, options.neutralCulture)
      for (const f of set.files) this.addWatchFile(f)
      for (const w of set.warnings) this.warn(w)
      if (set.errors.length) this.error(set.errors.join('\n'))
      return { code: kbresModule(set), map: null }
    },

    // A satellite (`strings.fr.kbres`) changed, or was added: reload the module of its set's neutral file.
    handleHotUpdate(ctx) {
      if (!/\.kbres$/i.test(ctx.file)) return
      const { neutral } = kbresSet(ctx.file)
      const mods = ctx.server.moduleGraph.getModulesByFile(neutral)
      if (!mods?.size) return
      for (const m of mods) ctx.server.moduleGraph.invalidateModule(m)
      return [...mods]
    },

    async transform(code, id) {
      const file = id.split('?')[0]
      if (isViewFile(file)) {
        const p = await getProject()
        const out: CompileOutput = p.compile(file, code, options.design ?? false)
        if (options.generateTypes !== false) writeGenerated(p.root, file, out)
        const rel = projectPath(p.root, file)
        for (const d of out.diagnostics.filter((x) => x.severity !== 'error')) {
          this.warn({ message: formatDiagnostic(rel, d), id: file, loc: { line: d.line, column: d.column - 1 } })
        }
        const errors = out.diagnostics.filter((x) => x.severity === 'error')
        const hasCodeBehind = codeBehindOf(file) !== null
        if (!hasCodeBehind && out.plan && out.plan.handlers.length > 0) {
          const first = out.handlers[0]
          errors.push({
            severity: 'error',
            code: 'code-behind',
            message: `the view names handlers (${out.plan.handlers.join(', ')}) but has no code-behind: add ${rel.replace(/\.(kbview|kbcontrol)$/, '.ts')} with a class extending ViewBase`,
            line: first?.at[0] ?? 1,
            column: first?.at[1] ?? 1,
            end_line: first?.end[0] ?? 1,
            end_column: first?.end[1] ?? 1,
          })
        }
        if (errors.length > 0 || !out.plan) {
          const d = errors[0]
          this.error({
            message: errors.map((e) => formatDiagnostic(rel, e)).join('\n') || `${rel}: the view has no root element`,
            id: file,
            loc: d ? { file, line: d.line, column: d.column - 1 } : undefined,
          })
        }
        const result = emitViewModule(out.plan!, {
          file: rel,
          source: code,
          defaultExport: !hasCodeBehind,
          hmr: serve,
          runtime: options.runtime,
        })
        return { code: result.code, map: result.map }
      }

      // Code-behind of a view: lower standard decorators, make it self-accepting in dev.
      if (/\.(ts|tsx)$/.test(file) && !file.includes('/node_modules/') && viewOfCodeBehind(file)) {
        let out = code
        let map: unknown = null
        if (DECORATOR.test(code)) {
          const t = typescript()
          const result = t.transpileModule(code, {
            fileName: file,
            compilerOptions: {
              target: t.ScriptTarget.ES2022,
              module: t.ModuleKind.ESNext,
              jsx: t.JsxEmit.Preserve,
              useDefineForClassFields: true,
              experimentalDecorators: false,
              verbatimModuleSyntax: false,
              sourceMap: true,
              inlineSources: true,
            },
          })
          out = result.outputText.replace(/\n\/\/# sourceMappingURL=.*$/, '')
          map = result.sourceMapText ? JSON.parse(result.sourceMapText) : null
        }
        if (serve) out += '\nif (import.meta.hot) import.meta.hot.accept()\n'
        if (out === code) return null
        return { code: out, map: map as never }
      }
      return null
    },

    async configureServer(server) {
      const p = await getProject()
      const onAddOrRemove = (file: string): void => {
        if (!isViewFile(file)) return
        p.rescan()
        if (options.generateTypes !== false) p.generateAll()
        // The set of user controls changed: every view may resolve elements differently.
        server.ws.send({ type: 'full-reload' })
      }
      server.watcher.on('add', onAddOrRemove)
      server.watcher.on('unlink', onAddOrRemove)
      if (options.designServer !== false) {
        if (hostRuntimeProblem) server.config.logger.warn(`@kubuno/views-compiler: ${hostRuntimeProblem}`)
        installDesignServer(server, p, hostRuntime)
      }
    },
  }
}

/** The `tsconfig.json` settings a project using views needs (documented in the package README). */
export const TSCONFIG_HINT = {
  compilerOptions: { rootDirs: ['.', '.kubuno/views'] },
  include: ['src', '.kubuno/views'],
} as const

/** Whether `root` looks set up for generated view types (used by `kbview-tsc` for a friendly hint). */
export function hasGeneratedTypesSetup(root: string): boolean {
  const file = resolve(root, 'tsconfig.json')
  if (!existsSync(file)) return false
  const text = readFileSync(file, 'utf8')
  if (text.includes('.kubuno/views')) return true
  // A solution-style tsconfig.json (`files: []` + `references`, the Vite template) keeps the setup in a
  // referenced project, usually tsconfig.app.json: look one level down.
  for (const m of text.matchAll(/"path"\s*:\s*"([^"]+)"/g)) {
    let ref = resolve(root, m[1])
    if (!ref.endsWith('.json')) ref = join(ref, 'tsconfig.json')
    if (existsSync(ref) && readFileSync(ref, 'utf8').includes('.kubuno/views')) return true
  }
  return false
}
