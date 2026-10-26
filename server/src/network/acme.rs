//! Automatic certificates over ACME (Let's Encrypt).
//!
//! The ACME protocol (RFC 8555) is handled entirely by the `instant-acme` crate,
//! which terminates over rustls with the ring provider - the same engine the
//! rest of the core uses. Nothing here implements ACME or any cryptography; this
//! module orchestrates an order and hands the resulting certificate to the same
//! storage and hot-reload path an uploaded certificate uses ([`super::cert`],
//! [`super::runtime`]).
//!
//! Validation is HTTP-01: the ACME server fetches
//! `http://<domain>/.well-known/acme-challenge/<token>` from this instance, so
//! each domain must resolve here and be reachable over HTTP (port 80). The
//! response for a pending token lives in the shared [`super::runtime::TlsRuntime`]
//! and is served by a public route.

use instant_acme::{
    Account, AccountCredentials, AuthorizationStatus, ChallengeType, Identifier, NewAccount,
    NewOrder, OrderStatus, RetryPolicy,
};
use kubuno_db::dialect::Assign;
use kubuno_db::{params, DbPool};

use crate::{errors::AppError, state::AppState};

use super::cert::{self, StoredCert};

// ── Setting keys (declared by migration 000127) ──────────────────────────────
pub const KEY_DIRECTORY_URL: &str = "network.acme_directory_url";
pub const KEY_EMAIL: &str = "network.acme_email";
pub const KEY_DOMAINS: &str = "network.acme_domains";
pub const KEY_TOS_AGREED: &str = "network.acme_tos_agreed";

// The ACME account credentials contain the account key - the thing that can mint
// certificates for this instance's domains. They live ON DISK next to the TLS
// key material (`super::store`), not in the database: see that module for why.

/// The ACME configuration, resolved to concrete values.
pub struct AcmeConfig {
    pub directory_url: String,
    pub email: String,
    pub domains: Vec<String>,
    pub tos_agreed: bool,
}

impl AcmeConfig {
    pub async fn load(db: &DbPool) -> Self {
        let s = |v: Option<serde_json::Value>| {
            v.and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
        };
        let directory_url = {
            let v = s(crate::settings::instance_value(db, KEY_DIRECTORY_URL).await);
            if v.is_empty() {
                "https://acme-v02.api.letsencrypt.org/directory".to_string()
            } else {
                v
            }
        };
        AcmeConfig {
            directory_url,
            email: s(crate::settings::instance_value(db, KEY_EMAIL).await),
            domains: parse_domains(&s(crate::settings::instance_value(db, KEY_DOMAINS).await)),
            tos_agreed: crate::settings::instance_value(db, KEY_TOS_AGREED)
                .await
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        }
    }
}

