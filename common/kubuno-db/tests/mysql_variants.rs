//! MySQL flavour variants: a file under `migrations/mysql-mariadb/` or
//! `migrations/mysql-oracle/` replaces its `migrations/mysql` namesake on that
//! flavour only, and is recorded under the base file's checksum.
//!
//! The offline tests check the macro and the run-time loader agree. The live
//! tests run the fixture on real servers and are guarded by
//! `KUBUNO_MYSQL_TEST_URL` (Oracle MySQL) and `KUBUNO_MARIADB_TEST_URL`
//! (MariaDB), URLs whose user may CREATE/DROP databases; each is skipped when
//! its variable is not set.

use kubuno_db::{connect, params, DbSettings, MigratorSet, MySqlFlavor};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/variant_migrations");

fn embedded() -> MigratorSet {
    kubuno_db::migrations!(
        "tests/variant_migrations/postgres",
        "tests/variant_migrations/mysql",
        "tests/variant_migrations/sqlite",
        mariadb = "tests/variant_migrations/mysql-mariadb",
        oracle_mysql = "tests/variant_migrations/mysql-oracle",
    )
}

#[tokio::test]
async fn macro_and_loader_resolve_the_same_variants() {
    let loaded = MigratorSet::from_dir(ROOT).await.expect("load");
    let embedded = embedded();
    loaded.check().expect("loaded variants are well-formed");
    embedded.check().expect("embedded variants are well-formed");
    for (flavor, default) in [(MySqlFlavor::MariaDb, "'mariadb'"), (MySqlFlavor::Oracle, "'oracle'")] {
        let a = loaded.mysql_migrations(flavor).expect("loaded");
        let b = embedded.mysql_migrations(flavor).expect("embedded");
        assert_eq!(a.len(), 4);
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(&b) {
            assert_eq!(x.sql.as_str(), y.sql.as_str());
            assert_eq!(x.checksum, y.checksum);
        }
        let up1 = a.iter().find(|m| m.version == 1 && m.migration_type.is_up_migration()).expect("v1");
        assert!(up1.sql.as_str().contains(default), "{flavor:?}: {}", up1.sql.as_str());
        // The variant is recorded as its base.
        let base1 = embedded
            .mysql
            .iter()
            .find(|m| m.version == 1 && m.migration_type.is_up_migration())
            .expect("base v1");
        assert_eq!(up1.checksum, base1.checksum);
        assert_eq!(up1.description, base1.description);
    }
}

#[tokio::test]
async fn a_module_without_variants_keeps_the_three_argument_form() {
    let set = kubuno_db::migrations!(
        "tests/prefix_migrations/postgres",
        "tests/prefix_migrations/mysql",
        "tests/prefix_migrations/sqlite",
    );
    assert!(set.mysql_variants.mariadb.is_none() && set.mysql_variants.oracle.is_none());
    let base: Vec<_> = set.mysql.iter().map(|m| m.checksum.clone()).collect();
    for flavor in [MySqlFlavor::MariaDb, MySqlFlavor::Oracle] {
        let got: Vec<_> = set.mysql_migrations(flavor).expect("resolve").into_iter().map(|m| m.checksum).collect();
        assert_eq!(got, base);
    }
}

fn settings(url: &str) -> DbSettings {
    serde_json::from_value(serde_json::json!({
        "engine": "mysql",
        "url": url,
        "max_connections": 2,
        "min_connections": 0,
        "connect_timeout": 15,
        "run_migrations": true,
    }))
    .expect("DbSettings")
}

/// Migrates a fresh namespace on the server behind `url`, twice, and checks
/// the flavour's variant ran while the base checksum was recorded.
async fn live(url: &str, expect: MySqlFlavor) {
    // A unique namespace per run; `connect` creates it.
    let schema: &'static str =
        Box::leak(format!("kbvar_{}", &uuid::Uuid::new_v4().simple().to_string()[..10]).into_boxed_str());
    let pool = connect(&settings(url), schema).await.expect("connect");

    embedded().run(&pool, schema).await.expect("first run");
    // A second run validates every applied checksum against the resolved set.
    embedded().run(&pool, schema).await.expect("second run (checksums validate)");

    let want = match expect {
        MySqlFlavor::MariaDb => "mariadb",
        MySqlFlavor::Oracle => "oracle",
    };
    pool.execute(&format!("INSERT INTO {schema}.widgets (id) VALUES ($1)"), params![1_i32])
        .await
        .expect("insert");
    let got: String = pool
        .fetch_scalar(&format!("SELECT flavor FROM {schema}.widgets WHERE id = $1"), params![1_i32])
        .await
        .expect("read default");
    assert_eq!(got, want, "the {expect:?} variant must have run");

    let base = embedded();
    let base_up1 = base
        .mysql
        .iter()
        .find(|m| m.version == 1 && m.migration_type.is_up_migration())
        .expect("base v1");
    let recorded: Vec<u8> = pool
        .fetch_scalar(&format!("SELECT checksum FROM {schema}._sqlx_migrations WHERE version = 1"), params![])
        .await
        .expect("recorded checksum");
    assert_eq!(recorded, base_up1.checksum.to_vec(), "the BASE checksum is recorded");

    pool.execute(&format!("DROP DATABASE `{schema}`"), params![]).await.expect("drop");
}

#[tokio::test]
async fn oracle_mysql_runs_its_variant() {
    let Ok(url) = std::env::var("KUBUNO_MYSQL_TEST_URL") else {
        eprintln!("KUBUNO_MYSQL_TEST_URL not set - test skipped");
        return;
    };
    live(&url, MySqlFlavor::Oracle).await;
}

#[tokio::test]
async fn mariadb_runs_its_variant() {
    let Ok(url) = std::env::var("KUBUNO_MARIADB_TEST_URL") else {
        eprintln!("KUBUNO_MARIADB_TEST_URL not set - test skipped");
        return;
    };
    live(&url, MySqlFlavor::MariaDb).await;
}
