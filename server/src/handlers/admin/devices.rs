//! `/admin/devices` and `/admin/sessions` - the operator's view of the
//! inventory.
//!
//! ## Privileges
//!
//! Reads are gated on `core.sessions.read`, mutations on
//! `core.sessions.delete`, and both are narrowed to the caller's organisational
//! subtree inside the queries themselves ([`crate::devices::store`]). No new
//! privilege key was minted: `adminNav.ts` already gates the reserved
//! `device-sessions` entry on `core.sessions.read`, and every mutation offered
//! here ends in revoking sessions. A brand-new key would have to be granted to
//! every existing delegated role before the screen worked at all, which is how a
//! security feature ships switched off.
//!
//! ## Every mutation is audited, and rides its own transaction
//!
//! Approve, block, sign out and forget go through [`crate::audit::AuditTx`],
//! which cannot be committed without its entry. "Forget" in particular: it is
//! the action whose meaning is most often misread, so the trail records exactly
//! what it did - remove an inventory row - and the interface says, in words,
//! that nothing was erased on the machine itself.

use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::audit::{redact::target, AdminAudit, AuditEntry};
use crate::auth::middleware::AdminUser;
use crate::authz::{keys, AdminCtx};
use crate::devices::{
    correlate,
    model::{event_kind, Approval},
    store::{self, DeviceQuery, SessionQuery},
};
use crate::errors::AppError;
use crate::state::AppState;

/// Display label of the acting operator, denormalised onto the device timeline
/// so the history stays readable once the account is gone.
fn actor_label(user: &crate::models::user::User) -> String {
    match user.display_name.as_deref() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => user.username.clone(),
    }
}

/// Snapshot of a device for the audit trail, filtered by the whitelist.
fn snapshot(device: &crate::devices::DeviceRow) -> Value {
    crate::audit::redact::snapshot(
        target::DEVICE,
        &json!({
            "id":           device.id,
            "user_id":      device.user_id,
            "label":        device.label,
            "device_type":  device.device_type,
            "client_kind":  device.client_kind,
            "platform":     device.platform,
            "browser":      device.browser,
            "signal_level": device.signal_level,
            "approval":     device.approval,
            "last_ip":      device.last_ip,
            "last_country": device.last_country,
        }),
    )
}

/// Human name of a device, for the trail and the timeline.
fn device_label(device: &crate::devices::DeviceRow) -> String {
    device.label.clone().unwrap_or_else(|| {
        let described = format!(
            "{} {}",
            device.browser.as_deref().unwrap_or(""),
            device.platform.as_deref().unwrap_or("")
        );
        let trimmed = described.trim();
        if trimmed.is_empty() {
            "Appareil".to_string()
        } else {
            trimmed.to_string()
        }
    })
}

// ── Reads ────────────────────────────────────────────────────────────────────

/// `GET /api/v1/admin/devices` - the filterable inventory.
pub async fn list_devices(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Query(query): Query<DeviceQuery>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::SESSIONS_READ)?;
    let (rows, total) = store::list(&state.db, &query, &ctx).await?;
    Ok(Json(json!({
        "devices": rows.iter().map(crate::devices::DeviceRow::to_json).collect::<Vec<_>>(),
        "total":   total,
        // The console explains an empty country column instead of leaving the
        // operator to wonder whether nobody travels or nothing is configured.
        "country_db_available": crate::devices::geoip::is_available(),
    })))
}

/// `GET /api/v1/admin/devices/facets` - the distinct values worth filtering on.
pub async fn device_facets(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::SESSIONS_READ)?;
    let (platforms, countries, types) = store::facets(&state.db, &ctx).await?;
    Ok(Json(json!({
        "platforms": platforms,
        "countries": countries,
        "device_types": types,
    })))
}

/// `GET /api/v1/admin/devices/:id` - one device, its sessions and its timeline.
pub async fn get_device(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::SESSIONS_READ)?;
    let device = store::get(&state.db, id, &ctx).await?;
    let sessions = store::sessions_of(&state.db, id).await?;
    let events = store::events_of(&state.db, id, 50).await?;
    Ok(Json(json!({
        "device":   device.to_json(),
        "sessions": sessions,
        "events":   events,
    })))
}

/// `GET /api/v1/admin/sessions` - every live session of the instance.
///
/// This view simply did not exist: the only way to answer "who is signed in
/// right now" was to open each account in turn, which meant nobody ever asked.
pub async fn list_sessions(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Query(query): Query<SessionQuery>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::SESSIONS_READ)?;
    let (rows, total) = store::all_sessions(&state.db, &query, &ctx).await?;
    Ok(Json(json!({ "sessions": rows, "total": total })))
}

// ── Mutations ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ApprovalDto {
    /// `pending` | `approved` | `blocked`.
    pub approval: String,
    /// Why. Recorded on the trail and on the device timeline - "who blocked
    /// this laptop" is only half the question an operator asks later.
    #[serde(default)]
    pub reason: Option<String>,
}

