// SPDX-FileCopyrightText: 2026 Kubuno contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `@kubuno/host-runtime/entry` - the Visual Studio design page of a MODULE project, in project mode.
 *
 * Loaded by the module's own Vite dev server at `/__kubuno_design__/` (`@kubuno/views-compiler`'s plugin, for a
 * project whose `kubuno.views.json` names no `design.entry`). Copied untouched into `dist/project/entry.js` by the
 * package's build: the dev server transforms it like the project's own code, so `import.meta.hot` and the dynamic
 * `import()` of the project's modules work here, which they could not in the prebuilt page.
 *
 * - the page's stylesheet (the host CSS, its fonts, the surface's chrome) is linked first, so that the project's
 *   own stylesheet (`design.setup`) lands after it, as in the host;
 * - `design-page.js` is the prebuilt page, built with the host's shared modules (`./shared/*`), which the plugin
 *   gives the project's code for `react`, `@ui`, `@kubuno/sdk`, `@kubuno/drive`, `@kubuno/views`, … - one instance
 *   of each for the page and the project;
 * - a module of the project changed on disk (HMR): the page picks up the latest code-behind and controls.
 */
const css = document.createElement('link')
css.rel = 'stylesheet'
css.href = new URL('./design-page.css', import.meta.url).href
await new Promise((done) => {
  css.onload = done
  css.onerror = done
  document.head.prepend(css)
})

const { startModuleDesign } = await import('./design-page.js')

const surface = startModuleDesign((specifier) => import(/* @vite-ignore */ specifier))

if (import.meta.hot) {
  import.meta.hot.on('vite:afterUpdate', (payload) => {
    void surface.modulesUpdated(payload.updates.map((u) => u.path))
  })
}
