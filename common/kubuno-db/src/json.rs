//! Decoding a JSON-array column into a `Vec<T>` on any of the three engines.
//!
//! # The gap this fills
//!
//! Kubuno's array columns (`TEXT[]`, `UUID[]`) become JSON arrays on the move to
//! a portable engine (MySQL and SQLite have no array type). Writing one is easy:
//! a `Vec<String>`/`Vec<Uuid>` binds through [`crate::DbValue`] as JSON (see the
//! `From` impls in `value.rs`). Reading one back is the asymmetric half.
//!
//! A plain `field: Vec<String>` on a `#[derive(sqlx::FromRow)]` struct is
//! **wrong** here: on PostgreSQL `Vec<String>` means the array type `TEXT[]`, not
//! a JSON array, and on SQLite the column is `TEXT` that must be parsed. sqlx's
//! own answer is the `#[sqlx(json)]` field attribute, which decodes the column
//! through [`sqlx::types::Json`] - portable across all three drivers:
//!
//! ```ignore
//! #[derive(sqlx::FromRow)]
//! struct Row {
//!     #[sqlx(json)]
//!     tags: Vec<String>,
//! }
//! ```
//!
//! That covers the *derive* path. It does **not** cover the hand-mapped path,
//! [`crate::DbRow::try_get`], which needs a type that is `Decode + Type` on all
//! three engines - and `Vec<String>` is not (it is the array type on Postgres).
//! [`JsonVec`] is that type: usable both as a `FromRow` field
//! (`tags: JsonVec<String>`) and as `row.try_get::<JsonVec<String>>("tags")`.
//!
//! The blanket impls below mirror sqlx's own for `serde_json::Value`: `JsonVec`
//! is `Type`/`Decode`/`Encode` for any backend where `Json<Vec<T>>` is. Writing
//! stays `params![tags]` (through `DbValue::Json`); the `Encode` half is there so
//! the type is coherent and bindable, but it is rarely needed directly.

use serde::Serialize;
use sqlx::encode::IsNull;
use sqlx::error::BoxDynError;
use sqlx::types::Json;
use sqlx::{Database, Decode, Encode, Type};

/// A `Vec<T>` stored in, and read from, a JSON-array column, portably across
/// PostgreSQL (`jsonb`/`json`), MySQL/MariaDB (`JSON`) and SQLite (`TEXT`).
///
/// Decodes wherever [`sqlx::types::Json<Vec<T>>`](sqlx::types::Json) does, i.e.
/// everywhere the `T` deserialises. Dereferences to `Vec<T>`, so `row.tags.iter()`
/// and `&row.tags` read as if it were a plain vector.
///
/// ```ignore
/// #[derive(sqlx::FromRow)]
/// struct Row {
///     id: i64,
///     tags: JsonVec<String>,     // decoded from a JSON array column
/// }
/// // writing is unchanged: params![id, tags_vec]  (a Vec<String>)
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct JsonVec<T>(pub Vec<T>);

impl<T> JsonVec<T> {
    /// The inner `Vec<T>`, by value.
    pub fn into_inner(self) -> Vec<T> {
        self.0
    }
}

impl<T> std::ops::Deref for JsonVec<T> {
    type Target = Vec<T>;
    fn deref(&self) -> &Vec<T> {
        &self.0
    }
}

impl<T> std::ops::DerefMut for JsonVec<T> {
    fn deref_mut(&mut self) -> &mut Vec<T> {
        &mut self.0
    }
}

impl<T> From<Vec<T>> for JsonVec<T> {
    fn from(v: Vec<T>) -> Self {
        JsonVec(v)
    }
}

impl<T> From<JsonVec<T>> for Vec<T> {
    fn from(v: JsonVec<T>) -> Self {
        v.0
    }
}

