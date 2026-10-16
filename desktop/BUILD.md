# Kubuno Desktop - build guide

## Layout

Kubuno Desktop lives in `desktop/` of the core repository (the former `kubuno/desktop` repository, merged with its
history on 2026-10-06). It is **one Cargo workspace for every operating system** (`desktop/Cargo.toml`), organised
by platform: the common part carries the complete app, an OS folder only what that system does differently.

```
desktop/
├── Cargo.toml   the workspace (every OS), Cargo.lock, target/
├── common/      complete and portable: the shell's app (kubuno-desktop-shell-common: start-up, accounts and
│                token broker, the sync engine's door and its offline sample, the activity log, the platform
│                extension points), the sync daemon (kubuno-desktop-sync), accounts/secrets/storage/API client,
│                the offline-sync engine, the portable framework layers (.kbview
│                grammar, model, metadata, macros; resources and data models; the web views compiler), assets
├── windows/     what Windows does differently: the Win32 / Direct2D framework (kubuno-desktop, -ui, -controls,
│                -views, -views-ls, -data, -print, -resources, the painting surface, the header menus and data),
│                the shell's Windows interface and kubuno-desktop.exe, packaging/ (MSIX), tools/
├── linux/       kubuno-desktop-shell-linux: the entry point (portable platform, text interface)
└── macos/       kubuno-desktop-shell-macos: the entry point (portable platform, text interface)
```

The graphical shell is **native Win32 + Direct2D**: no WebView2, no Node, no bundler (Tauri was removed on
2026-08-17). The Win32 framework only builds on Windows; everything in `common/` builds on Windows, Linux and
macOS, and the Linux and macOS entry points run the portable app.

## Windows

From `desktop/`:

```bash
cargo build --release -p kubuno-desktop-shell       # → target/release/kubuno-desktop.exe (the shell)
cargo test  -p kubuno-desktop-shell -p kubuno-desktop-shell-common
cargo run   -p kubuno-desktop-ui --example gallery  # the component gallery (UI reference)
cargo run   -p kubuno-desktop-shell -- --sample     # the offline sample: no server, nothing registered
```

`KUBUNO_SANDBOX_DIR=<folder>` moves every file of a run (configuration, accounts, secrets prefix, broker pipe)
under that folder, for tests that must not touch the real profile.

### Static linking: every exe is self-contained

Every program of the workspace (shell, the gallery, the
tools) links the design system (`kubuno-desktop-ui`, with the host `kubuno-desktop-controls` and
the painting surface `kubuno-drive-desktop-app-controls`) and Rust's `std` **statically**: an
exe runs from a folder that holds only itself - no `kubuno_desktop_ui` DLL, no
`std-*.dll`, nothing to stage after a build. `kubuno-desktop-ui` is an ordinary rlib and
the workspace sets no `rustflags`.

Why (product decision of 2026-10-03): the apps are released from their own
per-module repositories, each on its own schedule, so no Rust DLL may be shared
between them (a Rust dylib has no stable ABI: it would tie every app to one
build of it). Kubuno Desktop (the shell) stays mandatory on every PC, but as a
**service** dependency - the account/token broker over its named pipe, the sync,
the launcher - never as a binary one.

What this replaced: until 2026-10-02 `kubuno-desktop-ui` was a Rust `dylib`
(`kubuno_desktop_ui-<hash>.dll`, one file name per build, with a link shim in its
`build.rs`), the workspace was linked with `-C prefer-dynamic`, and
`tools/stage-runtime.ps1` copied the DLLs next to each exe. All of that is gone.
The global state the framework keeps (input queue, focus ring, floating
surfaces) still exists exactly once per process, since a program links one copy
of the crate. Cost: each exe carries its own copy of the framework (see the
CHANGELOG for sizes).

```powershell
pwsh ./windows/tools/build-all.ps1 -Profile release   # every app and example in one cargo run
```

The programs, over the framework (linked statically into each exe):

| Program | Crate | Role |
|---|---|---|
| `kubuno-desktop.exe` | `windows/kubuno-desktop-shell` (over `common/kubuno-desktop-shell-common`) | the shell: launcher, accounts, activity, settings, sync, Explorer |

The module apps build in their own repositories (`kubuno/chat` → `kubuno-chat.exe`, `kubuno/drive` → `drive.exe`,
`kubuno/office` → `kubuno-documents.exe`,
under `desktop/`), against a `desktop-v*` tag of the core repository (README, "Versions and tags").

> **target-dir**: the repository often lives on a network share (Z:), where the MSVC linker fails to write a PDB
> (LNK1201). Never commit a build path; set it **per machine**:
> `setx CARGO_TARGET_DIR C:\kubuno-build\desktop-target` (or in `%USERPROFILE%\.cargo\config.toml`). Elsewhere
> the local `target/` is fine.

