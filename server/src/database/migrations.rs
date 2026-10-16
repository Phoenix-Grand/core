use crate::database::SCHEMA;
use anyhow::{Context, Result};
use kubuno_db::{DbPool, MigratorSet};

/// The core's migration set. The three dialects live under
/// `migrations/{postgres,mysql,sqlite}`; `migrations/mysql-oracle` holds the
/// Oracle MySQL flavour variants of a few `mysql` files (MariaDB runs the
/// `mysql` files as written). See `kubuno_db::MySqlVariants`.
fn set() -> MigratorSet {
    kubuno_db::migrations!(
        "migrations/postgres",
        "migrations/mysql",
        "migrations/sqlite",
        oracle_mysql = "migrations/mysql-oracle",
    )
}

/// Runs the migration set for the pool's engine; `.run` applies the one that
/// matches the pool (with the MySQL flavour's variants), keeping
/// `_sqlx_migrations` inside the `core` namespace (the table PostgreSQL already
/// used through its search_path, so an applied migration is not re-run).
pub async fn run(pool: &DbPool) -> Result<()> {
    tracing::info!("Application des migrations SQL…");
    if let Some(pg) = pool.as_pg() {
        ensure_pg_extensions_in_public(pg).await;
    }
    set().run(pool, SCHEMA).await.context("Échec des migrations")?;
    tracing::info!("Migrations appliquées avec succès");
    Ok(())
}

/// A PostgreSQL extension the migrations (the core's and the modules') rely on,
/// with its statements spelled out so no identifier is ever formatted into SQL.
struct PgExtension {
    name: &'static str,
    create: &'static str,
    relocate: &'static str,
}

/// The extensions created by core migration 000001, whose objects
/// (`uuid_generate_v4()`, `citext`, `gin_trgm_ops`, `similarity()`,
/// `unaccent()`) are called UNQUALIFIED by core and module migrations alike.
const PG_EXTENSIONS: &[PgExtension] = &[
    PgExtension {
        name: "uuid-ossp",
        create: r#"CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public"#,
        relocate: r#"ALTER EXTENSION "uuid-ossp" SET SCHEMA public"#,
    },
    PgExtension {
        name: "pg_trgm",
        create: "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public",
        relocate: "ALTER EXTENSION pg_trgm SET SCHEMA public",
    },
    PgExtension {
        name: "unaccent",
        create: "CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public",
        relocate: "ALTER EXTENSION unaccent SET SCHEMA public",
    },
    PgExtension {
        name: "citext",
        create: "CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public",
        relocate: "ALTER EXTENSION citext SET SCHEMA public",
    },
];

/// Makes sure the shared PostgreSQL extensions live in schema `public`, before
/// any migration runs.
///
/// Migration 000001 says `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"` without
/// a schema, so PostgreSQL put the extension in the first schema of the
/// connection's search_path - `core` (or `<prefix>core`). An extension exists
/// once per database, so from then on only a connection with that schema on
/// its path could resolve `uuid_generate_v4()`: every module (search_path
/// `<module>, public`) failed its first migration on a fresh install, and a
/// second, prefixed core sharing the database failed its own migrations with
/// `function uuid_generate_v4() does not exist`. Every Kubuno connection keeps
/// `public` on its path, which is where these objects belong.
///
/// * Missing extension: created in `public`; migration 000001's own
///   `CREATE EXTENSION IF NOT EXISTS` then finds it and does nothing (its file,
///   hence its checksum, is unchanged).
/// * Extension already elsewhere (an install created by an earlier release):
///   moved to `public`. The four are relocatable, and column defaults, column
///   types and index operator classes reference them by OID, so existing tables
///   are unaffected; unqualified calls keep resolving through `public`.
///
/// Best effort: on failure the error is logged and the migrations run exactly
/// as before. Moving an extension needs ownership of its member objects, which
/// for a trusted extension created by a non-superuser belong to the bootstrap
/// superuser: on such an install the log names the statement a PostgreSQL
/// superuser has to run once (`ALTER EXTENSION … SET SCHEMA public`).
async fn ensure_pg_extensions_in_public(pg: &sqlx::PgPool) {
    for ext in PG_EXTENSIONS {
        let schema: Option<String> = match sqlx::query_scalar(
            "SELECT n.nspname::text FROM pg_extension e \
             JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = $1",
        )
        .bind(ext.name)
        .fetch_optional(pg)
        .await
        {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(extension = ext.name, error = %e, "PostgreSQL extension lookup failed");
                continue;
            }
        };
        match schema.as_deref() {
            Some("public") => {}
            None => {
                if let Err(e) = sqlx::query(ext.create).execute(pg).await {
                    tracing::error!(
                        extension = ext.name,
                        error = %e,
                        "could not create the PostgreSQL extension in schema public"
                    );
                }
            }
            Some(other) => match sqlx::query(ext.relocate).execute(pg).await {
                Ok(_) => tracing::info!(
                    extension = ext.name,
                    from = other,
                    "PostgreSQL extension moved to schema public"
                ),
                Err(e) => tracing::error!(
                    extension = ext.name,
                    schema = other,
                    error = %e,
                    fix = ext.relocate,
                    "could not move the PostgreSQL extension to schema public; modules will not \
                     resolve its objects until a PostgreSQL superuser runs the statement in `fix`"
                ),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn mysql_flavour_variants_replace_existing_files() {
        super::set().check().expect("every variant has a namesake in migrations/mysql");
    }

    #[test]
    fn extension_statements_name_their_extension() {
        for ext in super::PG_EXTENSIONS {
            assert!(ext.create.contains(ext.name) && ext.create.ends_with("WITH SCHEMA public"));
            assert!(ext.relocate.contains(ext.name) && ext.relocate.ends_with("SET SCHEMA public"));
        }
    }
}