impl<T> IntoIterator for JsonVec<T> {
    type Item = T;
    type IntoIter = std::vec::IntoIter<T>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

// ── the SQL type, for every backend `Json<Vec<T>>` covers ───────────────────

impl<T, DB> Type<DB> for JsonVec<T>
where
    DB: Database,
    Json<Vec<T>>: Type<DB>,
{
    fn type_info() -> DB::TypeInfo {
        <Json<Vec<T>> as Type<DB>>::type_info()
    }
    fn compatible(ty: &DB::TypeInfo) -> bool {
        <Json<Vec<T>> as Type<DB>>::compatible(ty)
    }
}

impl<'r, T, DB> Decode<'r, DB> for JsonVec<T>
where
    DB: Database,
    Json<Vec<T>>: Decode<'r, DB>,
{
    fn decode(value: <DB as Database>::ValueRef<'r>) -> Result<Self, BoxDynError> {
        <Json<Vec<T>> as Decode<'r, DB>>::decode(value).map(|j| JsonVec(j.0))
    }
}

impl<'q, T, DB> Encode<'q, DB> for JsonVec<T>
where
    DB: Database,
    T: Serialize,
    for<'a> Json<&'a Vec<T>>: Encode<'q, DB>,
{
    fn encode_by_ref(
        &self,
        buf: &mut <DB as Database>::ArgumentBuffer,
    ) -> Result<IsNull, BoxDynError> {
        <Json<&Vec<T>> as Encode<'q, DB>>::encode_by_ref(&Json(&self.0), buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_and_unwraps() {
        let v = JsonVec::from(vec!["a".to_string(), "b".to_string()]);
        assert_eq!(v.len(), 2); // via Deref
        assert_eq!(v.into_inner(), vec!["a".to_string(), "b".to_string()]);
    }
}

/// End-to-end proof that a `Vec<String>`/`Vec<Uuid>` written through `params!`
/// as JSON reads back into a struct, and that `json_array_contains` filters it.
/// SQLite runs unconditionally on a temp file; MySQL/MariaDB runs only when
/// `KUBUNO_QB_MYSQL_URL` points at a throwaway server, and **fails** (never
/// silently skips) if that server is set but unreachable.
#[cfg(test)]
mod exec_tests {
    use super::JsonVec;
    use crate::exec::DbPool;
    use crate::pool::{connect, DbSettings};
    use std::time::Duration;
    use uuid::Uuid;

    #[derive(Debug, sqlx::FromRow, PartialEq)]
    struct Tagged {
        id: i64,
        tags: JsonVec<String>,
        ids: JsonVec<Uuid>,
    }

    /// The same row read with the sqlx-native `#[sqlx(json)]` attribute instead
    /// of the `JsonVec` wrapper - the derive path modules will most often use.
    #[derive(Debug, sqlx::FromRow, PartialEq)]
    struct TaggedPlain {
        id: i64,
        #[sqlx(json)]
        tags: Vec<String>,
    }

