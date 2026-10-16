# Changelog - @kubuno/views

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are
added under `[Unreleased]` **as the change is made**; on npm publish, the section is stamped
under the published version number.

## [Unreleased]

### Changed

- **A user control converted from a component keeps its DOM.** A `.kbcontrol` whose `<UserControl>` root sets nothing
  of its own (no name, property, DOM event or menu) and holds one element renders that element as its DOM root: the
  control is as large as its content and its host's child selectors (`space-y-*`, `divide-y`) reach it, as they
  reached the component. The Visual Studio designer still shows the `UserControl` surface.

## [0.1.4] - 2026-10-06

### Fixed

- **A component hosted by `ReactHost` renders again with its view.** A converted screen's elements only render again
  when what they read changes, so a hosted React component lost the re-render it got from its TSX parent: whatever it
  read on render without subscribing (the shell's `<Slot name="app-dialogs">` reading the slot registry) stayed as
  the first render left it - the dialogs a module registers once its bundle has loaded (Files open / save / folder
  picker, audio player, paint, remote storage) never appeared. It now renders whenever its view root does.
- **An element inside a `display: contents` wrapper keeps the spacing its parent gives it.** An element that needs
  its DOM root (a DOM event, a name, attributes) and whose component has a wrapper root of its own (`TextField`) sits
  in a `display: contents` box, where the parent's `space-y-*` margin or `divide-y` border landed without being
  drawn (8 px missing under a drive label field). The wrapped element now takes them, on the sides where it sets none
  of its own.

## [0.1.3] - 2026-10-06

### Fixed

- A `Visible` binding that gives no value (`undefined`, `null`, a path not found) hides its element, as `{cond && <X/>}` renders nothing (in the designer the element stays shown). An `@ui` element whose `className` lands on its root (`kbRootClass`: `Card`, `Callout`, `EmptyState`, `Badge`, `Separator`, `Spinner`, `ProgressBar`, `Toggle`) receives a view's `Class` directly, with no `display: contents` wrapper among its parent's children (`space-y-*` and `divide-y` reach it again). What a view memoized (`View.memo`) is computed again after a language or theme change (a module's name read from a registry kept the previous language).
- A view no longer renders again because its own hooks published new values during its render (only its elements are
  refreshed): a hook returning a new object on every render looped without end. `ReactHost` shows nothing, instead
  of throwing, when the designer's sample data stand in for its component or props.

### Added

- **`DataAttributes`** on `Panel` and `Stack` (web only): `data-*` attributes of the element (`app-chrome; module=drive`), bindable - the page's styles and scripts find the shell's chrome and panels by them.
- **`setTranslator(t)`** (host): the translator an `@ui` element receives as `t` when its view sets `HostStrings`;
  the `host-t` converter. Object props are built field by field along dotted paths (`actions` + `confirm.label`).

## [0.1.2] - 2026-10-05

### Added

- **`View.publish(values)`** sets fields from what hooks returned this render and re-renders only when one changed,
  compared shallowly: a hook returning a fresh but equal object or list on every render no longer loops.
- **`AutoSize` on `Panel` and `Stack`**: the container sizes to its content instead of filling its line; a push-button
  container (`AccessibleRole="PushButton"`) then sizes like a native button.
- **`View.memo(key, deps, compute)`** for getters returning an object or a list: the same object while `deps` are
  unchanged, so a binding reading the getter twice sees no change (a new array on every read would re-render without
  end).
- **Containers keep their HTML element.** `Panel` and `Stack` take `HtmlTag` (`section`, `nav`, `form`, `ul` / `li`…)
  and a form raises `OnSubmit`, a dialog container takes `AccessibleModal` (`aria-modal`); any element takes
  `AccessibleHidden` (`aria-hidden`). `ReactHost` is registered for
  interpreted plans (the designer).
- **`{Res}` arguments and plurals.** A plan's `{Res}` may carry arguments (`{Res files, Count={Binding n}, Name=Kim}`):
  the host's resolver receives them (`setResourceResolver((key, set, args) => …)`, `interpolationOptions(args)` turns
  them into i18next options: each name as written and with a lower-case first letter, `Count` as a number) and a
  view re-reads its strings when a bound argument changes. `View.t(key, set, args)` takes them too.
- **`TableLayoutPanel`.** A grid of cells: column and row counts, sizes per column and row (pixels, shares of
  the room left, or the content's), children placed in reading order or at a given cell, spanning several
  cells, aligned in their cell by their anchors, more children adding rows (or columns), optional cell lines
  and spacing. Columns follow the reading direction.
- **Interaction states and outlines on every element**, in theme colours: a background under the mouse
  (`HoverBackColor`) and while pressed (`PressedBackColor`), rounded corners (`CornerRadius`; a container clips
  its children to them), an outline (`BorderBrush`, `BorderThickness`) and a shadow (`Elevation`). A theme
  colour followed by `/NN` is that colour at NN % opacity. Containers can draw a line between their children
  (`DividerColor`); a scroll area can use the thin inset scroll bar of the menus.
- **Anchored placement in a panel with `Layout="Absolute"`.** Elements keep their distance to the edges they
  are anchored to (`Anchor`) when the panel is larger or smaller than the size they were placed at, stretch
  between two anchored edges, or stay centred; docked elements keep their bands. The end edge follows the
  reading direction.
- **Item events through their parent:** an accordion section's `Open` follows the user (two-way) and raises
  `OnToggled`; menu commands with `CheckOnClick` or a `RadioGroup` keep their check mark and raise
  `OnCheckedChanged`; a context menu adds the commands of its `ItemsSource` and raises `OnItemClicked` with the
  chosen one's key. A hidden item is left out of its parent's list.

- **Lists, trees, navigation and drawing in views.** `ListBox`, `CheckedListBox`, `ListView`, `TreeView` (with their
  `Item` children or a bound list, two-way selection and check marks), `Toolbar`, `Sidebar`, `StatusBar`, `Splitter`,
  `SearchField`, `MaskedField` and `PaintBox`, whose `OnPaint` handler draws on a canvas (`PaintEventArgs`: context,
  size, pixel ratio). New event args: `ItemCheckEventArgs`, `PaintEventArgs`.

- **Sample rows in the designer.** A `Repeater` with nothing to show at design time shows `DesignItemCount`
  sample rows (3 by default) whose bound fields read their own name and row number (`name 1`, `name 2`…), as
  in the desktop designer.
- **Design mode can be switched on and off on a live view**: its elements are marked for the designer again
  (or no longer) without the view losing its state.

### Changed

- **`ToolTip` renders the element's `title`** instead of wrapping it in the `@ui` `Tooltip`: no wrapper element any more
  (a wrapped push button lost its sizing in a row), the same accessible name as a hand-written `title`, and the
  shell still draws the Kubuno tooltip for it.
- **`View.component()` is typed as a function component** (it always was one): a view without props now fits a slot
  expecting a component with props, as a function component does.

### Fixed

- **Theme colours with a digit in their name** (`Surface1`, `Surface2`, `Surface3`) pointed at a CSS variable
  that does not exist; theme colours now map to the host's variables (`OnPrimary`, `Divider`, `Selection`…).
- **A container shown as a push button** fills its line like the block it replaces and lays its text out from
  the start, and is drawn faded while disabled; a `Stack.Fill` child may shrink below its content's width.

## [0.1.0] - 2026-10-05

### Added

- **Layout elements: `Stack`, `Panel`, `UserControl` and `ScrollArea`.** A stack places its children along a
  direction with a gap; a panel (and a user control's root) docks its children as bands on its edges, the
  last one filling the rest, mirrored in right-to-left languages, or places them by position; a scroll area
  scrolls its child. A container marked as a push button renders a real button, one with an address a real
  link.
- **The row of a repeated element in its events.** An event raised by an element of a `Repeater`'s template
  carries that row's item and position (`e.row`, `e.rowIndex`).

### Fixed

- **A view re-reads what it shows from its props when its host passes new ones.** Elements bound to a getter
  over `this.props` kept their first value.

- **First version: the type surface of the `.kbview` views runtime.** Modules that write their screens
  as `.kbview` views build against it: the code-behind base class (`View`, `@bind`), the typed handles of
  named elements, the event args, the runtime elements (`Repeater`, `Timer`, `Query`, `Mutation`,
  `ReactHost`), `MessageBox` and `Dialog`. The implementation is served by the Kubuno host at runtime
  (keep `@kubuno/views` external in module builds).
