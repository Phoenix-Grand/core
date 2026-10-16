//! Drafts the Oracle MySQL flavour variants of a `migrations/mysql` directory.
//!
//! ```text
//! cargo run -p kubuno-db --example mysql_oracle_variants -- <migrations root> [--write]
//! ```
//!
//! Reads `<root>/mysql/*.sql` in version order, applies the line-level rewrite
//! of [`compat`] (the constructs MariaDB accepts and Oracle MySQL refuses), and
//! lists every file the rewrite changes. With `--write`, each changed file is
//! written under `<root>/mysql-oracle/` with the same name - a flavour variant
//! (see `kubuno_db::MySqlVariants`). An existing variant is never overwritten.
//!
//! The output is a draft: review it, then apply the module's migrations on a
//! real Oracle MySQL AND a real MariaDB before committing it. A variant is
//! recorded under its base file's checksum, so a variant must be a faithful
//! translation of its base.

mod compat;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut root = None;
    let mut write = false;
    for a in std::env::args().skip(1) {
        if a == "--write" {
            write = true;
        } else if root.is_none() {
            root = Some(PathBuf::from(a));
        } else {
            eprintln!("unexpected argument `{a}`");
            return ExitCode::from(2);
        }
    }
    let Some(root) = root else {
        eprintln!("usage: mysql_oracle_variants <migrations root> [--write]");
        return ExitCode::from(2);
    };
    match run(&root, write) {
        Ok(n) => {
            println!("{n} file(s) need an Oracle MySQL variant");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

/// `000012_name.up.sql` → (12, is_down). Files that do not parse are skipped,
/// as sqlx would reject them anyway.
fn version_of(name: &str) -> Option<(i64, bool)> {
    let v = name.split('_').next()?.parse().ok()?;
    Some((v, name.ends_with(".down.sql")))
}

fn run(root: &Path, write: bool) -> Result<usize, String> {
    let base = root.join("mysql");
    let out_dir = root.join("mysql-oracle");
    let mut files: Vec<(i64, bool, PathBuf)> = std::fs::read_dir(&base)
        .map_err(|e| format!("{}: {e}", base.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter_map(|p| {
            let name = p.file_name()?.to_str()?.to_string();
            if !name.ends_with(".sql") {
                return None;
            }
            let (v, down) = version_of(&name)?;
            Some((v, down, p))
        })
        .collect();
    files.sort();

    // Up migrations share one catalog (a later index needs the column kinds an
    // earlier migration created); a down migration is rewritten on its own.
    let mut catalog = compat::Catalog::default();
    let mut changed = 0;
    for (_, down, path) in files {
        let sql = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let out = if down {
            compat::rewrite(&sql, &mut compat::Catalog::default())
        } else {
            compat::rewrite(&sql, &mut catalog)
        };
        if out == sql {
            continue;
        }
        changed += 1;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let target = out_dir.join(&name);
        if !write {
            println!("needs variant: {name}");
        } else if target.exists() {
            println!("kept existing variant: {}", target.display());
        } else {
            std::fs::create_dir_all(&out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
            let header = format!(
                "-- Oracle MySQL variant of migrations/mysql/{name}: runs instead of it on\n\
                 -- Oracle MySQL only and is recorded under its checksum (kubuno_db::MySqlVariants).\n\
                 -- Drafted by kubuno-db's `mysql_oracle_variants` example, then reviewed.\n"
            );
            std::fs::write(&target, format!("{header}{out}"))
                .map_err(|e| format!("{}: {e}", target.display()))?;
            println!("wrote {}", target.display());
        }
    }
    Ok(changed)
}
