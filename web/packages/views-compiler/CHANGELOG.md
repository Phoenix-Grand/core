# Changelog — @kubuno/views-compiler

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are
added under `[Unreleased]` **as the change is made**; on npm publish, the section is stamped
under the published version number.

## [Unreleased]

## [0.1.6] - 2026-10-13

### Added

- **A user control can take a value-transforming function as a property, not only an event.** A function field in a
  control's `x:Props` is an event (`OnX`) only when it returns nothing (`(v) => void`); a function that returns a
  value (`format: (n) => string`, a comparator, a key extractor) now becomes an ordinary bindable property, bound to
  a getter that returns the function. Before, every function field was forced to an event, so a control with a
  formatter-style prop could not be used as a native element where that prop was set.


## [0.1.5] - 2026-10-13

### Added

- **User controls can host child elements (slots).** A `.kbcontrol` whose `x:Props` type has a `children:
  ReactNode` field now accepts child elements when used as a native element, exactly like `Panel` or `Stack`:
  `<Figure Label="…"><Label Text="…"/></Figure>` compiles, and the children are rendered into the control's
  `children` prop. Previously the compiler rejected any child of a user control (`KBV-children: <X> takes no
  child element`), so a control built around a `children` slot could only be used through a React host hole.
  Rebuild the `.wasm` (`npm run build:wasm`, from the matching `web-views-compiler-core` tag) to pick up the
  compiler side.

## [0.1.4] - 2026-10-13

### Added

- **User controls become native, typed elements (WV-7).** `userControlsOf` now reads each `.kbcontrol`'s
  `x:Props` type from its code-behind (through the TypeScript API, already a peer dependency — no new
  dependency) and hands its members to the compiler: a value field becomes a bindable property, a function
  field becomes an event. Another view can then use the control as a typed element (`<SearchResultRow
  File="{Binding file}" OnOpen="handler"/>`) and binding an object or wiring a function type-checks. A control
  without `x:Props` keeps the earlier pass-through behaviour. Rebuild the `.wasm` (`npm run build:wasm`, from
  the matching `web-views-compiler-core` tag) to pick up the compiler side.

## [0.1.3] - 2026-10-06

### Changed

- **The WebAssembly compiler is built from the core repository.** Kubuno Desktop, which holds the `.kbview`
  compiler (`kubuno-web-views-compiler-core`), moved into the core repository (`desktop/common`); the `.wasm` is now
  built from its tag `web-views-compiler-core-v0.2.1` there and reports that version (`compiler.version()` gives
  `0.2.1`, the ABI is unchanged). It compiles views exactly as before. `npm run build:wasm -- --local` builds it from
  the repository's own `desktop/` (`--desktop <checkout>` still accepts a former `kubuno/desktop` checkout).

## [0.1.2] - 2026-10-06

### Added

- **Module projects open in the Visual Studio designer with their own code.** With `@kubuno/host-runtime` installed
  as a devDependency, a module's development server serves that package's design page, and the module's views render
  with their code-behinds, their own controls and React parts, the host's real elements, translations and themes —
  instead of placeholders. The host's shared libraries (`react`, `@ui`, `@kubuno/sdk`, `@kubuno/drive`,
  `@kubuno/views`, `i18next`, `zustand`, …) resolve to the package's single copies, as the host's import map does in
  production, so the page and the module share one instance of each. Production builds are unchanged.
