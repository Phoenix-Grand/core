/**
 * Build of `@kubuno/host-runtime` (`npm run build:design-host`, two passes into `packages/host-runtime/dist/`, not
 * committed):
 *
 * 1. default mode — the design surface page of `.kbview` web views in **bundled** mode
 *    (`src/views/design/entry.bundled.tsx`) as a static site with relative URLs, so it can be served from any origin
 *    or folder (Visual Studio maps it to `https://kubuno-design.invalid/`): `index.html`, `entry.js`, `assets/`, the
 *    production fonts with their licence texts (`fonts/`, byte-identical copies of `public/fonts`) and the light /
 *    dark Kubuno themes (`themes/`).
 * 2. `--mode project` — the page in **project** mode for module projects, served by the module's own Vite dev server
 *    (`src/views/design/entry.module.ts` → `project/design-page.js` + `project/design-page.css`), built TOGETHER with
 *    the host's shared modules (`project/shared/<chunk>.js`, the entries of `build/shared-entries.ts`), so that the
 *    page and the module's code share one instance of each; `project/shared.json` maps every shared specifier of the
 *    host's import map to its module (read by `@kubuno/views-compiler`), and `project/entry.js` is the hand-written
 *    `packages/host-runtime/src/entry.js` (the dev server transforms it: HMR, dynamic imports). Built with React's
 *    development build, like a dev server's (Fast Refresh of the module's React parts, readable errors).
 *
 * Pass 2 ends by writing `design-host.json` (the build's file list and the hash of the host registry it embeds),
 * which the Visual Studio extension's build checks before shipping `dist/`.
 */
import { defineConfig, type Plugin, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
// The core's own views and user controls are compiled like in the app's build (the host imports some of them).
import { kbview } from './packages/views-compiler/dist/index.js'
import { SPECIFIER_TO_CHUNK } from './build/importmap-plugin'
import { SHARED_ENTRIES, sharedEntryInputs } from './build/shared-entries'

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url))
const OUT = here('./packages/host-runtime/dist')
const STAGE = here('./packages/host-runtime/.build-public')
const THEMES = ['kubuno-reference', 'kubuno-dark']
/** The project-mode output, under `dist/`. */
const PROJECT = 'project'

/** The page's public files: the fonts (and licences) of `public/fonts`, and the themes' `theme.json` + CSS. */
function stagePublic(): void {
  rmSync(STAGE, { recursive: true, force: true })
  mkdirSync(join(STAGE, 'fonts'), { recursive: true })
  cpSync(here('./public/fonts'), join(STAGE, 'fonts'), { recursive: true })
  for (const id of THEMES) {
    const src = here(`./themes/${id}`)
    const dst = join(STAGE, 'themes', id)
    mkdirSync(dst, { recursive: true })
    for (const name of readdirSync(src)) {
      if (name === 'theme.json' || name.endsWith('.css')) cpSync(join(src, name), join(dst, name))
    }
    if (existsSync(join(src, 'modules'))) cpSync(join(src, 'modules'), join(dst, 'modules'), { recursive: true, filter: (f) => !f.endsWith('.js') })
  }
}
stagePublic()

/**
 * The page's HTML is `src/views/design/index.html` under the Vite root (the frontend, so that the views compiler
 * sees the core project): emit it at the output's root, with its relative URLs rebased.
 */
function htmlAtRoot(): Plugin {
  const from = 'src/views/design/index.html'
  return {
    name: 'kubuno-design-host-html',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = bundle[from]
      if (!html || html.type !== 'asset') return
      delete bundle[from]
      const source = String(html.source).replace(/(src|href)="(?:\.\.\/)+/g, '$1="./')
      this.emitFile({ type: 'asset', fileName: 'index.html', source })
    },
  }
}

const pkg = JSON.parse(readFileSync(here('./packages/host-runtime/package.json'), 'utf-8')) as { version: string }

/**
 * Project mode: `project/shared.json` (the shared specifiers → their modules, as the host's import map maps them)
 * and `project/entry.js` (copied from `packages/host-runtime/src/entry.js`).
 */
function projectManifest(): Plugin {
  return {
    name: 'kubuno-design-host-project',
    generateBundle(_options, bundle) {
      const byName = new Map<string, string>()
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk' && file.isEntry && file.name) byName.set(file.name, file.fileName)
      }
      const shared: Record<string, string> = {}
      for (const [spec, chunk] of Object.entries(SPECIFIER_TO_CHUNK)) {
        const fileName = byName.get(chunk)
        if (!fileName) this.error(`[host-runtime] no shared module '${chunk}' for '${spec}'`)
        shared[spec] = `dist/${fileName}`
      }
      const page = byName.get('design-page')
      if (page !== `${PROJECT}/design-page.js`) this.error(`[host-runtime] the design page was emitted as ${String(page)}`)
      const manifest = {
        version: 1,
        hostRuntime: pkg.version,
        entry: `dist/${PROJECT}/entry.js`,
        themes: 'dist/themes',
        shared,
      }
      this.emitFile({ type: 'asset', fileName: `${PROJECT}/shared.json`, source: JSON.stringify(manifest, null, 2) + '\n' })
      this.emitFile({ type: 'asset', fileName: `${PROJECT}/entry.js`, source: readFileSync(here('./packages/host-runtime/src/entry.js'), 'utf-8') })
    },
  }
}

