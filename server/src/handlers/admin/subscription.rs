//! The console side of "Abonnement et licence".
//!
//! ## What this page is, and what it deliberately is not
//!
//! It is not a billing page. Kubuno is AGPL-3.0-or-later and is **not sold**:
//! there is no seat to count, no plan to upgrade to, no capability to unlock,
//! and no licence server to call. A page modelled on a commercial console would
//! be a page of buttons that lie.
//!
//! What it answers instead is what an operator of a free, self-hosted product
//! actually asks: *under what terms do I hold this software*, *which
//! installation is this exactly*, and *is anybody obliged to help me if it
//! breaks*. The first is a constant, the second already existed in the schema,
//! and only the third needed anything new.
//!
//! ## One route, because the page is one reading
//!
//! Everything the page shows arrives in a single `GET`. Composing it here rather
//! than making the browser call `/admin/stats`, `/admin/modules` and this route
//! in parallel is what keeps the page openable by an operator who holds
//! `core.settings.read` and nothing else: each block is included only when the
//! caller may see it, and the blocks they may not see arrive as `null` rather
//! than as a 403 that would blank the whole page.

use axum::{extract::State, Json};
use kubuno_db::params;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    audit::{redact, AdminAudit, AuditEntry},
    auth::middleware::AdminUser,
    authz::{keys, AdminCtx},
    errors::AppError,
    state::AppState,
    support::{self, store, Trust},
};

/// Account totals for the page's header. `active` is computed with a portable
/// `SUM(CASE ...)` rather than PostgreSQL's `COUNT(*) FILTER (WHERE ...)`.
#[derive(sqlx::FromRow)]
struct AccountCounts {
    total:  i64,
    active: i64,
}

/// One installed module and the licence it declares.
#[derive(sqlx::FromRow)]
struct ModuleLicenceRow {
    id:           String,
    display_name: String,
    version:      String,
    license:      Option<String>,
    homepage_url: Option<String>,
    is_enabled:   bool,
    installed_at: chrono::DateTime<chrono::Utc>,
}

/// Longest key accepted from the form. Well above any plausible contract, and
/// checked before anything is parsed.
const MAX_KEY_LEN: usize = 8192;

/// The contract as the page shows it: the stored claims, plus the two things
/// only the server can say - today's verdict on the signature, and how long is
/// left.
fn contract_json(stored: &store::StoredContract, trust: &Trust) -> Value {
    let now = chrono::Utc::now();
    let expired = stored.expires_at.map(|e| e <= now).unwrap_or(false);
    let days_left = stored
        .expires_at
        .map(|e| (e - now).num_days())
        .filter(|_| !expired);

    json!({
        "subject":       stored.subject,
        "plan":          stored.plan,
        "perimeter":     stored.perimeter,
        "contact":       stored.contact,
        "issued_at":     stored.issued_at,
        "expires_at":    stored.expires_at,
        "registered_at": stored.registered_at,
        "expired":       expired,
        "days_left":     days_left,
        // The verdict recomputed on this read, not the one stored at
        // registration: the day the publisher's signing key ships, contracts
        // registered before it become verified without anybody re-pasting them.
        "verified":      matches!(trust, Trust::Verified { .. }),
        "key_id":        match trust { Trust::Verified { key_id } => Some(key_id.clone()), Trust::Declarative => None },
    })
}

/// The blocks that are always true, whatever the caller may read.
fn licence_json() -> Value {
    json!({
        "spdx":             support::LICENCE_SPDX,
        "text_url":         support::LICENCE_URL,
        "source_url":       support::SOURCE_URL,
        "organisation_url": support::ORGANISATION_URL,
    })
}

/// `GET /admin/subscription`
pub async fn get(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::SETTINGS_READ)?;

    let identity = store::identity(&state.db).await?;
    let instance_name = crate::settings::instance_value(&state.db, "instance.name")
        .await
        .and_then(|v| v.as_str().map(str::to_string));

    // How many accounts this instance carries. Behind `stats.read`, the key that
    // governs every other instance-wide aggregate: a delegated operator who may
    // not see the dashboard's totals must not read them off this page either.
    let accounts = if ctx.has(keys::STATS_READ) {
        // Both aggregates decode as `i64` on every engine; the active count uses
        // a portable `SUM(CASE ...)` in place of `COUNT(*) FILTER (WHERE ...)`.
        let backend = state.db.backend();
        let sql = format!(
            "SELECT {total} AS total, {active} AS active FROM core.users",
            total = backend.count_bigint("*"),
            active = backend.sum_bigint("CASE WHEN is_active THEN 1 ELSE 0 END"),
        );
        let row = state
            .db
            .fetch_one_as::<AccountCounts>(&sql, params![])
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "subscription: comptage des comptes");
                AppError::Database(e)
            })?;
        Some(json!({
            "total":  row.total,
            "active": row.active,
        }))
    } else {
        None
    };

    // The installed modules and the licence each one declares. Read from
    // `core.modules`, which is where the manifest each module ships lands
    // (`modules::manager::sync_to_db`) - never from a list of names in the core.
    let modules = if ctx.has(keys::MODULES_READ) {
        let rows = state
            .db
            .fetch_all_as::<ModuleLicenceRow>(
                "SELECT id, display_name, version, license, homepage_url, is_enabled, installed_at
                   FROM core.modules
                  WHERE is_core_module = FALSE
                  ORDER BY display_name",
                params![],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "subscription: inventaire des modules");
                AppError::Database(e)
            })?;

        let items: Vec<Value> = rows
            .into_iter()
            .map(|row| {
                json!({
                    "id":           row.id,
                    "display_name": row.display_name,
                    "version":      row.version,
                    "license":      row.license,
                    "homepage_url": row.homepage_url,
                    "is_enabled":   row.is_enabled,
                    "installed_at": row.installed_at,
                })
            })
            .collect();
        Some(Value::Array(items))
    } else {
        None
    };

    let stored = store::contract(&state.db).await?;
    let contract = match &stored {
        Some(row) => {
            let trust = store::recheck(&state.db, &identity.instance_id)
                .await?
                .unwrap_or(Trust::Declarative);
            contract_json(row, &trust)
        }
        None => Value::Null,
    };

    Ok(Json(json!({
        "licence": licence_json(),
        "instance": {
            "name":         instance_name,
            "instance_id":  identity.instance_id,
            "installed_at": identity.installed_at,
            "core_version": env!("CARGO_PKG_VERSION"),
        },
        "accounts": accounts,
        "modules":  modules,
        "support": {
            // The community channels, always - they are what an instance without
            // a contract actually has, and they do not stop existing when one is
            // registered.
            "community": {
                "source_url":       support::SOURCE_URL,
                "issues_url":       support::ISSUES_URL,
                "organisation_url": support::ORGANISATION_URL,
            },
            "contract": contract,
            // Whether this build can check a signature at all. The console says
            // so plainly rather than letting an operator believe a declarative
            // contract was verified.
            "verification_available": support::verification_available(),
        },
    })))
}

