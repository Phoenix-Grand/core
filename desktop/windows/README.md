# Kubuno Desktop - Windows

The Windows version of Kubuno Desktop: native Win32 applications written in Rust,
drawn with Direct2D, DirectWrite and DirectComposition - no web view, no UI
framework, no runtime to install.

This folder only holds what Windows does differently: the complete, portable app is in
[`../common`](../common) (the shell's app `kubuno-desktop-shell-common`, the
[`kubuno-sync`](../common/kubuno-desktop-sync) file synchronisation engine, accounts, secrets, storage), and these
crates are members of the one desktop workspace (`../Cargo.toml`). See the [desktop README](../README.md) for the
whole picture and [`BUILD.md`](../BUILD.md) for build notes common to every platform.

---

## What's inside

```
windows/
├── kubuno-desktop/                     the framework's facade (Application, views, resources, splash screen…)
├── kubuno-desktop-ui/                  the design system built on the controls
├── kubuno-desktop-controls/            the control library, drawn natively on Direct2D
├── kubuno-desktop-views, -views-ls, -data, -data-tool, -print, -resources, -app-storage-components/
├── kubuno-drive-desktop-app-controls/  the painting surface (ported from Files, MIT)
├── kubuno-desktop-shell-controls/, kubuno-desktop-header-data/   the header menus and their data, for every app
├── kubuno-desktop-shell/               kubuno-desktop.exe - the Windows face of the shell's app
├── packaging/                          Microsoft Store (MSIX): manifest, Store logos, packaging script
└── tools/                              UI reference and parity tooling (PowerShell)
```

### The shell - `kubuno-desktop.exe`

`kubuno-desktop-shell` puts a Windows face on the portable app of
`../common/kubuno-desktop-shell-common`: its `main.rs` registers the Windows platform (the Documents known folder,
the `Run` key) and the Win32 interface (`platform::ui_host::WindowsUi`), and calls
`kubuno_desktop_shell_common::app::run`.

The launcher that stays with the user: accounts, activity, settings, favourites and
labels, the applications of each Kubuno instance, and file synchronisation driven
by `kubuno-sync`. It integrates with Windows itself:

- **Cloud Files API** - each sync folder is registered as a sync root, so Explorer
  shows the standard in-sync / syncing overlays and a Status column, without
  administrator rights;
- **Explorer navigation pane** - each instance's sync folder appears as a root node
  in Explorer's left pane (a per-user namespace extension under `HKEY_CURRENT_USER`);
- **Administration** - a native port of the web administration console (dashboard,
  users, groups, organisational units, audiences, modules, storage, settings), with
  an "open in the browser" fallback for the sections not ported yet.

### Kubuno Drive - `drive.exe`

A native file manager for Kubuno Drive. It now lives in the drive module's repository
([`kubuno/drive`](https://github.com/kubuno/drive), `desktop/windows/`): window, tabs, views and actions
in `kubuno-drive-desktop`, custom Direct2D controls, the shell/storage layer, localisation for
49 cultures. Those crates are MIT-licensed.

### Chat and Documents

- **`kubuno-chat`** - two-pane messaging for the Chat module, now in the chat module's repository
  ([`kubuno/chat`](https://github.com/kubuno/chat), `desktop/windows/`).
- **`kubuno-documents`** - a native word processor for the Office module's documents, now in the office module's
  repository ([`kubuno/office`](https://github.com/kubuno/office), `desktop/`; its engine in `common/core`).

## Requirements

- Windows 10 or 11, x86-64
- Rust stable with the MSVC toolchain (`x86_64-pc-windows-msvc`)
- For MSIX packaging: the Windows 10/11 SDK (`makeappx.exe`, `signtool.exe`)

## Build

From `desktop/` (the workspace root):

```powershell
cargo build --release -p kubuno-desktop-shell     # → target\release\kubuno-desktop.exe (the shell)
cargo test  -p kubuno-desktop-shell               # interaction geometry, text fields
cargo run   -p kubuno-desktop-ui --example gallery  # component gallery (UI reference)
```

**Build directory.** When the repository lives on a network share, the MSVC linker
cannot reliably write its PDB there (`LNK1201`). Keep the target directory local,
per machine, rather than in the repository:

```powershell
setx CARGO_TARGET_DIR C:\kubuno-build\desktop-target
```

On a machine with little memory, build the `windows` crate sequentially (`-j 1`):
in parallel it can exhaust memory and the link fails.

## Packaging (MSIX)

Everything lives in [`packaging/`](packaging): the MSIX manifest, the Store logos and
`package-msix.ps1`, which wraps the executable as a full-trust desktop package.
`makeappx.exe` only runs on Windows.

```powershell
cargo build --release -p kubuno-desktop-shell
cd windows\packaging
pwsh ./package-msix.ps1 -ExePath ..\..\target\release\kubuno-desktop.exe
# or, signed for local installation:
pwsh ./package-msix.ps1 -Sign -Thumbprint <certificate-thumbprint>
```

The script produces `Kubuno-Desktop.msix`. The unsigned package is the one uploaded
to Partner Center, where the Store signs it. The steps to reserve the app and submit
it are in [`packaging/README.md`](packaging/README.md).

## Continuous integration

The core repository's `.github/workflows/desktop-release.yml` runs for every `desktop-v*` tag (or on demand): on
a Windows runner it tests and builds `kubuno-desktop`, packages the MSIX, and attaches `kubuno-desktop.exe` and
`Kubuno-Desktop.msix` to a draft GitHub Release, next to the command-line sync client (`kubuno-sync`) built for
each OS. `desktop.yml` checks every change of `desktop/`.

## License

[AGPL-3.0-or-later](../../LICENSE) © Kubuno contributors. The crates ported from Files
(`kubuno-drive-desktop-app-controls` here, `../common/kubuno-drive-desktop-shared`) are MIT-licensed.