/// Splits the free-text domains setting on commas and whitespace, dropping
/// blanks. `"a.fr, b.fr  c.fr"` → `["a.fr", "b.fr", "c.fr"]`.
fn parse_domains(raw: &str) -> Vec<String> {
    raw.split([',', ' ', '\t', '\n'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// The last recorded outcome of an ACME order, for the console.
#[derive(Debug, Clone, serde::Serialize, Default)]
pub struct AcmeState {
    pub last_order_status: Option<String>,
    pub last_order_detail: Option<String>,
    pub last_attempt_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Reads the recorded state (never the credentials).
pub async fn state(db: &DbPool) -> AcmeState {
    match db
        .fetch_optional_row(
            "SELECT last_order_status, last_order_detail, last_attempt_at FROM core.acme_state WHERE id = TRUE",
            params![],
        )
        .await
    {
        Ok(Some(row)) => AcmeState {
            last_order_status: row.try_get("last_order_status").ok(),
            last_order_detail: row.try_get("last_order_detail").ok(),
            last_attempt_at: row.try_get("last_attempt_at").ok(),
        },
        _ => AcmeState::default(),
    }
}

fn stored_credentials(paths: &super::store::Paths) -> Option<AccountCredentials> {
    let raw = super::store::read_acme_account(paths)?;
    serde_json::from_str::<AccountCredentials>(&raw)
        .map_err(|e| tracing::error!(error = %e, "acme : identifiants de compte illisibles"))
        .ok()
}

async fn store_credentials(
    db: &DbPool,
    paths: &super::store::Paths,
    directory_url: &str,
    email: &str,
    creds: &AccountCredentials,
) -> Result<(), AppError> {
    let json = serde_json::to_string(creds).map_err(|e| {
        AppError::Internal(anyhow::anyhow!("sérialisation des identifiants ACME : {e}"))
    })?;
    // The account key goes to disk, mode 0600; the database only records which
    // directory and contact the account was created against, for the console.
    super::store::write_acme_account(paths, &json)?;
    // The timestamp is bound from Rust rather than `NOW()`, and the single-row
    // upsert is spelled per engine by the dialect layer.
    let now = chrono::Utc::now();
    let sql = format!(
        "INSERT INTO core.acme_state (id, directory_url, email, updated_at) \
         VALUES (TRUE, $1, $2, $3){}",
        db.backend().upsert(
            "core.acme_state",
            &["id"],
            &[
                Assign::Incoming("directory_url"),
                Assign::Incoming("email"),
                Assign::Incoming("updated_at"),
            ],
        )
    );
    db.execute(&sql, params![directory_url, email, now])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "acme: recording the account");
            AppError::Database(e)
        })?;
    Ok(())
}

async fn record_outcome(db: &DbPool, status: &str, detail: Option<&str>) {
    // Both `last_attempt_at` and `updated_at` take the same instant, bound
    // twice (each placeholder is distinct); no `NOW()` in the SQL.
    let now = chrono::Utc::now();
    let sql = format!(
        "INSERT INTO core.acme_state (id, last_order_status, last_order_detail, last_attempt_at, updated_at) \
         VALUES (TRUE, $1, $2, $3, $4){}",
        db.backend().upsert(
            "core.acme_state",
            &["id"],
            &[
                Assign::Incoming("last_order_status"),
                Assign::Incoming("last_order_detail"),
                Assign::Incoming("last_attempt_at"),
                Assign::Incoming("updated_at"),
            ],
        )
    );
    let _ = db
        .execute(&sql, params![status, detail, now, now])
        .await
        .map_err(|e| tracing::error!(error = %e, "acme: recording the order outcome"));
}

fn acme_err(context: &str, e: impl std::fmt::Display) -> AppError {
    AppError::Internal(anyhow::anyhow!("ACME - {context} : {e}"))
}

/// One issuance at a time, process-wide.
///
/// Certificate authorities enforce strict quotas (Let's Encrypt: a handful of
/// failures per hour, a few certificates per domain per week), so overlapping
/// orders are not merely wasteful - a double click, or the renewal worker firing
/// while an operator presses the button, can burn the allowance and lock the
/// instance out of renewals for days. Refusing the second caller costs nothing:
/// the first is already doing the work.
static ISSUING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Releases the issuance flag however the order ends - error or early return
/// included. A flag left set would disable renewal for the life of the process.
struct IssuingGuard;

impl Drop for IssuingGuard {
    fn drop(&mut self) {
        ISSUING.store(false, std::sync::atomic::Ordering::Release);
    }
}

/// Obtains (or renews) a certificate over ACME and installs it as the active
/// one, hot-reloading the live listener. Records the outcome for the console.
///
/// Shared by the admin "obtain now" action and the renewal worker; only one runs
/// at a time (see [`ISSUING`]).
pub async fn issue(state: &AppState) -> Result<StoredCert, AppError> {
    use std::sync::atomic::Ordering;
    if ISSUING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(AppError::Conflict(
            "A certificate request is already in progress".into(),
        ));
    }
    let _guard = IssuingGuard;

    record_outcome(&state.db, "pending", None).await;
    match issue_inner(state).await {
        Ok(stored) => {
            let detail = format!(
                "Certificat obtenu pour {}",
                stored.san.join(", ")
            );
            record_outcome(&state.db, "ok", Some(&detail)).await;
            Ok(stored)
        }
        Err(e) => {
            record_outcome(&state.db, "error", Some(&e.to_string())).await;
            Err(e)
        }
    }
}

