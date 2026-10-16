# Portable Kubuno Desktop - audit and design study (Linux, macOS, Windows)

Status: study, 2026-10-16. Read-only audit of `core/desktop` (tag line `0.1.6-alpha`) and of the module apps that
build on it (`office/desktop`, `calendar/desktop`, `chat/desktop`, `maps/desktop`, `drive/desktop`), plus the mobile
renderer in `core/mobile`. No source file was changed to write it.

Goal set by the owner: the Kubuno desktop apps (Kubuno Documents first, then every module app) must **compile on
Linux and macOS and look exactly the same as on Windows**. Constraints: never Tauri / wry / tao, no WebView for UI
(winit is allowed), Linux identical on every desktop environment (GNOME, KDE, XFCE, MATE..., X11 and Wayland) with
Kubuno-drawn UI and client-side decorations, pixel parity with Windows (same fonts shipped, same layout metrics),
and the apps keep their `.kbview` views and code-behind unchanged.

Related documents: `vskubuno/docs/MOBILE-RUST-FEASIBILITY.md` (recommended a portable renderer spike; its `vello`
suggestion has since been invalidated by the mobile work, see section 3), `vskubuno/docs/MULTI-OS-AUDIT.md`
(server side and packaging), `vskubuno/docs/SHARED-CORES.md`, `desktop/BUILD.md`.

---

## 0. Summary

**The framework is much closer to portable than its folder name suggests.** Of the ~266k Rust lines in the 15
crates under `desktop/windows/`, roughly **20k lines (7-8 %) are genuine platform code** (window, message loop,
Direct2D/DirectWrite device code, OLE, UxTheme, printing, splash). The rest is either already free of `windows::`
(~69k lines in the six paint/host/view crates alone, plus the ~40k lines of views-ls, data, tools and header
controls) or only *names* Win32 types (~70k lines in files whose only Windows content is types such as
`D2D1_COLOR_F`, `IDWriteTextFormat`, `ID2D1Bitmap1`, `DWRITE_TEXT_ALIGNMENT`, `HWND`). The painting already flows
through two traits (`Canvas`, `ControlCanvas`; ~1,200 `&dyn` uses) and a recordable display list
(`kubuno_desktop_ui::graphics::display::Op`). Direct Direct2D/DirectWrite calls (~266) are concentrated in **~11
backend files of the framework** (plus 1-2 stray calls in 10 others) and **11 files of the office apps** (~183).

What blocks a Linux/macOS build today:

1. **Type leakage**: Direct2D/DirectWrite COM and struct types in every paint signature (`D2D1_COLOR_F` 749
   occurrences in 78 framework files, `IDWriteTextFormat` 144/34, `ID2D1Bitmap1` 74/17, `DWRITE_TEXT_ALIGNMENT`
   123/20; plus 103 / 16 / 18 occurrences in the office apps).
2. **The host** (`kubuno-desktop-controls/src/host`, 10.9k lines, 63 distinct window messages): Win32 windowing,
   nested modal message loops, popup windows, custom chrome, OLE drag and drop, IMM32, UI Automation, cursors,
   timers.
3. **Fonts that cannot ship**: the UI is set in *Segoe UI Variable* and *Segoe Fluent Icons* resolved from the
   system, documents default to *Arial / Times New Roman / Courier New / Georgia*. None may be redistributed to
   Linux or macOS, so **pixel parity requires bundling open fonts on all three systems, Windows included**.
4. **"System visuals"** of the WinForms replica controls are read live from Windows (`GetSysColor`,
   `GetSystemMetricsForDpi`, `SystemParametersInfoForDpi`, UxTheme parts: 95 call sites, 21 `draw_theme_part`
   calls over 16 theme classes).

**Recommended architecture (one approach):**

- A portable graphics vocabulary crate (`kubuno-desktop-gfx`, in `common/`) and a backend-neutral `Canvas`
  (same methods, portable types), migrated with a zero-churn type shim so Windows keeps building at every step.
- **One portable renderer on all three systems, Windows included**: CPU rasterisation with **tiny-skia** (the
  rasteriser the mobile renderer already ships), glyphs from **skrifa**, text layout/shaping with **parley**
  (+ fontique, harfrust), bundled fonts only, tile-level damage tracking driven by the existing display list,
  and a thin per-OS presenter (DXGI/DirectComposition, wl_shm, MIT-SHM, CALayer/IOSurface). Same code + same font
  files + same scale = the same pixels, by construction. Direct2D stays as a reference/fallback backend during the
  transition.
- **An own platform layer** (`kubuno-desktop-platform`) extracted from the Win32 host, with backends **Win32**
  (existing code), **Wayland** (smithay-client-toolkit + calloop), **X11** (x11rb) and **AppKit** (objc2). winit
  is used for the first spike only: it cannot run the framework's synchronous `ShowDialog` nested loops (45
  `show_dialog(` call sites) and lacks Wayland popups, window geometry for client-side shadows and owned windows.
- Platform services behind portable traits: clipboard (multi-format), IME, drag and drop, AccessKit adapters
  (`accesskit_unix`, `accesskit_macos`), file dialogs (portal / NSOpenPanel), printing (PDF + IPP to CUPS),
  notifications/tray, theme/accent.

**Plan:** M0 owner decisions (fonts) -> M1 de-Windows the paint types (Windows only, no visual change) -> M2
portable renderer + text + fonts (offscreen parity on 3 OS) -> M3 framework crates move to `common/` ->
M4 platform hosts (Linux, macOS) -> M5 platform services -> M6 Documents on Linux/macOS -> M7 Windows on the
portable renderer, then the other apps. **First spike (S1, ~2-3 person-weeks):** `kubuno-drive-desktop-app-controls`
compiled on the three systems against portable types, a tiny-skia + parley `Canvas`, a widget sheet rendered to PNG
on Windows/Linux/macOS (bit-exact across OS) and compared with the Direct2D rendering on Windows. **S2 (~2
person-weeks):** the platform-layer proof (window + nested modal dialog + popup overflowing the window) on GNOME
Wayland, GNOME Xorg and macOS.

Rough total to "Documents identical on Linux and macOS": **41-61 person-weeks** (section 5.4). Main risks: the
font decision (reverses an earlier owner decision), the visible change of text rendering on Windows, CPU
rasterisation cost at 4K, Wayland specifics, and the long tail of platform services.

---

## 1. Scope, method and definitions

### 1.1 What was measured

- Every crate of the desktop workspace (`core/desktop/Cargo.toml`: 19 crates in `common/`, 15 in `windows/`, one
  entry point each in `linux/` and `macos/`).
- The office desktop workspace (`office/desktop`: 9 `common/` crates, 8 `windows/` app crates), the other module
  apps (calendar, chat, maps, drive) for comparison.
- The mobile renderer `core/mobile/common/kubuno-mobile-render` and the iOS shell (winit).

Counts were taken with `grep`/`wc` over `*.rs` (scripts in Appendix A). "Occurrences" are token matches, not lines;
they are indicative (some patterns can match a non-Windows identifier) but the orders of magnitude and the file
lists were checked by hand on the main files.

### 1.2 What "pixel parity" means in this document

Two runs are at parity when, for the same view, data, theme, window size in DIP and scale factor, the **client
area** is identical pixel for pixel. Excluded by definition (drawn by the OS, not by Kubuno): the mouse cursor,
IME candidate windows, native file dialogs, the window drop shadow outside the client area, and Windows' Mica
backdrop (wallpaper-dependent even on Windows; parity is defined with `Backdrop::None`). Tolerance: bit-exact on
the same CPU architecture; at most 1/255 per channel on at most 0.1 % of pixels between x86_64 and aarch64
(floating point library differences, see risk R8).

Parity is only achievable with **the same rasteriser and the same font files on every OS** (section 4.4).

---

## 2. Audit

### 2.1 Workspace inventory

`desktop/windows/` crates (all `*.rs` of the crate, tests and examples included):

| Crate | Files | Lines | Files with `windows::` | Role |
|---|---:|---:|---:|---|
| kubuno-desktop-ui | 51 | 77,717 | 38 | design system: widgets, ribbon, dock, editors, rich text, color, `Graphics`, splash |
| kubuno-desktop-views | 93 | 61,668 | 12 | `.kbview` runtime, registry families, events router, design mode |
| kubuno-desktop-controls | 50 | 42,103 | 32 | WinForms replicas + **the host** (window, loop, input, DnD, a11y) + `Painter` |
| kubuno-desktop-gallery | 24 | 15,198 | 5 | the control gallery (UI reference app) |
| kubuno-desktop-views-ls | 36 | 15,117 | 0 | `.kbview` language server |
| kubuno-desktop-data | 42 | 11,389 | 0 (uses `windows-sys`) | data components |
| kubuno-desktop-shell | 60 | 9,151 | 9 | Kubuno Desktop's Windows face (tray, sync root, admin) |
| kubuno-desktop | 33 | 9,039 | 4 | the facade (`Application`, forms, file dialogs, `NotifyIcon`, popups) |
| kubuno-drive-desktop-app-controls | 69 | 6,220 | 10 | **`Canvas` trait**, `Renderer` (D3D11/DXGI/D2D/DComp), theme, vector icons, Files widgets |
| kubuno-desktop-data-tool | 23 | 4,956 | 0 | tool |
| kubuno-desktop-print | 14 | 4,288 | 6 | PrintDocument, preview, D2D print control over XPS, winspool |
| kubuno-desktop-shell-controls | 18 | 3,696 | 0 | header menus (waffle, account) |
| kubuno-desktop-header-data | 8 | 2,020 | 1 | launcher data |
| kubuno-desktop-app-storage-components | 12 | 1,926 | 0 (registry via `windows-sys`) | storage components |
| kubuno-desktop-resources | 7 | 1,200 | 1 | `.kbres` runtime (UI culture) |
| **Total** | **540** | **~265,700** | **~118** | |