- **`design.setup` in `kubuno.views.json`**: the project modules the design page loads before it shows a view (the
  module's stylesheet and translations, e.g. `["src/index.css", "src/i18n.ts"]`).
- The design page of a module project offers the host runtime's light and dark Kubuno themes when
  `design.themes` is not set.

## [0.1.1] - 2026-10-05

### Added

- **String resources as `.kbres` sets.** `import strings from './strings.kbres'` gives the set's i18next bundles by
  language (`{ en: {…}, fr: {…} }`, ready for `registerModuleTranslations`): the neutral file (its language named by
  `<Resources Culture="en">`, English when absent) and its `strings.<lang>.kbres` satellites, dotted names nested as
  i18next keys, plural forms kept (`files_one`, `files_other`). A satellite edit reloads the set in `vite serve`. Add
  `/// <reference types="@kubuno/views-compiler/client" />` for the `*.kbres` module type.
- **`{Res}` with arguments and plurals in views.** `{Res files_count, Count={Binding n}, Name={Binding user.name}}`:
  the arguments fill the string's `{{count}}` / `{{name}}` placeholders and `Count` picks the plural form of the
  language, as i18next does; a bound argument is type-checked like any binding (`kbview-tsc`).
- **`kbres-convert`**, a converter from existing dictionaries to `.kbres` sets: `locales/<lang>/<ns>.json` folders
  (`--json`) or `i18n.ts` modules calling `registerModuleTranslations` (`--module`, read statically). Every set is
  read back and compared before the command succeeds: every key, value and key order of every language identical.
  `--check` compares an existing set with its source.
- **The development server serves the Visual Studio design surface.** While `vite serve` runs, the page the
  Kubuno extension for Visual Studio shows in its web view designer is available at `/__kubuno_design__/`, with
  what it needs to render your views with your own controls (`/__kubuno_design__/project.json`, the Kubuno themes),
  and `.kubuno/design-server.json` tells Visual Studio the server's address (removed when it stops). The page
  comes from `kubuno.views.json` → `design.entry`; `kbview({ designServer: false })` turns the route off.

### Fixed

- **A project opened through a link** (a folder junction, `C:\kubuno-build` → `E:\kubuno-build`, or a symbolic link):
  Vite hands out the real paths of the files, which the plugin took for files outside the project, so a view's
  imports of the project's own controls pointed nowhere (`../../../…/src/…`) and its generated types went under
  `_external/`. A file inside the project through a link now keeps its project path.
- **Generated files of deleted views are removed.** `kbview-tsc` and the Vite plugin delete the `.d.ts`, check file and
  span map of a view that no longer exists (renamed, moved, or turned back into TSX): left behind, the check file
  would still be type-checked against a code-behind that is gone.
- **Generated files never leave `.kubuno/views`.** A view outside the project root (a sibling folder, another
  drive) had its `.d.ts`, check file and span map written outside the project's `.kubuno/views` folder; they now
  go under `.kubuno/views/_external/` followed by the view's absolute path (`generatedRelPath`, the same rule as
  the Kubuno language server).

## [0.1.0] - 2026-10-05

### Fixed

- **`kbview-tsc` no longer warns about a missing `.kubuno/views` setup in projects with a solution-style
  `tsconfig.json`** (`files: []` + `references`, the Vite template): it now also looks in the referenced
  projects (such as `tsconfig.app.json`), where the setup lives.

- **A compiled view finds its components even inside an import cycle.** A view of an application whose own
  code imports back into it (the core's shell views) could be evaluated before the components it uses; it
  now looks them up when it renders.
- **A list or object property of a custom control can be bound.** A property that the registry describes as a
  list or an object was type-checked as a string, so `Apps="{Binding apps}"` failed `kbview-tsc`.

### Added

- **First version: the build-time tooling of `.kbview` web views.** The package compiles the declarative
  `.kbview` views of the Kubuno web UI with the same parser and validator as the desktop (shipped as
  WebAssembly, so no Rust toolchain is needed to build a module, online or offline), and contains:
  - a **Vite plugin** (`kbview()`) that turns each view into a module (its render plan, its generated
    `ViewBase` class), maps every binding and handler back to its line in the `.kbview` in the browser's
    debugger, fails the build with file, line and column on an error, and keeps the screen's state when a
    view or its code-behind is edited during development;
  - **`kbview-tsc`**, to use instead of `tsc`: it also type-checks every `{Binding …}` and every handler
    against the code-behind and reports the problems at the attribute in the `.kbview`;
  - a browser entry (`@kubuno/views-compiler/browser`) for the Visual Studio design surface.
  A view can only use the host's elements and its own module's controls: anything else is an error.

### Changed

- **Views may declare their XML namespaces** (`xmlns="https://kubuno.com/views"`, `xmlns:x="https://kubuno.com/views/x"`,
  `xmlns:d="https://kubuno.com/views/design"` on the root element, vskubuno `docs/VIEWS-SPEC.md` §3): the compiler
  ignores them as markup (never a property), so a view compiles the same with or without them. The test views now
  declare them, except `errors.kbview`, kept without to cover the undeclared form.