/// The pasted key.
///
/// Deliberately **not** `Debug`: the field is the bearer proof of a contract,
/// and a derived `Debug` is how one ends up in a log the day somebody adds a
/// `?dto` to a tracing call.
#[derive(Deserialize)]
pub struct RegisterKeyDto {
    /// The key as the publisher issued it. Never echoed back, never logged.
    key: String,
}

/// `POST /admin/subscription/support-key` - register or replace the contract.
pub async fn register_key(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<RegisterKeyDto>,
) -> Result<Json<Value>, AppError> {
    // Writing a support contract is editing instance-wide configuration, so it
    // is governed by the settings key - the same one the menu entry is gated on
    // for reading. It grants nothing: the contract unlocks no feature.
    ctx.require(keys::SETTINGS_MANAGE)?;

    let key_text = dto.key.trim();
    if key_text.is_empty() {
        return Err(AppError::Validation(
            "Collez la clé de support fournie par l'éditeur.".into(),
        ));
    }
    if key_text.len() > MAX_KEY_LEN {
        return Err(AppError::Validation(
            "Cette clé de support est trop longue pour en être une.".into(),
        ));
    }

    let identity = store::identity(&state.db).await?;
    // Validation before any write, and the only place the key is interpreted.
    let key = support::read_key(key_text, &identity.instance_id.to_string())?;

    let previous = store::contract(&state.db).await?;
    let before = previous.as_ref().map(|p| {
        redact::snapshot(
            redact::target::SUPPORT_CONTRACT,
            &json!({
                "subject":    p.subject,
                "plan":       p.plan,
                "perimeter":  p.perimeter,
                "contact":    p.contact,
                "expires_at": p.expires_at,
                "verified":   p.verified_at_registration,
                "key_id":     p.key_id,
            }),
        )
    });

    let after = redact::snapshot(
        redact::target::SUPPORT_CONTRACT,
        &json!({
            "subject":    key.claims.sub.trim(),
            "plan":       key.claims.plan,
            "perimeter":  key.claims.perimeter,
            "contact":    key.claims.contact,
            "expires_at": key.expires_at(),
            "verified":   key.is_verified(),
            "key_id":     key.key_id(),
        }),
    );

    let mut tx = audit.begin(&state.db).await?;
    store::register(&mut tx, key_text, &key, audit.admin.id).await?;

    let mut entry = AuditEntry::new("core.support.register")
        .target_kind(redact::target::SUPPORT_CONTRACT, key.claims.sub.trim().to_string())
        .after(after)
        // Says, in the trail itself, whether the instance could confirm the
        // claims or merely recorded them. Without it an auditor cannot tell a
        // proven contract from a typed one.
        .detail(if key.is_verified() {
            "signature vérifiée"
        } else {
            "signature non vérifiée - informations déclaratives"
        });
    if let Some(before) = before {
        entry = entry.before(before);
    }
    tx.commit(entry).await?;

    let stored = store::contract(&state.db).await?.ok_or_else(|| {
        tracing::error!("subscription: contrat introuvable juste après son enregistrement");
        AppError::NotFound("Contrat de support".into())
    })?;
    Ok(Json(json!({ "contract": contract_json(&stored, &key.trust) })))
}

/// `DELETE /admin/subscription/support-key` - go back to community support.
///
/// Not a destructive operation in any meaningful sense: the instance loses a
/// display, never a capability. The contract itself lives in the operator's
/// agreement with the publisher, not here.
pub async fn remove_key(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::SETTINGS_MANAGE)?;

    let previous = store::contract(&state.db).await?.ok_or_else(|| {
        AppError::NotFound("Aucun contrat de support n'est enregistré".into())
    })?;

    let mut tx = audit.begin(&state.db).await?;
    store::remove(&mut tx).await?;
    tx.commit(
        AuditEntry::new("core.support.remove")
            .target_kind(
                redact::target::SUPPORT_CONTRACT,
                previous.subject.clone(),
            )
            .before(redact::snapshot(
                redact::target::SUPPORT_CONTRACT,
                &json!({
                    "subject":    previous.subject,
                    "plan":       previous.plan,
                    "perimeter":  previous.perimeter,
                    "contact":    previous.contact,
                    "expires_at": previous.expires_at,
                    "verified":   previous.verified_at_registration,
                    "key_id":     previous.key_id,
                }),
            )),
    )
    .await?;

    Ok(Json(json!({ "ok": true })))
}