`desktop/common/`: **19 crates, ~41,800 lines**, all building on Windows, Linux and macOS today (account and token
broker over named pipe / Unix socket, secrets via Credential Manager / Secret Service / Keychain, single instance
via named mutex / `flock`, app storage paths per OS, sync daemon and engine, the `.kbview` grammar, model, metadata
and macros, resources and data models, the web views compiler core). `linux/` and `macos/` hold an 11-line `main`
running the shell's app with `app::TextUi`.

Dependency spine (everything visual rests on the two bottom crates):

```
kubuno-drive-desktop-app-controls  (Canvas, Renderer, Theme, TextFormats, vector icons)
        ^
kubuno-desktop-controls            (ControlCanvas, Visuals, WinForms replicas, host/*)
        ^
kubuno-desktop-ui                  (design system, Graphics + display list)
        ^
kubuno-desktop-views               (.kbview runtime)        kubuno-desktop-print
        ^                                   ^
kubuno-desktop  (facade: Application, forms, dialogs, resources, storage, printing)
        ^
apps: kubuno-office-*, kubuno-calendar, chat, maps, kubuno-desktop-shell, gallery
```

### 2.2 Classification of the framework source (`src/` only)

| Crate | `src` lines | No `windows::` at all | Types only (no platform call) | In files with platform calls |
|---|---:|---:|---:|---:|
| kubuno-desktop-ui | 77,554 | 4,314 | 52,629 | 20,611 (14 files) |
| kubuno-desktop-views | 57,564 | 50,053 | 6,606 | 905 |
| kubuno-desktop-controls | 38,866 | 2,626 | 8,235 | 28,005 (24 files) |
| kubuno-drive-desktop-app-controls | 6,220 | 3,401 | 1,193 | 1,626 |
| kubuno-desktop | 7,517 | 6,793 | 128 | 596 |
| kubuno-desktop-print | 3,907 | 1,742 | 650 | 1,515 |

"Files with platform calls" overstates the work: most of those files contain 1-5 platform lines inside thousands
of portable lines. The files where platform code is the substance:

| File | Lines | Platform lines | What |
|---|---:|---:|---|
| controls/src/host/mod.rs | 4,154 | 260 | window class, wndproc, loops, popups, DWM, DPI |
| controls/src/host/input.rs | 1,158 | 36 | keyboard, wheel, clipboard text, IMM, timers, wakers |
| controls/src/host/painter.rs | 1,034 | 54 | the Direct2D `Painter` (`impl Canvas`, `impl ControlCanvas`) |
| controls/src/host/dnd.rs | 865 | 18 | OLE drop target and drag source |
| controls/src/host/{frame,form,backdrop,caption,chrome,window_tls,access,diagnostics,crash}.rs | 3,387 | ~70 | corners, Form properties, Mica, caption, UIA, logs |
| controls/src/icon_image.rs | 646 | 28 | icon bitmaps (D2D/WIC) |
| controls/src/theme.rs | 1,056 | 26 | UxTheme parts rendered into a DIB and uploaded |
| controls/src/system.rs | 853 | 9 | system colours, metrics, fonts |
| ui/src/splash/{window,art,mod}.rs | 2,571 | 85 | layered splash window on its own thread, software D2D |
| ui/src/graphics/d2d.rs | 506 | 43 | the `Graphics` (WinForms-like) Direct2D executor |
| app-controls/src/renderer.rs | 514 | 23 COM calls | D3D11 device, DXGI composition swap chain, D2D context, DComp, WIC, text formats |
| app-controls/src/themed_icon/mod.rs | 641 | 11 COM calls | SVG-path icons built as `ID2D1PathGeometry` |
| print/src/{engine,xps}.rs | 382 | ~25 | `ID2D1PrintControl`, XPS print job |
| kubuno-desktop/src/{file_dialog,notify_icon,popup}.rs | 838 | ~16 | IFileDialog, Shell_NotifyIcon |

Sum of the platform-substance files: **~19-20k lines**.

### 2.3 Windows API use by area (framework `desktop/windows/*` unless stated)

Format: occurrences / files, per crate.

| Area | Where (occurrences / files) | Notes |
|---|---|---|
| **Direct2D drawing** | ui 667/35, controls 493/21, app-controls 197/11, print 80/4, views 72/15, gallery 7/3 | Mostly `D2D1_COLOR_F` in signatures and constants; real device calls in ~12 files (2.2). `Matrix3x2` transforms 51/6, path geometries 16/5, command lists 12/3, layers 3/3, gradients 4/2, no effects. |
| **DirectWrite text** | ui 301/24, controls 162/11, app-controls 77/2, shell 3, views 4, gallery 2 | Text formats (`TextFormats`, 25 shared `IDWriteTextFormat`), `CreateTextLayout` in 4 files for measuring/drawing, **no DirectWrite hit-testing** (0 `HitTestPoint`/`HitTestTextPosition`), no explicit font fallback (0 `IDWriteFontFallback`), one system font collection enumeration (font picker). ribbon.rs, dock.rs and richtext.rs each create their own DWrite factory and format cache. |
| Caret / selection | `ui/src/fields/outlined.rs::index_at`, `ui/src/richtext.rs::offset_at_x`, `color.rs::index_at` | Computed by **prefix measurement** through `Canvas::measure` (portable as is). |
| **WIC / images** | controls 26/2, print 6/1, app-controls 17/1; office apps: images.rs in documents, presentations, spreadsheets, diagrams (raster) | PNG/JPEG decode to `ID2D1Bitmap1`; Documents also re-encodes (insert plan). |
| **Win32 windowing, loop** | controls 519/14, shell 68/4, ui 103/4, views 77/8, kubuno-desktop 35/5 | 63 distinct `WM_*` handled by the host (section 2.6). |
| **Keyboard / mouse / wheel** | controls 56/3, views 52/19, gallery 27/10, ui 17/4, kubuno-desktop 9/3 | Already abstracted: `host::InputEvent`, `host::vk` (Win32 VK values restated as plain `u16`), `Modifiers`, `Frame` (pointer, buttons, wheel in notches, click count). `vk::` is used 1,174 times in the framework and 248 in office: the codes are portable values, only their *source* is Win32. |
| Touch / pen | none | No `WM_POINTER`/touch handling today: mouse-promoted touch only. |
| **IME** | controls/host/input.rs (IMM32 composition), office documents platform/ime.rs (`ImmSetCompositionWindow`, `ImmSetCandidateWindow`, hidden system caret) | No TSF. `InputEvent::Composition { text, caret }` is portable. |
| **DPI** | controls 52/5, ui 4/1, views 5/1 | Per-monitor V2, `WM_DPICHANGED`, `AdjustWindowRectExForDpi`, `GetSystemMetricsForDpi`. Everything above the host is in DIP. |
| **Clipboard** | controls/host/input.rs (text), views 2/1; office: **6 apps** have `platform/clipboard.rs` (documents, data, diagrams, presentations, projects, spreadsheets) | Documents: private format `Kubuno.Documents.Blocks` + CF_HTML + CF_UNICODETEXT out; + PNG / CF_DIB / CF_HDROP in. |
| **Drag and drop** | controls/host/dnd.rs (OLE `IDropTarget`/`IDropSource`, 865 lines), views/src/dnd.rs, component/control.rs | `InputEvent::FilesDropped`, `do_drag_drop`. |
| **Cursors** | controls 25/2, ui 8/2 | `host::Cursor` enum (portable), `LoadCursorW` behind it. `host::set_cursor` used 65 times. |
| **Timers / wake-ups** | controls 10/1, ui 11/2, views 3/2 | `SetTimer` behind `request_repaint_after` (96 uses), `request_wake_after`, `UiWaker` (`PostMessage(WM_KUBUNO_WAKE)`). |
| **Accessibility** | controls/host/access.rs (`accesskit` 0.25 + `accesskit_windows` 0.35), ui/splash | Tree built portably with AccessKit; only the adapter is Windows. `host::access` used 67 times. |
| **File dialogs / shell** | kubuno-desktop/src/file_dialog.rs (IFileDialog over COM), shell 5/2, header-data 3/1 | `OpenFileDialog`, `SaveFileDialog`, `FolderBrowserDialog`, synchronous `show_dialog()`. |
| **Printing** | print 53/6, views 43/7, kubuno-desktop 10/4, shell 18/2 | D2D print control -> XPS print job, winspool (printers, DEVMODE), comdlg32 print/page-setup dialogs. Preview is already Kubuno-drawn. |
| **Registry / settings** | app-controls 8/1 (theme detection), shell 9/3, ui 4/1, app-storage-components 5/1 | `common/kubuno-desktop-app-storage` already has per-OS backends; the Windows Registry component needs a file-backed equivalent. |
| **Single instance** | `common/kubuno-desktop-single-instance` (portable already), chat platform/protocol.rs (`CreateMutexW`, `FindWindowW`, `WM_COPYDATA`) | Chat's hand-off should move to the common crate. |
| **Notifications / tray** | kubuno-desktop/src/notify_icon.rs (17), shell/platform/tray.rs (13) | `Shell_NotifyIconW`, hidden window. |
| **DWM / chrome** | controls 199/8 | `WM_NCCALCSIZE`/`WM_NCHITTEST` custom chrome, DWM caption colour, corner preference, Mica. |
| **System visuals** | 95 call sites in 14 files (`GetSysColor`, `GetSystemMetrics*`, `SystemParametersInfo*`, `OpenThemeData`, `DrawThemeBackground`) | Section 2.5. |
| **Theme detection** | app-controls/themes/mod.rs | Accent from the DWM registry values, light/dark from `AppsUseLightTheme`. |
| Dates | views/src/clock.rs, calendar, maps, documents platform (`GetLocalTime`, `GetDateFormatEx`) | Replace with `chrono` + `icu`-style formatting already present in the tree (`chrono` with `unstable-locales` is a workspace dependency). |

### 2.4 The `Canvas` boundary

`kubuno-drive-desktop-app-controls/src/canvas.rs` (312 lines) defines the object-safe trait every control paints
through. Its 28 methods:

| Group | Methods |
|---|---|
| Ambient | `theme() -> &Theme`, `formats() -> &TextFormats`, `scale() -> f32` |
| Fill / stroke | `fill_rounded`, `fill_top_rounded`, `fill_triangle`*, `stroke_arc`*, `stroke_rounded`, `stroke_rounded_w` |
| Text | `text(text, rect, &IDWriteTextFormat, &D2D1_COLOR_F, centered)`, `text_aligned(.., DWRITE_TEXT_ALIGNMENT)`, `text_ellipsis`, `text_ellipsis_center`, `measure(text, &IDWriteTextFormat) -> f32` |
| Images | `image(&ID2D1Bitmap1, rect, size)`, `image_alpha` |
| Vector icons | `vector_icon(name, rect, size, color)`, `vector_icon_layered(name, rect, size, fg, accent)` |
| Effects | `draw_card_shadow`, `draw_shadow(rect, radius, layers, colour)`, `erase_rounded` |
| Clips | `push_clip`, `pop_clip`, `push_clip_rounded`, `pop_clip_rounded` |
| Scrolling | `push_offset`*, `pop_offset`*, `begin_extent`*, `end_extent`* |
| Background stack | `current_bg`*, `push_bg`*, `pop_bg`* |
| Escape hatches | `graphics_renderer() -> Option<&Renderer>`*, `note_drawn`* |

(* = provided default.)

`ControlCanvas: Canvas` (`kubuno-desktop-controls/src/control.rs:339`) adds `visuals() -> &Visuals` (system
colours/metrics/fonts), `renderer() -> Option<&Renderer>`, `fill_rect`, `stroke_rect`, `draw_edge` (WinForms 3-D
borders), `draw_theme_part(class, part, state, rect, background) -> bool` (UxTheme) and
`draw_bitmap(&ID2D1Bitmap1, dest, alpha)`.

**Leaked platform types** in the boundary:

| Type | Where it appears | Portable replacement |
|---|---|---|
| `D2D1_COLOR_F` (`{r,g,b,a: f32}`) | every colour parameter, `Theme` fields, constants | `gfx::Color { r, g, b, a }` (same field names and layout) |
| `IDWriteTextFormat` | `text*`, `measure`, all 25 `TextFormats` fields | `gfx::TextFormat` (family, size, weight, style, wrapping, direction) with a backend cache |
| `DWRITE_TEXT_ALIGNMENT` | `text_aligned` | `gfx::TextAlign { Leading, Center, Trailing, Justified }` |
| `ID2D1Bitmap1` | `image*`, `draw_bitmap`, `Images` | `gfx::Image` (premultiplied RGBA + id, backend-uploaded on demand) |
| `Renderer` (D3D11/DXGI/D2D/DComp) | `graphics_renderer()`, `renderer()` | removed from the trait; the needs it served move into Canvas v2 (transforms, opacity layers, paths, rich text runs) |
| `ID2D1PathGeometry` | `IconLayer` (vector icons) | `kurbo::BezPath` (icons are SVG path strings already) |

**Implementors**: `host::Painter` (controls, the real one), `StyledCanvas<C>` (a restyling wrapper),
`ui::graphics::Graphics` (WinForms `Graphics` over a canvas), `ui::graphics::testing::RecordingCanvas` (tests),
plus the apps' own `Painter`s (office documents `platform/painter.rs`, presentations `platform/d2d.rs`, diagrams
and whiteboard `platform/surface.rs`; chat has a near-identical copy).

**How much painting goes through the trait**: 1,019 `&dyn Canvas` and 195 `&dyn ControlCanvas` uses in
`core/desktop`. Bypasses that reach the device directly:

- `.d2d_context` / `.dwrite` / `.d2d_factory` / `graphics_renderer()` / `.renderer()`: 36 files with at least one
  use (top: `controls/styled.rs` 12, `controls/host/painter.rs` 10, office `documents/platform/painter.rs` 10,
  `app-controls/renderer.rs` 8, `ui/graphics/d2d.rs` 7, office `diagrams/platform/surface.rs` 6,
  `presentations/controls/slide_show.rs` 5, `print/engine.rs` 5, ...).
- Direct COM calls (`Fill*`, `Draw*`, `Create*`, `Push*`, `SetTransform`, `GetMetrics`, figure building...):
  framework **~266 call sites in 21 files** (top: `ui/graphics/d2d.rs` 57, `controls/host/painter.rs` 53,
  `ui/splash/art.rs` 32, `controls/icon_image.rs` 25, `app-controls/renderer.rs` 23, `print/engine.rs` 19;
  1-2 each in ribbon.rs, dock.rs, richtext.rs, styled.rs, toolstrip.rs, containers.rs), office apps **~183 in 11
  files** (documents 54 in 3, presentations 64 in 4, diagrams 34 in 2, whiteboard 27 in 1, spreadsheets 4 in 1).
- Apps paint their document bodies with raw Direct2D/DirectWrite *by design*: Documents'
  `platform/painter.rs` states "The DOCUMENT BODY does not go through `Canvas`" (multi-style runs, transforms,
  opacity, dashed lines, rotated bitmaps, leaning caret). These needs are what Canvas v2 must offer (4.3).

**Already a portable intermediate representation**: `kubuno_desktop_ui::graphics::display::{Op, DisplayList}`
(`Fill`, `Stroke`, `Text`, `Image`, `Icon`, `Clear`, `Canvas(CanvasCall)`) records every `Graphics` call with its
state (transform, clips, hints). It is the natural basis for damage tracking, printing and tests.

### 2.5 Text, fonts and system visuals today

- `Renderer::create_text_formats_styled` builds 25 formats from **system** families: *Segoe UI Variable
  Small/Text/Display* (UI text, weights 400/500/600) and *Segoe Fluent Icons* (6 icon sizes), locale `fr-FR`, no
  wrapping except `caption_wrap`/`body_wrap` (emergency break). A user font override replaces the UI family. The
  literal `"Segoe UI"` appears 78 times in 29 framework files (fonts named in `Graphics` calls, defaults).
