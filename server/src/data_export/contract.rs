//! **The module export contract, v1** - how the core asks a module for one
//! account's data.
//!
//! This file is the specification. A module implementing it needs nothing from
//! this crate: two HTTP routes and a ZIP writer.
//!
//! ═════════════════════════════════════════════════════════════════════════════
//!
//! # Why a contract exists at all
//!
//! The core owns the PostgreSQL schema `core` and **may never read another
//! schema** - that rule is absolute in this product and it is what makes a
//! module independently installable, upgradable and removable. An export,
//! however, is worth having precisely because it reaches the modules: an archive
//! that carries an account's profile and none of its mail, files or calendar is
//! a database extract, not a portability answer.
//!
//! Those two facts leave exactly one shape: the core cannot READ a module's
//! data, so it must ASK the module for it. The module stays the only thing that
//! understands its own schema, its own file layout and its own idea of what a
//! meaningful export format is (a mail module answers with `.eml`, a contacts
//! module with vCards, a drive with the files themselves) - and the core stays
//! the only thing that knows about accounts, archives, holds and expiry.
//!
//! # Discovery is dynamic, always
//!
//! The core never contains a list of modules that can export. It asks every
//! module that is currently registered, and a module that does not answer
//! [`DESCRIBE_PATH`] simply does not take part. Adding the contract to a module
//! is therefore the *only* thing needed for it to appear in the console's
//! service picker - no core release, no entry in a table, nothing to keep in
//! step. Removing it is equally silent.
//!
//! # The two routes
//!
//! ## 1. `GET /internal/export/describe`
//!
//! *"What can you export, and under what names?"* Answered without touching any
//! account's data, so it is cheap enough to call on every page load.
//!
//! ```json
//! {
//!   "contract": 1,
//!   "services": [
//!     { "id": "contacts", "label": "Contacts", "format": "vCard 4.0 (.vcf) + avatars",
//!       "description": "Les fiches du carnet d'adresses et leurs photos." }
//!   ]
//! }
//! ```
//!
//! * `contract` - the version of THIS document the module implements. The core
//!   refuses anything it does not know rather than guessing, because a guess
//!   here produces a silently incomplete archive.
//! * `services` - usually one entry whose `id` is the module id. A module that
//!   holds genuinely separate bodies of data may declare several; every id must
//!   be stable, lowercase, and match `[a-z0-9_-]{1,40}`, because it becomes a
//!   **directory name inside the archive** and is stored in the run history.
//! * `label` / `format` / `description` are shown to the operator choosing what
//!   to include. They are the module's words, in French, and the core never
//!   translates or rewrites them.
//!
//! ## 2. `POST /internal/export/account`
//!
//! *"Give me everything you hold about this person."*
//!
//! Request body:
//!
//! ```json
//! { "contract": 1,
//!   "user_id":  "9e6f…",
//!   "export_id":"3f2a…",
//!   "services": ["contacts"] }
//! ```
//!
//! * `user_id` - the account, as the core knows it. A module addresses its own
//!   rows by that same id (it is the `x-kubuno-user-id` it receives on every
//!   ordinary request), so no mapping table is needed anywhere.
//! * `export_id` - the run this belongs to. Carried for one purpose: it lets the
//!   module log, rate-limit and de-duplicate on something stable, and it is what
//!   a module's own audit trail should record. Never a secret.
//! * `services` - the subset of what the module declared that the operator kept.
//!   A module that declares one service can ignore the field.
//!
//! Responses:
//!
//! | Status | Meaning | What the core does |
//! |---|---|---|
//! | `200` + `application/zip` | Here is the data | Merges the entries into the account's folder |
//! | `204` | This account has nothing here | Writes no folder at all |
//! | `4xx` / `5xx` / timeout | Could not answer | Records the failure in the manifest, **continues** |
//!
//! `204` and a failure are deliberately different. "This person has no
//! calendar" and "the calendar module was down" look identical in an archive
//! unless somebody insists they do not, and the person receiving the archive is
//! the one who pays for the confusion.
//!
//! ## The ZIP a module returns
//!
//! Entry paths are **relative and service-prefixed**: `contacts/carnet.vcf`,
//! `contacts/avatars/9e6f….webp`. The core re-writes every entry under
//! `comptes/<account>/`, so the module never knows - and must never assume -
//! where its folder lands.
//!
//! Refused by the core, entry by entry, and reported in the manifest rather than
//! trusted: absolute paths, any `..` component, a path escaping the module's own
//! service prefix, and any single file over `data_export.max_file_mb`. A module
//! is a separate process that the core does not audit; an archive built from
//! paths it supplied without checking is a directory-traversal primitive with a
//! download button on it. See [`super::archive::safe_entry_path`].
//!
//! # Authentication
//!
//! Both routes are `/internal/*` and carry `X-Internal-Secret`, exactly like
//! every other core→module call. The core presents
//! [`ServerSettings::module_secret`] - the per-module derived
//! value, never the master secret, or the call breaks the day
//! `derive_module_secrets` is switched on. The module compares it to its own
//! `KUBUNO_INTERNAL_SECRET` and answers `401` otherwise. **A module that skips
//! that check has published every account's data to its network.**
//!
//! # What a module must never put in the archive
//!
//! Passwords and their hashes, any token or its hash, TOTP secrets, API keys,
//! OAuth client secrets, share tokens that still grant access, encryption keys.
//! An export leaves the instance on a laptop; a credential that reaches it has
//! left for good. The core cannot enforce this - it is the one clause of this
//! contract that rests entirely on the module.
//!
//! # Reference implementation
//!
//! `contacts` (`/internal/export/*`, vCard 4.0 + avatars) - the smallest
//! complete example, and the one to copy.

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::StreamExt;
use kubuno_db::{params, DbPool};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::config::settings::ServerSettings;

