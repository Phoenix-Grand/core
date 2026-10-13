import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { importMapPlugin } from './build/importmap-plugin'
import { sharedEntryInputs } from './build/shared-entries'
// The .kbview / .kbcontrol compiler (vskubuno docs/WEB-VIEWS.md, WV-2): the core's own views and user controls
// (registries and folders: kubuno.views.json).
import { kbview } from './packages/views-compiler/dist/index.js'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { version: string }

/**
 * Version strings injected at build time as `__APP_VERSION__` / `__APP_BUILD__`
 * (see src/vite-env.d.ts), derived from git the way `build_deb.sh` derives the
 * package build id. The point is that a screenshot of the login page names the
 * commit it was built from — `package.json` alone only moves on a release, so
 * between two releases it can say nothing useful.
 *
 *   released (clean tree, HEAD on tag `v<version>`)   0.1.5
 *   development                                       0.1.5-42.g1a2b3c
 *   uncommitted changes                               0.1.5-42.g1a2b3c.dirty
 *
 * One deliberate difference from `build_deb.sh`: no UTC timestamp after `dirty`.
 * These strings are baked into the bundle, so a value that changes on every build
 * would change the chunk content-hash on every build — defeating the stable-hash
 * scheme the shared chunks rely on (see SHARED_CHUNK below) and leaving a fresh
 * copy of every shared chunk in the deployed `shared/` directory each time.
 *
 * Falls back to the bare package version when git is unavailable (tarball builds).
 */
function versionStrings(): { display: string; build: string } {
  const git = (...args: string[]): string | null => {
    try {
      return execFileSync('git', args, {
        cwd: fileURLToPath(new URL('.', import.meta.url)),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim()
    } catch {
      return null
    }
  }

  const commit = git('rev-parse', '--short=7', 'HEAD')
  const count  = git('rev-list', '--count', 'HEAD')
  if (!commit || !count) return { display: pkg.version, build: pkg.version }

  const dirty = (git('status', '--porcelain') ?? '') !== ''
  const onTag = git('describe', '--exact-match', '--tags', 'HEAD') === `v${pkg.version}`

  // A tagged, clean tree *is* the release: show the plain SemVer, nothing else.
  if (onTag && !dirty) return { display: pkg.version, build: pkg.version }

  return {
    display: `${pkg.version}-${count}`,
    build:   `${pkg.version}-${count}.g${commit}${dirty ? '.dirty' : ''}`,
  }
}

const VERSION = versionStrings()

// Shared chunks targeted by the host import map (@ui/@kubuno/*/vendors).
// They are emitted under `shared/` but WITH a content-hash in the name, like the
// rest of the assets: the import map plugin reads the real (hashed) fileName, and
// the host app plus every module all point at the SAME hashed URL → the single
// shared instance is preserved. The hash makes the URL change whenever the content
// changes, which busts iOS Safari's memory/bfcache (keyed by URL, and it ignores
// `no-store` as long as the URL is stable) — the source of stale content on iPhone.
// Trade-off: the inline import map changes hash → the core re-reads
// `importmap.sha256` on (re)start, which every frontend deployment does anyway.
const SHARED_CHUNK = (name: string | undefined) =>
  name === 'kubuno-shared' || name === 'drive-shared' || name === 'kubuno-views' || (name?.startsWith('vendor-') ?? false)

export default defineConfig({
  plugins: [kbview(), react(), tailwindcss(), importMapPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(VERSION.display),
    __APP_BUILD__:   JSON.stringify(VERSION.build),
  },
  resolve: {
    alias: {
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
      '@kubuno/sdk': fileURLToPath(new URL('./src/sdk/index.ts', import.meta.url)),
      '@kubuno/drive': fileURLToPath(new URL('./src/drive/index.ts', import.meta.url)),
      // The .kbview runtime (vskubuno docs/WEB-VIEWS.md, WV-3): one instance, served to modules by the import map.
      '@kubuno/views': fileURLToPath(new URL('./src/views/index.ts', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        // The shared modules the import map points at (@ui, @kubuno/sdk, @kubuno/drive, @kubuno/views, the
        // singleton vendors): one entry each, listed in build/shared-entries.ts (also built into
        // @kubuno/host-runtime for module projects in the Visual Studio designer).
        ...sharedEntryInputs(fileURLToPath(new URL('.', import.meta.url))),
      },
      // Keeps every export of the kubuno-shared entry reachable by the modules.
      preserveEntrySignatures: 'strict',
      output: {
        // Consolide la surface partagée (registries/stores/i18n/@ui/SDK) dans UN
        // seul chunk, pour que host ET modules en partagent une seule instance.
        // Les paquets vendor (react, zustand…) sont gérés par les entrées-facades.
        manualChunks(id: string) {
          // Capture vocale : chargée à la demande (import dynamique) → la garder
          // hors du chunk eager kubuno-shared. AVANT la règle /src/core/.
          if (/\/src\/core\/shell\/voiceStt/.test(id)) return undefined
          // The views runtime keeps its own chunk (@kubuno/views in the import map). BEFORE the sdk/ui rules.
          if (/\/src\/views\//.test(id)) return 'kubuno-views'
          if (/\/src\/sdk\//.test(id)) return 'kubuno-shared'
          if (/\/src\/ui\//.test(id)) return 'kubuno-shared'
          // core/components peut tirer du lourd (PdfViewerModal→pdfjs) : ne pas
          // le forcer dans le chunk eager.
          if (/\/src\/core\/components\//.test(id)) return undefined
          // Les arbres de PAGES (console d'admin, réglages, installation) ne font
          // PAS partie de la surface singleton de l'import map (@kubuno/sdk ne les
          // réexporte pas). Les sortir du chunk eager kubuno-shared pour qu'ils
          // soient chargés à la demande — il FAUT que App.tsx les importe en
          // React.lazy, sinon ils restent tirés dans le graphe eager. AVANT la
          // règle /src/core/ ci-dessous.
          if (/\/src\/core\/(admin|settings|setup)\//.test(id)) return undefined
          // TOUT le reste de core (i18n, stores, registries, hooks, api, shell…)
          // → kubuno-shared (instance unique partagée). AVANT la règle drive pour
          //   qu'aucun singleton core ne fuie dans le chunk drive-shared.
          if (/\/src\/core\//.test(id)) return 'kubuno-shared'
          if (/\/src\/drive\//.test(id)) return 'drive-shared'
          return undefined
        },
        entryFileNames(chunk: { name?: string }) {
          return SHARED_CHUNK(chunk.name) ? 'shared/[name]-[hash].js' : 'assets/[name]-[hash].js'
        },
        chunkFileNames(chunk: { name?: string }) {
          return SHARED_CHUNK(chunk.name) ? 'shared/[name]-[hash].js' : 'assets/[name]-[hash].js'
        },
      },
    },
  },
  server: {
    proxy: {
      '/api':      'http://localhost:8080',
      '/ws':       { target: 'ws://localhost:8080', ws: true },
      '/internal': 'http://localhost:8080',
      '/modules':  'http://localhost:8080',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
    },
  },
})
