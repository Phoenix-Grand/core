# kubuno-db

The database foundation shared by the Kubuno core and every module: **one binary,
three engines - PostgreSQL, MySQL/MariaDB or SQLite - chosen at run time**. The
administrator names the engine in configuration (`database.engine`), at install
time or later, and the same binary connects to whichever is named. A dialect layer
covers everything the three engines spell differently.

```toml
kubuno-db = { git = "https://github.com/kubuno/core", tag = "db-v0.9.0", package = "kubuno-db" }
```

---

## 1. The design, and why

### One binary, the engine is a run-time value

All three sqlx drivers are always compiled in. `DbPool` and `DbTx` are **enums**
over the three concrete sqlx pools and transactions; they replace `PgPool` and
`Transaction<'_, Postgres>` in signatures and hide the engine behind a small set of
methods (`db.fetch_one_as`, `db.execute`, `db.begin`). A bound value travels as a
`DbValue` (built with `params!`) and is encoded against the concrete driver only at
the moment of execution. There is no per-engine build and no per-engine `.kbpkg`:
an instance can change engine without reinstalling anything.

The two alternatives were rejected for concrete reasons:

* **Generic over `sqlx::Database`.** Every function that binds a value would
  have to carry the bounds that make it bindable - `for<'a> Uuid: Encode<'a, DB>`,
  `Uuid: Type<DB>`, and one more pair per type. Those bounds are viral: they
  climb from the query into the service, the handler, and `AppState`, which
  Axum then has to be generic over too. Kubuno binds a `Uuid` in thousands of places.
* **`sqlx::Any`.** It carries only Null/Bool/SmallInt/Integer/BigInt/Real/
  Double/Text/Blob. The three types Kubuno uses most - `Uuid`,
  `serde_json::Value` and `DateTime<Utc>` - cannot cross it at all.

### sqlx does not translate SQL

The SQL text is made correct for the engine by the `dialect` layer (methods on
`Backend`) before it ever reaches sqlx; sqlx only carries the text and
encodes/decodes the parameters. `sql::prepare` rewrites `$1` into `?` where the
engine wants it and rejects text no engine could run faithfully - it is not a
translator.

### What else the crate provides

* `returning` - how to get a row back on MySQL, which has no `RETURNING`;
* `pool` - connecting, the per-engine session policy, migrations;
* `events` - `pg_notify` and its outbox fallback on the other engines;
* `journal` - the portable change journal (monotonic per-domain sequence,
  tombstones, delta pull) behind the modules' sync APIs;
* `search` - engine-independent full-text search (stemmed, accent-insensitive).

---

## 2. Porting a module: the checklist

### 2.1 `Cargo.toml`

```toml
[dependencies]
# All three drivers are compiled in; the engine is a run-time choice made by
# kubuno-db. `#[derive(FromRow)]` resolves against the three row types, so the
# three drivers must be enabled here too.
sqlx = { version = "0.9", default-features = false, features = [
    "runtime-tokio", "tls-rustls", "uuid", "chrono", "json", "migrate",
    "bigdecimal", "derive", "macros", "postgres", "mysql", "sqlite",
] }
kubuno-db = { git = "https://github.com/kubuno/core", tag = "db-v0.9.0", package = "kubuno-db" }
```

`derive` and `macros` are in sqlx's *default* features, which
`default-features = false` has just removed - a module using `#[derive(FromRow)]`
needs them back.

### 2.2 Declare the schema once

```rust
// src/lib.rs
pub const SCHEMA: &str = "keestore";
```

### 2.3 Types

| before | after |
|---|---|
| `sqlx::PgPool` | `kubuno_db::DbPool` |
| `sqlx::postgres::PgRow` | `kubuno_db::DbRow` |
| `sqlx::Transaction<'_, sqlx::Postgres>` | `kubuno_db::DbTx` |

### 2.4 Queries