/// Version of this document. Bumped only for a breaking change; a module
/// announcing a version the core does not know is skipped, loudly.
pub const CONTRACT_VERSION: u32 = 1;

/// Where a module answers "what can you export?".
pub const DESCRIBE_PATH: &str = "/internal/export/describe";

/// Where a module answers "everything you hold about this account".
pub const ACCOUNT_PATH: &str = "/internal/export/account";

/// How long the core waits for a module to say what it can export. Short: this
/// runs while an operator is looking at a page, and a module that cannot answer
/// a static question in three seconds is a module that is down.
const DESCRIBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Hard ceiling on one module's answer for one account, whatever the policy
/// says. Not a tuning knob - a bound: without it, a module with a defect writes
/// until the volume the instance runs on is full, and the export that was meant
/// to protect the data takes the service down instead.
const MAX_PAYLOAD_BYTES: u64 = 16 * 1024 * 1024 * 1024;

// ── What a module declares ───────────────────────────────────────────────────

/// One body of data a module offers to export.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceDescriptor {
    /// Stable, lowercase, `[a-z0-9_-]{1,40}`. Becomes a directory name in the
    /// archive and is stored in the run history - renaming one splits a
    /// service's history in two, exactly like renaming an alert kind.
    pub id: String,
    /// The operator's words for it, in French, from the module.
    pub label: String,
    /// What comes out, named as a format a human recognises: "vCard 4.0 (.vcf)",
    /// "un fichier .eml par message". Optional, and worth writing: it is the
    /// difference between choosing a service and gambling on one.
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

impl ServiceDescriptor {
    /// True when `id` is safe to use as a directory name and as a stored key.
    ///
    /// Checked on the way in, once, rather than at every use: a module is a
    /// separate program and this string reaches a filesystem path.
    pub fn has_usable_id(&self) -> bool {
        !self.id.is_empty()
            && self.id.len() <= 40
            && self
                .id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    }
}

/// What one module answered at [`DESCRIBE_PATH`].
#[derive(Debug, Clone, Serialize)]
pub struct ModuleOffer {
    pub module_id: String,
    pub contract: u32,
    pub services: Vec<ServiceDescriptor>,
}

#[derive(Debug, Deserialize)]
struct DescribeResponse {
    #[serde(default)]
    contract: u32,
    #[serde(default)]
    services: Vec<ServiceDescriptor>,
}

// ── Discovery ────────────────────────────────────────────────────────────────

