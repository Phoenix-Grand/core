<!--
  SPDX-FileCopyrightText: 2026 Kubuno contributors
  SPDX-License-Identifier: AGPL-3.0-or-later
-->

# @kubuno/host-runtime

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://github.com/kubuno/core/blob/main/LICENSE)

**The design host of [Kubuno](https://github.com/kubuno/core) web views: the page that renders `.kbview` /
`.kbcontrol` views in the Visual Studio designer - for a module project through its own development server, and as
a ready-to-serve static site when no server runs.**

The Kubuno extension for Visual Studio shows a web view in a WebView2 document pane. That pane loads one of the two
pages this package ships:

| Mode | When | Served by | Project controls and code-behinds |
|---|---|---|---|
| **project** | the project's Vite dev server runs | the project's dev server, at `/__kubuno_design__/` ([`@kubuno/views-compiler`](../views-compiler)) | real: imported through the dev server, with HMR |
| **bundled** | no dev server (no `node_modules` yet, the server failing, offline) | Visual Studio itself, from `dist/` (`https://kubuno-design.invalid/`) | labelled placeholders, no code-behind |

Both carry the same host runtime: React, the real `@ui` elements and `@kubuno/sdk`, `@kubuno/drive`, the
`@kubuno/views` runtime in design mode, the `.kbview` compiler's WebAssembly and the host registry, the host CSS with
the **production fonts** (byte-identical copies of the core's `public/fonts`, with their licence texts), the core's
translations (the designer offers French, English and Arabic) and the light and dark Kubuno themes
(`kubuno-reference`, `kubuno-dark`).

## Using it in a module project

In the module's `frontend/`:

```bash
npm install --save-dev @kubuno/host-runtime @kubuno/views-compiler@^0.1.2
```

`kbview()` must be in `vite.config.ts` (it already is for a project with views), and `kubuno.views.json` names no
`design.entry`. Tell the page what your entry would load in the host before your views render - your stylesheet and
your translations:

```json
{
  "target": "web",
  "hostRegistry": "node_modules/@kubuno/ui/kbview-registry.web.json",
  "sources": ["src"],
  "design": { "setup": ["src/index.css", "src/i18n.ts"] }
}
```

Then `npm run dev` (or « Démarrer le serveur de développement » in Visual Studio): the designer switches from the
bundled page to the project page, which reports `mode: "project"` and this package's version to Visual Studio.
Nothing else changes: your production build (`vite build`) keeps every shared specifier `external`, resolved by the
host's import map at run time, and your code never imports the core or another module.

## How project mode gets one instance of everything

A module's code imports the host's **shared specifiers** - `react`, `react-dom`, `react-dom/client`,
`react/jsx-runtime`, `react/jsx-dev-runtime`, `@ui`, `@kubuno/sdk`, `@kubuno/drive`, `@kubuno/views`, `i18next`,
`react-i18next`, `zustand`, `@tanstack/react-query`, `react-router-dom`, `@radix-ui/react-dropdown-menu`. In
production none of them is bundled: the host's import map maps each one to the host's single instance. On npm,
`@kubuno/sdk`, `@kubuno/drive` and `@kubuno/views` are type surfaces whose runtime throws, and `@ui` is not even a
package name. In a module's dev server they would resolve to nothing, to throwing stubs, or to copies different
from the page's - a second React breaks every hook, a second `@kubuno/views` does not know the page's views.

So the project-mode build (`dist/project/`) is made the way the host's own build is made:

- **one Rollup build** with the page (`design-page.js`) and one entry per shared module (`shared/<chunk>.js`, the
  same facades and the same `build/shared-entries.ts` list as the host's import map). Rollup never puts a module in
  two chunks, so the page and every shared module share one React, one `@ui`, one i18next, one views runtime;
- **`shared.json`**, the dev-server twin of the import map: every shared specifier → its module in this package,
  generated from the host's own specifier table;
- **`entry.js`**, a small hand-written module the dev server transforms like your own code: it links the page's
  stylesheet, starts the page with an `importModule` that goes through the dev server, and passes Vite's HMR
  updates to the page.

`@kubuno/views-compiler`'s Vite plugin reads `shared.json` and, in `vite serve` only:

1. resolves each shared specifier (the exact specifier, never a subpath such as `zustand/traditional`) to its file
   here, so your code imports the page's instances at the same URLs;
2. keeps those exact specifiers **external in Vite's dependency pre-bundling** (a Rolldown plugin given to
   `optimizeDeps`), so a pre-bundled `lucide-react` or `@react-three/fiber` imports the shared `react` instead of
   bundling a copy (a `require('react')` in CommonJS code gets an ES facade), and removes them from
   `optimizeDeps.include`;
3. serves `entry.js` as `/__kubuno_design__/`'s script, the themes of `dist/themes` at `/__kubuno_design__/themes/`,
   and your `design.setup` modules in `project.json`.

**Why not an import map?** The page could carry an import map pointing the shared specifiers at this package. But
Vite rewrites every bare import of the code it serves to a resolved URL, and pre-bundles the dependencies of your
code with their own copies of `react`: an import map would only see what Vite left bare, and would still leave two
Reacts. Resolving the specifiers in the dev server, and keeping them out of pre-bundling, gives every importer - your
code, its dependencies, the page - the same module at the same URL; the shared modules are built exactly as the
host's import-map targets are, so the design page behaves like the running host.

The project-mode build uses **React's development build** (as a dev server does): readable errors and warnings, and
Fast Refresh of your React parts. The bundled page keeps the production build.

## Bundled mode

The page speaks the designer's protocol with Visual Studio (`window.chrome.webview`): it compiles the unsaved
buffer, renders it, and turns selection, move, resize, reorder, delete and Toolbox drops into edit requests.
The project's own controls cannot run without its development server: they are shown as **labelled
placeholders** (a dashed box with the element's name, and its content inside), their registry entries arriving
from Visual Studio. The toolbar says so. Code-behinds do not run either: a binding resolves against the view's
sample data (`<view>.design.json` → `dataContext`, else its `props`).

Every URL in the bundled build is relative: serve `dist/` from any origin or folder.

## What is in the package

| Path | What |
|---|---|
| `dist/index.html`, `dist/entry.js`, `dist/assets/` | the bundled page (`@kubuno/host-runtime/bundled` is its script) |
| `dist/fonts/`, `dist/themes/` | the production fonts with their licences, the Kubuno themes (both modes) |
| `dist/project/entry.js` | the project-mode entry (`@kubuno/host-runtime/entry`) |
| `dist/project/design-page.js`, `design-page.css` | the project-mode page and its stylesheet |
| `dist/project/shared/*.js`, `dist/project/chunks/` | the host's shared modules |
| `dist/project/shared.json` | shared specifier → module (`@kubuno/host-runtime/shared.json`): `{version: 1, hostRuntime, entry, themes, shared}` |
| `dist/design-host.json` | written last: `{version: 1, hostRuntime, registrySha256, files}` - every file of the build and the hash of the host registry it embeds, checked by the Visual Studio extension's build before it ships `dist/` |

## Build

From the core's frontend (the published package is built by `packages/build.sh`, which `_tools/publish_all.sh`
runs):

```bash
cd core/frontend
npm run build:design-host     # → packages/host-runtime/dist (not committed): bundled page, then --mode project
```

## License

AGPL-3.0-or-later. The fonts keep their own licences (SIL Open Font License 1.1 for Plus Jakarta Sans, Outfit
and DM Mono; Apache 2.0 for Roboto), shipped next to them in `dist/fonts/`.