/// `POST /api/v1/admin/devices/:id/approval`
///
/// `blocked` is the only state with teeth: it revokes the device's live
/// sessions in the same transaction and makes the refresh path refuse it.
/// `approved` and `pending` are statements an operator makes.
pub async fn set_approval(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<ApprovalDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::SESSIONS_DELETE)?;

    let next = Approval::parse(dto.approval.trim())
        .ok_or_else(|| AppError::Validation("Unknown approval state".into()))?;
    let reason = dto
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(|r| r.chars().take(500).collect::<String>());

    // Read through the scoped query first: a device outside the caller's
    // perimeter must read as "not found" before anything is written.
    let device = store::get(&state.db, id, &ctx).await?;
    let label = device_label(&device);
    let operator = actor_label(&audit.admin);
    let before = snapshot(&device);

    let mut tx = audit.begin(&state.db).await?;
    let previous = match store::set_approval(
        &mut tx,
        id,
        next,
        audit.admin.id,
        &operator,
        reason.as_deref(),
    )
    .await
    {
        Ok(previous) => previous,
        Err(e) => {
            return Err(tx
                .abort(
                    &state.db,
                    AuditEntry::new("core.devices.approval")
                        .module("core")
                        .target(target::DEVICE, id, label),
                    e,
                )
                .await)
        }
    };

    // Blocking without closing the live sessions would leave the machine signed
    // in for up to a full refresh cycle, which makes the button a statement
    // rather than a control.
    let revoked = if next == Approval::Blocked {
        match store::revoke_sessions(&mut tx, id, "device_blocked").await {
            Ok(n) => n,
            Err(e) => {
                return Err(tx
                    .abort(
                        &state.db,
                        AuditEntry::new("core.devices.approval")
                            .module("core")
                            .target(target::DEVICE, id, label),
                        e,
                    )
                    .await)
            }
        }
    } else {
        0
    };

    tx.commit(
        AuditEntry::new("core.devices.approval")
            .module("core")
            .target(target::DEVICE, id, label)
            .before(before)
            .after(crate::audit::redact::snapshot(
                target::DEVICE,
                &json!({
                    "id": id,
                    "user_id": device.user_id,
                    "approval": next.as_str(),
                    "approval_reason": reason,
                }),
            ))
            .detail(format!(
                "{} → {}{}",
                previous.as_str(),
                next.as_str(),
                if revoked > 0 {
                    format!(" ({revoked} session(s) fermée(s))")
                } else {
                    String::new()
                }
            )),
    )
    .await?;

    Ok(Json(json!({
        "approval": next.as_str(),
        "previous": previous.as_str(),
        "revoked_sessions": revoked,
    })))
}

/// `POST /api/v1/admin/devices/:id/sign-out` - closes the device's sessions.
///
/// Distinct from blocking on purpose: the device may sign in again. It is the
/// action for "somebody left a session open in a meeting room", not for "this
/// machine is compromised".
pub async fn sign_out_device(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::SESSIONS_DELETE)?;

    let device = store::get(&state.db, id, &ctx).await?;
    let label = device_label(&device);
    let operator = actor_label(&audit.admin);

    let mut tx = audit.begin(&state.db).await?;
    let revoked = match store::revoke_sessions(&mut tx, id, "admin").await {
        Ok(n) => n,
        Err(e) => {
            return Err(tx
                .abort(
                    &state.db,
                    AuditEntry::new("core.devices.sign_out")
                        .module("core")
                        .target(target::DEVICE, id, label),
                    e,
                )
                .await)
        }
    };

    if let Err(e) = correlate::record_event_tx(
        &mut tx,
        id,
        event_kind::SIGNED_OUT,
        Some(audit.admin.id),
        Some(&operator),
        Some(&format!("{revoked} session(s)")),
    )
    .await
    {
        return Err(tx
            .abort(
                &state.db,
                AuditEntry::new("core.devices.sign_out")
                    .module("core")
                    .target(target::DEVICE, id, label),
                e,
            )
            .await);
    }

    tx.commit(
        AuditEntry::new("core.devices.sign_out")
            .module("core")
            .target(target::DEVICE, id, label)
            .after(json!({ "revoked": revoked }))
            .detail(format!("{revoked} session(s) fermée(s)")),
    )
    .await?;

    Ok(Json(json!({ "revoked_sessions": revoked })))
}

/// `DELETE /api/v1/admin/devices/:id` - forgets a device.
///
/// ⚠ Erases **nothing on the machine**. It removes what the server remembered:
/// the inventory row, its timeline, its approval. The device keeps every file it
/// already holds, and it reappears in the inventory the next time it signs in.
/// Sessions survive too (`ON DELETE SET NULL`), which is why the console offers
/// "sign out" separately and states the difference rather than implying it.
pub async fn forget_device(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::SESSIONS_DELETE)?;

    let device = store::get(&state.db, id, &ctx).await?;
    let label = device_label(&device);
    let before = snapshot(&device);

    let mut tx = audit.begin(&state.db).await?;
    if let Err(e) = store::forget(&mut tx, id).await {
        return Err(tx
            .abort(
                &state.db,
                AuditEntry::new("core.devices.forget")
                    .module("core")
                    .target(target::DEVICE, id, label),
                e,
            )
            .await);
    }

    tx.commit(
        AuditEntry::new("core.devices.forget")
            .module("core")
            .target(target::DEVICE, id, label)
            .before(before)
            // Spelled out in the trail, because it is the misreading everybody
            // makes: this deletes an inventory entry, not the device's contents.
            .detail("Entrée d'inventaire supprimée - aucune donnée effacée sur l'appareil"),
    )
    .await?;

    Ok(Json(json!({ "ok": true })))
}