`sqlx::query(...)` → `kubuno_db::query(...)?`. The `?` is the whole difference:
the function returns `Result<_, sqlx::Error>`, so any error enum that already
has `#[from] sqlx::Error` absorbs it without a new variant.

```rust
let row = kubuno_db::query("SELECT * FROM keestore.vaults WHERE owner_id = $1")?
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
```

Keep writing `$1`, `$2` - PostgreSQL's style is the source dialect, translated
to `?` where the engine wants it. Same for `query_as` and `query_scalar`.

### 2.5 Connecting, migrating

```rust
let pool = kubuno_db::connect(&settings.database, SCHEMA).await?;   // also creates the schema

if settings.database.run_migrations {
    kubuno_db::migrations!(
        "./migrations/postgres", "./migrations/mysql", "./migrations/sqlite",
    )
    .run(&pool, SCHEMA)
    .await?;
}

kubuno_db::events::ensure_outbox(&pool, SCHEMA).await?;   // no-op on PostgreSQL
```

Replace the module's `DatabaseSettings` with `kubuno_db::DbSettings` (field for
field what the modules already deserialise, plus `path` for SQLite). The
separate `search_path` migration pool goes away: `run` puts
`_sqlx_migrations` in `<schema>._sqlx_migrations`, which is where PostgreSQL
already had it.

### 2.6 Migrations: three directories

Move the existing files to `migrations/postgres/` **unchanged** - same
filenames, same bytes, so the version, description and checksum are identical
and an applied migration stays applied. Then write the MySQL and SQLite
versions.

| Rust type | PostgreSQL | MySQL/MariaDB | SQLite |
|---|---|---|---|
| `Uuid` | `UUID` | `BINARY(16)` | `BLOB` |
| `DateTime<Utc>` | `TIMESTAMPTZ` | `DATETIME(6)` | `TEXT` (`%F %T%.f`, UTC) |
| `serde_json::Value` | `JSONB` | `JSON` | `TEXT` |
| `Vec<String>` / `Vec<Uuid>` (a small list) | `JSONB` | `JSON` | `TEXT` - as a JSON array; see §2.8 |
| `Vec<u8>` | `BYTEA` | `LONGBLOB` | `BLOB` |
| `String` (indexed/unique) | `TEXT` | `VARCHAR(n)` - MySQL cannot index a `TEXT` without a prefix length | `TEXT` |

`dialect::column::*` returns these, so a generated migration and a hand-written
one cannot drift.

Other per-engine differences: `CREATE SCHEMA` disappears (kubuno-db does it),
`DEFAULT gen_random_uuid()` disappears (see §3), and an `updated_at` trigger
becomes `ON UPDATE CURRENT_TIMESTAMP(6)` on MySQL and a hand-written trigger on
SQLite.

> ⚠️ Several PostgreSQL migrations depend on extensions the **core** creates
> (`uuid-ossp`, `pg_trgm`, `unaccent`, `citext`). There is no equivalent on the
> other engines: `CITEXT` becomes a case-insensitive collation on MySQL and
> `COLLATE NOCASE` on SQLite, and trigram search has no replacement at all.

### 2.6.1 MySQL and MariaDB: one set, flavour variants where they differ

The MySQL protocol is spoken by two servers - **Oracle MySQL** and **MariaDB** -
whose DDL is not quite the same. Kubuno supports both (tested on MySQL 8.4 and
MariaDB 12.3 LTS). The rule:

1. **Write one `migrations/mysql` file that runs on both.** This is almost always
   possible; the dialect differences that bite in practice are listed below.
2. **Where it is not possible, add a flavour variant**: a file with **the same
   name** (same version, same `.up`/`.down` suffix) in
   `migrations/mysql-mariadb/` (used on MariaDB only) or
   `migrations/mysql-oracle/` (used on Oracle MySQL only). The other flavour
   keeps running the `mysql` file. A variant can exist for both flavours when
   the `mysql` file fails on both but must stay as released (see 4).