/** The host registry the bundled page compiles with (`entry.bundled.tsx` embeds it). */
const HOST_REGISTRY = here('./src/ui/kbview-registry.web.json')
/** Written last, by pass 2: its absence means an unfinished build. */
const BUILD_MANIFEST = 'design-host.json'

/**
 * `dist/design-host.json`, written once both passes are on disk: `{version: 1, hostRuntime, registrySha256, files}`
 * (every other file of `dist/`, sorted, `/`-separated). A consumer that ships the build (the Visual Studio
 * extension's VSIX) checks that every listed file is there and that the registry hash is its source's: a pass-1-only
 * or half-copied `dist/`, or a build older than the registry, is refused instead of shipped.
 */
function buildManifest(): Plugin {
  const list = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? list(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
    )
  return {
    name: 'kubuno-design-host-manifest',
    closeBundle() {
      // Emit the host registry as a standalone file beside the bundle. The bundled page embeds it
      // (entry.bundled.tsx), but the Visual Studio Toolbox / Properties window read a registry FILE
      // (WebRegistry.Load), not the live page: a view bridged to the bundled host (a mobile `.kbview`)
      // has no node_modules/@kubuno/ui/kbview-registry.web.json, so without this copy its Toolbox is
      // empty. Written before the file list below so it ships in design-host.json's `files`.
      cpSync(HOST_REGISTRY, join(OUT, 'kbview-registry.web.json'))
      const files = list(OUT, '').filter((f) => f !== BUILD_MANIFEST).sort()
      if (!files.includes('index.html') || !files.includes(`${PROJECT}/shared.json`)) {
        this.error(`[host-runtime] incomplete build in ${OUT}: run both passes (npm run build:design-host)`)
      }
      const registrySha256 = createHash('sha256').update(readFileSync(HOST_REGISTRY)).digest('hex')
      const manifest = { version: 1, hostRuntime: pkg.version, registrySha256, files }
      writeFileSync(join(OUT, BUILD_MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
    },
  }
}

const aliases = {
  '@ui': here('./src/ui'),
  '@kubuno/sdk': here('./src/sdk/index.ts'),
  '@kubuno/drive': here('./src/drive/index.ts'),
  '@kubuno/views': here('./src/views/index.ts'),
}

// @kubuno/ui is co-located in src/ui with its own package.json (npm `exports` -> built dist/). The `kubuno-source`
// export condition resolves "@ui" to its source index.ts here instead of dist/ (same as the host's vite.config.ts).
const KUBUNO_CONDITIONS = ['kubuno-source', 'module', 'browser']

const versions = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __APP_BUILD__: JSON.stringify(`host-runtime-${pkg.version}`),
}

/** Pass 1: the bundled page. */
const bundled: UserConfig = {
  root: here('.'),
  base: './',
  publicDir: STAGE,
  plugins: [kbview({ generateTypes: false, designServer: false }), react(), tailwindcss(), htmlAtRoot()],
  define: versions,
  resolve: { conditions: KUBUNO_CONDITIONS, alias: aliases },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    chunkSizeWarningLimit: 20000,
    rollupOptions: {
      input: here('./src/views/design/index.html'),
      output: {
        entryFileNames: 'entry.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}

/** Pass 2: the project-mode page and the shared modules (added to pass 1's output). */
const project: UserConfig = {
  root: here('.'),
  base: './',
  // The public files are pass 1's; known here so that the CSS points at them (`../fonts/…`).
  publicDir: STAGE,
  plugins: [kbview({ generateTypes: false, designServer: false }), react(), tailwindcss(), projectManifest(), buildManifest()],
  define: {
    ...versions,
    // React's (and every library's) development build, as a dev server would serve it.
    'process.env.NODE_ENV': JSON.stringify('development'),
  },
  resolve: { conditions: KUBUNO_CONDITIONS, alias: aliases },
  build: {
    outDir: OUT,
    emptyOutDir: false,
    copyPublicDir: false,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 20000,
    rollupOptions: {
      input: {
        'design-page': here('./src/views/design/entry.module.ts'),
        ...sharedEntryInputs(here('.')),
      },
      // Every export of the shared entries stays reachable by the module's code.
      preserveEntrySignatures: 'strict',
      output: {
        entryFileNames: (chunk) => (chunk.name in SHARED_ENTRIES ? `${PROJECT}/shared/[name].js` : `${PROJECT}/[name].js`),
        chunkFileNames: `${PROJECT}/chunks/[name]-[hash].js`,
        assetFileNames: (asset) =>
          (asset.names ?? []).some((n) => n.endsWith('.css')) ? `${PROJECT}/design-page.css` : `${PROJECT}/assets/[name]-[hash][extname]`,
      },
    },
  },
}

export default defineConfig(({ mode }) => (mode === 'project' ? project : bundled))
