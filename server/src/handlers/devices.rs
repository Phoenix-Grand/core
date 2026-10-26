//! `/me/devices` - what a person sees about their own machines.
//!
//! ## Strict symmetry
//!
//! This screen shows **exactly** what an administrator sees of the same
//! devices: the same rows, from the same queries in [`crate::devices::store`],
//! with the same fields. Not a summary, not a friendlier subset. On a
//! self-hosted platform that symmetry is the whole trust contract - the reason
//! to run your own instance is that nobody holds a view of you that you cannot
//! hold of yourself.
//!
//! The only asymmetry is in the *verbs*, and it runs the other way: a user can
//! do something to their own devices that no operator can do on their behalf -
//! say "this was not me".
//!
//! ## "Ce n'est pas moi"
//!
//! One button, three consequences, all of them immediate:
//!
//! 1. every session of the account is revoked, including the one pressing the
//!    button - a half-measure that spares the current session is exactly the
//!    hole an attacker sitting in it would use;
//! 2. the next sign-in must set a new password (`must_change_password`);
//! 3. an alert is raised for the operator ([`crate::alerts`]), because the
//!    person who noticed has now done everything they can and the rest is not
//!    theirs to do.

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap},
    Json,
};
use kubuno_db::params;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::alerts::{self, catalog, model::NewAlert, model::Severity};
use crate::audit::{login_context, redact::target, AuditEntry};
use crate::auth::{client_ip::ClientIp, middleware::AuthUser};
use crate::devices::{
    correlate,
    declared::{self, DeclareDto},
    model::event_kind,
    store,
};
use crate::errors::AppError;
use crate::state::AppState;

/// The device the caller is holding right now, resolved from the correlation
/// cookie. `None` when the browser has none yet (a session that predates the
/// inventory), and the screen then simply marks nothing - which is honest.
async fn current_device(state: &AppState, headers: &HeaderMap, user_id: Uuid) -> Option<Uuid> {
    let cookies = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    let header_key = headers
        .get(correlate::DEVICE_HEADER)
        .and_then(|v| v.to_str().ok());

    let lookup = |hash: String| async move {
        state
            .db
            .fetch_optional_scalar::<Uuid>(
                "SELECT id FROM core.devices WHERE user_id = $1 AND correlation_hash = $2",
                params![user_id, hash],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "devices: résolution de l'appareil courant");
                e
            })
            .ok()
            .flatten()
    };

    // Strong path: the opaque cookie or a native client's key.
    // `accepts_cookie = false` - this is a read, nothing may be minted here.
    if cookies.is_some() || header_key.is_some() {
        let key = correlate::resolve(
            header_key,
            cookies,
            user_id,
            "web",
            &crate::devices::Normalised::default(),
            false,
        );
        if key.kind == "key" {
            if let Some(found) = lookup(key.hash()).await {
                return Some(found);
            }
        }
    }

    // Fallback: the fingerprint. It is what attached the sessions that predate
    // this feature, so without it a browser signed in before the inventory
    // shipped would never see "this device" marked - and the marker is the
    // whole point of the screen. Weaker, and never used to *write* anything.
    let raw_ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if raw_ua.is_empty() {
        return None;
    }
    let normalised = crate::devices::normalise(raw_ua);
    lookup(correlate::fingerprint_key(user_id, "web", &normalised).hash()).await
}

/// `GET /api/v1/me/devices` - my devices, my sessions, grouped.
pub async fn list_my_devices(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    headers: HeaderMap,
) -> Result<Json<Value>, AppError> {
    let devices = store::for_user(&state.db, user.id).await?;
    let sessions = store::sessions_of_user(&state.db, user.id).await?;
    let current = current_device(&state, &headers, user.id).await;

    Ok(Json(json!({
        "devices":  devices.iter().map(crate::devices::DeviceRow::to_json).collect::<Vec<_>>(),
        "sessions": sessions,
        "current_device_id": current,
        // The console needs both to explain what it is showing rather than
        // leaving the reader to infer why a column is empty.
        "declared_signals_enabled": declared::enabled(&state.db).await,
        "country_db_available":     crate::devices::geoip::is_available(),
    })))
}

