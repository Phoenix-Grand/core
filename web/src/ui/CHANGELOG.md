# Changelog — @kubuno/ui

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are
added under `[Unreleased]` **as the change is made**; on npm publish, the section is stamped
under the published version number.

## [Unreleased]

## [0.1.17] - 2026-10-06

### Changed

- Rebuilt with the core of this release: the module list the bundle carries asks the live `.kbview` views to
  compute again what they memoized once module bundles have loaded (`invalidateViews` of `@kubuno/views`). No
  change to the components or their props.

## [0.1.16] - 2026-10-06

### Added

- **Registry**: `DataAttributes` on `Panel` and `Stack` (web only, bindable): the element's `data-*` attributes.
- **Registry**: `Card` takes `IconSize`, `IconScaling` and `IconColor` for its header glyph.
- **Registry**: `FloatingWindow` gains its footer (`ConfirmText`, `ConfirmEnabled`, `ConfirmBusy`, `ConfirmDanger`,
  `ConfirmFocused`, `CancelText`, `CancelEnabled`, events `OnConfirm` / `OnCancel`, written to `actions.confirm` /
  `actions.cancel`) and the `Banner` / `TitleActions` property elements; `HostStrings` on `Callout`, `EmptyState`,
  `FloatingWindow`, `Tabs`, `Stepper`, `ComboBox` and `ProgressBar` (the host's translator as `t`); `FieldClass` on
  `TextField`, `TextArea` and `NumericField` (the classes of the input box). Element metadata accept dotted fields
  (`confirm.label`).
- **Types**: `FloatCheckboxProps` is exported, so a view code-behind can name the props it passes to `FloatCheckbox`.

## [0.1.15] - 2026-10-05

### Added

- **Four more typographic roles** for `Label` and `LinkLabel` (`role`, registry `Role`), shared with the desktop:
  `Badge` (10 px, initials and counts in small pills), `Caption` (11 px, small pills and chips), `Subtitle` (16 px,
  Tailwind's `text-base` line) and `Display` (24 px, `text-2xl`), with the tokens `--kb-text-badge`, `--kb-text-caption`,
  `--kb-text-subtitle` and `--kb-text-display`. A view names a role instead of writing a text size in `Class`.
- **`Label` keeps the HTML semantics of a text.** `as` renders it as a heading (`h1`–`h6`), an inline `span`, a
  `strong`… instead of a paragraph, and `inheritSize` (also on `LinkLabel`) leaves out the role's size class so the
  text keeps its parent's font size. The registry gains `Label HtmlTag` / `InheritFontSize`, `LinkLabel
  InheritFontSize`, `TextField InputType` / `AutoComplete`, `Button ButtonType` and the `ReactHost` element.
- **`GroupBox`, `SettingsRow`, `RadioGroup` and `PictureBox` components.** A titled group of settings with an
  optional help line; one settings row (the setting's name and help line in a 240 px column beside its control,
  stacked above it on a phone, a line between rows); a set of exclusive options built on `Radio`, one native
  radio group moved with the arrow keys, vertical or side by side; a picture fitted by a size mode (normal,
  stretch, zoom, centre, cover) with rounded corners and an optional border. They replace the local copies the
  modules' settings pages each defined, and are the `.kbview` elements of the same names.
- **Lists and trees: `ListBox`, `CheckedListBox`, `ListView` and `TreeView`.** Virtualised (only the visible rows are
  drawn, 10 000 rows stay fluid), with the usual keyboard (arrows, Home / End, Page Up / Down, type-ahead, Space to
  check, Left / Right to fold a tree branch, Enter to open, Shift / Ctrl to select several) mirrored in right-to-left
  languages, and announced to screen readers as lists, grids and trees with their selected, checked and expanded states.
- **Navigation and tools: `Toolbar`, `Sidebar`, `StatusBar`, `Splitter`, `SearchField`, `MaskedField` and `PaintBox`.**
  A toolbar moved through with the arrow keys; a navigation sidebar with folding sections and a compact rail; a status
  bar; a split view resized with the mouse or the keyboard; the shell's search pill; a field with an input mask; a
  drawing surface repainted on resize.
- **`DataTable`** selects one row by index, opens a row on double-click or Enter, has a compact density and a
  text-only empty state; its rows no longer need a key. **`AnchoredPopover`** opens on any side, closes on Escape and
  gives the focus back. **`Avatar`** shows a presence dot. **`Badge`** shortens its text past a maximum width;
  **`FloatingWindow`** can hide its close button.
- **Text weights and italics on `Label` and `LinkLabel`** (`weight`: Regular, Medium, SemiBold, Bold;
  `fontStyle`: Italic).
- **`Radio` takes a `name`**, so radios can form one native group (arrow keys move the choice).
- **Element registry:** the new elements; `HoverBackColor`, `PressedBackColor`, `CornerRadius`, `BorderBrush`,
  `BorderThickness` and `Elevation` on every element; `DividerColor` on `Stack` and `Panel`; `ScrollBarStyle`
  on `ScrollArea`; `FontWeight` and `FontStyle` on `Label` and `LinkLabel`; `TableLayoutPanel`.

## [0.1.13] - 2026-10-05

### Added

- **`Label`, `LinkLabel`, `Avatar`, `IconGlyph` and `IconButton` components.** A line of text in one of the
  shared typographic roles (Micro, Meta, Body, Heading, Title); a link whose plain click stays in the app;
  a person's photo or initials on a disc; an icon alone or on a coloured disc; a round icon-only button
  (diameter, glyph size, tinted fill). They are also the `.kbview` elements `Label`, `LinkLabel`, `Avatar`,
  `Icon` and `IconButton` in the element registry, which now also lists the runtime's layout elements
  (`Stack`, `Panel`, `UserControl`, `ScrollArea`, `Repeater`).

### Changed

- **The `.kbview` element `IconButton` now renders the round `IconButton`** with the desktop's `Diameter`,
  `Glyph` and `Filled` properties, instead of a text-less `Button` with web-only `Variant` and `Size`.

- **`kbview-registry.web.json`, the element registry for `.kbview` web views.** The package now
  ships the description of the components that a `.kbview` view can use (Button, CheckBox,
  TextField, Dropdown, Tabs, Card, DataTable, ContextMenu, the workspace's DockArea and
  WorkspaceShell…): element names, properties with kinds, defaults and French descriptions,
  events, accepted children, and how each maps onto the React component's props. It has the
  same format as the desktop registry, so the Visual Studio designer and the views language
  server read both the same way. The components themselves are unchanged.

- **`Collapse`, a block that unrolls and rolls up.** `<Collapse open={…}>` animates its height when opening and closing instead of appearing at once; the content is mounted on first opening and kept inert while closed. Styling comes from the host's `.kb-collapse` rule, so it follows the platform's motion settings, including reduced motion.

- **A label field, `LabelField`.** Chips for the labels an element carries and a
  list to add or drop one, for putting the instance's labels on something from
  inside its own form rather than from a context menu. Presentational: it is
  handed the labels that exist and the ones chosen, and reports back — which is
  what lets it work on something that does not exist yet.

- **A help bubble, `HelpBubble`.** The filled answer behind a "?": the
  instance's accent, white text, and an arrow pointing at the control that
  raised the question — which a floating white card never does, and which
  matters most where several little "?" sit near each other. It goes on
  whichever side of that control has room (below, above, right, left) and the
  arrow follows, always on the edge facing it. Near a screen edge the bubble
  slides back into view rather than the arrow giving up and parking in a corner,
  where it would name whatever happened to be beside it. Only the tip of the
  arrow shows, and its point is square.


### Changed

- **The × on a mention chip fills its side of the chip.** Its box was narrower
  than it was tall and the leftover interline piled up above and below it, so
  its hover square sat inset at the top and bottom while sitting flush on the
  right — three different margins, visible the moment you pointed at it. It is
  now a square as tall as the chip's line, flush against the name and against
  the chip's inner edge; what keeps it off the outer edge is a two-pixel rim
  around the chip, drawn in the accent. Whole pixels, deliberately: at a
  fraction of the text size, the chip's edge and the square's edge fell on
  different phases of the screen's pixel grid, so they were drawn differently
  and the gap below LOOKED larger than the one above even though the layout had
  them equal to a hundredth of a pixel.

- **The × on a mention chip is centred.** It was a typed character, and a
  glyph sits wherever its typeface puts it inside the em box — low, here — so it
  read a touch below the middle however the button was aligned, and the offset
  would have moved again with a different font. It is now drawn rather than
  typed, which centres it by construction at any size.

- **A mention reads as one object, not as coloured words.** The chip a `@`
  mention leaves behind was a pale tint with the accent as its ink, which at a
  glance was hard to tell from emphasised text. It is now a solid block in the
  accent with white text, the square-ish corners the instance uses for its other
  chips, and a white × set slightly apart so it reads as a button rather than
  the last letter of the name.


### Fixed

- **`Dropdown` answers the keyboard like a native select.** Closed: ↓ ↑ Enter
  Space open on the current value, Home/End on the first/last row, a typed
  letter on the first matching label. Open: ↓ ↑ walk without wrapping, Home End
  PageUp PageDown jump, typing walks the matches, Enter/Space choose, Tab
  chooses and leaves, Escape closes the list and is consumed before any
  window-level listener sees it. ARIA select-only combobox: the trigger is
  `role="combobox"` with `aria-activedescendant`, the popup a `listbox` of
  `option`s; the popup never takes the focus. Mouse hover and keyboard share
  one highlight.

### Changed

- **`Dropdown` takes the focus a click gives it, unless a document editor holds
  it.** `focusable` gains a third value, `'auto'`, which is the new default:
  the trigger decides at the click, refusing the focus only when the active
  element is a contenteditable surface that is not a form field (see
  `focusGuard.ts`). Toolbar lists over a document keep behaving exactly as
  before — the selection they act on survives — while every list in a form now
  behaves like a native select: the field just left goes dark, the list keeps
  the focus after closing, the keyboard follows the pointer. `true` and `false`
  keep their meanings for callers that want to force either way.

### Fixed

- **`OutlinedField`: labels no longer lose their descenders.** The label was laid
  out on a line box exactly as tall as its own type size, while the ellipsis it
  needs clips whatever falls outside — so the tails of `p`, `g`, `q`, `j` and `y`
  were sliced flat along the bottom (visible on any label that has one, such as
  the French "Mot de passe"). The label now uses the same line box as the text it
  stands in for, in both the resting and the floated position, and every offset
  was compensated so nothing moves on screen. At rest it also lands exactly on
  the typed text now, instead of one pixel above it.

### Added

- **`Input` accepts `bare`** — a field with no frame, drawn as a single stroke
  under the text, for a title line at the head of a sheet where a boxed field
  would read as one more form row. The stroke is three pixels when the field has
  focus, the thickness the focus mark has on every other control, and it is
  reserved (transparent) at rest so taking focus never nudges the text.

- **`OutlinedField` accepts `autoComplete`.** The outlined field can now tell the
  browser what it holds (`username`, `current-password`, `email`…), so password
  managers and the browser's own autofill recognise it. Without it, a sign-in or
  address form built from this field lost the suggestions a bare `<input>` got
  for free. Optional: fields that pass nothing behave exactly as before.

- **`cn()` — class names composed in house.** Eight repositories pulled in `clsx`
  to do what fits in a dozen lines, and one more added `tailwind-merge`. Neither
  earns a place in a supply chain meant to stay small: this is finished logic
  with no security surface to track upstream. `cn()` accepts what the call sites
  already passed — strings, conditions that fall through when false, arrays,
  objects keyed by class name — and `clsx` is exported as an alias so a file can
  move without being rewritten.
### Added

- `Breadcrumb`: a `size` option. `lg` sets the trail at heading scale for screens
  where it *is* the page title; the default is unchanged, so consoles that render
  it as a secondary line are untouched.

## [0.1.11] - undated

- Published to npm before this changelog was introduced.
