<!--
  SPDX-FileCopyrightText: 2026 Kubuno contributors
  SPDX-License-Identifier: AGPL-3.0-or-later
-->

# @kubuno/views-compiler

[![npm](https://img.shields.io/npm/v/@kubuno/views-compiler.svg)](https://www.npmjs.com/package/@kubuno/views-compiler)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://github.com/kubuno/core/blob/main/LICENSE)

**The build-time side of `.kbview` views for the [Kubuno](https://github.com/kubuno/core) web UI.**

A `.kbview` file describes a screen declaratively - the same XML format, element names, `{Binding}` and
`{Res}` grammar as the Kubuno desktop views - and a same-stem TypeScript **code-behind** class holds its
state and handlers (WinForms style). This package turns the view into code the browser runs and checks
it against the code-behind:

- **The compiler, as WebAssembly.** The parser and validator are the Rust crates shared with the desktop
  and the language server (`kubuno-views-syntax`, `kubuno-views-web`). The package ships the built
  `wasm/kubuno-views-web.wasm`: installing it never needs a Rust toolchain, and a module still builds
  offline. The same `.wasm` runs in Node (Vite plugin, `kbview-tsc`) and in a browser
  (`@kubuno/views-compiler/browser`, the Visual Studio design surface).
- **A Vite plugin**, `kbview()`: `X.kbview` becomes an ES module exporting the render **plan** (components
  imported from `@ui` / `@kubuno/sdk` / your own controls, Lucide icons imported by name, every binding
  with a precompiled getter/setter) and the generated **`ViewBase`** class the code-behind extends. Source
  maps point every accessor and every handler call to its attribute in the `.kbview`. Errors fail the build
  and appear in the dev overlay with file, line and column.
- **Generated types**: `.kubuno/views/**/X.kbview.d.ts` (one typed handle per `x:Name`, one abstract method
  per handler) and `X.kbview.check.ts` (every binding written as TypeScript against your code-behind).
- **`kbview-tsc`**: `tsc` plus the views. It compiles every view, writes the generated files, runs your
  project's TypeScript and reports binding and handler errors **at the `.kbview` attribute**:

  ```
  src/Settings.kbview(12,34): error TS2339: Property 'titel' does not exist on type 'Settings'.
  src/Settings.kbview(14,40): error TS2515: handler 'save_click' of Button.OnClick is missing from the code-behind: …
  ```
- **HMR that keeps state**: editing a `.kbview` swaps the new plan into the live view (fields, `@bind`
  values and element handles kept); editing the code-behind moves the live instances onto the new class.

The runtime that renders plans is **`@kubuno/views`**, provided by the Kubuno host through its import map.

## Install

```bash
npm install -D @kubuno/views-compiler @kubuno/views
```

Peer dependencies: `typescript` (always) and `vite` (for the plugin). Node.js ≥ 20.19.

## Set up a module

`vite.config.ts` - add the plugin and keep `@kubuno/views` external like the other host singletons:

```ts
import react from '@vitejs/plugin-react'
import { kbview } from '@kubuno/views-compiler'

const SHARED = ['react', 'react-dom', 'react/jsx-runtime', '@ui', '@kubuno/sdk', '@kubuno/views' /* … */]

export default defineConfig({
  plugins: [kbview(), react()],
  build: { rollupOptions: { external: SHARED } },
})
```

`tsconfig.json` - let TypeScript see the generated files next to your sources:

```jsonc
{
  "compilerOptions": { "rootDirs": [".", ".kubuno/views"] },
  "include": ["src", ".kubuno/views"]
}
```

`package.json` - type-check with `kbview-tsc` instead of `tsc`:

```json
{ "scripts": { "typecheck": "kbview-tsc -b", "build": "kbview-tsc -b && vite build" } }
```

Add `.kubuno/views/` to `.gitignore`: generated files are never committed.

Optional `kubuno.views.json` at the project root:

```json
{
  "target": "web",
  "registries": ["src/kbview-controls.json"],
  "sources": ["src"],
  "hostRegistry": "node_modules/@kubuno/ui/kbview-registry.web.json"
}
```

`registries` lists the project's own control registries (same schema as the host's), whose `web.module`
paths are relative to the registry file. By default the host registry is found in
`node_modules/@kubuno/ui`.

## A view and its code-behind

```xml
<!-- src/Counter.kbview -->
<Card Title="{Res counter_title}">
  <Button x:Name="inc" Text="{Binding label}" OnClick="inc_click"/>
</Card>
```

```ts
// src/Counter.ts
import { bind, type Button, type MouseEventArgs } from '@kubuno/views'
import { ViewBase } from './Counter.kbview'

export class Counter extends ViewBase {
  @bind accessor count = 0
  get label() { return `Clicked ${this.count} times` }
  inc_click(_sender: Button, _e: MouseEventArgs) { this.count++ }
}
export default Counter.component()
```

`@bind accessor` is a standard (TC39) decorator; the plugin lowers it for the browser. The class must be
exported under the file's name.

## Module isolation

A view may only use the host's elements (`@ui`, `@kubuno/sdk`, `@kubuno/views`) and its own project's
controls and user controls (`.kbcontrol`). A control resolving to anything else - another module's
package - is a compile **error**, and the generated code only imports host singletons, `lucide-react` and
the project's own files.

## The Visual Studio design surface

In `vite serve`, the plugin also serves the page the Kubuno extension for Visual Studio shows in its web view
designer, so the designer renders your views with **your project's own controls and code-behinds**:

| Route | What |
|---|---|
| `/__kubuno_design__/` | the design page (its entry: `kubuno.views.json` → `design.entry`, else `@kubuno/host-runtime/entry`) |
| `/__kubuno_design__/project.json` | the registries (host, then the project's, with project-local modules as `/src/…`), the user controls, the plan ABI, the compiler version and the setup modules (`design.setup`) |
| `/__kubuno_design__/themes/<id>/…` | the Kubuno themes of `design.themes`, else the host runtime's (`theme.json` and CSS only) |

While the server listens, `.kubuno/design-server.json` (`{version, urls, designPath, pid, root}`) tells Visual
Studio where to find it; the file is removed when the server stops. Turn the route off with
`kbview({ designServer: false })`.

`kubuno.views.json` → `design`:

| Key | What |
|---|---|
| `entry` | the page's entry module, project-root-relative. Only the core names one (`src/views/design/entry.tsx`); a module leaves it out and gets `@kubuno/host-runtime`'s page. |
| `themes` | a folder of Kubuno themes (`<id>/theme.json` + CSS). Default: the host runtime's light and dark Kubuno themes. |
| `setup` | project modules the page imports, in order, before it renders a view: what the project's own entry loads in the host - typically its stylesheet and its translations. Project-root-relative files, or bare specifiers. |

### Module projects: `@kubuno/host-runtime`

A module's code imports the host's shared specifiers (`react`, `react-dom`, `react/jsx-runtime`, `@ui`,
`@kubuno/sdk`, `@kubuno/drive`, `@kubuno/views`, `i18next`, `react-i18next`, `zustand`, `@tanstack/react-query`,
`react-router-dom`, `@radix-ui/react-dropdown-menu`). In production they are `external` and the host's import map
gives every module the host's single instance of each; on npm, `@kubuno/sdk`, `@kubuno/drive` and
`@kubuno/views` are type surfaces whose runtime throws. Add **`@kubuno/host-runtime`** as a devDependency and, in
`vite serve`, for a project without `design.entry`, the plugin:

- serves the package's project-mode page at `/__kubuno_design__/` (registries, controls and code-behinds from your
  dev server, HMR kept);
- resolves each shared specifier - the exact specifiers its `dist/project/shared.json` lists, never their subpaths -
  to the package's module of the same name, built together with the page: one React, one `@ui`, the real sdk,
  drive and views runtime, i18next with the core's translations, for the page and your code alike;
- keeps those specifiers external in Vite's dependency pre-bundling (a pre-bundled `lucide-react` or
  `@react-three/fiber` imports the shared `react` instead of bundling a copy), and removes them from
  `optimizeDeps.include` (`@vitejs/plugin-react` adds `react` there).

Your production build is untouched (the plugin does none of this in `vite build`), and your code never imports the
core or another module. Without the package, the dev server warns and the route serves no page.

```json
{ "design": { "setup": ["src/index.css", "src/i18n.ts"] } }
```

The core's own `kubuno.views.json`:

```json
{ "design": { "entry": "src/views/design/entry.tsx", "themes": "../themes" } }
```

## Rebuilding the WebAssembly (maintainers)

```bash
npm run build:wasm                                   # the git tag of wasm/Cargo.toml
node scripts/build-wasm.mjs --local                 # this repository's own desktop/ (development)
```

Needs Rust with the `wasm32-unknown-unknown` target; Linux, Windows and macOS alike. `wasm/BUILD-INFO.json`
records the compiler tag, the toolchain and the checksum of the committed `.wasm`.

## Tests

```bash
npm run test:views    # from core/frontend: compiler, kbview-tsc, Vite plugin, HMR in Chrome, runtime conformance
```

The HMR test drives a real headless Chrome (`KBVIEW_CHROME`, else the usual install path); it is skipped
when none is found.

## License

[AGPL-3.0-or-later](https://github.com/kubuno/core/blob/main/LICENSE) © Kubuno contributors.