/// `GET /api/v1/me/devices/:id` - one of my devices, with its timeline.
pub async fn get_my_device(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let device = store::get_owned(&state.db, id, user.id).await?;
    let sessions = store::sessions_of(&state.db, id).await?;
    // The same timeline the operator reads. Symmetry is not a slogan here: it
    // is the same function.
    let events = store::events_of(&state.db, id, 50).await?;
    Ok(Json(json!({
        "device":   device.to_json(),
        "sessions": sessions,
        "events":   events,
    })))
}

#[derive(Debug, Deserialize)]
pub struct RenameDto {
    /// Empty or absent clears the custom name and restores the description
    /// derived from the user agent.
    pub label: Option<String>,
}

/// `PATCH /api/v1/me/devices/:id` - name a device.
pub async fn rename_my_device(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Json(dto): Json<RenameDto>,
) -> Result<Json<Value>, AppError> {
    let label: Option<String> = dto
        .label
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| l.chars().take(120).collect());

    store::rename(&state.db, id, user.id, label.as_deref()).await?;
    correlate::record_event(
        &state.db,
        id,
        event_kind::RENAMED,
        None,
        None,
        Some(user.id),
        None,
        label.as_deref(),
    )
    .await;

    Ok(Json(json!({ "label": label })))
}

/// `POST /api/v1/me/devices/:id/sign-out` - close this device's sessions.
pub async fn sign_out_my_device(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    // Ownership first: `get_owned` is what stops this route from becoming a
    // way to sign out somebody else's laptop by guessing a UUID.
    let _device = store::get_owned(&state.db, id, user.id).await?;

    let mut tx = state.db.begin().await.map_err(|e| {
        tracing::error!(error = %e, "devices: connexion pour la déconnexion");
        AppError::Database(e)
    })?;
    let revoked = store::revoke_sessions(&mut tx, id, "logout").await?;
    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, "devices: commit (déconnexion)");
        AppError::Database(e)
    })?;

    correlate::record_event(
        &state.db,
        id,
        event_kind::SIGNED_OUT,
        None,
        None,
        Some(user.id),
        None,
        Some(&format!("{revoked} session(s)")),
    )
    .await;

    Ok(Json(json!({ "revoked_sessions": revoked })))
}

#[derive(Debug, Deserialize, Default)]
pub struct DisownDto {
    /// Free-text note the user may leave for the operator.
    #[serde(default)]
    pub note: Option<String>,
}

