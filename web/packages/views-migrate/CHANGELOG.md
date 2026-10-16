# Changelog - @kubuno/views-migrate

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are
added under `[Unreleased]` **as the change is made**; on npm publish, the section is stamped
under the published version number.

## [Unreleased]

### Added

- **Views and user controls told apart.** Each screen is classified before it is converted, from how the project uses
  it: a page a route renders (a route table, `RouteRegistry.register`, a `lazy` route, what the app's root component
  renders in place of its routes), a window or a dialog becomes a view (`X.kbview`); a component other components
  place (JSX, a view's `ReactHost`, a host's slot or extension point) becomes a user control (`X.kbcontrol`, its markup
  inside `<UserControl x:Props="…">`, its props its properties and its callbacks its events). The report says what each
  screen is and why.
- **`--layout --app-root <dir>`**: the converted files go to the folder of their role under the app root - `views/`
  (pages, windows), `dialogs/`, `pages/` (the user controls one component places, and the rows its lists repeat) and
  `controls/` (the user controls several components place) - and every importer follows.
- **`--relayout`** does the same for the views a project already has: each one classified again (`.kbview` ↔
  `.kbcontrol`, the root wrapped in or taken out of `<UserControl>`), moved with `git mv` so its history follows,
  every relative import of the project rewritten (`import`, `export … from`, `import()`, `vi.mock()`), the headers of
  the code-behind and parts renamed. `--components` places the React components the same way; a folder holding more
  than a dozen views (`--split`) is split by role like the app root, a feature folder below keeps its views and user
  controls side by side; `--place <unit>=<dir>` puts a unit in a feature folder, `--move <from>=<to>` moves any other
  file, `--exclude <dir>` leaves a folder alone.
- A user control is an element named after its file: two user controls of one project, or a user control and a host
  element, cannot share a name. `--relayout` stops on such a clash and names the files; `--rename <view>=<Name>`
  renames the user control's files and its class.

## [0.1.2] - 2026-10-06

### Fixed

- **Default texts reach the screen.** The `defaultValue`s of strings missing from the bundles went to
  `src/views-defaults.json`, which nothing loads; a module with a generated catalogue (`src/i18n.data.json` and its
  `i18n.ts`) now gets them in its fallback language, and `src/gen_i18n.mjs` is run again to regenerate `i18n.ts`.
  Only texts with neither bundle nor catalogue still go to `views-defaults.json`, and the run says that nothing loads
  it (`storeDefaults`, exported).
- **A type the file names otherwise is written through its module**: a getter typed `Folder[]` (a module's
  `Folder`) in a file importing the `Folder` icon is typed `import("@kubuno/drive").Folder[]`, and the icon is no
  longer imported by the code-behind when only the view uses it.