3. **Name the variant directories in the macro**, after the three engine
   directories, in this order, each optional:

   ```rust
   kubuno_db::migrations!(
       "./migrations/postgres", "./migrations/mysql", "./migrations/sqlite",
       mariadb = "./migrations/mysql-mariadb",
       oracle_mysql = "./migrations/mysql-oracle",
   )
   .run(&pool, SCHEMA)
   .await?;
   ```

   and keep a unit test calling `MigratorSet::check()` on the same set: it fails
   when a variant has no `mysql` namesake (a variant only replaces a file, it
   never adds a version) or when one file has two variants.
4. **How a variant is recorded.** At start-up `run` reads `SELECT VERSION()`
   (`…-MariaDB` → MariaDB, anything else → Oracle MySQL; an unreadable version is
   an error, never a guess) and substitutes that flavour's variants. A variant
   is recorded in `_sqlx_migrations` under its **base file's** version,
   description and **checksum** - never its own. Consequences:
   * the bookkeeping is identical on both flavours, so a database moved from
     MariaDB to MySQL (or back) keeps validating;
   * adding a variant for an already released migration never invalidates an
     install that applied the base successfully;
   * a variant must therefore be a faithful **translation** of its base (the
     same schema change), never a different change;
   * released files stay immutable, base and variants alike: the base checksum
     still guards every install against an edited base, and an edited variant
     is a silent divergence between installs - fix forward with a new version.
5. **When a released `mysql` file turns out to fail on a flavour**, do not edit
   it: add the variant for that flavour. Installs that applied the base keep
   their checksum; installs where it failed (sqlx leaves the version marked
   failed) delete that `_sqlx_migrations` row once and restart, and the
   variant runs.

Differences met so far (MySQL 8.4 vs MariaDB 12.3):

| Construct | MariaDB | Oracle MySQL | Portable form / variant |
|---|---|---|---|
| Literal default on `TEXT`/`BLOB`/`JSON` (`DEFAULT 'x'`) | accepted | error 1101 | `DEFAULT ('x')` (expression) works on both |
| `ALTER COLUMN c SET DEFAULT ('…')` on a `JSON`/`TEXT` column | accepted | error 1101 | `MODIFY COLUMN c JSON NOT NULL DEFAULT ('…')` works on both |
| `UNIQUE` key on a `TEXT` column without a prefix | accepted (hash key) | error 1170 | a `VARCHAR(n)` column; or an Oracle variant with `(SHA2(c, 256))` |
| Plain index on `TEXT` without a prefix | accepted | error 1170 | give a prefix length: `c(191)` |
| Index on a `JSON` column | accepted (`LONGTEXT`) | error 3152 | none: drop it in an Oracle variant |
| `STORED` generated column over a column whose FK is `ON DELETE SET NULL`/`CASCADE` | error 1901 | error 1215 | `VIRTUAL` + an index on it works on both |
| Functional key part `((expr))` | not supported | accepted | a generated column + index |

`cargo run -p kubuno-db --example mysql_oracle_variants -- <migrations root>`
lists the `mysql` files that hit the first four rows; with `--write` it drafts
their Oracle variants into `mysql-oracle/` (never overwriting one). The draft
must be reviewed and the module's migrations applied to a real MySQL **and** a
real MariaDB before it is committed - nothing is rewritten at run time.

### 2.7 SQL to rewrite

Run `kubuno_db::lint(sql)` over the module's statements in a unit test; it names
each non-portable construct and the helper that replaces it.

