/**
 * The host runtime of module projects in the design page (`host-runtime.ts`): reading `@kubuno/host-runtime`'s
 * manifest, resolving the shared specifiers to its modules (exact specifiers only), keeping them out of dependency
 * pre-bundling, the setup modules and the entry / themes of the design route - unit by unit, then on a real Vite dev
 * server over a temporary module project with a fake host runtime package.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { createServer, type Plugin } from 'vite'
import { afterAll, describe, expect, it } from 'vitest'

import { designPageEntryUrl, designSetupUrls, designThemesDir } from '../src/design-server.js'
import {
  CJS_FACADE_PREFIX,
  HOST_RUNTIME_MANIFEST,
  devServerUrl,
  dropShared,
  findHostRuntime,
  parseHostRuntimeManifest,
  prebundleExternals,
  resolveShared,
  usesHostRuntime,
  type HostRuntimeManifest,
} from '../src/host-runtime.js'
import { kbview } from '../src/vite.js'
import { UI_REGISTRY } from './paths.js'

const temp: string[] = []
afterAll(() => {
  for (const d of temp) rmSync(d, { recursive: true, force: true })
})

const MANIFEST: HostRuntimeManifest = {
  version: 1,
  hostRuntime: '9.8.7',
  entry: 'dist/project/entry.js',
  themes: 'dist/themes',
  shared: {
    react: 'dist/project/shared/vendor-react.js',
    'react/jsx-dev-runtime': 'dist/project/shared/vendor-react-jsx.js',
    zustand: 'dist/project/shared/vendor-zustand.js',
    '@ui': 'dist/project/shared/kubuno-shared.js',
    '@kubuno/sdk': 'dist/project/shared/kubuno-shared.js',
  },
}

/** A module project with `@kubuno/host-runtime` installed (a fake one: the manifest and its files). */
function moduleProject(options: { design?: Record<string, unknown>; manifest?: boolean; install?: boolean } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kbview-hostrt-')))
  temp.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'package.json'), '{"name":"module-fixture","private":true,"type":"module"}')
  writeFileSync(join(root, 'kubuno.views.json'), JSON.stringify({ hostRegistry: UI_REGISTRY, ...(options.design ? { design: options.design } : {}) }))
  writeFileSync(join(root, 'src', 'index.css'), '.x{}')
  writeFileSync(join(root, 'src', 'i18n.ts'), 'export {}\n')
  writeFileSync(join(root, 'src', 'Widget.ts'), "import { useState } from 'react'\nimport { create } from 'zustand'\nimport { Button } from '@ui'\nexport const parts = [useState, create, Button]\n")
  if (options.install === false) return root
  const pkg = join(root, 'node_modules', '@kubuno', 'host-runtime')
  mkdirSync(join(pkg, 'dist', 'project', 'shared'), { recursive: true })
  mkdirSync(join(pkg, 'dist', 'themes', 'kubuno-dark'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@kubuno/host-runtime', version: '9.8.7', type: 'module', exports: { './entry': './dist/project/entry.js', './package.json': './package.json' } }))
  if (options.manifest !== false) writeFileSync(join(pkg, HOST_RUNTIME_MANIFEST), JSON.stringify(MANIFEST))
  writeFileSync(join(pkg, 'dist', 'project', 'entry.js'), "import './shared/vendor-react.js'\n")
  for (const f of ['vendor-react.js', 'vendor-react-jsx.js', 'vendor-zustand.js', 'kubuno-shared.js']) {
    writeFileSync(join(pkg, 'dist', 'project', 'shared', f), `export const id = ${JSON.stringify(f)}\nexport default id\n`)
  }
  writeFileSync(join(pkg, 'dist', 'themes', 'kubuno-dark', 'theme.json'), '{"id":"kubuno-dark","vars":{}}')
  return root
}

const PKG_DIR = (root: string): string => join(root, 'node_modules', '@kubuno', 'host-runtime')

describe('the host runtime manifest', () => {
  it('reads a manifest into absolute paths', () => {
    const dir = resolve('/pkg')
    const rt = parseHostRuntimeManifest(dir, JSON.stringify(MANIFEST))
    expect(rt.version).toBe('9.8.7')
    expect(rt.entry).toBe(join(dir, 'dist', 'project', 'entry.js'))
    expect(rt.themes).toBe(join(dir, 'dist', 'themes'))
    expect(rt.shared.get('@ui')).toBe(join(dir, 'dist', 'project', 'shared', 'kubuno-shared.js'))
    expect(rt.shared.get('@kubuno/sdk')).toBe(rt.shared.get('@ui'))
  })

  it('refuses a manifest of another format, without an entry, or naming files outside the package', () => {
    const dir = resolve('/pkg')
    expect(() => parseHostRuntimeManifest(dir, '{')).toThrow(HOST_RUNTIME_MANIFEST)
    expect(() => parseHostRuntimeManifest(dir, JSON.stringify({ ...MANIFEST, version: 2 }))).toThrow(/unsupported format 2/)
    expect(() => parseHostRuntimeManifest(dir, JSON.stringify({ ...MANIFEST, entry: '' }))).toThrow(/no entry/)
    expect(() => parseHostRuntimeManifest(dir, JSON.stringify({ ...MANIFEST, shared: { react: '../../react/index.js' } }))).toThrow(/outside the package/)
    expect(() => parseHostRuntimeManifest(dir, JSON.stringify({ ...MANIFEST, entry: resolve('/elsewhere/entry.js') }))).toThrow(/outside the package/)
  })

  it('finds the installed package from the project root, or reports why it cannot', () => {
    const root = moduleProject()
    const rt = findHostRuntime(root)
    expect(rt?.dir).toBe(PKG_DIR(root))
    expect(rt?.entry).toBe(join(PKG_DIR(root), 'dist', 'project', 'entry.js'))
    expect(findHostRuntime(moduleProject({ install: false }))).toBeNull()
    expect(() => findHostRuntime(moduleProject({ manifest: false }))).toThrow(/predates project mode/)
  })

  it('applies to projects without a design entry of their own', () => {
    expect(usesHostRuntime(undefined)).toBe(true)
    expect(usesHostRuntime({})).toBe(true)
    expect(usesHostRuntime({ entry: 'src/views/design/entry.tsx' })).toBe(false)
  })
})

describe('the shared specifiers', () => {
  const rt = parseHostRuntimeManifest(resolve('/pkg'), JSON.stringify(MANIFEST))

  it('resolve exactly to the host runtime modules, and to externals while Vite scans', () => {
    expect(resolveShared(rt, 'react')).toBe(rt.shared.get('react'))
    expect(resolveShared(rt, '@ui')).toBe(rt.shared.get('@ui'))
    expect(resolveShared(rt, '@kubuno/host-runtime/entry')).toBe(rt.entry)
    // Subpaths are not shared: they keep their normal resolution.
    expect(resolveShared(rt, 'zustand/traditional')).toBeNull()
    expect(resolveShared(rt, 'react-dom/server')).toBeNull()
    expect(resolveShared(rt, 'lucide-react')).toBeNull()
    expect(resolveShared(rt, 'react', true)).toEqual({ id: 'react', external: true })
    expect(resolveShared(rt, 'lucide-react', true)).toBeNull()
  })

  it('stay external in pre-bundled dependencies, with an ES facade for require()', () => {
    const p = prebundleExternals(rt)
    expect(p.resolveId('react', '/x/lucide.js', { kind: 'import-statement' })).toEqual({ id: 'react', external: true })
    expect(p.resolveId('react', '/x/shim.js', { kind: 'require-call' })).toEqual({ id: CJS_FACADE_PREFIX + 'react' })
    expect(p.resolveId('zustand/traditional', '/x/fiber.js', { kind: 'import-statement' })).toBeNull()
    expect(p.resolveId('three', '/x/fiber.js', { kind: 'import-statement' })).toBeNull()
    expect(p.load(CJS_FACADE_PREFIX + 'react')).toBe('import * as m from "react";\nmodule.exports = { ...m };\n')
    expect(p.load('/x/lucide.js')).toBeNull()
  })

  it('are dropped from optimizeDeps.include, the rest kept', () => {
    const include = ['react', 'react-dom', 'react/jsx-dev-runtime', 'lucide-react', '@kubuno/host-runtime/entry']
    expect(dropShared(include, rt)).toBe(3)
    expect(include).toEqual(['react-dom', 'lucide-react'])
    expect(dropShared(undefined, rt)).toBe(0)
  })
})

describe('the design route of a module project', () => {
  it('maps files to dev-server URLs inside and outside the project', () => {
    const root = resolve('/work/module')
    expect(devServerUrl(root, join(root, 'node_modules', '@kubuno', 'host-runtime', 'dist', 'project', 'entry.js'))).toBe('/node_modules/@kubuno/host-runtime/dist/project/entry.js')
    expect(devServerUrl(root, resolve('/opt/shared/entry.js'))).toBe('/@fs/' + resolve('/opt/shared/entry.js').split(sep).join('/').replace(/^\/+/, ''))
    expect(devServerUrl(root, resolve('/work/module-other/x.js'))).toMatch(/^\/@fs\//)
  })

  it('lists the setup modules as URLs, skipping what is not one', () => {
    const root = moduleProject()
    expect(designSetupUrls(root, ['src/index.css', './src/i18n.ts', '/src/i18n.ts', 'some-package/style.css', '../outside.css', 42, ''])).toEqual([
      '/src/index.css',
      '/src/i18n.ts',
      '/src/i18n.ts',
      '/@id/some-package/style.css',
    ])
    expect(designSetupUrls(root, 'src/index.css')).toEqual([])
    expect(designSetupUrls(root, undefined)).toEqual([])
  })

  it('takes the entry and the themes from the host runtime when the project names none', () => {
    const root = moduleProject()
    const rt = findHostRuntime(root)
    expect(designPageEntryUrl(root, {}, rt)).toBe('/node_modules/@kubuno/host-runtime/dist/project/entry.js')
    expect(designPageEntryUrl(root, { entry: 'src/design.tsx' }, rt)).toBe('/src/design.tsx')
    expect(designPageEntryUrl(root, {}, null)).toBe('/@id/@kubuno/host-runtime/entry')
    expect(designThemesDir(root, {}, rt)).toBe(join(PKG_DIR(root), 'dist', 'themes'))
    expect(designThemesDir(root, { themes: 'themes' }, rt)).toBe(join(root, 'themes'))
    expect(designThemesDir(root, { entry: 'src/design.tsx' }, rt)).toBeNull()
  })
})

describe('a module project on a real dev server', () => {
  /** What `@vitejs/plugin-react` does: ask for React to be pre-bundled. */
  const askForReact: Plugin = { name: 'ask-for-react', config: () => ({ optimizeDeps: { include: ['react', 'react/jsx-dev-runtime'] } }) }

  it('serves the host runtime page and resolves the shared specifiers to its modules', async () => {
    const root = moduleProject({ design: { setup: ['src/index.css', 'src/i18n.ts'] } })
    const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [kbview(), askForReact], server: { host: '127.0.0.1', port: 5382 } })
    await server.listen()
    try {
      const base = `http://127.0.0.1:${server.config.server.port}/`
      const html = await (await fetch(`${base}__kubuno_design__/`)).text()
      expect(html).toContain('<script type="module" src="/node_modules/@kubuno/host-runtime/dist/project/entry.js"></script>')

      const info = await (await fetch(`${base}__kubuno_design__/project.json`)).json()
      expect(info.setup).toEqual(['/src/index.css', '/src/i18n.ts'])
      expect(info.themes).toEqual(['kubuno-dark'])
      expect((await fetch(`${base}__kubuno_design__/themes/kubuno-dark/theme.json`)).status).toBe(200)

      // Never pre-bundled: plugin-react's include lost the shared specifiers.
      expect(server.config.optimizeDeps.include).toEqual([])
      expect(server.environments.client.config.optimizeDeps.include).toEqual([])
      expect(server.config.optimizeDeps.exclude ?? []).not.toContain('zustand')

      const importer = join(root, 'src', 'Widget.ts')
      expect((await server.pluginContainer.resolveId('react', importer))?.id).toBe(join(PKG_DIR(root), 'dist', 'project', 'shared', 'vendor-react.js'))
      expect((await server.pluginContainer.resolveId('@ui', importer))?.id).toBe(join(PKG_DIR(root), 'dist', 'project', 'shared', 'kubuno-shared.js'))

      // The project's code imports them at the host runtime's URLs, the same for every importer.
      const out = await server.transformRequest('/src/Widget.ts')
      expect(out?.code).toContain('/node_modules/@kubuno/host-runtime/dist/project/shared/vendor-react.js')
      expect(out?.code).toContain('/node_modules/@kubuno/host-runtime/dist/project/shared/vendor-zustand.js')
      expect(out?.code).toContain('/node_modules/@kubuno/host-runtime/dist/project/shared/kubuno-shared.js')
      const entry = await (await fetch(`${base}node_modules/@kubuno/host-runtime/dist/project/entry.js`)).text()
      expect(entry).toContain('/node_modules/@kubuno/host-runtime/dist/project/shared/vendor-react.js')
    } finally {
      await server.close()
    }
  })

  it('leaves a project with its own design entry, or without the package, as it was', async () => {
    for (const root of [moduleProject({ design: { entry: 'src/Widget.ts' } }), moduleProject({ install: false })]) {
      const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [kbview(), askForReact], server: { middlewareMode: true } })
      try {
        expect(server.config.optimizeDeps.include).toEqual(['react', 'react/jsx-dev-runtime'])
        expect(await server.pluginContainer.resolveId('@ui', join(root, 'src', 'Widget.ts'))).toBeNull()
      } finally {
        await server.close()
      }
    }
  })

  it('changes nothing in a build', async () => {
    const root = moduleProject()
    const plugin = kbview()
    const config = (plugin.config as (c: object, e: { command: string; mode: string }) => unknown)({ root }, { command: 'build', mode: 'production' })
    expect(config).toBeUndefined()
  })
})
