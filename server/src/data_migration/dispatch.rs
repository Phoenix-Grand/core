//! The call from the core to the module that owns the destination.
//!
//! ## Two routes, and why the second one is chunked
//!
//! `POST {module}/internal/migration/probe` opens a session on the source and
//! answers with the folders it holds. It runs when a campaign is being
//! composed, never while it runs.
//!
//! `POST {module}/internal/migration/run` copies for at most `budget_secs` and
//! then stops, whatever is left, handing back an opaque cursor. It is bounded
//! on purpose: a call that ran until a mailbox was finished would be a request
//! held open for hours, unkillable, invisible while it worked, and lost whole
//! on a restart. Bounded chunks make "pause", "resume", "retry" and "the
//! process was killed" the same operation - call again with the cursor you
//! have.
//!
//! ## The credential travels, and is never kept
//!
//! The source password is decrypted here, put in the request body, and dropped.
//! The module holds it for the length of the call and stores nothing. It never
//! appears in a `tracing` field: the structs that carry it derive no `Debug`,
//! and the error paths below log the *module's* message, never the request.
//!
//! ## What an error means
//!
//! A source that refuses a password is not a broken module, so the module
//! answers `200 {"ok": false, "error": …}` and the core files that against the
//! ACCOUNT. A module that is down, unreachable or answering nonsense is a
//! transport failure, and the core files that against the campaign's job, which
//! retries. Collapsing the two would either retry a wrong password for ever or
//! give up on an account because a module restarted.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config::settings::ServerSettings;
use crate::errors::AppError;

/// Probing opens a session and lists folders - a couple of round trips.
const PROBE_TIMEOUT: Duration = Duration::from_secs(45);

/// A chunk's own budget plus room for the copy to finish the batch it is in.
/// Deliberately not tight: the module stops itself, and cutting the connection
/// while it is mid-write is how a chunk becomes work with no cursor to show for
/// it.
const CHUNK_TIMEOUT_MARGIN: Duration = Duration::from_secs(60);

/// How long the module is allowed to copy in one call.
pub const CHUNK_BUDGET_SECS: u64 = 20;

/// Everything needed to open a session on the source, credential included.
///
/// No `Debug`: a derived one is how a password reaches a log through a
/// `tracing` field somebody added later without thinking about it.
#[derive(Serialize)]
pub struct SourceCredentials {
    pub host:     String,
    pub port:     u16,
    pub security: String,
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
struct ProbeRequest<'a> {
    source: &'a SourceCredentials,
}

#[derive(Serialize)]
struct RunRequest<'a> {
    source:          &'a SourceCredentials,
    target_user_id:  Uuid,
    since:           Option<String>,
    exclude_folders: &'a [String],
    budget_secs:     u64,
    cursor:          serde_json::Value,
}

/// One folder of the source, as the module describes it.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SourceFolder {
    /// The name to send back in `exclude_folders`.
    pub name:         String,
    /// The name to show a human (the wire encoding already decoded).
    #[serde(default)]
    pub display_name: String,
    /// What the module recognised it as: inbox, sent, drafts, spam, trash,
    /// archive, custom.
    #[serde(default)]
    pub kind:         String,
    #[serde(default)]
    pub messages:     u32,
}

#[derive(Debug, Deserialize)]
struct ProbeResponse {
    #[serde(default)]
    ok:      bool,
    #[serde(default)]
    folders: Vec<SourceFolder>,
    #[serde(default)]
    error:   Option<String>,
}

/// What one chunk achieved, as the core records it.
#[derive(Debug, Deserialize)]
pub struct ChunkOutcome {
    #[serde(default)]
    pub ok:     bool,
    #[serde(default)]
    pub done:   bool,
    #[serde(default)]
    pub cursor: serde_json::Value,
    /// Items copied **by this chunk**, not in total.
    #[serde(default)]
    pub copied: i32,
    #[serde(default)]
    pub total:  i32,
    #[serde(default)]
    pub error:  Option<String>,
}

