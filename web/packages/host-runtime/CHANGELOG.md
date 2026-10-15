# Changelog — @kubuno/host-runtime

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are
added under `[Unreleased]` **as the change is made**; on npm publish, the section is stamped
under the published version number.

## [Unreleased]

### Fixed

- **Ctrl+wheel now zooms the design surface** (web and mobile views), centred on the pointer, like every
  other visual editor; the Zoom menu follows. A device frame (a mobile view) fits the pane by default and
  an explicit zoom — Ctrl+wheel or the Zoom menu — now overrides that fit instead of being ignored.

### Added

- **`dist/kbview-registry.web.json`, the host element registry as a file.** The bundled page already embeds the host
  registry (its SHA-256 is in `design-host.json`); it is now also emitted beside the build as a standalone file.
  A consumer that reads a registry file rather than the live page — the Visual Studio Toolbox / Properties window for a
  view bridged to the bundled host (a mobile `.kbview`, which has no `node_modules/@kubuno/ui/kbview-registry.web.json`)
  — can then show the same host elements the page renders instead of an empty list. Listed in `design-host.json`'s
  `files`, so the extension's build ships and verifies it.

## [0.1.2] - 2026-10-06

### Changed

- **A page is designed on a white sheet.** In the Visual Studio designer, a `.kbview` (a page, window or dialog) is
  now shown on a white canvas whatever Visual Studio's theme, with the page's boundary drawn as a light-grey dashed
  line at the chosen width (1px at every zoom, outside the page so it never covers it). The page itself keeps its own
  theme: the light / dark preview switches the page, not the canvas. A `.kbcontrol` (user control) keeps the canvas
  in Visual Studio's colours, as before.

### Added

- **`dist/design-host.json`, the build's manifest**, written once both passes of the build are done: every file of
  `dist/` and the SHA-256 of the host element registry the bundled page embeds. The Visual Studio extension's build
  checks it and refuses a half-built or out-of-date design host instead of shipping it.

## [0.1.1] - 2026-10-06

### Changed

- Built with the `@kubuno/views` runtime of this core: a component hosted by `ReactHost` renders again with its
  view, and an element in a `display: contents` wrapper keeps its parent's spacing (see `@kubuno/views`).

### Fixed

- **The Visual Studio designer's bundled page compiles with the project's own element registry.** The page accepts
  the registry the designer sends (`setHostRegistry`) instead of the one it was built with, so a module whose
  `@kubuno/ui` is newer than the designer's copy (drive) no longer shows errors such as « `Label` has no property
  `HtmlTag` » that the build does not report.

## [0.1.0] - 2026-10-06

### Added

- **First version: the design host of Kubuno web views.** A ready-to-serve page that shows a `.kbview` or
  `.kbcontrol` view in the Visual Studio designer when the project's own development server is not running:
  it renders the view with the host's real elements, fonts, translations and light / dark themes, lets you
  select, move, resize and reorder elements and drop new ones from the Toolbox, and shows the project's own
  controls as labelled placeholders. It works from any address or folder, offline.
- **Module projects in the designer with their own code.** Installed as a devDependency of a module (with
  `@kubuno/views-compiler` 0.1.2 or later), the package also provides the design page the module's development
  server shows to Visual Studio: the module's views render with their code-behinds, their own controls and React
  parts, and update as you edit them. The page and the module share one copy of React, of the host's elements, of
  the sdk and of the views runtime, as in the running host; the module's stylesheet and translations are loaded
  first (`design.setup` in `kubuno.views.json`).