    async fn seed_and_read(pool: &DbPool, schema: &str) {
        let table = format!("{schema}.tagged");
        let json = pool.backend().col_json();
        pool.execute(
            &format!(
                "CREATE TABLE {table} \
                 (id BIGINT PRIMARY KEY, tags {json} NOT NULL, ids {json} NOT NULL)"
            ),
            crate::params![],
        )
        .await
        .expect("create table");

        let uuid_a = Uuid::from_u128(0x1111_1111_1111_1111_1111_1111_1111_1111);
        let uuid_b = Uuid::from_u128(0x2222_2222_2222_2222_2222_2222_2222_2222);

        // Row 1: two tags, two ids - bound as Vec<String> / Vec<Uuid>, which the
        // `From` impls turn into JSON arrays via DbValue::Json.
        pool.execute(
            &format!("INSERT INTO {table} (id, tags, ids) VALUES ($1, $2, $3)"),
            crate::params![1i64, vec!["red".to_string(), "green".to_string()], vec![uuid_a, uuid_b]],
        )
        .await
        .expect("insert row 1");

        // Row 2: one tag, an empty id list - the empty array must round-trip too.
        pool.execute(
            &format!("INSERT INTO {table} (id, tags, ids) VALUES ($1, $2, $3)"),
            crate::params![2i64, vec!["blue".to_string()], Vec::<Uuid>::new()],
        )
        .await
        .expect("insert row 2");

        // Read row 1 back into JsonVec fields and assert the exact vectors.
        let row: Tagged = pool
            .fetch_one_as(&format!("SELECT id, tags, ids FROM {table} WHERE id = $1"), crate::params![1i64])
            .await
            .expect("fetch tagged");
        assert_eq!(
            row,
            Tagged {
                id: 1,
                tags: JsonVec(vec!["red".to_string(), "green".to_string()]),
                ids: JsonVec(vec![uuid_a, uuid_b]),
            },
            "JsonVec round-trip failed on {:?}",
            pool.backend()
        );

        // Empty Vec<Uuid> round-trips as an empty JsonVec.
        let row2: Tagged = pool
            .fetch_one_as(&format!("SELECT id, tags, ids FROM {table} WHERE id = $1"), crate::params![2i64])
            .await
            .expect("fetch tagged 2");
        assert!(row2.ids.is_empty(), "empty uuid array did not round-trip on {:?}", pool.backend());

        // The sqlx-native `#[sqlx(json)]` derive path reads the same column.
        let plain: TaggedPlain = pool
            .fetch_one_as(&format!("SELECT id, tags FROM {table} WHERE id = $1"), crate::params![1i64])
            .await
            .expect("fetch plain");
        assert_eq!(plain, TaggedPlain { id: 1, tags: vec!["red".to_string(), "green".to_string()] });

        // Filter: "tags contains ?" via the dialect helper. The candidate is a
        // bound value, never interpolated.
        let frag = pool.backend().json_array_contains("tags", 1);
        let filter_sql = format!("SELECT id FROM {table} WHERE {frag} ORDER BY id");

        for (needle, expected) in [("green", vec![1i64]), ("blue", vec![2]), ("purple", vec![])] {
            let rows: Vec<IdOnly> = pool
                .fetch_all_as(&filter_sql, crate::params![needle])
                .await
                .expect("filter");
            let ids: Vec<i64> = rows.into_iter().map(|r| r.id).collect();
            assert_eq!(ids, expected, "contains({needle:?}) on {:?}", pool.backend());
        }
    }

    #[derive(Debug, sqlx::FromRow)]
    struct IdOnly {
        id: i64,
    }

    fn sqlite_settings(dir: &str) -> DbSettings {
        DbSettings {
            engine: "sqlite".into(),
            url: None,
            host: None,
            port: None,
            user: None,
            password: None,
            database: None,
            path: Some(dir.into()),
            schema_prefix: None,
            max_connections: 1,
            min_connections: 0,
            connect_timeout: Duration::from_secs(10),
            run_migrations: false,
        }
    }

    #[tokio::test]
    async fn json_array_roundtrip_on_sqlite() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = connect(&sqlite_settings(&dir.path().to_string_lossy()), "jv")
            .await
            .expect("connect sqlite");
        seed_and_read(&pool, "jv").await;
    }

    #[tokio::test]
    async fn json_array_roundtrip_on_mysql_when_configured() {
        let Ok(url) = std::env::var("KUBUNO_QB_MYSQL_URL") else {
            eprintln!("KUBUNO_QB_MYSQL_URL unset - skipping the MySQL/MariaDB round-trip");
            return;
        };
        let settings = DbSettings {
            engine: "mysql".into(),
            url: Some(url),
            host: None,
            port: None,
            user: None,
            password: None,
            database: None,
            path: None,
            schema_prefix: None,
            max_connections: 2,
            min_connections: 0,
            connect_timeout: Duration::from_secs(10),
            run_migrations: false,
        };
        let pool = connect(&settings, "jv").await.expect("connect mysql");
        pool.execute("DROP TABLE IF EXISTS jv.tagged", crate::params![])
            .await
            .expect("drop");
        seed_and_read(&pool, "jv").await;
        pool.execute("DROP TABLE IF EXISTS jv.tagged", crate::params![])
            .await
            .expect("cleanup");
    }
}