- **A helper used only inside a template literal is copied with the code using it** (`url('${absUrl(u)}')` in a
  part's CSS): uses are found by TypeScript's parser instead of text patterns, so neither strings, comments nor JSX
  text count as uses, and template expressions always do.
- **A static `style` next to a computed `className` is kept** in the computed `Class` (`[background:#fff]`).
- **Several text runs stay several text nodes**: `<span>{used} / {quota}</span>` gives the `Label` a list of runs,
  rendered as React rendered them (the page's text and accessibility tree are the TSX's), instead of one string.
- **A `<label>` around a checkbox (or any `<input>`, `<select>`, `<textarea>`) stays whole in React**: its text
  stays a bare text node of the label (it became a `<span>`, which the accessibility tree exposes as LabelText +
  StaticText).

## [0.1.1] - 2026-10-06

### Fixed

- A hook called inside an expression (`useLocation().pathname`, `useStore(sel) ?? fallback`) runs in `use()` on every render instead of a getter (React's hook order broke). A store hook the TSX called only to render again (`useModulesStore((s) => s.loadedVersion)`) keeps its value in a field every memoized getter depends on. A method or setter passed as a value is bound once per view (`ref={setNode}` updated without end). A part keeps the lines of its template literals as they are (a `<pre>`'s text moved). `--split`: a local component two screens render is copied into each new file and no longer left unused in the old one, and the old file's unused imports are all removed. A handler given only under a condition (`onClick={f ? () => f(id) : undefined}`) starts with that condition; an untyped event parameter keeps React's event type. A narrowed component written as a tag (`<config.Body />`) reaches its part as a capitalised prop. The screen's own `navigate` serves its links (no duplicate field). A function body that only assigns or calls setters gets no `return`; a literal of an enum with no `.kbview` value, a component re-exported by default, untyped destructured props and annotations reading `typeof state` no longer break the code-behind.
- A memoized getter calling a method of the class depends on what that method reads (the rules run log stayed on « Loading… »); an aliased condition (`const snapshot = previous == null`) narrows its value in the getter that reads both; a part's prop no longer pulls in a module-level helper of the same name; the importers of a file split into several views are switched even when the old file ends up empty.
- A screen whose other cases render nothing (`if (!x) return null`) has its element as the view's root, without a wrapper (a parent's `divide-y` line landed on an invisible `display: contents` box); a bare `disabled` gives `Enabled="false"`; a narrowed property passed to a part is read with `?.` (the narrowing may come from inside the part); functions keep their declared return type; an effect reading a nullable getter in its callbacks reads it through a local constant.
- A nullable value read inside a callback of a getter or of a component's props is read through a local constant (the narrowing holds there, as in the TSX); a boolean in a text run prints nothing (`{busy && ' · busy'}`); a component returning `cond ? <A/> : <B/>` is recognised; a code-behind keeping a helper component is a `.tsx`; row-scoped part props are typed from the non-null rows; a narrowed intermediate property (`reading.trash.used_bytes`) is passed to a part; an identifier inside a string or a URL path no longer counts as a use (unused imports).
- Code-behinds of larger screens: a hook result is published as soon as its hook ran (a later hook's dependencies read getters built on it - a module's page crashed); getters and hook fields carry their written types when they can (no type depending on itself); a local component rendered by the code itself is imported from the parts file; a type declared in the component body moves to the module level; `list?.map(…)` gives no rows instead of failing; a functional state update keeps its parameter.
- Code-behinds that did not type-check: a binding path through a value that can be null (now a guarded getter); a
  template row whose parameter is called `key`; a hook reading what another hook gave (both now in `useHooks()`, read
  through local constants so the TSX's narrowing still applies); functions declared after an early return and
  handlers of elements shown under a condition (they start with the same conditions); a nullable value read inside a
  callback; an unreachable `?? ''`; an event passed to a function that takes none; a part's helper using another
  helper; an exported helper of the screen dropped. The codemod's row-guard regular expressions held backspace
  characters instead of `\b` (template conditions leaked into page getters).
- The code-behind was deleted right after being written when it was a `.tsx` (Windows paths), and importers using
  the name of a component also exported by default were not switched to the view.

### Added

- `data-*` attributes → `DataAttributes` (a literal, or a getter building the list when values are computed). A screen nothing of which maps to a `.kbview` element (it only renders another React component) is left as it is, with its importers. A module's generated catalogue (`src/i18n.data.json`, registered by `src/i18n.ts` under `registerModuleTranslations('<ns>', …)`) counts as its bundle.
- More conversions: a list, map or set filled by statements of the body (`const rows = []; walk(root)`, a `for` loop) is computed in its getter with the local functions it calls; a branch block's own early returns (`if (!scoped) { …; if (n === 0) return null; … }`); a property narrowed where a part sits (`menu.pos && <Menu pos={menu.pos}/>`) is passed to the part as a prop of its own; with `--write`, the `defaultValue` of a key no bundle has goes into the fallback language's bundle (the view shows the same text in every language).
- More conversions: an early return whose block computes constants first (`if (outcome) { const n = …; return <A/> }`), several children of a one-child element (`Card`, `FloatingWindow`) wrapped in a layout-neutral panel, `checked={cond}` on a radio (`SelectedValue` against `Value="true"`), an icon prop's theme colour (`IconColor`), and the props object of a ReactHost typed as the component's props (inline callbacks keep their parameter types).
- **`--split`: a file exporting several screens is cut into one file per screen before the conversion** (each then
  becomes its own view): the helpers only one screen uses move with it, the shared ones stay exported, and the
  project's importers are switched to the new files.
- New conversions: object props fed field by field, nested ones included (`action={{ label, onClick }}` →
  `ActionLabel` + `OnAction`, a window's `actions` → `ConfirmText` / `OnConfirm` / `CancelText`…); elements
  given as props written as property elements (`<Card.Actions>`); `t={t}` → `HostStrings` (left out where it changes
  nothing); `@ui/<Component>` imports read as `@ui`; a component with spread props rendered by a ReactHost directly
  (no part); an icon prop's `size` → `IconSize`; a field's `className` → `FieldClass`; a boolean for an enum
  property (`indeterminate={some}` → `CheckState`) through a lookup getter.

## [0.1.0] - 2026-10-05

### Added

- **`kbview-migrate`, the codemod from React/TSX screens to `.kbview` views.** One `.tsx` screen becomes `X.kbview`
  + an `X.ts` code-behind class (+ `X.parts.tsx` for what stays React) and a report: `@ui` components by reverse
  registry lookup, HTML elements as `Panel` / `Stack` / `Label` keeping their tag (headings, lists, forms), Tailwind
  classes turned into properties where the result is pixel-identical (roles, weights, theme colours, flex rows and
  columns) and kept in `Class` otherwise, `t()` as `{Res}` (with arguments and plurals), state as `@bind` fields,
  hooks in a `useHooks()` method, derived values as getters (memoized when they build objects), inline handlers as
  methods, `cond && <X/>` and early returns as `Visible` (their getters guarded by the same conditions), lists as a
  `Repeater` over memoized rows, and what does not convert (a local or another screen's component, a raw `<input>`,
  an unmapped prop) rendered through `<ReactHost>` with a TODO comment. `--out <dir>` writes a dry run elsewhere,
  `--report` the per-file report (converted / partial with reasons / skipped).
- Hooks are split in `useStores()` (reading nothing of the class) and `useHooks()`; their results become plain fields
  published through `View.publish`, so a view sees them on its first render and does not re-render without end.
  Lists over a getter or a field (`items-source`) map to a `Repeater` too.

### Fixed

- A screen's top-level statements declaring nothing (a `Registry.register(…)` run when the file is imported) are
  kept in the code-behind, after the class; they were dropped (the core notification settings lost their « Account and
  security » activities).
- A part or a component shown under a condition is guarded like its props, and a memoized getter depends on what its
  guard reads: computed while the condition failed, it is computed again once it holds (the core sessions screen
  showed its error state without its texts; the designer, which shows hidden elements, failed to render it).
