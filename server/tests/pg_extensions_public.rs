//! The PostgreSQL extensions the migrations call unqualified (uuid-ossp,
//! pg_trgm, unaccent, citext) must live in schema `public`, where every Kubuno
//! connection - the core's and each module's (`<module>, public`) - finds them.
//!
//! Needs `KUBUNO_PG_FRESH_DB_URL`: a THROWAWAY database whose role owns it
//! (the test runs the whole core migration set; its upgrade half, which moves
//! extensions around, also needs the role to be a superuser). Skipped when
//! unset. Locally:
//!
//! ```text
//! sudo -u postgres psql -c "CREATE DATABASE kubuno_freshtest OWNER kubuno_test"
//! KUBUNO_PG_FRESH_DB_URL=postgres://kubuno_test:kubuno_test@127.0.0.1/kubuno_freshtest \
//!   cargo test --test pg_extensions_public
//! ```

use kubuno_db::{connect, params, DbPool, DbSettings};

const EXTENSIONS: &[&str] = &["uuid-ossp", "pg_trgm", "unaccent", "citext"];

fn settings(url: &str) -> DbSettings {
    serde_json::from_value(serde_json::json!({
        "engine": "postgres",
        "url": url,
        "max_connections": 4,
        "min_connections": 0,
        "connect_timeout": 10,
        "run_migrations": false,
    }))
    .expect("DbSettings")
}

async fn extension_schema(pool: &DbPool, name: &str) -> Option<String> {
    pool.fetch_optional_scalar(
        "SELECT n.nspname::text FROM pg_extension e \
         JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = $1",
        params![name],
    )
    .await
    .expect("extension lookup")
}

/// What a module connection (`search_path = <module>, public`) must resolve.
async fn module_resolves_extensions(url: &str) {
    let module = connect(&settings(url), "extprobe").await.expect("module pool");
    let ok: bool = module
        .fetch_scalar(
            "SELECT uuid_generate_v4() IS NOT NULL \
               AND similarity('kubuno', 'kubunos') > 0 \
               AND unaccent('été') = 'ete' \
               AND 'ABC'::citext = 'abc'::citext",
            params![],
        )
        .await
        .expect("extension functions resolve from a module schema");
    assert!(ok);
    module.execute("DROP SCHEMA extprobe", params![]).await.expect("drop probe schema");
}

#[tokio::test]
async fn extensions_live_in_public_on_fresh_and_upgraded_databases() {
    let Ok(url) = std::env::var("KUBUNO_PG_FRESH_DB_URL") else {
        eprintln!("skipping: KUBUNO_PG_FRESH_DB_URL not set");
        return;
    };
    let pool = connect(&settings(&url), "core").await.expect("connect core");

    // Fresh install (or a re-run on an already migrated database).
    kubuno_core::database::migrations::run(&pool).await.expect("core migrations");
    for ext in EXTENSIONS {
        assert_eq!(extension_schema(&pool, ext).await.as_deref(), Some("public"), "{ext}");
    }
    module_resolves_extensions(&url).await;

    // Upgrade: the layout an earlier release left behind (extensions in `core`).
    // Moving a trusted extension needs a superuser (its member objects belong
    // to the bootstrap superuser), as does the core's own repair: without one,
    // this half is skipped.
    let su: bool = pool
        .fetch_scalar("SELECT rolsuper FROM pg_roles WHERE rolname = current_user", params![])
        .await
        .expect("role lookup");
    if !su {
        eprintln!("upgrade half skipped: the test role is not a superuser");
        return;
    }
    for stmt in [
        r#"ALTER EXTENSION "uuid-ossp" SET SCHEMA core"#,
        "ALTER EXTENSION pg_trgm SET SCHEMA core",
        "ALTER EXTENSION unaccent SET SCHEMA core",
        "ALTER EXTENSION citext SET SCHEMA core",
    ] {
        pool.execute(stmt, params![]).await.expect("legacy layout");
    }
    kubuno_core::database::migrations::run(&pool).await.expect("core migrations after upgrade");
    for ext in EXTENSIONS {
        assert_eq!(extension_schema(&pool, ext).await.as_deref(), Some("public"), "{ext}");
    }
    module_resolves_extensions(&url).await;

    // Existing core tables keep working (citext column on core.users).
    let n: i64 = pool
        .fetch_scalar("SELECT count(*) FROM core.users WHERE email = 'NOBODY@EXAMPLE.INVALID'", params![])
        .await
        .expect("citext comparison on core.users");
    assert_eq!(n, 0);
}