async fn issue_inner(state: &AppState) -> Result<StoredCert, AppError> {
    let cfg = AcmeConfig::load(&state.db).await;
    let paths = super::store::Paths::from_settings(&state.settings.server.tls);

    if !cfg.tos_agreed {
        return Err(AppError::Validation(
            "Accept the ACME authority's terms of service before requesting a certificate".into(),
        ));
    }
    if cfg.email.trim().is_empty() {
        return Err(AppError::Validation(
            "Enter an ACME contact address".into(),
        ));
    }
    if cfg.domains.is_empty() {
        return Err(AppError::Validation(
            "Enter at least one domain to certify".into(),
        ));
    }
    // Checked again at the point of use, not only where it is written: this
    // value may predate the validation (an instance upgraded from an earlier
    // build), and it is about to become an outbound request from this server.
    super::config::validate_acme_directory_url(&cfg.directory_url)?;

    // Account: reuse the stored one, or create it and remember the credentials.
    let account = match stored_credentials(&paths) {
        Some(creds) => Account::builder()
            .map_err(|e| acme_err("client", e))?
            .from_credentials(creds)
            .await
            .map_err(|e| acme_err("compte", e))?,
        None => {
            let contact = format!("mailto:{}", cfg.email.trim());
            let contacts = [contact.as_str()];
            let (account, credentials) = Account::builder()
                .map_err(|e| acme_err("client", e))?
                .create(
                    &NewAccount {
                        contact: &contacts,
                        terms_of_service_agreed: true,
                        only_return_existing: false,
                    },
                    cfg.directory_url.clone(),
                    None,
                )
                .await
                .map_err(|e| acme_err("Account creation", e))?;
            store_credentials(&state.db, &paths, &cfg.directory_url, &cfg.email, &credentials)
                .await?;
            account
        }
    };

    let identifiers: Vec<Identifier> =
        cfg.domains.iter().map(|d| Identifier::Dns(d.clone())).collect();
    let mut order = account
        .new_order(&NewOrder::new(&identifiers))
        .await
        .map_err(|e| acme_err("commande", e))?;

    // Publish every HTTP-01 challenge response, then tell the server we are
    // ready. The token is the segment of the key authorization before the dot,
    // which is exactly the path the server fetches.
    let mut tokens: Vec<String> = Vec::new();
    let issue_result = async {
        let mut authorizations = order.authorizations();
        while let Some(result) = authorizations.next().await {
            let mut authz = result.map_err(|e| acme_err("autorisation", e))?;
            match authz.status {
                AuthorizationStatus::Valid => continue,
                AuthorizationStatus::Pending => {}
                other => {
                    return Err(acme_err(
                        "autorisation",
                        format!("Unexpected state: {other:?}"),
                    ));
                }
            }
            let mut challenge = authz.challenge(ChallengeType::Http01).ok_or_else(|| {
                acme_err("challenge", "The authority did not offer an HTTP-01 challenge")
            })?;
            let key_auth = challenge.key_authorization().as_str().to_string();
            let token = key_auth
                .split('.')
                .next()
                .unwrap_or_default()
                .to_string();
            state.tls.set_acme_challenge(token.clone(), key_auth);
            tokens.push(token);
            challenge
                .set_ready()
                .await
                .map_err(|e| acme_err("challenge", e))?;
        }

        let status = order
            .poll_ready(&RetryPolicy::default())
            .await
            .map_err(|e| acme_err("attente de validation", e))?;
        if status != OrderStatus::Ready {
            return Err(acme_err("commande", format!("Unexpected state: {status:?}")));
        }

        let key_pem = order.finalize().await.map_err(|e| acme_err("finalisation", e))?;
        let cert_pem = order
            .poll_certificate(&RetryPolicy::default())
            .await
            .map_err(|e| acme_err("Certificate retrieval", e))?;
        Ok((cert_pem, key_pem))
    }
    .await;

    // Challenge responses are single-use; drop them whatever the outcome.
    for token in &tokens {
        state.tls.clear_acme_challenge(token);
    }
    let (cert_pem, key_pem) = issue_result?;

    // Store as the active certificate (source = acme), atomically, then hot-reload.
    let mut tx = state.db.begin().await.map_err(|e| {
        tracing::error!(error = %e, "acme : ouverture de transaction (certificat)");
        AppError::Database(e)
    })?;
    let stored =
        cert::store_active(&mut tx, &paths, "acme", &cert_pem, &key_pem, None).await?;
    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, "acme : commit du certificat");
        AppError::Database(e)
    })?;

    super::runtime::reload_certificate(state).await;
    tracing::info!(domains = ?cfg.domains, "acme : certificat obtenu et installé");
    Ok(stored)
}

/// How long before expiry a certificate is renewed. 30 days is the Let's Encrypt
/// convention (certificates last 90 days).
const RENEW_BEFORE_DAYS: i64 = 30;

/// Background task: periodically renews the ACME certificate when the instance
/// is in `acme` mode and the active certificate is missing or within
/// [`RENEW_BEFORE_DAYS`] of expiry. Never fails the process - an error is logged
/// and recorded, and the next tick tries again.
pub async fn renewal_worker(state: AppState) {
    // A short delay after boot, then a daily cadence. Not aligned to a wall
    // clock: the exact hour does not matter, only that it runs about once a day.
    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    loop {
        if let Err(e) = maybe_renew(&state).await {
            tracing::warn!(error = %e, "acme : renouvellement automatique échoué (nouvel essai plus tard)");
        }
        tokio::time::sleep(std::time::Duration::from_secs(12 * 3600)).await;
    }
}

async fn maybe_renew(state: &AppState) -> Result<(), AppError> {
    let net = super::NetworkConfig::load(&state.db).await;
    if net.cert_mode != "acme" {
        return Ok(());
    }
    let due = match cert::active(&state.db).await? {
        // No certificate yet, or the active one was uploaded manually: obtain one.
        None => true,
        Some(c) if c.source != "acme" => true,
        Some(c) => match c.not_after {
            Some(exp) => (exp - chrono::Utc::now()).num_days() <= RENEW_BEFORE_DAYS,
            None => true,
        },
    };
    if !due {
        return Ok(());
    }
    // Only attempt if a configuration is actually present, to avoid hammering the
    // recorded error state on an instance that merely selected the mode.
    let cfg = AcmeConfig::load(&state.db).await;
    if !cfg.tos_agreed || cfg.email.trim().is_empty() || cfg.domains.is_empty() {
        return Ok(());
    }
    tracing::info!("acme : renouvellement automatique en cours");
    issue(state).await.map(|_| ())
}