/// `POST /api/v1/me/devices/:id/not-me`
///
/// The strongest thing a user can say about their own account. It is
/// deliberately not a confirmation dialog with a soft outcome: everything is
/// revoked, a password change is forced, and an operator is told.
pub async fn disown_my_device(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    client_ip: ClientIp,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    body: Option<Json<DisownDto>>,
) -> Result<Json<Value>, AppError> {
    let device = store::get_owned(&state.db, id, user.id).await?;
    let note = body
        .and_then(|Json(dto)| dto.note)
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(500).collect::<String>());

    // Same fallback as the console: the user's own name if they gave one, else
    // the observed description. A trail entry saying "Windows" identifies far
    // less than one saying "Edge sur Windows".
    let label = device.label.clone().unwrap_or_else(|| {
        let described = format!(
            "{} {}",
            device.browser.as_deref().unwrap_or(""),
            device.platform.as_deref().unwrap_or("")
        );
        let trimmed = described.trim().to_string();
        if trimmed.is_empty() {
            "Appareil".to_string()
        } else {
            trimmed
        }
    });

    // One transaction: revoking every session while leaving the password change
    // unforced (or the reverse) is a half-secured account, which is the state
    // this button exists to make impossible.
    let mut tx = state.db.begin().await.map_err(|e| {
        tracing::error!(error = %e, "devices: ouverture de transaction (désaveu)");
        AppError::Database(e)
    })?;

    let now = chrono::Utc::now();
    let revoked = tx
        .execute(
            "UPDATE core.refresh_tokens
                SET revoked_at = $1, revoke_reason = 'disowned'
              WHERE user_id = $2 AND revoked_at IS NULL",
            params![now, user.id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user.id, "devices: révocation globale (désaveu)");
            AppError::Database(e)
        })?;

    tx.execute(
        "UPDATE core.users SET must_change_password = TRUE WHERE id = $1",
        params![user.id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, user_id = %user.id, "devices: forçage du changement de mot de passe");
        AppError::Database(e)
    })?;

    // The device is blocked too: it revoked its own sessions above, and a
    // blocked device cannot open a new one until an operator clears it.
    tx.execute(
        "UPDATE core.devices
            SET approval = 'blocked', approval_by = $1, approval_at = $2,
                approval_reason = COALESCE($3, 'Désavoué par l''utilisateur')
          WHERE id = $4",
        params![user.id, now, note.as_deref(), id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, device_id = %id, "devices: blocage à la suite d'un désaveu");
        AppError::Database(e)
    })?;

    correlate::record_event_tx(
        &mut tx,
        id,
        event_kind::DISOWNED,
        Some(user.id),
        None,
        note.as_deref(),
    )
    .await?;

    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, "devices: commit (désaveu)");
        AppError::Database(e)
    })?;

    // A step-up proof must not survive an account the holder just disowned.
    crate::auth::reauth::store::revoke_all(&state.db, user.id).await;

    // The trail records it as the user's own act, from their own address.
    let ctx = login_context(&headers, client_ip, &user);
    ctx.record(
        &state.db,
        AuditEntry::new("core.devices.disowned")
            .module("core")
            .target(target::DEVICE, id, label.clone())
            .after(json!({ "revoked_sessions": revoked, "approval": "blocked" }))
            .detail(
                note.clone()
                    .unwrap_or_else(|| "Appareil désavoué par l'utilisateur".into()),
            ),
    )
    .await;

    // And the operator is told. This is the only alert kind a user can raise,
    // and the strongest signal the product has: somebody read their own session
    // list and did not recognise what they saw.
    let alert = NewAlert::new(
        catalog::DEVICE_DISOWNED,
        catalog::SRC_AUDIT,
        Severity::Critical,
        format!("Appareil désavoué par {}", user.username),
    )
    .summary(format!(
        "« {label} » a été désavoué. {revoked} session(s) révoquée(s), changement de mot de passe imposé."
    ))
    .payload(json!({
        "user_id":   user.id,
        "device_id": id,
        "revoked_sessions": revoked,
        "note": note,
    }))
    .subject(user.id)
    .dedup(id);

    if let Err(e) = alerts::raise(&state.db, alert).await {
        // A failure here must not undo what the user just secured.
        tracing::error!(error = %e, user_id = %user.id, "devices: alerte de désaveu non levée");
    }

    tracing::warn!(user_id = %user.id, revoked, "Appareil désavoué : toutes les sessions révoquées");

    Ok(Json(json!({
        "revoked_sessions": revoked,
        "password_change_required": true,
    })))
}

/// `POST /api/v1/me/devices/declare` - a native application states what it
/// knows about itself.
///
/// Refused with a 403 that says why when the operator has not switched
/// declarations on. The values it writes are shown as "declared by the device"
/// everywhere they appear, and never as verified - see
/// [`crate::devices::declared`].
pub async fn declare(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    headers: HeaderMap,
    Json(dto): Json<DeclareDto>,
) -> Result<Json<Value>, AppError> {
    if !declared::enabled(&state.db).await {
        return Err(AppError::Forbidden);
    }

    // A client declares about *itself*: the device is resolved from the request,
    // never taken from the body. Accepting an identifier would let one
    // application state that another machine is encrypted.
    let device_id = current_device(&state, &headers, user.id)
        .await
        .ok_or_else(|| {
            AppError::Validation(
                "Unidentified device: the app must send its device key".into(),
            )
        })?;

    declared::apply(&state.db, device_id, user.id, &dto).await?;

    let device = store::get_owned(&state.db, device_id, user.id).await?;
    Ok(Json(json!({ "device": device.to_json() })))
}