| PostgreSQL | replacement |
|---|---|
| `x = ANY($n)` (an `IN`-list of bound values) | `format!("x IN ({})", dialect::in_list(start, n))` + one `.bind()` per element |
| `x = ANY(col)` (`col` is a `TEXT[]`/`UUID[]` **column**) | store the column as a JSON array and filter with `Backend::json_array_contains("col", n)` - see §2.8 |
| `expr::bigint` | `dialect::cast("expr", SqlType::BigInt)` |
| `SUM(c)`, `COUNT(*)`, `AVG(c)` | `dialect::sum_bigint`, `count_bigint`, `avg_double` - the *return type* differs per engine (see §4) |
| `ON CONFLICT (a) DO UPDATE SET ...` | `dialect::upsert(table, &["a"], &[Assign::…])` |
| `ON CONFLICT DO NOTHING` | `dialect::insert_ignore_prefix()` **and** `dialect::on_conflict_do_nothing(&[...])` - MySQL puts its marker in the prefix |
| `RETURNING ...` | `kubuno_db::returning::*` (see §3) |
| `col->>'k'`, `col#>>'{a,b}'` | `dialect::json_text("col", &["a", "b"])` |
| `col ? 'k'`, `?|`, `?&` | `dialect::json_has_key` / `json_has_any_key` / `json_has_all_keys` |
| `ILIKE` | `dialect::ilike("col", n)` |
| `NOW()`, `INTERVAL '7 days'` | bind `chrono::Utc::now()`, or `dialect::now()` / `dialect::interval_before()` |
| `string_agg(...)` | `dialect::string_agg(...)` |
| `SELECT pg_notify(...)` | `kubuno_db::events::notify(...)` |
| `to_tsvector`, `plainto_tsquery`, `ts_rank`, `unaccent`, `pg_trgm` | `kubuno_db::search` - stem in Rust into a `TEXT` column (see §2.8) |
| `DISTINCT ON`, `array_agg`, `SKIP LOCKED` | no portable form - restructure (see §5) |

Two constructs are **refused outright**, on every backend including PostgreSQL:

* a placeholder out of order or reused (`... $2 ... $1 ...`, or `$1` twice) -
  `?` is positional and cannot express it. Bind the value a second time.
* a bare `?` - it would be mistaken for a placeholder and shift every parameter
  after it by one.

Failing loudly is deliberate. A query that is silently one bind off is the kind
of defect only production finds.

### 2.8 Array columns become JSON

PostgreSQL's `TEXT[]` and `UUID[]` have no equivalent on MySQL or SQLite. The
portable representation of a small list column is a **JSON array**, and the
foundation makes writing, reading and filtering one ergonomic on all three
engines. (A list that needs atomicity or an inverted index becomes a child
table instead - out of scope here.)

**Write** - bind the vector; it becomes a JSON array through `DbValue::Json`:

```rust
let tags: Vec<String> = vec!["red".into(), "green".into()];
db.execute("INSERT INTO photos.items (id, tags) VALUES ($1, $2)",
           params![id, tags]).await?;         // Vec<String>, &[String], Vec<Uuid>, … all work
```

`From` impls cover `Vec<String>`/`Vec<Uuid>` (owned, `&[..]`, `&Vec<..>`, and
`Option<Vec<..>>` for a nullable column). `Vec<Uuid>` is written as an array of
hyphenated strings, the spelling `uuid`'s own `Serialize` uses.

**Read** - two paths, both portable across the three drivers:

```rust
// (a) the sqlx-native derive attribute - the common case:
#[derive(sqlx::FromRow)]
struct Item { id: Uuid, #[sqlx(json)] tags: Vec<String> }

// (b) the JsonVec<T> wrapper - needed on the hand-mapped DbRow::try_get path,
//     where a plain Vec<String> would mean PostgreSQL's TEXT[], not a JSON array:
#[derive(sqlx::FromRow)]
struct Item2 { id: Uuid, tags: JsonVec<String> }   // Derefs to Vec<String>
let tags: JsonVec<String> = row.try_get("tags")?;
```

**Filter** - `Backend::json_array_contains(col, n)` replaces `value = ANY(col)`
and its GIN index. The candidate is a bound value, never interpolated (for a
UUID, bind `uuid.to_string()`):

