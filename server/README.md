# kubuno-core

The Kubuno server: the platform's "operating system", which every installation runs
and every app plugs into. This crate builds the server and the administration
command line.

For installation, packages and configuration, see the [core README](../README.md).

---

## What it builds

| Target | Output | Role |
|---|---|---|
| `[[bin]] kubuno-core` | `src/main.rs` | the server (HTTP, WebSocket, background jobs) |
| `[[bin]] kubuno` | `src/bin/kubuno/` | the administration CLI |
| `[lib] kubuno_core` | `src/lib.rs` | the server's modules, shared by both binaries and the integration tests |

```bash
cargo build --release -p kubuno-core     # → target/release/kubuno-core and target/release/kubuno
```

## How the crate is organised

### Serving requests

| Module | Responsibility |
|---|---|
| `router` | assembles the Axum router: `/api/v1/*`, `/internal/*` (module → core), `/mcp`, the proxied module routes and the static web host |
| `handlers` | the HTTP handlers - `auth`, `users`, `admin/*` (one file per console section), `modules`, `themes`, `labels`, `clipboard`, `storage_*`, `push`, `ws`, `mcp`… |
| `middleware` | cross-cutting HTTP middleware |
| `websocket` | the per-user WebSocket hub that pushes events to connected clients |
| `collab` | the generic real-time collaboration service (Yjs) the editors share |
| `openapi` | the OpenAPI 3.1 specification of the core API |

### Apps (modules)

| Module | Responsibility |
|---|---|
| `modules` | the module manifest (`module.toml`), the registry of installed modules and running instances, the manager (start, stop, health), the reverse proxy to each module, per-module databases, and the `marketplace` (remote catalogue and installation at run time) |
| `events` | the in-process event bus and the delivery of events to the modules that subscribed to them |
| `jobs` | the background job runner backed by the `core.jobs` table |

### Identity and security

| Module | Responsibility |
|---|---|
| `auth` | JWT access tokens and refresh sessions, TOTP and backup codes, OAuth/OIDC providers, rate limiting, login throttling, CAPTCHA gate, anti-DDoS, per-module internal secrets, API token scopes |
| `authz` | delegated administration: privileges, roles, assignments and their guards |
| `directory` | LDAP and Active Directory: connection, mapping and synchronisation |
| `crypto` | Argon2id passwords, AES-256-GCM encryption and the data key, token generation |
| `audit` | the administrative audit trail |
| `devices` | device and session inventory |

### Administration

| Module | Responsibility |
|---|---|
| `settings` | scoped settings - one value per key and scope, inherited down the organisational-unit tree, lockable |
| `setup` | the first-run installation |
| `health`, `alerts`, `rules` | instance health checks, the alert centre, the "when x happens, do y" rule engine |
| `backup`, `data_export`, `data_migration` | backup policy and runs, data export archives, imports from another provider |
| `domains`, `network`, `mailer` | verified domains, HTTP/HTTPS configuration, the outgoing mail relay |
| `holidays`, `maintenance`, `support` | public holidays, maintenance notices, licence and support contract |
| `storage`, `push` | storage usage and remote mounts, push notifications for native apps |

### Foundations

| Module | Responsibility |
|---|---|
| `config` | settings loaded from the configuration file and environment, and the session settings read live from the database |
| `database` | the pool, migrations, seeding, `LISTEN`/`NOTIFY` and its outbox fallback on the other engines, portable SQL equivalents |
| `models`, `errors`, `logging`, `state` | shared types, the `AppError` → HTTP mapping, tracing setup, the application state |

The database schema lives in `migrations/{postgres,mysql,sqlite}` next to this file
(`server/migrations`); the engine is chosen at run time through [`kubuno-db`](../common/kubuno-db/README.md).

## The `kubuno` CLI

```text
kubuno status                   server and module status
kubuno db:status | db:migrate   database connectivity and migrations
kubuno db:backup | db:restore   dump and restore
kubuno db:reset  | app:reset    reset the core schema, or the whole application
kubuno auth:recover             restore access to an account
kubuno security:rekey           rotate the data encryption key
kubuno users:list | users:show | users:create | users:update
kubuno users:disable | users:enable | users:delete [--purge]
kubuno users:password | users:require-change | users:logout | users:unlock
kubuno groups:list | groups:show | groups:create | groups:delete
kubuno groups:add-member | groups:remove-member
kubuno org-units:list | org-units:create | org-units:rename | org-units:move | org-units:delete
kubuno modules:list | modules:install <file>.kbpkg | modules:commands
kubuno <module>:<command>       routed to the module's own CLI binary
```

The `users:*`, `groups:*` and `org-units:*` commands are not a second
implementation of the directory: they run the console's own operations -
`kubuno_core::accounts`, `kubuno_core::groups`, `kubuno_core::org_units`, which
the `/admin/*` handlers also call - as `Actor::System`. Password policies,
quotas, the "never remove the last super-administrator" guard and the audit
entries are therefore identical; a change made at the prompt is recorded with the
"system" origin, and account events reach the running server over the database
notification channel.

## Workspace crates it relies on

- [`kubuno-db`](../common/kubuno-db/README.md) - one binary over PostgreSQL, MySQL/MariaDB or SQLite
- [`kubuno-storage`](../common/kubuno-storage/README.md) - the storage backend
- [`kubuno-modauth`](../common/kubuno-modauth/README.md) - the signed identity token the proxy mints for each module
- [`kubuno-mcp`](../common/kubuno-mcp/README.md) - the Model Context Protocol server core

## Tests

```bash
cargo test -p kubuno-core
```

Unit tests sit next to the code; the integration tests in `tests/` cover the database
engines and portability, engine switching, backups, delegated administration, API
token scopes and alert lifecycles.

## License

[AGPL-3.0-or-later](../LICENSE) © Kubuno contributors.