- Segoe Fluent Icons glyphs are used in only **16 places in 7 files** (caption buttons, chevrons); every other icon
  is a vector path (Files' ThemedIcon paths, Lucide ISC, module logos) in `app-controls/assets/*.txt`.
- Text rendering: default Direct2D text antialiasing on a premultiplied composition swap chain (grayscale in
  practice), natural measuring mode; the `Graphics` layer exposes WinForms `TextRenderingHint` (aliased /
  grayscale / ClearType).
- Documents measures with DirectWrite behind the portable `kubuno_office_docs_core::measure::Measure` trait (advance
  width of a token + ascent/descent); the engine does its own line breaking, identical to the web's
  `canvas-engine.ts`. Default document family: **Arial**; others named in the core: Times New Roman, Courier New,
  Georgia.
- `kubuno-desktop-controls/src/system.rs`: the WinForms replicas read **live** `GetSysColor` colours,
  `GetSystemMetricsForDpi` metrics and the message font from `SPI_GETNONCLIENTMETRICS`, by design ("never written
  down here"), and `theme.rs` renders real UxTheme parts (BUTTON, EDIT, COMBOBOX, LISTVIEW, TREEVIEW, HEADER,
  SCROLLBAR, SPIN, TRACKBAR, TAB, PROGRESS, TOOLBAR, MENU, STATUS, DATEPICKER, MONTHCAL) into a DIB, with a classic
  `DrawEdge` fallback. On a non-Windows system that fallback would give a Windows 95 look: parity needs a frozen
  Windows 11 snapshot of those visuals (4.7).

### 2.6 The host layer: what a portable Window/EventLoop must cover

`kubuno-desktop-controls/src/host` is an immediate-mode host: on every frame it calls the page's paint closure with
a `Frame` (size, pointer, buttons latched per frame, wheel in notches, modifiers, click count, focus, DPI scale,
client origin and monitor work area in screen DIP, chrome height) and a `&dyn ControlCanvas`; input that does not
fit in `Frame` is queued per frame (`events()`, `take_key`, `take_text`, `consume`). Its public API is a small set of
free functions; usage counts over the framework and apps:

`request_repaint_after` 96, `take_key` 89, `vk` 83 (module), `popup` 78, `now_ms` 71, `access` 67, `set_cursor` 65,
`consume` 35, `claim_wheel` 19, `overlay` 17, `dnd` 17, `set_clipboard_text` 14, `form` 11, `events` 11,
`on_message` 10 (+25 `on_message(` method calls), `main_window` 10, `clipboard_text` 10, `key_pressed` 9,
`take_text` 8, `request_wake_after` 7, `quit` 6, `set_zoom` 6, `screen_geometry` 5, `run*` 13, `ui_waker` 4, ...

Messages handled (63): creation/destruction, `WM_PAINT`/`WM_ERASEBKGND`, sizing and move loop
(`WM_SIZE`, `WM_GETMINMAXINFO`, `WM_ENTERSIZEMOVE`/`EXITSIZEMOVE`), DPI (`WM_DPICHANGED`, `_AFTERPARENT`),
non-client (`WM_NCCALCSIZE`, `WM_NCHITTEST`, `WM_NC*BUTTON*`, `WM_NCMOUSEMOVE/LEAVE`), activation/focus, mouse
(L/M/R buttons, double click, move, leave, wheel, horizontal wheel, capture), keyboard (`WM_KEYDOWN/UP`,
`WM_SYSKEY*`, `WM_CHAR`, `WM_SYSCHAR`), IME (`WM_IME_COMPOSITION`, `WM_IME_ENDCOMPOSITION`), `WM_SETCURSOR`,
`WM_TIMER`, `WM_DROPFILES`, `WM_GETOBJECT` (UIA), theme/settings changes, session end, `WM_SYSCOMMAND`, private
`WM_KUBUNO_*` (wake, resize page, tab out, drag, key mods).

A portable host must therefore provide:

| Capability | Today (Win32) | Notes for the portable design |
|---|---|---|
| Top-level windows, several per UI thread | `window_tls` swaps per-window thread-local state | Keep the model; one UI thread = the main thread on macOS. |
| **Nested modal loops** | `run_boxed` `Role::Nested`: `ShowDialog` returns synchronously; owner keeps its last frame (`render()` defers while `rendering`) | 45 `.show_dialog(` + 18 `ShowDialog` + `message_box` call sites in framework and apps. Code-behind relies on it. |
| Modeless / owned windows | `open_window`, `HostOptions::owner`, `modal` disables others | Wayland `xdg_toplevel.set_parent`, X11 `WM_TRANSIENT_FOR`, macOS `addChildWindow`/sheets. |
| **Popups and overlays beyond the window** | `host::popup`/`overlay`: separate top-level windows placed in screen DIP against `Frame::screen_area` | Wayland has no global coordinates: needs `xdg_popup` + positioner; X11 override-redirect; macOS borderless `NSPanel`. |
| Custom chrome | `Chrome::Custom`/`Kubuno`: page-declared title bar drives `WM_NCHITTEST` (drag band, holes, caption buttons, resize borders) | Client-side decorations: interactive move/resize requests per OS, window menu, maximise on double click, rounded corners with transparency. |
| DWM extras | caption colour, corner preference, Mica | Windows only; solid fallback elsewhere. |
| Input | mouse with capture, wheel (notches, precision), keyboard VK + text + modifiers, double/triple click from system settings | Map keysyms / macOS key codes to `vk`; system double-click time/distance per OS. |
| IME | composition string + caret, candidate window position | Wayland text-input-v3, X11 XIM (or IBus/Fcitx via D-Bus), macOS `NSTextInputClient`. |
| DPI | per-monitor V2, DIP everywhere | Wayland `fractional-scale-v1` + viewporter, X11 Xft.dpi/XSETTINGS (+ RandR), macOS backing scale. |
| Timers, wake-ups from other threads | `SetTimer`, `PostMessage` | calloop timers + ping, `CFRunLoopTimer` + `dispatch_async(main)`. |
| Cursors | `Cursor` enum -> `LoadCursorW` | Wayland `cursor-shape-v1` (fallback: cursor theme), X11 Xcursor, `NSCursor`. |
| Clipboard text | `OpenClipboard` | See services (4.9). |
| Drop target and drag source | OLE | Wayland `wl_data_device`, X11 XDND, macOS `NSDraggingDestination/Source`. |
| Accessibility | AccessKit + `accesskit_windows` on `WM_GETOBJECT` | `accesskit_unix` (AT-SPI, X11 and Wayland), `accesskit_macos`. |
| Close protocol | `CloseRequested`, `defer_close`, session end | `xdg_toplevel.close`, `WM_DELETE_WINDOW`, `windowShouldClose:` / `applicationShouldTerminate:`. |
| Diagnostics, crash dialog | debugger output / `%LOCALAPPDATA%` log | Per-OS log dir (already in app-storage paths). |
| Embedding into a foreign window | `HostOptions::parent` (Visual Studio designer) | Windows only; unchanged. |
| Raw message hooks | `on_message`, `MessageArgs { hwnd, msg, wparam, lparam }`, `main_window() -> HWND` | Not portable: 10 + 25 uses; replace by typed services (single-instance hand-off, tray callbacks) and gate the rest `cfg(windows)`. |

### 2.7 What is already portable

- **All of `desktop/common/`** (19 crates, ~41.8k lines): accounts and broker, secrets, single instance, storage
  paths and settings backends, sync daemon and engine, API client, `.kbview` syntax/model/meta/macros, resources and
  data models/macros, web views compiler core, drive shared data.
- **The `.kbview` language** (grammar, model, metadata, codegen macros) and the views runtime logic: 50k of the 57.6k
  `kubuno-desktop-views` lines contain no Windows reference.
- **The input model** (`InputEvent`, `vk` codes as plain values, `Modifiers`, `Frame`), the cursor enum, the
  accessibility tree (AccessKit), the dock layout (JSON), the theme tokens, layout engines (`layout_panels.rs`,
  Dock/Anchor/Flow), every state machine of the widgets, caret/selection logic (prefix measurement).
- **The vector icon data** (SVG path strings, Lucide ISC, Files MIT).
- **Module cores**: `kubuno-office-docs-core` (Documents' layout engine behind `Measure`) and the other
  `kubuno-*-core` crates; the office `common/` crates have 0-1 Windows references.
- **The other module apps** are thin: calendar (6.4k lines) and maps (2.5k) use Windows only for `GetLocalTime`;
  chat (2.7k) only for its single-instance hand-off. The heavy exception is the drive explorer
  (`drive/desktop/windows/kubuno-drive-desktop-windows`: 312 files, 37.9k lines, 96 files with Windows calls:
  shell icons, Explorer integration, cloud files), which should be ported last.

### 2.8 Kubuno Documents in detail (`office/desktop/windows/kubuno-office-documents`, 26 `.rs`, 7.2k lines, 4 `.kbview`)

| Part | Lines | Windows dependency | Portable plan |
|---|---:|---|---|
| views/document_window.{kbview,rs}, link/note/review dialogs, backstage | ~2,800 | `platform::today*`, `short_date` (dates) | unchanged code-behind; dates via a portable `platform` module |
| controls/page_canvas.rs | 1,490 | `Painter`, `renderer().dwrite` as a cache key, `owner_window() -> HWND`, clipboard, IME, images | Canvas v2 + portable services |
| controls/ruler/* | 1,321 | one colour conversion | types only |
| doc/fonts.rs | 206 | DirectWrite `Measure` implementation | `Measure` over the portable text engine (harfrust shaping, same bundled fonts) |
| doc/paint.rs | 463 | `D2D1_COLOR_F` constants, painter | types only |
| platform/painter.rs | 756 | the raw Direct2D painter (41 COM calls) | deleted: Canvas v2 offers its primitives |
| platform/clipboard.rs | 231 | multi-format Win32 clipboard | portable clipboard service with custom formats |
| platform/ime.rs | 121 | IMM32 composition/candidate window, hidden system caret | `host::set_ime_cursor_area(rect)` |
| platform/images.rs | 168 | WIC decode + re-encode | `image` crate (PNG/JPEG/GIF/WebP/BMP) |
| platform/mod.rs | 88 | `GetDateFormatEx` | portable date formatting |

The `linux/` and `macos/` entry points of the office workspace exist (11 lines each) and run the common app with the
portable defaults. Once the framework is portable, the whole `windows/kubuno-office-documents` crate can move to
`common/` and the per-OS crates shrink to entry points.

---

## 3. Reuse: the mobile renderer (`core/mobile/common/kubuno-mobile-render`, ~3k lines)

What it provides (2026-10-15 state, after `vello` was **removed**):

- **taffy 0.6** flexbox layout of a `.kbview` element tree parsed with the shared grammar
  (`kubuno-desktop-views-syntax`), with its own mapping of `Stack`/`Dock`/`ScrollArea`/absolute layout to CSS flex.
- **tiny-skia 0.11** CPU rasterisation: rounded rects, strokes, image cover/transform, soft shadows (silhouette + 3
  box blurs + opacity), clip masks.
- **skrifa 0.22** glyph outlines and metrics, drawn as tiny-skia paths.
- **wgpu 0.20** used only to present the CPU pixmap with a full-screen textured quad (no compute shaders, so it runs
  on the iOS Simulator and any GPU).
- Text input state for fields (`text_input.rs`), hit testing, host controls (`HostControl`, e.g. Maps' `MapView`),
  a UI task queue and waker, Lucide icon paths (109 icons), JPEG decoding.
- The iOS shell drives it with **winit 0.30** + wgpu/Metal.

Its lessons are directly relevant: `vello` 0.2 was dropped because it had no blur and its indirect compute dispatch
does not run on the iOS Simulator; the CPU raster + simple present path proved robust on Android, iPhone and the
simulator, at 10-45 ms per full screen in a release build.

What it does **not** provide, and why it cannot be the desktop renderer as is:

| Need of the desktop | Mobile renderer today |
|---|---|
| Shaping (kerning, ligatures, complex scripts), bidi | per-`char` cmap lookup, advance sum; no kerning, no bidi |
| Font fallback (emoji, CJK, symbols) | missing glyphs are skipped |
| Weights | regular + optional bold file, faux bold by stroking |
| Hinting / glyph cache | unhinted outlines re-filled every frame, no cache |
| The desktop `Canvas` contract | its own `HostCanvas`, not `Canvas` |
| The desktop layout model | taffy flex, whereas desktop views use the WinForms-style Dock/Anchor/Flow engines of `kubuno-desktop-controls`/`-ui` (pixel parity with Windows demands the *same* layout code, not a re-interpretation) |
| Incremental repaint | whole view re-rasterised when it changes |

**Recommendation for sharing.** Do not port the desktop onto the mobile renderer; instead extract a common
**raster + text core** used by both: `kubuno-render-core` (portable `gfx` types, tiny-skia painter primitives
including the shadow blur, image decode, SVG-path icons, glyph cache, the parley-based text engine). The desktop
`Canvas` backend and the mobile `view.rs` painter both sit on it. Mobile then gains shaping, bidi, fallback and
weights for free, and the two renderers stop diverging. The winit + wgpu present path of the iOS shell remains a
valid presenter option for the desktop spike.

---

## 4. Design

### 4.1 Principles

1. **Same pixels = same code + same fonts + same scale.** Parity is engineered by running one rasteriser and one
   text engine everywhere, not by tuning several to look alike.
2. **The apps do not change.** `.kbview` files and code-behind compile unchanged; the migration happens below the
   `kubuno-desktop` facade. Where code-behind touches Win32 directly (10 `on_message`/`HWND` sites, Documents'
   `owner_window`, chat's `WM_COPYDATA`), a portable service replaces it.
3. **Windows never breaks.** Every step is shippable on Windows; Direct2D stays available as a backend until the
   portable one has proven itself.
4. **Linux looks the same on every desktop**: Kubuno draws everything inside its windows including the title bar;
   nothing depends on GTK/Qt themes.
5. **Pure Rust, permissive licences**, no WebView, no Tauri/wry/tao, no process spawning.

### 4.2 Target architecture

```
                 apps (.kbview + code-behind)   - unchanged
                               |
 kubuno-desktop (facade) - Application, forms, dialogs, resources, storage, printing, data
                               |
 kubuno-desktop-views (.kbview runtime)   kubuno-desktop-ui (design system, Graphics)
                               |
 kubuno-desktop-controls (control model, WinForms replicas, ControlCanvas, Visuals)
                               |
 kubuno-desktop-host  - the immediate-mode host (Frame, input queue, popups, title bar,
                        modal stack, window_tls), written ONCE against the platform trait
          |                                       |
 kubuno-desktop-platform (trait)            kubuno-desktop-canvas (Canvas v2, portable types)
   win32 | wayland | x11 | appkit              |                         |
   (windows + clipboard + IME + DnD +     kubuno-render-core          d2d backend
    cursors + timers + a11y adapters)     (tiny-skia + parley +       (Windows, reference/
          |                                skrifa, glyph cache,        fallback during
          |                                tile damage)                transition)
          +---------- presenter per OS: DXGI+DComp | wl_shm | MIT-SHM | CALayer/IOSurface
 services: clipboard, file dialogs, printing (PDF+IPP), notifications/tray, theme/accent, dates
```

Crate moves: `kubuno-drive-desktop-app-controls`, `-controls`, `-ui`, `-views`, `-print`, `-resources`,
`kubuno-desktop`, `-data`, `-shell-controls`, `-header-data`, `-views-ls`, `-app-storage-components` move to
`common/`; `windows/` keeps the Win32 platform backend, the Direct2D backend, the Windows shell face and the
Windows-only extras (Mica, DWM tints, VS embedding, sync root registration). `linux/` and `macos/` get their
platform backends.

### 4.3 Portable graphics types and Canvas v2

New crate `common/kubuno-desktop-gfx` (or the `gfx` module of `kubuno-render-core`):

- `Color { r, g, b, a: f32 }` - **same field names and layout as `D2D1_COLOR_F`**, so the 749 + 103 + 92 literal
  constructions `D2D1_COLOR_F { r, g, b, a }` become `Color { r, g, b, a }` by a mechanical rename.
- `Rect`, `Point`, `Size`, `Affine` (2x3, `kurbo::Affine`), `Path` (`kurbo::BezPath`), `TextAlign`,
  `TextFormat` (a value: family list, size, weight, style, stretch, wrapping, trimming, reading direction, locale;
  hashed into the backend's cache), `Image` (shared premultiplied RGBA8 pixels + generation id), `Brush` (solid,
  linear, radial), `Pen` (width, dash, caps, joins).

Migration without a flag day (M1):

1. On Windows, `pub type Color = D2D1_COLOR_F;` is **not** used; instead `Color` is its own struct with `From`
   conversions both ways, and the D2D backend converts at its boundary (cost: one struct copy). A temporary alias
   module `compat` (`pub use Color as D2D1_COLOR_F;` re-export inside the framework only) lets the rename proceed
   crate by crate while everything compiles.
2. `TextFormats` fields become `TextFormat` values; the 3 private DWrite factories (ribbon, dock, richtext) go away.
3. `ID2D1Bitmap1` users receive `Image`; the D2D backend uploads and caches by id.
4. `graphics_renderer()` / `renderer()` are replaced by Canvas v2 capabilities, after which the escape hatches are
   removed (apps that still need raw Direct2D keep it under `cfg(windows)` only temporarily).

**Canvas v2** keeps every current method (same names, portable types) and absorbs what apps currently do with the
raw device, so the office apps' own painters disappear:

- `push_transform(Affine)` / `pop_transform` (today the D2D context transform, used by page canvases, slide
  canvases, rulers);
- `push_layer(opacity, clip: Option<Path>)` / `pop_layer`;
- `fill_path` / `stroke_path` with `Brush` and `Pen` (dash, caps, joins);
- `draw_image(image, dest, src, opacity, transform)` (rotated bitmaps);
- `draw_text_layout(&TextLayout, origin, brush)` where `TextLayout` is a shaped, multi-run paragraph built by the
  text engine (Documents' body runs, rich text);
- `measure_text(&str, &TextFormat) -> TextMetrics` (advance, ascent, descent, line gap) - a superset of `measure`.

`ControlCanvas::draw_theme_part` and `visuals()` stay, but are served from the frozen visuals table on non-Windows
systems (4.7). `kubuno_desktop_ui::graphics::Graphics` keeps its WinForms API and its display list; its D2D executor
becomes one executor among two (`graphics/d2d.rs` and a new `graphics/raster.rs`), the fallback executor stays for
test doubles.

### 4.4 Rendering backend: options and decision

| Option | Pixel parity Win/Linux/macOS | Performance | Effort | Risks |
|---|---|---|---|---|
| **A. One CPU raster backend everywhere (tiny-skia + own glyph cache), Windows included** | **By construction** (same code, fonts, scale); bit-exact per architecture | Full-frame CPU raster; needs tile damage and glyph caching; fine for UI, to be measured for scrolling documents at 4K | Medium: Canvas v2 + text engine + 4 small presenters | Text look changes on Windows (DirectWrite -> our rasteriser); CPU cost at very high resolutions |
| B. Keep Direct2D on Windows, portable backend on Linux/macOS | Layout parity possible (same fonts, unhinted advances), **pixel parity impossible** (different rasteriser, gamma, hinting, ClearType) | Best on Windows (GPU) | Medium (same as A minus the Windows switch) + permanent double maintenance and double testing | Two rendering truths forever; every visual fix tested twice |
| C. vello on wgpu (GPU compute) everywhere | Good but GPU/driver dependent anti-aliasing differences; needs a CPU fallback (VMs, RDP, old GPUs) | Excellent | High; API churn | Already rejected on mobile (no blur in 0.2, indirect dispatch unsupported on some Metal targets); compute shader support varies |
| D. Skia via `skia-safe` everywhere | By construction on its CPU raster; GPU optional | Excellent, mature (Chrome's engine) | Medium; C++ toolchain or prebuilt binary download at build time, +15-25 MB per statically linked app, slow builds | Supply chain of prebuilt binaries, build complexity in offline CI, very large dependency for 10+ apps each linking statically |

**Decision: A.** Reasons: it is the only option where "identical pixels" is a property of the design rather than a
tuning target; it is pure Rust with permissive licences; it reuses what the mobile renderer validated on real
devices (tiny-skia + skrifa + simple present); it runs everywhere including VMs and remote sessions; and its cost
is controllable with damage tracking. The rasteriser sits behind an internal `RasterBackend` trait so a GPU path
(vello_cpu / vello_hybrid / vello when mature, or a Skia backend) can be added later without touching `Canvas`;
any GPU backend would then be validated against the CPU reference.

Performance design (the host repaints the whole window every frame today, `InvalidateRect(None)` + flip-discard):

- Record each frame as a display list (Canvas v2 calls are recorded, cheap), split into 128x128 or 256x256 device
  pixel tiles, hash the ops touching each tile, **re-rasterise only tiles whose hash changed**, and in parallel
  across tiles (rayon). Present only damaged regions where the presenter supports it (wl_shm damage, partial
  `XShmPutImage`, `IDXGISwapChain1::Present1` dirty rects).
- Glyph cache: coverage masks keyed by (font id, glyph id, size in 1/64 px, subpixel x offset quantised to 1/4 px).
- Shadow cache: blurred silhouettes keyed by (size, radius, layers, scale).
- Image cache: resampled images keyed by (image id, destination size).
- Budget to verify in S1/M2: <= 8 ms per frame for a gallery page at 2560x1600, <= 16 ms while scrolling a
  Documents page at 3840x2160 on the .100 machine.

Presenters (each a few hundred lines):

| OS | Presenter | Notes |
|---|---|---|
| Windows | upload the CPU buffer into the existing DXGI composition swap chain (staging texture + `CopySubresourceRegion`), keep DirectComposition | keeps transparency, Mica and the current window plumbing |
| Wayland | `wl_shm` ARGB8888 premultiplied, double-buffered pool, `wl_surface.damage_buffer`, `wp_viewporter` for fractional scale | always composited, so rounded corners and transparency work |
| X11 | 32-bit ARGB visual + MIT-SHM `PutImage` (plain `PutImage` fallback) | without a compositor: opaque, square corners (defined fallback) |
| macOS | `CALayer` backed by an `IOSurface` (or `CGImage`) with premultiplied BGRA, `contentsScale` = backing scale | alternatively a CAMetalLayer blit through wgpu (the iOS path) |

### 4.5 Text stack

Requirements: shaping with kerning and ligatures, complex scripts, bidi (the framework has `right_to_left`), line
breaking for wrapped labels and rich text, ellipsis trimming, font fallback chains (emoji, CJK, symbols), weights
400/500/600/700 and italics from real font files, precise measurement (Documents' `Measure` must return the advances
the web's canvas returns), cursor/selection geometry (today by prefix measurement; a real cluster-aware
hit-test is better for complex scripts), and deterministic rasterisation.

| Candidate | Licence | Fit |
|---|---|---|
| **parley** (+ **fontique** font collection/fallback, **harfrust** shaping, **skrifa** outlines and hinting, ICU4X segmentation) | Apache-2.0 OR MIT (harfrust: MIT) | Layout, bidi, line breaking, alignment, cluster hit-testing, cursor and selection geometry, editor helpers; same fontations stack as the mobile renderer (skrifa); rasterisation is left to us (tiny-skia), which is what parity needs. 0.x API: pin and wrap. |
| cosmic-text (rustybuzz/harfrust, fontdb, swash) | MIT OR Apache-2.0 | Mature batteries (buffer, editor, fallback); used by the COSMIC desktop and iced. Good fallback if parley's maturity disappoints. |
| swash (shaping + scaling) | Apache-2.0 OR MIT | Lower level; parley already covers its role. |
| HarfBuzz/ICU via Skia | MIT/BSD (C++) | Only with option D. |

**Decision: parley + fontique + harfrust + skrifa**, wrapped behind a `TextEngine` trait owned by Kubuno
(`shape_line`, `layout_paragraph`, `measure`, `hit_test`, `caret_rect`, `selection_rects`) so the engine can be
swapped. fontique is configured with **bundled fonts only** (system font enumeration disabled for UI text) so the
fallback chain is identical everywhere. Rasterisation: skrifa outlines (unhinted, or skrifa's autohinter if the
owner prefers crisper small text on Windows-like screens; the same choice applies on every OS) filled by tiny-skia
into the glyph cache, with a gamma/contrast curve tuned once to approximate DirectWrite's grayscale look.

Side benefit: harfrust is a HarfBuzz port, the shaper Chrome uses, so Documents' token widths will match the web
client's `measureText` better than DirectWrite does today.

Colour emoji: COLRv1 painting through skrifa's colour-glyph API into tiny-skia (gradients, clips) or the CBDT bitmap
version of Noto Color Emoji as a first step.

### 4.6 Fonts and icons

Segoe UI Variable, Segoe Fluent Icons, Arial, Times New Roman, Courier New, Georgia, Calibri and Cambria are
Microsoft/Monotype fonts licensed with Windows: they **cannot be shipped** to Linux or macOS. Pixel parity therefore
requires an open font set **used on all three systems, Windows included**. Proposed set (all SIL OFL 1.1 unless
stated; OFL fonts may be bundled with AGPL software):

| Role | Today | Proposed bundled font | Why |
|---|---|---|---|
| UI text | Segoe UI Variable (system) | **Owner decision D1**: *Selawik* (Microsoft's open, Segoe UI metric-compatible font: least visible change), or *Plus Jakarta Sans* (the web's font: desktop = web), or *Inter* | one family, 4 weights + italics |
| UI icons (16 glyph uses) | Segoe Fluent Icons | vector paths (Fluent UI System Icons, MIT, or Lucide, ISC) | already the pattern for every other icon |
| Document default (Arial) | Arial | Liberation Sans | metric-compatible: identical advances, same pagination |
| Times New Roman | system | Liberation Serif | metric-compatible |
| Courier New | system | Liberation Mono | metric-compatible |
| Georgia | system | Gelasio | metric-compatible |
| Calibri / Cambria (Word documents) | system | Carlito (OFL) / Caladea (Apache-2.0) | metric-compatible |
| Fallback | DirectWrite system fallback | Noto Sans (+ Arabic, Hebrew, Devanagari...), Noto Sans CJK subset, Noto Color Emoji | defined, identical chain |

Delivery (**owner decision D7**): the full set with CJK is tens of megabytes; since every app links statically and
Kubuno Desktop is mandatory on every PC (`BUILD.md`), install the fonts **once** with Kubuno Desktop into a shared
per-OS directory (e.g. `%ProgramData%\Kubuno\fonts`, `/usr/share/kubuno/fonts`, `/Library/Application
Support/Kubuno/fonts`), with the UI family and Liberation Sans also embedded in each app (~2 MB) so an app still
renders if the shared set is missing. Fonts are loaded from memory (fontique in-memory sources), never registered
system-wide.

This **reverses two recorded decisions** and must be confirmed: "desktop keeps the system font (Segoe UI Variable)"
(2026-09-30) and "on Linux the system font is still followed" (2026-10-07). With the system font, parity can only be
layout-level, not pixel-level.

### 4.7 System visuals of the WinForms replicas

The replicas in `kubuno-desktop-controls` (buttons, text boxes, lists, tool strips...) intentionally paint with the
live Windows system colours, metrics, message font and UxTheme parts. For Linux/macOS parity:

1. A Windows tool (`kubuno-desktop-visuals-dump`) records, on a reference Windows 11 machine, `GetSysColor` for every
   `COLOR_*` used, `GetSystemMetricsForDpi` at 96/120/144/168/192 DPI, the `NONCLIENTMETRICS` fonts, light and dark,
   into a generated Rust table (`visuals_win11.rs`).
2. The 16 UxTheme classes used are re-drawn as **vector recipes** (rounded rects, gradients, glyph paths) checked
   against real UxTheme renders on Windows at each DPI; the recipes are drawn through Canvas v2 (Microsoft's theme
   bitmaps are not copied).
3. `Visuals::current()` returns the live values on Windows by default and the frozen table elsewhere; a
   `KUBUNO_PARITY=1` switch (and the parity tests) force the frozen table on Windows too.
4. The WinForms "system font" (Segoe UI 9 pt) maps to the bundled UI family at the same size.

### 4.8 Windowing and the platform layer

#### winit evaluated

winit 0.30 (already used by the iOS shell) would give, quickly: windows, keyboard layouts (xkb), IME events
(text-input-v3, XIM, NSTextInputClient), DPI, cursors, drag-move/resize requests, file drops, raw window handles,
AccessKit integration (`accesskit_winit`). It falls short on points the framework depends on:

| Framework need | winit 0.30 |
|---|---|
| Synchronous `ShowDialog` (nested modal loop inside an event handler; 45+18 call sites) | not possible: the event loop is borrowed by `run_app`/`pump_app_events`, no re-entrant pumping (a stackful-coroutine workaround exists but makes every handler run on a coroutine stack) |
| Menus/tooltips/popovers that overflow the window (`host::popup`, 78 uses) on Wayland | no `xdg_popup`; top-level windows cannot be positioned on Wayland |
| Owned dialogs on Wayland (`xdg_toplevel.set_parent`) | not exposed |
| Client-side shadows on Wayland (`xdg_surface.set_window_geometry`) | not exposed when decorations are off |
| Drag source (drag out of a Kubuno window) | not supported |
| Multi-format clipboard, custom formats | out of scope of winit |
| UIScene lifecycle on iOS 26+ (mobile) | missing (already a known problem of the iOS shell) |

#### Decision: an own platform layer, winit only for the first spike

`kubuno-desktop-platform` defines what the host needs (window create/configure/close, owned/modal windows, popups
with a positioner, title-bar move/resize/menu requests, present a pixel buffer with damage, events in, timers,
cross-thread wake, cursors, IME area, clipboard, DnD, accessibility adapter hook, monitors/work areas when known) and
a **re-entrant `run_until(condition)`** used both by the main loop and by nested modal loops. The host (Frame, input
queue, popups, title bar, `window_tls`, modal stack) is then written once on top of it, extracted from today's
`host/mod.rs`. Backends:

| Backend | Built on (licence) | Notes |
|---|---|---|
| Win32 | existing host code (`windows` crate) | mostly a move: the wndproc becomes the backend, the Frame/queue logic moves up |
| Wayland | smithay-client-toolkit (MIT), wayland-client/protocols (MIT), calloop (MIT), xkbcommon (MIT) | xdg-shell toplevel + **xdg_popup** with positioner and constraint adjustment, `xdg-decoration` (request client side), `fractional-scale-v1`, `viewporter`, `cursor-shape-v1`, `text-input-v3`, `wl_data_device` (clipboard and DnD), `xdg-activation`, `idle-inhibit` if needed |
| X11 | x11rb (MIT OR Apache-2.0), xkbcommon, an XIM client (`xim` crate) | override-redirect popups, `_NET_WM_MOVERESIZE` for client-side move/resize, `_GTK_FRAME_EXTENTS` for shadows, XInput2 for smooth scrolling, XSETTINGS for DPI and double-click time, XDND, selections |
| AppKit | objc2, objc2-app-kit, objc2-foundation, objc2-quartz-core (MIT / Zlib OR Apache-2.0 OR MIT) | `NSWindow` (borderless + resizable + full-size content, own caption), `NSView` subclass implementing `NSTextInputClient`, `NSPanel` popups, `NSDraggingSource/Destination`, nested modal loop with `nextEventMatchingMask:untilDate:inMode:dequeue:` |

Nested modal loops become natural: the platform callbacks only *queue* events; the Kubuno loop drains the queue,
runs frames, and a `show_dialog` simply calls `run_until(dialog_closed)` again (Wayland and X11 dispatch is
re-entrant from our loop; AppKit supports nested event loops natively). The owner window keeps its last frame, as
today.

#### Wayland and coordinates

Wayland hides global positions: `Frame::client_origin` and `Frame::work_area` cannot be known. The host reports
`client_origin = (0, 0)` and the output's logical size as `work_area` (best effort), and every `popup`/`overlay` is
created as an `xdg_popup` anchored on the requested rectangle, with flip/slide constraint adjustment; the compositor's
`configure` tells the final position, which the host feeds back so the page's hit-testing in client coordinates stays
correct. The page API does not change.

#### Client-side decorations (Linux and macOS)

Every Kubuno window already supports `Chrome::Custom` (the page draws its title bar and declares drag band, holes,
caption buttons). On Linux and macOS the host forces it:

- move: `xdg_toplevel.move` / `_NET_WM_MOVERESIZE` / `performWindowDragWithEvent:`; resize from the 8 border zones:
  `xdg_toplevel.resize` / `_NET_WM_MOVERESIZE` / AppKit resizable style mask; double click toggles maximise;
  right click opens the compositor's window menu (`xdg_toplevel.show_window_menu`) where available.
- corners: 8 DIP radius drawn by Kubuno with transparent pixels (Wayland, composited X11, macOS); square on X11
  without compositor.
- shadow: drawn by Kubuno in a transparent margin declared through `set_window_geometry` (Wayland) and
  `_GTK_FRAME_EXTENTS` (X11); `hasShadow` on macOS. Out of the parity scope (outside the client area).
- caption buttons: **owner decision D3** for macOS (Windows-style buttons on the right, identical, versus the
  traffic lights).

#### Input mapping

- Keys: xkb keysyms and macOS `kVK_*` codes mapped to `vk` values (table generated once, unit-tested both ways);
  text from IME commits / `insertText:`; `Modifiers.meta` = Super/Command.
- **Owner decision D4**: on macOS report Command as `ctrl` (and Control as `meta`) so code-behind shortcuts
  (`Ctrl+S`) work as `Cmd+S` without change.
- Wheel: Wayland `axis_value120` / X11 XI2 smooth scrolling / macOS `scrollingDeltaY` (with `hasPreciseScrollingDeltas`)
  normalised to the host's notches (`WHEEL_NOTCH_DIP` = 100).
- Double/triple click: system interval and distance per OS (XSETTINGS `Net/DoubleClickTime`, `NSEvent.doubleClickInterval`).
- Touch and pen: not handled today on Windows either; leave for later (both OS can promote to pointer events).

#### DPI

All framework code works in DIP. Scale sources: Windows per-monitor DPI; Wayland preferred fractional scale
(buffer = round(logical x scale), mapped by viewporter); X11 Xft.dpi / XSETTINGS (GNOME on Xorg exposes one global
scale); macOS backing scale (1 or 2). Parity is tested at 1.0 and 2.0 on all three, 1.25/1.5 on Windows and Linux.

#### Threads

The UI thread must be the process main thread on macOS (AppKit). Two current behaviours need care: the splash
screen paints on **its own thread** (`kubuno-desktop-ui/src/splash`), which AppKit forbids; on macOS the splash is
drawn on the main thread before the main window is built (or as a `CALayer` updated from a background thread under
`CATransaction`, to be validated). Worker threads wake the UI with `UiWaker`, mapped to calloop's ping / an eventfd
on Linux and `dispatch_async(main_queue)` / `CFRunLoopSource` on macOS.

### 4.9 Platform services per OS

| Service | Windows (today) | Linux | macOS | Portable API |
|---|---|---|---|---|
| Clipboard | Win32 (text in host; multi-format in 6 office apps) | Wayland `wl_data_device` (through the platform backend's connection, needs the focus serial), X11 selections (CLIPBOARD/PRIMARY, INCR) | `NSPasteboard` with custom UTIs | `Clipboard::{read,write}(formats)` with text, html, png, files, custom `application/x-kubuno-*`; the office clipboards become format mappings only |
| IME | IMM32 composition + candidate placement | text-input-v3 (Wayland), XIM (X11); IBus/Fcitx through them | `NSTextInputClient` (marked text, `firstRectForCharacterRange`) | `InputEvent::Composition` (exists) + `host::set_ime_cursor_area(rect)` replacing Documents' `platform/ime.rs` |
| Drag and drop | OLE target + source | `wl_data_device` / XDND | `NSDraggingDestination` / `NSDraggingSource` | existing `host::dnd` API, files + text + custom formats |
| Accessibility | AccessKit + accesskit_windows | **accesskit_unix** (AT-SPI over D-Bus, X11 and Wayland, Orca) | **accesskit_macos** (VoiceOver) | unchanged tree (`host::access`), adapter per backend; align versions |
| File dialogs | IFileDialog | xdg-desktop-portal FileChooser via **ashpd** (zbus, pure Rust); Kubuno-drawn fallback when no portal | `NSOpenPanel` / `NSSavePanel` (modal loop) | existing `OpenFileDialog`/`SaveFileDialog`/`FolderBrowserDialog`; **owner decision D5**: native picker (like Windows' own IFileDialog) vs Kubuno-drawn picker for identical look |
| Printing | D2D print control -> XPS, winspool, comdlg32 dialogs | Kubuno-drawn print and page-setup dialogs; pages rendered through a **PDF Canvas backend** (krilla, MIT OR Apache-2.0, fonts embedded via skrifa); job submitted by **IPP to CUPS** (local socket or :631, `ipp` crate) - no process spawned | same IPP-to-CUPS path (macOS uses CUPS), or `NSPrintOperation` with the PDF | `PrintDocument` unchanged; "Save as PDF" everywhere |
| Notifications | (toasts via the shell) | `org.freedesktop.Notifications` or the portal Notification interface (zbus) | `UNUserNotificationCenter` (needs a signed bundle) | `notify(title, body, actions)` |
| Tray / NotifyIcon | `Shell_NotifyIconW` | StatusNotifierItem over D-Bus (KDE, XFCE, MATE; GNOME needs the AppIndicator extension: **D8**) | `NSStatusItem` | existing `NotifyIcon` |
| Theme and accent | registry (`AppsUseLightTheme`, DWM colour) | portal Settings `org.freedesktop.appearance` (`color-scheme`, `accent-color`) | `NSApp.effectiveAppearance`, `NSColor.controlAccentColor` | `Theme::detect()` |
| Settings / Registry component | registry | file store of `kubuno-desktop-app-storage` (already per OS) | same | storage components map "Registry" to the file store |
| Single instance | named mutex + pipe (common crate) | flock + Unix socket (done) | same (done) | move chat's `WM_COPYDATA` hand-off onto it |
| Secrets | Credential Manager | Secret Service (done) | Keychain (done) | unchanged |
| Dates / locale | `GetLocalTime`, `GetDateFormatEx` | chrono + locale data | same | `kubuno_desktop::clock`, `format_date(style)` |
| Cursors | `LoadCursorW` | cursor-shape-v1 / Xcursor theme | `NSCursor` | existing `Cursor` enum (system cursors: outside the parity scope) |

### 4.10 Licences of the proposed dependencies

All permissive and compatible with distribution under AGPL-3.0-or-later: tiny-skia (BSD-3-Clause), skrifa /
read-fonts (Apache-2.0 OR MIT), parley / fontique (Apache-2.0 OR MIT), harfrust (MIT), ICU4X (Unicode-3.0),
kurbo (Apache-2.0 OR MIT), smithay-client-toolkit (MIT), wayland-rs (MIT), calloop (MIT), x11rb (MIT OR
Apache-2.0), xkbcommon crate (MIT), objc2 family (MIT; app-kit bindings Zlib OR Apache-2.0 OR MIT), AccessKit
(MIT OR Apache-2.0), ashpd / zbus (MIT), image (MIT OR Apache-2.0), krilla (MIT OR Apache-2.0), rayon (MIT OR
Apache-2.0); fonts under SIL OFL 1.1 (Selawik, Liberation 2.x, Gelasio, Carlito, Noto) and Apache-2.0 (Caladea);
icons ISC (Lucide) / MIT (Fluent UI System Icons, Files). Exact versions are pinned at spike time; each licence is
re-checked with `cargo deny` in CI.

### 4.11 Parity test harness

- **Offscreen golden renders**: every gallery page and every `.kbview` of an app rendered headless by the portable
  backend to PNG at scales 1.0/1.5/2.0, light and dark (`--render-to-png <dir>`), on Windows, Linux and macOS CI
  runners and on .100/.23; compared byte for byte (same arch) or with the tolerance of 1.2 (cross-arch).
- **Live-window capture**: the host can dump its last presented frame (`KUBUNO_CAPTURE_FRAME=path`) so live windows
  are compared without depending on the OS screenshot tools; OS screenshots (`import`/`gnome-screenshot` on .100,
  `screencapture` on .23) are kept for the visual montage the owner reviews.
- **Direct2D comparison on Windows**: same pages through the D2D backend; per-widget bounding boxes of non-background
  pixels must match exactly, and an SSIM threshold (e.g. >= 0.98) flags regressions; a side-by-side montage is
  produced for review.
- **Scripted interaction**: a test input driver injects `InputEvent`s/`Frame`s at the host level (not OS-level), so
  hover, focus, menus and dialogs replay identically on the three systems.
- **Documents layout dump**: page count, line breaks and glyph positions dumped as JSON from the layout engine and
  compared across OS (and against the web client).

---

## 5. Plan

### 5.1 Owner decisions needed first (M0)

| Id | Decision | Recommendation |
|---|---|---|
| D1 | UI font bundled on all three OS (Windows included), replacing Segoe UI Variable | Yes; Selawik for least change, or Plus Jakarta Sans for desktop = web |
| D2 | Document fonts: bundled metric-compatible set on all OS, or installed originals when present | Bundled set everywhere (parity); originals optional per user setting later |
| D3 | macOS caption buttons | Identical (Kubuno buttons on the right) |
| D4 | macOS shortcuts | Command reported as Ctrl |
| D5 | File picker | Native picker (portal / NSOpenPanel), Kubuno-drawn fallback |
| D6 | Windows moves to the portable renderer | Yes, after M6, with Direct2D kept one release as fallback |
| D7 | Font delivery | Shared directory installed by Kubuno Desktop + small embedded core set |
| D8 | Tray on GNOME | Accept "no tray unless AppIndicator extension"; notifications still work |

### 5.2 Spikes

**S1 - Canvas parity spike (first, ~2-3 person-weeks).** Smallest end-to-end proof of the rendering architecture
using the real `Canvas` contract:

1. Create `common/kubuno-desktop-gfx` (Color, Rect, Affine, Path, TextFormat, TextAlign, Image).
2. Port `kubuno-drive-desktop-app-controls` (6.2k lines: `Canvas`, `Theme`, `TextFormats`, vector icons, and the
   Files widgets: button, switch, breadcrumb bar, toolbar, sidebar, scrollbar, storage bar/ring, omnibar) to those
   types on a branch; `renderer.rs` and the D2D geometry building move under `cfg(windows)`; vector icons parse to
   `kurbo::BezPath`. The crate must `cargo build` on Windows, Linux and macOS.
3. A portable `Canvas` implementation on tiny-skia + parley/fontique/harfrust/skrifa with one bundled UI family.
4. A `canvas-parity` example: a fixed widget sheet (each widget, each state, light/dark) rendered to PNG at
   1.0/1.5/2.0 by (a) the portable canvas on Windows, Linux (.100) and macOS (.23), (b) the existing Direct2D
   `Painter` on Windows (detached renderer, read back). A tiny live viewer window may use winit (fast to write) to
   show the sheet with hover.
5. Report: byte comparison across OS, SSIM and bounding-box comparison against D2D, frame times, binary size delta,
   and a montage for the owner.

Go criteria: bit-identical sheets between Windows-x86_64 and Linux-x86_64, within tolerance on macOS-aarch64;
widget boxes identical to D2D; acceptable look in the owner's review; frame time within budget.

**S2 - Platform layer spike (~2 person-weeks, can run in parallel with M1).** One window with Kubuno-drawn title bar
(move, resize, maximise), a button opening a **modal dialog through a nested `run_until`** that returns a result
synchronously, a menu popup that **overflows the window** (xdg_popup on Wayland), text typed with an IME, on GNOME
Wayland and GNOME Xorg (.100) and macOS (.23). Go criteria: all behaviours work with the own backends; decide
definitively between own backends and winit (+ coroutines) with measured effort.

### 5.3 Milestones and acceptance tests

| Milestone | Content | Acceptance test |
|---|---|---|
| **M0** Decisions | D1-D8; font files selected and licence files added | written decisions recorded in the desktop README |
| **M1** De-Windows the paint types (Windows only) | `kubuno-desktop-gfx`; Canvas/ControlCanvas/Graphics/TextFormats/Theme/Visuals on portable types in every framework crate and the apps; private DWrite factories removed; Canvas v2 primitives added and implemented by the D2D backend; office painters moved onto Canvas v2 | Windows: gallery pages and Documents screenshots **bit-identical before/after** (D2D backend), all tests green; `cargo check -p kubuno-drive-desktop-app-controls` on Linux and macOS |
| **M2** Portable renderer + text + fonts | `kubuno-render-core` (raster, glyph cache, tile damage, shadows, images), `TextEngine` on parley, bundled fonts, frozen Win11 visuals table and themed-part recipes, `graphics/raster.rs` executor | Offscreen render of **all gallery pages** and all framework `.kbview` samples identical on Windows, Linux, macOS (1.2 tolerance); D2D comparison report reviewed by the owner |
| **M3** Framework crates to `common/` | move app-controls, controls (minus host backend), ui, views, print model, resources, `kubuno-desktop`, data, shell-controls, header-data, views-ls, storage components; host split into `kubuno-desktop-host` + `kubuno-desktop-platform` trait with the Win32 backend; CI matrix builds `common/` on 3 OS | `cargo build` + `cargo test` of the framework and the gallery (headless mode) on Linux and macOS in CI; Windows behaviour unchanged (gallery, shell, Documents smoke tests) |
| **M4** Platform hosts | Wayland, X11 and AppKit backends: windows, nested modal loops, popups, CSD, input, DPI, cursors, timers, wakers, presenters, accessibility adapters | Gallery **interactive** on .100 (GNOME Xorg and GNOME Wayland sessions; plus a KDE and an XFCE check) and .23: every page captured through `KUBUNO_CAPTURE_FRAME` and compared with the Windows capture of the same page and scale (identical); scripted interaction replay identical; Orca/VoiceOver read the gallery buttons |
| **M5** Platform services | clipboard (multi-format), IME area, DnD, file dialogs, notifications, tray, theme/accent, settings component, dates, printing (PDF backend + IPP) | per-service checklist on .100 and .23: copy/paste rich content between two Kubuno apps and plain text with gedit/TextEdit; Japanese input (IBus / macOS) in a text box and a document; drop a file from Nautilus/Finder; open/save dialogs; print a gallery page to a CUPS queue and to PDF; dark mode follows the system |
| **M6** Kubuno Documents on Linux and macOS | `doc/fonts.rs` Measure on the text engine; painter -> Canvas v2; clipboard/IME/images onto the services and the `image` crate; dates portable; crate moved to `office/desktop/common`; linux/macos entry points run `DocumentWindow` | on .100 and .23: open the reference documents, **layout dump identical to Windows** (pages, line breaks, glyph x positions), page and ribbon captures identical at 1.0 and 2.0 to the Windows run on the portable backend; scripted edit session (typing, bold, image insert, undo, save to server) gives identical document JSON |
| **M7** Windows on the portable renderer, then the other apps | switch Windows' default backend (D2D kept behind a setting for one release); port spreadsheets, presentations, diagrams, whiteboard, data, projects, maths, script; calendar, chat, maps; the shell's Linux/macOS faces; drive explorer last | per app: its `.kbview` golden renders identical on 3 OS; Windows users' review of the text rendering change before release |
| M8 Packaging (outside this study) | Linux packages for the desktop apps, macOS signed/notarized `.app` | install and launch tests on clean VMs |

### 5.4 Effort (person-weeks, indicative)

| Item | Size | Person-weeks |
|---|---|---:|
| S1 Canvas parity spike | M | 2-3 |
| S2 Platform layer spike | M | 2 |
| M1 Type migration + Canvas v2 + office painters | L (mechanical, wide: ~150 framework files, ~40 app files) | 4-6 |
| M2 Renderer, text engine, fonts, visuals freeze, themed-part recipes | L | 6-9 |
| M3 Crate moves, host/platform split, CI matrix | M | 3-4 |
| M4 Wayland + X11 backends | XL | 8-12 |
| M4 AppKit backend | L | 5-8 |
| M5 Services (clipboard, IME, DnD, a11y adapters, dialogs, printing, tray, notifications, theme) | L-XL | 8-12 |
| M6 Documents | M | 3-5 |
| **Total to Documents identical on Linux and macOS** | | **~41-61** |
| M7 Windows switch + review | M | 2-3 |
| M7 each other office app / calendar / chat / maps | S-M each | 1-3 each |
| M7 drive explorer (96 Windows files, Explorer integration) | XL | 8+ |

### 5.5 Risk register

| Id | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Font decision: Segoe/Arial cannot ship; parity needs bundled fonts on Windows too, reversing two owner decisions | Blocks pixel parity | M0 decision first; S1 montages with candidate fonts |
| R2 | Text on Windows will look different from DirectWrite (rasteriser, gamma, hinting, no ClearType) | User-visible change on the main platform | tune gamma/contrast once, owner review in S1/M2, keep D2D as fallback one release |
| R3 | CPU rasterisation cost at 4K / 200 % with full-frame repaint | Sluggish scrolling in Documents/Presentations | tile damage + caches + parallel tiles; measure in S1; optional GPU backend later behind `RasterBackend` |
| R4 | Wayland specifics: no global coordinates, popup constraints, CSD geometry, compositor differences | Menus/tooltips misplaced, DE-specific glitches | xdg_popup with feedback to the host; test GNOME, KDE, Sway; X11 path in parallel |
| R5 | Nested modal loops on macOS / AppKit re-entrancy; splash thread | Hangs or crashes on macOS | S2 proves it early; splash on main thread on macOS |
| R6 | IME quality on X11 (XIM) and Wayland compositors without text-input-v3 | CJK users blocked on some setups | prefer Wayland text-input; IBus/Fcitx D-Bus path as fallback |
| R7 | Re-creating Windows 11 themed parts for the WinForms replicas | Visual drift of replica controls | dump tool + per-part golden comparison against UxTheme renders |
| R8 | Floating-point determinism across x86_64 and aarch64 (libm `powf`, `exp` in gradients/blur/gamma) | Tiny cross-arch pixel differences | own polynomial approximations in the raster core; tolerance policy |
| R9 | 0.x crates (parley, fontique, harfrust, skrifa) API churn | Upgrade cost | pin versions, wrap behind `TextEngine`, upgrade deliberately |
| R10 | Four platform backends to maintain; test matrix GNOME/KDE/XFCE/MATE x X11/Wayland + macOS versions | Ongoing cost | host logic written once; backends thin; CI headless golden tests + periodic live matrix runs |
| R11 | Code-behind with Win32 leaks (`on_message`, `HWND`, `main_window`, chat `WM_COPYDATA`) | "Code-behind unchanged" violated in a few places | typed replacements in the facade; `cfg(windows)` for the remaining Windows-only features |
| R12 | Mica and other DWM effects have no equivalent | Windows-only look differences | parity defined with `Backdrop::None`; solid fallback colours elsewhere |
| R13 | GNOME without tray (SNI) support | Shell/tray features missing on stock GNOME | notifications instead; document the AppIndicator extension |

---

## Appendix A - How the numbers were produced

Run from `C:\kubuno` in Git Bash (read-only):

```bash
# files / lines / windows:: per crate
for d in core/desktop/windows/* core/desktop/common/*; do
  find $d -name '*.rs' | wc -l; find $d -name '*.rs' -exec cat {} + | wc -l
  grep -rl 'windows::' $d --include=*.rs | wc -l; done

# leaked types
grep -rEo 'D2D1_COLOR_F|IDWriteTextFormat|ID2D1Bitmap1|DWRITE_TEXT_ALIGNMENT' --include=*.rs core/desktop/windows | sort | uniq -c

# direct Direct2D/DirectWrite COM calls (approximate)
grep -rcE '\.(Fill|Draw|Create|Push|Pop|SetTransform|BeginDraw|EndDraw|SetWordWrapping|GetMetrics|BeginFigure|AddLine)[A-Za-z0-9]*\(' \
  --include=*.rs core/desktop/windows office/desktop/windows | grep -v ':0$'

# trait usage
grep -rEo '&dyn ([a-z_:]*::)?Canvas' --include=*.rs core/desktop | wc -l
grep -rEo '&(mut )?dyn ([a-z_:]*::)?ControlCanvas' --include=*.rs core/desktop | wc -l

# host API usage
grep -rhoE 'host::[a-z_]+' --include=*.rs core/desktop/windows office/desktop | sort | uniq -c | sort -rn

# window messages handled by the host
grep -Eo '\bWM_[A-Z_]+' core/desktop/windows/kubuno-desktop-controls/src/host/*.rs | sort -u
```

Per-area counts (section 2.3) used one regular expression per area (e.g. IME: `Imm[A-Z]\w+|HIMC|COMPOSITIONFORM`,
clipboard: `OpenClipboard|SetClipboardData|CF_UNICODETEXT|...`); some areas (DWM, print) include a few
false positives from generic names, the file lists in the tables were checked by hand.

## Appendix B - Files to read first when starting the work

- `windows/kubuno-drive-desktop-app-controls/src/canvas.rs` (the trait), `renderer.rs` (the D2D device and text
  formats), `themes/mod.rs`, `themed_icon/mod.rs`.
- `windows/kubuno-desktop-controls/src/control.rs` (`ControlCanvas`), `host/mod.rs`, `host/input.rs`,
  `host/painter.rs`, `host/window_tls.rs`, `system.rs`, `theme.rs`.
- `windows/kubuno-desktop-ui/src/graphics/{mod,display,d2d,fallback}.rs`.
- `office/desktop/windows/kubuno-office-documents/src/platform/*`, `doc/fonts.rs`, `controls/page_canvas.rs`;
  `office/common/core/src/measure.rs`.
- `core/mobile/common/kubuno-mobile-render/src/{lib,view,host}.rs`, `core/mobile/ios/kubuno-mobile-shell-ios`.