/// Every registered module, with its base URL. Read from SQL rather than from
/// the in-memory registry so a background job - which holds a pool and nothing
/// else - resolves exactly what a request handler would.
async fn live_modules(db: &DbPool) -> Result<Vec<(String, String)>, sqlx::Error> {
    #[derive(sqlx::FromRow)]
    struct ModuleRow {
        module_id: String,
        base_url: String,
    }
    // NOTE: `DISTINCT ON` is PostgreSQL-only. It keeps the newest instance per
    // module (ordered by registered_at DESC); on another engine this would need
    // rewriting as a grouped/windowed query.
    let rows = db
        .fetch_all_as::<ModuleRow>(
            "SELECT DISTINCT ON (i.module_id) i.module_id, i.base_url \
           FROM core.module_instances i \
           JOIN core.modules m ON m.id = i.module_id \
          WHERE m.is_enabled = TRUE AND i.status <> 'stopped' \
          ORDER BY i.module_id, i.registered_at DESC",
            params![],
        )
        .await?;
    Ok(rows.into_iter().map(|r| (r.module_id, r.base_url)).collect())
}

/// Asks every live module what it can export.
///
/// Never fails as a whole: a module that is down, slow, or does not implement
/// the contract is absent from the result and the rest of the list stands. The
/// alternative - one unreachable module blanking the service picker - would make
/// the feature unusable exactly when an instance is already unwell.
pub async fn describe_all(db: &DbPool, server: &ServerSettings) -> Vec<ModuleOffer> {
    let modules = match live_modules(db).await {
        Ok(m) => m,
        Err(e) => {
            tracing::error!(error = %e, "export: résolution des modules actifs impossible");
            return Vec::new();
        }
    };

    let client = match reqwest::Client::builder().timeout(DESCRIBE_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "export: client HTTP inconstructible");
            return Vec::new();
        }
    };

    let mut offers = Vec::new();
    for (module_id, base_url) in modules {
        let url = format!("{}{}", base_url.trim_end_matches('/'), DESCRIBE_PATH);
        let response = client
            .get(&url)
            .header("X-Internal-Secret", server.module_secret(&module_id))
            .send()
            .await;

        let body = match response {
            Ok(r) if r.status().is_success() => r.json::<DescribeResponse>().await,
            // 404 is the normal answer of a module that has not implemented the
            // contract. Logged at debug, never as a problem: most modules will
            // sit here for a long time and a warning per module per page load
            // would train an operator to ignore the log.
            Ok(r) => {
                tracing::debug!(module_id = %module_id, statut = %r.status(),
                    "export: module sans contrat d'export");
                continue;
            }
            Err(e) => {
                tracing::debug!(module_id = %module_id, error = %e,
                    "export: module injoignable pour la découverte");
                continue;
            }
        };

        let body = match body {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(module_id = %module_id, error = %e,
                    "export: réponse de découverte illisible - module ignoré");
                continue;
            }
        };

        if body.contract != CONTRACT_VERSION {
            // Loud, unlike the 404 above: this module MEANT to take part and the
            // core cannot honour it. Silently dropping it would produce an
            // archive missing a service nobody noticed was missing.
            tracing::warn!(module_id = %module_id, annoncé = body.contract,
                attendu = CONTRACT_VERSION,
                "export: version de contrat non prise en charge - module ignoré");
            continue;
        }

        let services: Vec<ServiceDescriptor> = body
            .services
            .into_iter()
            .filter(|s| {
                let ok = s.has_usable_id();
                if !ok {
                    tracing::warn!(module_id = %module_id, service = %s.id,
                        "export: identifiant de service refusé (caractères non autorisés)");
                }
                ok
            })
            .collect();

        if services.is_empty() {
            continue;
        }
        offers.push(ModuleOffer {
            module_id,
            contract: body.contract,
            services,
        });
    }

    offers.sort_by(|a, b| a.module_id.cmp(&b.module_id));
    offers
}

// ── Fetching one account ─────────────────────────────────────────────────────

/// What one call to a module produced.
pub enum ModulePayload {
    /// A ZIP was written at this path. The caller owns it and must delete it.
    Archive(PathBuf),
    /// The module answered `204`: this account holds nothing here.
    Empty,
}