On a machine with little memory, build the `windows` crate sequentially (`-j 1`): in parallel it exhausts the
memory and the link fails.

### Microsoft Store (MSIX)

Packaging lives in **`windows/packaging/`** (manifest, Store logos, script). `MakeAppx.exe` is Windows-only, so
packaging runs on Windows with the Windows 10/11 SDK:

```powershell
cargo build --release -p kubuno-desktop-shell        # from desktop/
cd windows/packaging
pwsh ./package-msix.ps1 -ExePath ..\..\target\release\kubuno-desktop.exe
#   → Kubuno-Desktop.msix (unsigned, for the Store)
pwsh ./package-msix.ps1 -Sign -Thumbprint <thumbprint>   # to install locally
```

Before a Store submission: copy the `Identity/Name` and `Identity/Publisher` reserved in Partner Center into
`AppxManifest.xml`, and increment `Identity/Version` (the 4th component must stay 0).

## The sync daemon (common)

`common/kubuno-desktop-sync` is pure Rust (rustls + bundled SQLite) and builds on the three desktop OSes.
From `desktop/`:

```bash
cargo build --release -p kubuno-desktop-sync
bash common/build_deb.sh     # → target/debian/*.deb + target/generate-rpm/*.rpm (Linux)
```

## The offline-sync foundation (common)

Four crates of `common/` carry the offline data sync (vskubuno `docs/DESKTOP-OFFLINE-SYNC.md`, lots SE-0 to
SE-3); none depends on the UI:

| Crate | Role |
|---|---|
| `kubuno-desktop-secrets` | the OS credential store (Windows Credential Manager, macOS Keychain, Linux Secret Service) |
| `kubuno-desktop-api-client` | the typed HTTP client of the API (Kubuno Delta Protocol v1, `If-Match`/`Idempotency-Key` headers, retries) |
| `kubuno-desktop-account` | accounts (server + user id), the token owner, the token broker (named pipe / Unix socket), the `creds.json` migration |
| `kubuno-desktop-sync-engine` | the local SQLite/SQLCipher database per account and app, outbox, feeds, conflicts, scheduler |

```bash
cargo test -p kubuno-desktop-secrets -p kubuno-desktop-api-client -p kubuno-desktop-account
cargo test -p kubuno-desktop-sync-engine                        # with SQLCipher (default)
cargo test -p kubuno-desktop-sync-engine --no-default-features  # plain SQLite, no OpenSSL
```

### SQLCipher: build prerequisites

`kubuno-desktop-sync-engine` enables the `sqlcipher` feature by default: the local database is encrypted
(AES-256, one key per account in the OS store). Cargo links one `libsqlite3-sys` per build, so SQLCipher also
replaces `rusqlite`'s SQLite (kubuno-sync) in every program that links the engine; without a key it reads and
writes plain databases as before.

| OS | `libsqlite3-sys` feature | Prerequisites |
|---|---|---|
| Windows (MSVC) | `bundled-sqlcipher-vendored-openssl` | a **native Perl** (Strawberry Perl; Git Bash/MSYS Perl is not enough: `Locale::Maketext::Simple` missing, MSYS paths) through `PERL=C:\…\perl.exe` or the `PATH`; **NASM** strongly recommended (without it `openssl-src` adds `no-asm`: no AES-NI, encryption 3 to 4 times slower); the MSVC tools (already required) |
| Linux | `bundled-sqlcipher-vendored-openssl` | `perl` and `make` (on the usual build images) |
| macOS | `bundled-sqlcipher` | nothing: SQLCipher uses CommonCrypto (Security framework) - builds on a Mac (the Apple SDK is needed: no cross check from Windows) |

Everything works offline once the crates are vendored (`cargo vendor`): OpenSSL's sources come from the
`openssl-src` crate. First OpenSSL build: ~12 min on the dev VM (nmake is sequential), then cached in `target/`.
Measured cost (spike SE-0, Windows, NASM): +4.3 MB per program; writes +3 %, point reads +2 %, full scans +70 %
with the 32 MB page cache the engine sets (+300 % with the default cache).

In CI: Strawberry Perl is preinstalled on the GitHub Windows runners; NASM is not (add it to the image, or accept
`no-asm`).

## Linux and macOS

`linux/kubuno-desktop-shell-linux` and `macos/kubuno-desktop-shell-macos` run the portable app of `common/` with
the portable platform and the text interface (`cargo run -p kubuno-desktop-shell-linux -- --sample`). A native
window and the system services of each OS are still to be written, as implementations of the extension points of
`kubuno_desktop_shell_common::platform`. Android and iOS are not concerned here: the mobile apps are native and
live in their own repositories.
