<!--
  SPDX-FileCopyrightText: 2026 Kubuno contributors
  SPDX-License-Identifier: AGPL-3.0-or-later
-->

<div align="center">

<img src=".github/logo.png" alt="Kubuno logo" width="120">

# Kubuno - Core

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Rust](https://img.shields.io/badge/Rust-edition_2021-orange.svg)
![React](https://img.shields.io/badge/React-19-61dafb.svg)
![Databases](https://img.shields.io/badge/DB-PostgreSQL_%7C_MySQL%2FMariaDB_%7C_SQLite-336791.svg)
![Status](https://img.shields.io/badge/status-alpha-yellow.svg)

**The heart of Kubuno - a self-hosted, libre (AGPLv3) cloud platform, a sovereign alternative to Google Workspace and Microsoft 365.**

The *core* is the platform's "operating system": it provides the infrastructure (auth, database, events, storage, reverse proxy, WebSocket, module lifecycle, administration console) that **independent modules** (drive, calendar, mail, photos, office, chat…) rely on to run.

</div>

---

## Screenshots

<!-- SCREENSHOTS -->

## Why Kubuno?

- **Modular architecture** - each module (drive, calendar, mail, office, photos…) is a **separate process** that connects to the core at startup. The core proxies its routes, distributes events and manages its lifecycle; nothing is hard-wired.
- **Your data, your rules** - fully self-hosted, no third-party service required, no telemetry.
- **One binary, three database engines** - the same server runs on **PostgreSQL**, **MySQL/MariaDB** or **SQLite**, the engine being chosen at run time from the connection URL. An instance - or a single module - can be migrated from one engine to another from the administration console, and several instances can share one database server thanks to a configurable schema prefix.
- **Guided first run** - a fresh instance opens on a setup assistant that asks for the database and the first administrator: there is no default password.
- **Built-in marketplace** - browse the official catalogue and install modules **at runtime** from the admin console, or offline from the command line (`kubuno modules:install <file>.kbpkg`). Modules ship as self-contained **Kubuno packages (`.kbpkg`)** the core unpacks itself, identically on Linux, Windows and macOS.
- **Secure by default** - JWT + HttpOnly refresh tokens with rotation, no access token in any script-readable cookie (images, media, downloads and sockets use short-lived signed tickets bound to one session, app and address - see [`AUTH.md`](AUTH.md)), Argon2id, AES-256-GCM with a data key separate from the signing secret, account lockout and a self-hosted sign-in CAPTCHA after repeated failures, a tamper-evident (HMAC-chained) administrative audit trail, anti-DDoS rate budgets per IP and per user, signed module-to-core authentication, and a seccomp sandbox that forbids process execution inside modules.
- **A complete administration console** - directory (users, groups, organisational units, target audiences, buildings and resources, directory policy), LDAP / Active Directory and OpenID Connect sign-in, per-unit settings with inheritance and locks, security dashboard, alert centre, automation rules, content detectors, printable reports, backups (whole database, compressed, restorable), data migration from other servers, data export, domains, public holidays, themes and native HTTPS (TLS certificates, ACME).
- **Fast and lean backend** - Rust + Axum; the database also serves as the event bus and the job queue, with no Redis or extra broker.
- **Runtime-loaded frontend** - the React 19 host loads modules **at runtime** via ESM import maps and shared singletons (`@kubuno/sdk`, `@kubuno/ui`), without ever naming a module statically, so every app shares one consistent shell.
- **Packaged themes (skins)** - themes are importable `.zip` bundles that restyle the whole platform or targeted modules with CSS variables, stylesheets and (admin-trusted) scripts; several themes ship with the core. See [`THEMES.md`](THEMES.md).
- **Cross-module labels and @mentions** - user-owned labels attach to items of *any* module (files, tasks, events…) and can be shared; typing `@` in any text field suggests people from the instance directory.
- **Voice search** - a microphone in the search bar, backed by the self-hosted [speech-to-text](https://github.com/kubuno/stt) service.
- **i18n** - 13 languages, RTL included.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Frontend host (React 19 / Vite)                         │
│  - shell, auth, admin console, registries, import map    │
│  - loads /modules/<id>/entry.js at runtime               │
├──────────────────────────────────────────────────────────┤
│  Core (Rust / Axum)            ← THIS REPO               │
│  auth · events · storage · proxy · websocket · modules   │
│  PostgreSQL · MySQL/MariaDB · SQLite (schema `core`)     │
├──────────────────────────────────────────────────────────┤
│  Modules (separate processes, dedicated repos)           │
│  drive · calendar · mail · photos · office · chat · …    │
└──────────────────────────────────────────────────────────┘
```

This repository contains:

| Component | Path | Role |
|---|---|---|
| **[kubuno-core](server/README.md)** | `server/` | Server application (bin `kubuno-core`) and administration CLI (`kubuno`) |
| **[kubuno-db](common/kubuno-db/README.md)** | `common/kubuno-db` | Database foundation: one binary over PostgreSQL / MySQL-MariaDB / SQLite - shared |
| **[kubuno-storage](common/kubuno-storage/README.md)** | `common/kubuno-storage` | Storage abstraction (local filesystem; S3 declared, not implemented yet) - shared |
| **[kubuno-seccomp](common/kubuno-seccomp/README.md)** | `common/kubuno-seccomp` | Execution sandbox (seccomp) - shared |
| **[kubuno-modauth](common/kubuno-modauth/README.md)** | `common/kubuno-modauth` | Signed module ↔ core authentication - shared |
| **[kubuno-mcp](common/kubuno-mcp/README.md)** | `common/kubuno-mcp` | MCP server building blocks - used by the core |
| **Web host** | `web/` | React shell + shared libraries `@kubuno/sdk`, `@kubuno/ui`, `@kubuno/drive` |
| **Migrations** | `server/migrations/` | Core database schema |
| **Themes** | `web/themes/` | Skin themes shipped with the platform (see [`THEMES.md`](THEMES.md)) |

Shared crates are consumed by the **module repositories** via tagged git dependencies; the shared frontend libraries are published to npm under the **`@kubuno/*`** scope.

## Modules

Each app lives in its **own repository** (`kubuno/<module>`) and ships its own `.kbpkg` package:

<table>
  <thead>
    <tr>
      <th width="52"></th>
      <th align="left">Module</th>
      <th align="left">Repository</th>
      <th align="left">Description</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/drive/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Drive</b></td>
      <td><a href="https://github.com/kubuno/drive">kubuno/drive</a></td>
      <td>Files: upload, sharing, search, remote mounts</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/office/main/.github/logo.svg" width="24" height="24" alt=""></td>
      <td><b>Office</b></td>
      <td><a href="https://github.com/kubuno/office">kubuno/office</a></td>
      <td>Office suite: documents, spreadsheets, presentations, projects, diagrams, data, maths, script, whiteboard</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/calendar/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Calendar</b></td>
      <td><a href="https://github.com/kubuno/calendar">kubuno/calendar</a></td>
      <td>Calendars, events, CalDAV, scheduling</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/mail/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Mail</b></td>
      <td><a href="https://github.com/kubuno/mail">kubuno/mail</a></td>
      <td>Multi-account email client (IMAP/SMTP)</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/chat/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Chat</b></td>
      <td><a href="https://github.com/kubuno/chat">kubuno/chat</a></td>
      <td>Messaging, calls and meetings</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/contacts/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Contacts</b></td>
      <td><a href="https://github.com/kubuno/contacts">kubuno/contacts</a></td>
      <td>Address book, groups, CardDAV</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/tasks/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Tasks</b></td>
      <td><a href="https://github.com/kubuno/tasks">kubuno/tasks</a></td>
      <td>Tasks, sub-tasks, Kanban boards, CalDAV VTODO</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/notes/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Notes</b></td>
      <td><a href="https://github.com/kubuno/notes">kubuno/notes</a></td>
      <td>Markdown notes, checklists, notebooks, backlinks</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/forms/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Forms</b></td>
      <td><a href="https://github.com/kubuno/forms">kubuno/forms</a></td>
      <td>Forms and surveys, responses, analytics</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/photos/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Photos</b></td>
      <td><a href="https://github.com/kubuno/photos">kubuno/photos</a></td>
      <td>Photo gallery: albums, timeline, sharing</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/media/main/.github/logo-listen.png" width="24" height="24" alt=""></td>
      <td><b>Media</b></td>
      <td><a href="https://github.com/kubuno/media">kubuno/media</a></td>
      <td>Streaming: Watch (films, series) and Listen (music)</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/books/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Books</b></td>
      <td><a href="https://github.com/kubuno/books">kubuno/books</a></td>
      <td>Library of books, comics and eBooks</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/paintsharp/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>PaintSharp</b></td>
      <td><a href="https://github.com/kubuno/paintsharp">kubuno/paintsharp</a></td>
      <td>Creative suite: raster, vector, 3D, video, animation, PDF, fonts</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/wiki/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Wiki</b></td>
      <td><a href="https://github.com/kubuno/wiki">kubuno/wiki</a></td>
      <td>Personal and shared wikis</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/forum/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Forum</b></td>
      <td><a href="https://github.com/kubuno/forum">kubuno/forum</a></td>
      <td>Discussion boards with moderation</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/app/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>App</b></td>
      <td><a href="https://github.com/kubuno/app">kubuno/app</a></td>
      <td>Visual no-code application builder</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/flow/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Flow</b></td>
      <td><a href="https://github.com/kubuno/flow">kubuno/flow</a></td>
      <td>Visual workflow automation</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/code/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Code</b></td>
      <td><a href="https://github.com/kubuno/code">kubuno/code</a></td>
      <td>Collaborative web IDE with Git</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/keestore/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Keestore</b></td>
      <td><a href="https://github.com/kubuno/keestore">kubuno/keestore</a></td>
      <td>Password manager (KeePass 4 <code>.kdbx</code>)</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/maps/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Maps</b></td>
      <td><a href="https://github.com/kubuno/maps">kubuno/maps</a></td>
      <td>Self-hosted maps, routes, places</td>
    </tr>
    <tr>
      <td align="center"><img src="https://raw.githubusercontent.com/kubuno/assistant/main/.github/logo.png" width="24" height="24" alt=""></td>
      <td><b>Assistant</b></td>
      <td><a href="https://github.com/kubuno/assistant">kubuno/assistant</a></td>
      <td>Self-hosted AI assistant (local models)</td>
    </tr>
    <tr>
      <td align="center"></td>
      <td><b>Speech-to-Text</b></td>
      <td><a href="https://github.com/kubuno/stt">kubuno/stt</a></td>
      <td>Self-hosted speech recognition for voice search</td>
    </tr>
    <tr>
      <td align="center"></td>
      <td><b>P2P NAS</b></td>
      <td><a href="https://github.com/kubuno/p2pnas">kubuno/p2pnas</a></td>
      <td>Encrypted, self-healing peer-to-peer storage</td>
    </tr>
  </tbody>
</table>

## Install with Docker

The fastest way to self-host Kubuno (core + all modules) is the all-in-one Docker image, published as `ghcr.io/kubuno/kubuno`:

```bash
git clone https://github.com/kubuno/docker && cd docker
cp .env.docker.example .env     # set POSTGRES_PASSWORD, KUBUNO_JWT_SECRET, KUBUNO_INTERNAL_SECRET
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
# → http://localhost:8080
#   A fresh instance greets you with the setup assistant: it asks for the database
#   and the first administrator, so YOU choose the password. There is no default.
```

Prefer building the image yourself? Run `docker compose up --build`. The full guide,
configuration, module selection and CI live in **[kubuno/docker](https://github.com/kubuno/docker)**.

## Native packages (Linux · Windows · macOS)

The core ships as **native packages**, each installing the server, the frontend host, the database migrations and the bundled themes, and registering Kubuno as a managed system service:

| Platform | Format | Script | Service |
|---|---|---|---|
| Debian / Ubuntu | `.deb` | `build_deb.sh` | systemd |
| Fedora / RHEL / openSUSE | `.rpm` | `build_rpm.sh` | systemd |
| Windows 10/11 / Server | `.exe` (NSIS installer) | `build_windows.sh` | Windows service (WinSW) |
| macOS (Apple Silicon) | `.pkg` | `build_macos.sh` | launchd |

Tagged releases (`v*`) attach all of them to the corresponding **GitHub Release** via CI (`build.yml` for the `.deb`, `dist.yml` for RPM / Windows / macOS). The only runtime prerequisite is a reachable database server - PostgreSQL 16 or MySQL / MariaDB - or none at all with SQLite. Full details and per-platform notes: **[`PACKAGING.md`](PACKAGING.md)**.

Modules are **not** system services: they install as `.kbpkg` packages into the core, from the Marketplace or with the CLI:

```bash
sudo kubuno modules:install calendar-<version>-<os>-<arch>.kbpkg
sudo kubuno modules:list
```

### Administering from the command line

The `kubuno` command also administers the directory from the server itself - for
scripts, headless installs, or when no browser is at hand. It runs the very same
operations as the administration console (same password policies, quotas,
guards and audit entries, recorded with the "system" origin):

```bash
sudo kubuno users:create --email alex@example.org --name "Alex Martin" --generate-password
sudo kubuno users:list --org-unit Support --inactive
sudo kubuno users:password alex@example.org --generate-password --require-change
sudo kubuno users:unlock alex@example.org          # forget failed sign-ins
sudo kubuno groups:add-member Accounting alex@example.org
sudo kubuno org-units:create Marketing --parent Kubuno
```

Every command has `--help`; listings accept `--json`. See `man kubuno` for the
full reference (`users:*`, `groups:*`, `org-units:*`, `db:*`, `auth:recover`…).

## Build & development

**Requirements:** Rust ≥ 1.82, Node.js ≥ 24, and PostgreSQL 16, MySQL/MariaDB or SQLite.

```bash
# Backend (core)
cargo build --release --bin kubuno-core

# Frontend host
cd web && npm ci && npm run build

# Dev (backend + frontend together)
make dev

# Native packages (see PACKAGING.md)
bash build_deb.sh        # → dist/kubuno-core_*.deb
bash build_rpm.sh        # → dist/kubuno-core-*.rpm
bash build_windows.sh    # → dist/kubuno-core-setup-*.exe   (cross-build, NSIS)
bash build_macos.sh      # → dist/kubuno-core-*.pkg         (on a Mac)
```

## Configuration

Copy [`config.toml.example`](config.toml.example) → `config.toml` (every option is documented inline) or override any value with `KV_`-prefixed environment variables (e.g. `KV__DATABASE__SCHEMA_PREFIX`). The database engine follows the connection URL: `postgres://…`, `mysql://…` or `sqlite://…`.

## Tech stack

Rust 2021 · Axum 0.7 · Tokio · SQLx 0.9 (PostgreSQL · MySQL/MariaDB · SQLite) · jsonwebtoken · argon2 · aes-gcm - React 19 · TypeScript · Vite · Tailwind CSS v4 · Zustand · React Query.

## Security

Please report vulnerabilities privately - see [`SECURITY.md`](SECURITY.md).

How the browser authenticates requests it makes on its own (images, media, downloads, event
streams, WebSockets) is described in [`AUTH.md`](AUTH.md).

## Contributing

Contributions are welcome. Please open an issue to discuss any significant change before submitting a pull request.

## License

[AGPL-3.0-or-later](LICENSE) © Kubuno contributors.