/// Asks one module for one account's data, streaming the answer to `into`.
///
/// Streamed to disk rather than buffered: a drive module's answer for a single
/// account is gigabytes, and an export that only works for small accounts is a
/// demonstration.
///
/// Returns `Err(message)` for anything that is not a clean answer. The message
/// is the operator's only clue and ends up in the archive's manifest, so it names
/// the module and the failing step - never a URL, which carries a port and a
/// host that have no place in a file handed to somebody outside the instance.
#[allow(clippy::too_many_arguments)]
pub async fn fetch_account(
    server: &ServerSettings,
    module_id: &str,
    base_url: &str,
    export_id: Uuid,
    user_id: Uuid,
    services: &[String],
    timeout: Duration,
    into: &Path,
) -> Result<ModulePayload, String> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Client HTTP inconstructible : {e}"))?;

    let url = format!("{}{}", base_url.trim_end_matches('/'), ACCOUNT_PATH);
    let response = client
        .post(&url)
        .header("X-Internal-Secret", server.module_secret(module_id))
        .json(&serde_json::json!({
            "contract":  CONTRACT_VERSION,
            "user_id":   user_id,
            "export_id": export_id,
            "services":  services,
        }))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("Module « {module_id} » : délai d'attente dépassé")
            } else {
                format!("Module « {module_id} » injoignable")
            }
        })?;

    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(ModulePayload::Empty);
    }
    if !response.status().is_success() {
        return Err(format!(
            "Module « {module_id} » a refusé l'export ({})",
            response.status()
        ));
    }

    let mut file = tokio::fs::File::create(into)
        .await
        .map_err(|e| format!("Fichier temporaire d'export impossible : {e}"))?;

    let mut written: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Module « {module_id} » : flux interrompu ({e})"))?;
        written = written.saturating_add(chunk.len() as u64);
        if written > MAX_PAYLOAD_BYTES {
            // Abandoned mid-stream rather than after the fact: the point of the
            // ceiling is to stop writing, not to notice afterwards that the
            // volume is full.
            let _ = tokio::fs::remove_file(into).await;
            return Err(format!(
                "Module « {module_id} » : réponse au-delà de la limite admise"
            ));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Écriture de la réponse du module « {module_id} » : {e}"))?;
    }

    file.flush()
        .await
        .map_err(|e| format!("Écriture de la réponse du module « {module_id} » : {e}"))?;
    drop(file);

    if written == 0 {
        // A 200 with an empty body is a module that meant `204`. Treated as
        // "nothing", not as an empty ZIP the reader would then fail to open.
        let _ = tokio::fs::remove_file(into).await;
        return Ok(ModulePayload::Empty);
    }
    Ok(ModulePayload::Archive(into.to_path_buf()))
}

/// The base URL of one module, or `None` when it is not running.
pub async fn base_url_of(db: &DbPool, module_id: &str) -> Option<String> {
    match db
        .fetch_optional_scalar::<String>(
            "SELECT base_url FROM core.module_instances \
          WHERE module_id = $1 AND status <> 'stopped' \
          ORDER BY registered_at DESC LIMIT 1",
            params![module_id],
        )
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(error = %e, module_id = %module_id,
                "export: résolution de l'adresse du module impossible");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svc(id: &str) -> ServiceDescriptor {
        ServiceDescriptor {
            id: id.to_string(),
            label: "X".into(),
            format: None,
            description: None,
        }
    }

    /// A service id becomes a directory name. Everything that could make it
    /// something else has to be refused here, not discovered in the archive.
    #[test]
    fn service_ids_are_directory_safe() {
        assert!(svc("contacts").has_usable_id());
        assert!(svc("mail-eml").has_usable_id());
        assert!(svc("photos_raw").has_usable_id());

        assert!(!svc("").has_usable_id());
        assert!(!svc("../etc").has_usable_id());
        assert!(!svc("Contacts").has_usable_id(), "majuscules refusées");
        assert!(!svc("a/b").has_usable_id());
        assert!(!svc("a b").has_usable_id());
        assert!(!svc(&"x".repeat(41)).has_usable_id());
    }
}
