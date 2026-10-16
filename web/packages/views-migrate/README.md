# @kubuno/views-migrate

The codemod that turns a Kubuno web screen written in React/TSX into a `.kbview` view with a TypeScript code-behind
(the format of the Kubuno views, designed in Visual Studio). A devDependency of web projects that migrate.

```bash
npx kbview-migrate --project . --report migrate-report.json src/settings/SettingsTab.tsx   # dry run: the report only
npx kbview-migrate --project . --out /tmp/migrated src/settings/SettingsTab.tsx           # the files, elsewhere
npx kbview-migrate --project . --write src/settings/SettingsTab.tsx                        # in place
npx kbview-migrate --project . --write --layout --app-root src src/SettingsTab.tsx          # and into its role folder
npx kbview-migrate --relayout --project . --app-root src --components                     # dry run: what each view is
npx kbview-migrate --relayout --project . --app-root src --components --write             # classify again and move
```

**Views and user controls.** Every screen is classified first, from how the project uses it (vskubuno
`docs/VIEWS-SPEC.md` §1.1–1.2): a page a route renders, a window or a dialog becomes a **view** (`X.kbview`); a
component other components place - a pane, a section, a tab, a row, a card, a panel given to a host slot - becomes a
**user control** (`X.kbcontrol`, its markup inside `<UserControl x:Props="XProps">`: its props are its properties, its
callbacks its events). With `--layout` (conversion) or `--relayout` (a project already converted), the files go to the
folder of their role under each `--app-root`:

| Folder | Holds |
|---|---|
| `views/` | pages a route renders, windows (full-screen viewers, floating windows) |
| `dialogs/` | dialogs and wizards |
| `pages/` | user controls one component places (a page's panes, sections, tabs, the rows its lists repeat) |
| `controls/` | user controls several components place |
| a feature folder | its own views and user controls side by side (a folder past `--split` views, 12 by default, is split by role) |

Files move with `git mv`; every relative import of the project follows. `--components` places the React components
too, `--place <view>=<dir>` puts one in a feature folder, `--move <from>=<to>` moves any other file (a store to
`model/`, an API client to `services/`), `--exclude <dir>` leaves a folder alone. A user control is an element named
after its file: when two share a name, or one has a host element's name, the run stops and `--rename <view>=<Name>`
renames it (files and class).

For every file the report says **converted** (everything became view elements), **partial** (some parts stay React,
rendered by `<ReactHost>` elements marked `TODO(views-migrate)` in the view, each with its reason) or **skipped** (the
file could not be converted: the reason says why - several exported components, an unsupported statement…).

What the codemod does, and what it leaves:

| TSX | View / code-behind |
|---|---|
| `@ui` components | their `.kbview` element (reverse lookup of the registry: props, events, enum values) |
| `div`, `section`, `form`, `ul`/`li`… | `Panel` (`HtmlTag` when not a `div`), `Stack` for a plain flex box |
| `p`, `span`, `h1`–`h6` with text | `Label` (`HtmlTag`, `Role`, `FontWeight`, colours; the rest of the classes in `Class`) |
| `t('key', { count, defaultValue })` | `{Res key, Count={Binding n}}`; a `defaultValue` of a key missing from the bundles is reported |
| `useState` | `@bind accessor` (a static initial value) or kept in `useHooks()` |
| other hooks | `useHooks()`, their results published as fields in `use()` (typed from it, nothing to import) |
| derived constants | getters (`View.memo` when they build an object or a list) |
| inline handlers, local functions | methods |
| `cond && <X/>`, `a ? <A/> : <B/>`, `if (c) return <A/>` | `Visible` bindings; the getters inside are guarded by the conditions |
| `list.map(item => <Row/>)` | `Repeater` over a memoized rows getter, keyed by the item's `key` |
| a local helper component, another screen | `<ReactHost Component=… Props=…/>` (the local ones move to `X.parts.tsx`) |

Run `kbview-tsc -b` after a conversion: the generated files must type-check before the screen is kept, and the visual
and accessibility parity of the screen must be checked (vskubuno `docs/WEB-VIEWS.md` §7).