```rust
let frag = db.backend().json_array_contains("tags", 1);   // $1 is the candidate
let rows: Vec<Item> =
    db.fetch_all_as(&format!("SELECT * FROM photos.items WHERE {frag}"),
                    params!["green"]).await?;
```

It emits `col @> jsonb_build_array($n)` on PostgreSQL (a `jsonb` GIN index
serves it), `JSON_CONTAINS(col, JSON_QUOTE($n))` on MySQL, and
`EXISTS (SELECT 1 FROM json_each(col) WHERE value = $n)` on SQLite.

**Migrating an existing `TEXT[]`/`UUID[]` column (octet-safe).** The PostgreSQL
migration that first created the column is *frozen* - its bytes and checksum
must not change (§2.6), and its tables are named without a schema prefix,
trusting the search path the pool sets. So the conversion is a **new** migration
file appended to `migrations/postgres/`, spelled the same unqualified way:

```sql
-- migrations/postgres/000042_tags_to_jsonb.up.sql
-- TEXT[]  → jsonb array of strings.  (For a UUID[] column, to_jsonb() yields an
-- array of the UUIDs' text form, exactly what JsonVec<Uuid> reads back.)
ALTER TABLE items ALTER COLUMN tags TYPE jsonb USING to_jsonb(tags);

-- Swap the array GIN index for a jsonb one so `@>` (json_array_contains) is indexed.
DROP INDEX IF EXISTS idx_items_tags;                 -- was: USING gin (tags)  [array_ops]
CREATE INDEX idx_items_tags ON items USING gin (tags jsonb_path_ops);
```

`jsonb_path_ops` is the smaller, faster GIN opclass for `@>`-only lookups; use
the default `jsonb_ops` if you also need key-existence operators. The
**MySQL and SQLite** migration directories are new, so their `CREATE TABLE`
declares the column JSON from the start - `tags JSON NOT NULL` (MySQL) /
`tags TEXT NOT NULL` (SQLite), or `Backend::col_json()` in a generated migration
- and never carry an `ALTER`.
### 2.9 Delta sync: the change journal

The local-first modules (calendar, tasks, notes, assistant, wiki, drive, mail,
contacts, chat) share one delta-sync layer: a monotonic `change_seq` per record,
a tombstone per deletion, a feed pulled from a cursor. On PostgreSQL that is a
`SEQUENCE` plus a `BEFORE UPDATE`/`AFTER DELETE` trigger pair - neither of which
MySQL or SQLite has, and the child "no-op bump" (`UPDATE ... SET change_seq =
change_seq`) does not even survive MySQL. The [`journal`](src/journal.rs) module
lifts the whole mechanism into a portable, application-driven primitive.

Tables a module creates (one shared counter per schema, one tombstone table per
synced entity; `domain` is `VARCHAR` so MySQL can key it):

```sql
CREATE TABLE calendar.change_counter (domain VARCHAR(190) NOT NULL PRIMARY KEY, n BIGINT NOT NULL);
CREATE TABLE calendar.event_tombstones (
    id {uuid} NOT NULL PRIMARY KEY, owner_id {uuid} NOT NULL,
    change_seq BIGINT NOT NULL, deleted_at {timestamptz} NOT NULL);
-- the live table gains a plain column, no default, no trigger:
ALTER TABLE calendar.events ADD COLUMN change_seq BIGINT NOT NULL DEFAULT 0;
CREATE INDEX idx_events_change_seq ON calendar.events(owner_id, change_seq);
```

(`{uuid}`/`{timestamptz}` per `Backend::col_uuid()` / `col_timestamptz()`.)

The diff from the trigger design is that the seq is taken in Rust and bound into
the same `INSERT`/`UPDATE`/`DELETE`, all on one `DbTx`:

```rust
let mut tx = pool.begin().await?;
let seq = journal::next_seq(&mut tx, "calendar.change_counter", "events").await?;
tx.execute("UPDATE calendar.events SET title=$1, change_seq=$2 WHERE id=$3",
           params![title, seq, id]).await?;
tx.commit().await?;                                    // was: BEFORE UPDATE trigger

// delete → tombstone, atomically:
let seq = journal::next_seq(&mut tx, "calendar.change_counter", "events").await?;
tx.execute("DELETE FROM calendar.events WHERE id=$1", params![id]).await?;
journal::record_tombstone(&mut tx, "calendar.event_tombstones", id, owner, seq).await?;

// child bumps parent (replaces the no-op UPDATE, which MySQL cannot observe):
journal::touch(&mut tx, "calendar.events", "calendar.change_counter", "events", "id", event_id).await?;

// the pull, live rows + tombstones unified and ordered:
let changes = journal::changes_since(pool, "calendar.events", "calendar.event_tombstones",
                                     owner, cursor, limit).await?;
```

`next_seq` is collision-free under concurrent writers on all three engines (a
single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` on PostgreSQL/SQLite; the
same increment plus a locked re-`SELECT` in one transaction on MySQL; and, on
SQLite, the foundation's single-writer gate on top). See
`tests/journal_delta.rs`.
### 2.10 Full-text search

`to_tsvector` / `plainto_tsquery` / `ts_rank`, the `unaccent` extension and
`pg_trgm` are all PostgreSQL-only. `kubuno_db::search` makes search identical on
the three engines by moving it into Rust: text is reduced to Snowball **French**
stems (the same algorithm PostgreSQL's `french` dictionary uses) and stripped of
diacritics **at write time**, then stored in a plain `TEXT` column; a query is
put through the same reduction and matched with a portable `LIKE`. Because the
stemming happens before any SQL, the stored and searched tokens are byte-for-byte
identical whatever the engine - so a search returns the same rows and the same
ranking on PostgreSQL, MySQL and SQLite, with no extension.

**Store** - one normalized `TEXT` column per weight class (the portable stand-in
for `setweight A/B/C`). Compute the columns in Rust on insert/update instead of a
`tsvector` trigger:

```rust
use kubuno_db::search::{self, Field, Weight, Query};

// write side (replaces `setweight(to_tsvector('french', unaccent(title)), 'A')`)
let title_norm = search::normalize(&title);   // e.g. "chevaux" -> "cheval"
let body_norm  = search::normalize(&body);
db.execute(
    "INSERT INTO notes.pages (id, title, title_norm, body_norm) VALUES ($1,$2,$3,$4)",
    params![id, title, title_norm, body_norm],
).await?;
```

**Search** - `Query::build` returns a portable `WHERE` filter, an `ORDER BY`
score and the bind values (every value bound, never interpolated). Placeholders
are numbered from `start`, the `WHERE` block then the `ORDER BY` block, so the
binds slot in between the caller's pre-conditions and its `LIMIT`/`OFFSET`:

```rust
let fields = [Field::new("title_norm", Weight::A), Field::new("body_norm", Weight::B)];
if let Some(s) = Query::build(&user_query, &fields, 3) {   // $1,$2 already used
    let sql = format!(
        "SELECT * FROM notes.pages \
         WHERE owner_id = $1 AND is_trashed = $2 AND {} \
         ORDER BY {} DESC LIMIT ${} OFFSET ${}",
        s.where_sql, s.order_sql, s.next, s.next + 1);
    let mut binds = params![owner_id, trashed];
    binds.extend(s.binds);
    binds.push(limit.into());
    binds.push(offset.into());
    db.fetch_all_as::<Page>(&sql, binds).await?
} else {
    // query reduced to no stems: run the plain, unfiltered listing
};
```

The query is **bounded**: only the first `search::max_terms()` distinct stems
are kept (16 by default), since each costs a `LIKE '%…%'` per field. The value is
set per process with `search::set_max_terms` - the core applies its `[search]
max_terms` and passes it to every module through `KUBUNO_DB_SEARCH_MAX_TERMS`,
which `connect` reads - or per call with `Query::build_with_max_terms`. Both are
clamped to `1..=256`.

A term matches when it is a substring of a normalized column, so a stored stem
`cheval` is found by the query word `chevaux` (both stem to `cheval`), and an
accent-free query (`resume`) finds an accented word (`résumé`). Every term must
be present (`AND` across terms); within a term any field satisfies it (`OR`).

**Migration** - drop the `TSVECTOR` column, its `GIN` index and its trigger;
add `title_norm`/`body_norm` `TEXT` columns and fill them in Rust. A plain
`B-tree`/no index is enough for a `LIKE '%stem%'`; on a large corpus, an engine's
own substring index (e.g. a trigram index where available) can be added later
without changing the query.

**What this does not do:** `pg_trgm`'s typo tolerance is gone - a `LIKE` needs
the stem to appear as a substring, so a misspelling that survives stemming will
not match. Stemming still folds inflections and `normalize` folds accents, so
inflected and accented queries match; only fuzzy/edit-distance matching is out
of scope. Snowball also leaves a few inflections whole (e.g. the present
3rd-person plural `-ent`), exactly as PostgreSQL's `french` stemmer does.

---

## 3. `RETURNING`, and the prerequisite behind it

487 statements use `RETURNING`, in all 22 modules. PostgreSQL and SQLite have
it; MySQL and MariaDB effectively do not.

**The blocker is not the clause, it is the key.** 295 Kubuno tables declare
`id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, so the key is invented by the
database and `RETURNING` is the only way the process learns it. On MySQL there
is no other way - `LAST_INSERT_ID()` reports an `AUTO_INCREMENT` integer, which
a UUID column is not.

So each such insert must **generate the key in Rust** and bind it:

```rust
let id = kubuno_db::new_id();
// INSERT INTO office.documents (id, owner_id, title) VALUES ($1, $2, $3)
```

The PostgreSQL `DEFAULT` stays in the (frozen) migration and is simply
overridden. The MySQL and SQLite migrations declare the column without one.

Once the key is known before the write, the helpers make the call site identical
on the three engines:

```rust
let mut tx = pool.begin().await?;
let row = kubuno_db::returning::insert_returning_row(
    &mut tx,
    "INSERT INTO office.documents (id, owner_id, title) VALUES ($1, $2, $3)",
    "*",                                   // what RETURNING would have listed
    |q| q.bind(id).bind(owner).bind(&title),
    "SELECT * FROM office.documents WHERE id = $1",   // MySQL only
    |q| q.bind(id),
).await?;
tx.commit().await?;
```

On PostgreSQL and SQLite: one statement, `RETURNING` appended. On MySQL: the
write, then the re-select - **always inside a transaction**, or a concurrent
session slips between them.

`update_returning_row` and `delete_returning_row` follow the same shape;
`delete` necessarily reads *before* it writes.

### What this cannot do

* **A guarded update.** `UPDATE … WHERE status = 'draft' … RETURNING *` cannot
  be emulated: once the update has changed `status`, a re-select keyed on the
  guard finds nothing, and one keyed on the primary key returns the row even
  when the guard never matched. Restructure it as `SELECT … FOR UPDATE` inside
  a transaction, then decide in Rust. That pattern is portable *and* says what
  it means.
* **`RETURNING` on a multi-row write.** The helpers handle one row.
* **A `DEFAULT` the database computes and the caller needs back**, other than
  through the re-select, which does return it.

---

## 4. Aggregate return types

`sqlx` type-checks on decode, and an aggregate does not return the same SQL type
on the three engines:

| expression | PostgreSQL | MySQL | SQLite |
|---|---|---|---|
| `COUNT(*)` | `bigint` | `BIGINT UNSIGNED` | `INTEGER` |
| `SUM(bigint)` | `numeric` | `DECIMAL` | `INTEGER` |
| `AVG(int)` | `numeric` | `DOUBLE` | `REAL` |

`numeric` and `DECIMAL` do **not** decode into `i64`/`f64` without the
`bigdecimal`/`rust_decimal` features. `dialect::sum_bigint`, `count_bigint` and
`avg_double` wrap the right cast for the engine, and `sum_bigint` also coalesces
`NULL` to `0`.

---

## 5. What this crate will never cover

* **The event bus.** `LISTEN`/`NOTIFY` has no equivalent. `events::notify`
  writes to a `<schema>.kubuno_event_outbox` table instead - durably, in the
  same transaction as the data, which is better than `pg_notify`. **But the
  core has no poller for it yet.** On MySQL and SQLite, events are recorded and
  undelivered. This is the largest remaining piece of core work.
* **The job queue.** `SELECT ... FOR UPDATE SKIP LOCKED` exists on MySQL 8 and
  MariaDB 10.6, and not at all on SQLite. A portable queue needs a different
  strategy per engine.
* **The `.sqlx` caches.** `core` (129 entries), `media` (173) and `drive` (8)
  use `sqlx::query!` macros, verified at compile time against a live
  PostgreSQL. Those are not portable as they stand: either the macros become
  runtime `kubuno_db::query`, or a cache is prepared per engine. Nothing here
  changes that.
* **Full-text search.** `tsvector`/`pg_trgm` against `MATCH ... AGAINST` against
  FTS5: three different engines with three different query languages.
* **PostgreSQL-specific types**: the native array type (`TEXT[]`, `UUID[]`),
  `INET`, `CITEXT`, ranges, `INTERVAL` as a column type. A *small list* column is
  the exception - it is carried portably as a JSON array (§2.8); it is only the
  native array **type**, with its operators and GIN opclasses, that has no
  cross-engine form.
* **Concurrency semantics.** `SERIALIZABLE` does not mean the same thing in the
  three engines, and MySQL reports 0 affected rows for an `UPDATE` that changed
  nothing. A module that reasons on `rows_affected` must be re-read.

---

## 6. Testing

All three drivers are always compiled in (there are no per-engine features), so
one command builds and tests everything. SQLite round-trips run unconditionally
on a temp file; the MySQL/MariaDB round-trips run only when a throwaway server
URL is provided, and **fail** rather than skip if that URL is set but unreachable
- a test that quietly does nothing is worse than no test.

```sh
# SQLite round-trips run with no setup:
SQLX_OFFLINE=true cargo test -p kubuno-db

# add the MySQL/MariaDB round-trips by pointing at a throwaway server
# (a disposable datadir, a non-standard port, never a shared database):
KUBUNO_QB_MYSQL_URL=mysql://root@127.0.0.1:3399/throwaway \
  SQLX_OFFLINE=true cargo test -p kubuno-db
```

The flavour-variant tests (`tests/mysql_variants.rs`) and the namespace test
(`tests/mysql_namespace.rs`) read `KUBUNO_MYSQL_TEST_URL` (an Oracle MySQL
server) and `KUBUNO_MARIADB_TEST_URL` (a MariaDB server), each skipped when
unset. Run both before changing anything that touches MySQL migrations.

CI runs `cargo clippy -p kubuno-db --all-targets -- -D warnings` with all three
drivers linked; keep it green.

---

## 7. Security

`sqlx` 0.9 refuses non-literal query text unless it is wrapped in
`AssertSqlSafe`. This crate contains exactly **one** such wrap,
`sql::assert_safe`, applied to the output of `sql::prepare` - developer-written
SQL with at most its placeholder syntax changed. `prepare` only ever *removes*
characters and copies the rest verbatim, so it cannot introduce a construct the
source did not already have.

Dynamic fragments come from `dialect`, whose identifier parameters are all
`&'static str`: a value that cannot come from an HTTP request without a
deliberate leak. **Bind parameters remain the only channel for user data.**
