//! `kubuno` — console d'administration de la plateforme.
//!
//! Ce fichier ne contient que l'entrypoint et le routage des sous-commandes ;
//! chaque responsabilité vit dans son propre module :
//!   - [`display`] : rendu console (couleurs, statuts, confirmations)
//!   - [`pgconn`]  : parsing de la configuration PostgreSQL
//!   - [`cli`]     : définition clap de la ligne de commande
//!   - [`db`]      : commandes `db:*`
//!   - [`reset`]   : `app:reset` et `<module>:reset`
//!   - [`auth`]    : `auth:recover` — voie de secours locale (jamais exposée par HTTP)
//!   - [`rekey`]   : `security:rekey` — renouvellement de la clé de chiffrement des données
//!   - [`modules`] : commandes des modules, dispatch et `status`

use anyhow::Result;

mod auth;
mod cli;
mod db;
mod display;
mod modules;
mod marketplace;
mod pgconn;
mod rekey;
mod reset;

use cli::external_args;
use display::{fail, header};

/// Administration commands act on the system instance only when they may read
/// its configuration: run as root / Administrator (`sudo kubuno …`), as the
/// service account, or with the configuration named (`KV_CONFIG_FILE`, or
/// `--config` where the command offers it). Otherwise the system file is not
/// read, and this says so before the command runs (paths only, no values).
fn note_skipped_system_config() {
    let explicit = std::env::var("KV_CONFIG_FILE").ok();
    let Ok(plan) = kubuno_core::config::paths::config_plan(explicit.as_deref()) else { return };
    if let Some((files, why)) = &plan.skipped {
        let present: Vec<String> = files.iter().filter(|f| f.exists()).map(|f| f.display().to_string()).collect();
        if !present.is_empty() && !matches!(why, kubuno_paths::SystemConfigSkip::Explicit) {
            display::warn(&format!("Configuration système non lue ({}) : {why}", present.join(", ")));
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Charger .env si présent (développement / Docker) — optionnel
    let _ = dotenvy::dotenv();

    let matches = cli::cli().get_matches();
    // Machine-readable publisher tooling must not print the admin banner or
    // read instance configuration before emitting JSON.
    if let Some(("marketplace:metadata", sub)) = matches.subcommand() {
        return marketplace::export(sub).await;
    }

    header();
    note_skipped_system_config();

    let result = match matches.subcommand() {
        Some(("db:backup",        sub)) => db::cmd_db_backup(sub).await,
        Some(("db:restore",       sub)) => db::cmd_db_restore(sub).await,
        Some(("db:reset",         sub)) => db::cmd_db_reset(sub).await,
        Some(("db:migrate",       _))   => db::cmd_db_migrate().await,
        Some(("db:status",        _))   => db::cmd_db_status().await,
        Some(("app:reset",        sub)) => reset::cmd_app_reset(sub).await,
        Some(("auth:recover",     sub)) => auth::cmd_auth_recover(sub).await,
        Some(("security:rekey",   sub)) => {
            rekey::cmd_security_rekey(
                sub.get_flag("force"),
                sub.get_flag("check"),
                sub.get_one::<String>("config").map(String::as_str),
            )
            .await
        }
        Some(("status",           _))   => modules::cmd_status().await,
        Some(("modules:commands", _))   => modules::cmd_modules_commands().await,
        Some(("modules:install",  sub)) => modules::cmd_modules_install(sub).await,
        Some(("modules:list",     _))   => modules::cmd_modules_list().await,
        // Réinitialisation d'un module : kubuno <module>:reset [--force] [--keep-files]
        // Intercepté avant le dispatch externe pour être géré par le core.
        Some((ext_cmd, sub)) if ext_cmd.ends_with(":reset") => {
            let module_id  = ext_cmd.trim_end_matches(":reset");
            let extra      = external_args(sub);
            let force      = extra.iter().any(|a| a == "--force");
            let keep_files = extra.iter().any(|a| a == "--keep-files");
            reset::cmd_module_reset(module_id, force, keep_files).await
        }
        // Dispatch dynamique : kubuno <module>:<cmd> [args] → kubuno-<module> <module>:<cmd> [args]
        Some((ext_cmd, sub)) if ext_cmd.contains(':') => {
            modules::cmd_module_dispatch(ext_cmd, &external_args(sub)).await
        }
        _ => unreachable!(),
    };

    if let Err(e) = result {
        fail(&format!("{e:#}"));
        std::process::exit(1);
    }

    Ok(())
}