fn client(timeout: Duration) -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Client HTTP indisponible : {e}")))
}

/// Asks the module what the source holds.
///
/// `Ok(Err(message))` is a source that refused; `Err(_)` is a module that could
/// not be asked. The console needs the first one on the form and the second one
/// as a page-level failure, which is why they are not the same return.
#[allow(clippy::result_large_err)]
pub async fn probe(
    server: &ServerSettings,
    module_id: &str,
    base_url: &str,
    source: &SourceCredentials,
) -> Result<Result<Vec<SourceFolder>, String>, AppError> {
    let base = base_url.trim_end_matches('/');
    let response = client(PROBE_TIMEOUT)?
        .post(format!("{base}/internal/migration/probe"))
        .header("X-Internal-Secret", server.module_secret(module_id).as_str())
        .json(&ProbeRequest { source })
        .send()
        .await
        .map_err(|e| {
            // `e` never carries the body, so it cannot carry the password.
            tracing::error!(module = %module_id, error = %e, "data_migration: module injoignable (sondage)");
            AppError::Internal(anyhow::anyhow!(
                "Le module « {module_id} » n'a pas répondu : {e}"
            ))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        tracing::error!(module = %module_id, statut = %status, "data_migration: sondage refusé par le module");
        return Err(AppError::Internal(anyhow::anyhow!(
            "Le module « {module_id} » a refusé le sondage (HTTP {status})"
        )));
    }

    let payload: ProbeResponse = response.json().await.map_err(|e| {
        tracing::error!(module = %module_id, error = %e, "data_migration: réponse de sondage illisible");
        AppError::Internal(anyhow::anyhow!(
            "Réponse illisible du module « {module_id} »"
        ))
    })?;

    if payload.ok {
        Ok(Ok(payload.folders))
    } else {
        Ok(Err(payload
            .error
            .unwrap_or_else(|| "Connexion au serveur source impossible.".into())))
    }
}

/// Runs one bounded chunk.
#[allow(clippy::too_many_arguments)] // a chunk is a source, a destination and a range
pub async fn run_chunk(
    server: &ServerSettings,
    module_id: &str,
    base_url: &str,
    source: &SourceCredentials,
    target_user_id: Uuid,
    since: Option<chrono::NaiveDate>,
    exclude_folders: &[String],
    cursor: serde_json::Value,
) -> Result<ChunkOutcome, AppError> {
    let base = base_url.trim_end_matches('/');
    let response = client(Duration::from_secs(CHUNK_BUDGET_SECS) + CHUNK_TIMEOUT_MARGIN)?
        .post(format!("{base}/internal/migration/run"))
        .header("X-Internal-Secret", server.module_secret(module_id).as_str())
        .json(&RunRequest {
            source,
            target_user_id,
            // ISO-8601, the one date format that means the same thing on both
            // sides of a wire.
            since: since.map(|d| d.format("%Y-%m-%d").to_string()),
            exclude_folders,
            budget_secs: CHUNK_BUDGET_SECS,
            cursor,
        })
        .send()
        .await
        .map_err(|e| {
            tracing::error!(module = %module_id, error = %e, "data_migration: module injoignable (lot)");
            AppError::Internal(anyhow::anyhow!(
                "Le module « {module_id} » n'a pas répondu : {e}"
            ))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        tracing::error!(module = %module_id, statut = %status, "data_migration: lot refusé par le module");
        return Err(AppError::Internal(anyhow::anyhow!(
            "Le module « {module_id} » a refusé le lot (HTTP {status})"
        )));
    }

    response.json::<ChunkOutcome>().await.map_err(|e| {
        tracing::error!(module = %module_id, error = %e, "data_migration: réponse de lot illisible");
        AppError::Internal(anyhow::anyhow!(
            "Réponse illisible du module « {module_id} »"
        ))
    })
}
