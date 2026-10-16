//! First-run installation, the way WordPress and Nextcloud do it.
//!
//! A freshly installed package has no database and only the placeholder secrets
//! the example configuration ships - the exact state `Settings::load()` refuses
//! to start on. Rather than leaving the administrator to edit
//! `/etc/kubuno/config.toml` by hand and create the schema themselves, the
//! process notices it is not installed yet and serves an installation wizard on
//! its normal port: it collects the database connection and the first
//! administrator, writes the configuration, creates the schema, and hands over.
//!
//! The hand-over is in-process: once the installation succeeds the wizard server
//! shuts down gracefully, `main` re-reads the configuration it has just written
//! and boots the real instance on the same port. Nothing has to be restarted, so
//! it behaves the same under systemd, under Docker and in development.

pub mod config_file;
pub(crate) mod handlers;
mod token;

pub use token::SetupToken;

use crate::config::Settings;
use anyhow::{Context, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Minimum length shared by the two secrets (`openssl rand -hex 32` → 64 chars).
const MIN_SECRET_LEN: usize = 32;

/// A value still at what `config.toml.example` ships is not a configured value.
fn is_placeholder(v: &str) -> bool {
    let v = v.trim();
    v.is_empty() || v.starts_with("CHANGEZ_MOI") || v.len() < MIN_SECRET_LEN
}

/// What this instance is missing before it can run. Empty ⇒ installed.
///
/// Deliberately answered from the CONFIGURATION only, never from whether the
/// database currently answers: an installed instance whose database is down is
/// suffering an outage, and offering it the wizard would let whoever reaches the
/// port point it at a database of their own.
pub fn missing(s: &Settings) -> Vec<&'static str> {
    let mut out = Vec::new();

    let db_by_url = s.database.url.as_deref().map(|u| !u.trim().is_empty()).unwrap_or(false);
    let db_by_fields = s.database.user.as_deref().map(|u| !u.trim().is_empty()).unwrap_or(false)
        && s.database.database.as_deref().map(|d| !d.trim().is_empty()).unwrap_or(false);
    // SQLite needs neither a URL nor credentials - only a file, and its directory
    // has a default - so an SQLite engine is configured as soon as it is chosen.
    let is_sqlite = matches!(
        kubuno_db::Backend::parse(&s.database.engine),
        Some(kubuno_db::Backend::Sqlite)
    );
    if !db_by_url && !db_by_fields && !is_sqlite {
        out.push("database");
    }
    if is_placeholder(&s.server.internal_secret) {
        out.push("internal_secret");
    }
    if is_placeholder(&s.auth.jwt_secret) {
        out.push("jwt_secret");
    }
    out
}

/// Does this boot have to run the installation wizard?
///
/// An incomplete configuration is not enough. An instance whose database ALREADY
/// holds an administrator is installed - whatever its configuration file looks
/// like - and offering to install it again would take a working service off the
/// air and invite someone to point it at another database. A placeholder secret
/// on such an instance is a misconfiguration to shout about, not an invitation
/// to start over.
///
/// The database is consulted only in that direction: to REFUSE the wizard, never
/// to offer it. An unreachable database therefore changes nothing.
pub async fn needs_setup(s: &Settings) -> bool {
    let missing = missing(s);
    if missing.is_empty() {
        return false;
    }
    if already_installed(s).await {
        tracing::error!(
            manquant = ?missing,
            "Configuration incomplète sur une instance QUI CONTIENT DÉJÀ DES DONNÉES - \
             l'assistant d'installation n'est pas proposé. Corrigez ces valeurs dans \
             /etc/kubuno/config.toml (générez un secret avec : openssl rand -base64 48)"
        );
        return false;
    }
    true
}

/// Does the configured database already carry a Kubuno instance with an
/// administrator? `false` whenever we cannot tell - the caller only ever uses
/// this to hold the wizard back.
async fn already_installed(s: &Settings) -> bool {
    // Connect with whichever engine is configured. An unreachable database, or a
    // `core.users` table that does not exist yet, both surface here as "cannot
    // tell" - the count query errors and we fall back to `false`, which only
    // ever holds the wizard back.
    let Ok(pool) = kubuno_db::connect(&s.database, crate::database::SCHEMA).await else {
        return false;
    };
    let sql = format!(
        "SELECT {} FROM core.users WHERE role = 'admin'",
        pool.backend().count_bigint("*")
    );
    let admins: i64 = pool.fetch_scalar(&sql, kubuno_db::params![]).await.unwrap_or(0);
    admins > 0
}

/// Serves the installation wizard until it succeeds.
///
/// Returns `true` when the instance was installed (the caller should carry on
/// and boot normally), `false` when the operator stopped the process instead.
pub async fn run_wizard(settings: &Settings) -> Result<bool> {
    let token = SetupToken::create_or_load().context("Préparation du jeton d'installation")?;
    token.announce();

    // Level-triggered on purpose: a `Notify` only wakes waiters already
    // registered, and the installation can finish before they are.
    let (done_tx, done_rx) = tokio::sync::watch::channel(false);
    let installed = Arc::new(AtomicBool::new(false));

    let state = Arc::new(handlers::SetupState {
        settings: settings.clone(),
        token,
        done: done_tx,
        installed: installed.clone(),
        drafts: std::sync::Mutex::new(std::collections::HashMap::new()),
    });

    let app = handlers::router(state);

    // Plain HTTP on purpose: TLS material cannot exist before the instance does,
    // and the wizard is meant to be reached the moment the package is installed.
    let addr = format!("{}:{}", settings.server.host, settings.server.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("Écoute de l'assistant d'installation sur {addr}"))?;
    tracing::warn!("Assistant d'installation disponible sur http://{addr}/setup");

    let serve = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown({
        let mut rx = done_rx.clone();
        async move {
            tokio::select! {
                _ = async { while rx.changed().await.is_ok() { if *rx.borrow() { break } } } =>
                    tracing::info!("Installation terminée - démarrage de l'instance"),
                _ = stop_signal() => tracing::info!("Signal d'arrêt reçu pendant l'installation"),
            }
        }
    });

    // The browser that ran the wizard keeps its connection open, and a graceful
    // shutdown waits for it - the real server would never get the port back. So
    // the wizard is given a moment to flush its last response, then the socket
    // is dropped whatever the browser is still holding.
    let deadline = {
        let mut rx = done_rx;
        async move {
            while rx.changed().await.is_ok() {
                if *rx.borrow() {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    };

    tokio::select! {
        r = serve => r.context("Erreur du serveur d'installation")?,
        _ = deadline => tracing::info!("Port libéré pour l'instance"),
    }

    Ok(installed.load(Ordering::SeqCst))
}

/// Ctrl-C or SIGTERM - the wizard has to answer them like any other server.
async fn stop_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_are_not_configuration() {
        assert!(is_placeholder(""));
        assert!(is_placeholder("   "));
        assert!(is_placeholder("CHANGEZ_MOI"));
        assert!(is_placeholder("CHANGEZ_MOI_AVEC_UNE_CLE_LONGUE_ET_ALEATOIRE"));
        assert!(is_placeholder("court"), "trop court pour un secret");
        assert!(!is_placeholder(&"a".repeat(64)));
    }
}
