//! **"Download my data"** - an account exporting its own, from its own
//! settings.
//!
//! ═════════════════════════════════════════════════════════════════════════════
//!
//! # This is the administrative export with one subject
//!
//! Not a new feature: the machinery of [`crate::data_export`] already produces an
//! archive for a *selection of accounts*, and its own preamble says the
//! single-account portability request is "an `accounts` scope of one - the same
//! machinery, deliberately, so the narrow errand can never drift from the wide
//! one". This file is the door to it, opened for the person the data is about.
//!
//! Everything below the door is unchanged: the same job, the same module
//! contract ([`crate::data_export::contract`]), the same redaction rule (a column
//! list in [`crate::data_export::core_data`], not a promise), the same retention
//! pass. A credential cannot reach this archive because it cannot reach *any*
//! archive.
//!
//! # The subject is the caller, and there is no parameter for it
//!
//! No route here accepts an account identifier. The subject is taken from the
//! token, in the handler, and is the only account a request can ever name - so
//! there is no value an attacker can substitute, no identifier to guess, and no
//! authorisation check that could be forgotten because there is no decision to
//! make. `GET /me/export/:id/download` takes an id, but it is the id of a *run*,
//! and it is resolved by [`runs::get_own`], which carries the owner in the
//! `WHERE` clause rather than checking it afterwards.
//!
//! # When the feature is switched off, it does not exist
//!
//! `data_export.self_service` is resolved **for the caller** through the scope
//! chain (instance ?? organisational unit ?? group ?? account), so an
//! administrator can allow it everywhere and refuse it for one unit. Where it is
//! refused, all three routes answer **404**, and the account settings show no
//! section at all - not a disabled one.
//!
//! `403` would have been the technically accurate status and is deliberately not
//! used: it is an admission that the thing exists and is being withheld, which
//! invites the question "why me?" and leaks the shape of the instance's policy
//! to anybody who probes. `404` says the same thing the interface says.
//!
//! # The two limits, and what they are for
//!
//! * **One request at a time per account.** Enforced by a unique index
//!   (`uq_core_data_export_self_active`) as well as by a check here, because two
//!   tabs and a double-click race and only the database arbitrates.
//! * **A download ceiling.** An archive that can be fetched for ever from a URL
//!   is a second copy of the account with none of its access control. The
//!   counter is claimed atomically ([`runs::claim_download`]) so the ceiling
//!   cannot be walked past by two simultaneous requests.
//!
//! What is deliberately **not** applied is the administrative hold
//! (`data_export.hold_hours`, 48 h). That delay exists so that a stolen
//! administrator session cannot walk out with *every* account's data before
//! another administrator notices. Here the archive contains one account's own
//! data - which a stolen session can already read, page by page, in the
//! interface - so the hold would buy almost nothing and would cost the one thing
//! portability is for: getting your data when you ask for it. It remains
//! available as `data_export.self_hold_hours` for an instance that wants it.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, request::Parts, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use uuid::Uuid;

use crate::{
    audit::{context_from, redact::target, AuditEntry},
    auth::middleware::AuthUser,
    data_export::{archive, contract, jobs, policy, runs},
    errors::AppError,
    models::user::User,
    state::AppState,
};

/// How many past requests the page shows. Small on purpose: this is a personal
/// page, and the only entries that matter are the last one and whichever is
/// still downloadable.
const HISTORY: i64 = 10;

/// Largest service list a request may carry. The picker offers a handful; the
/// bound only stops a hand-written body from arriving with a megabyte of them.
const MAX_SERVICES: usize = 100;

/// Longest service id accepted, matching [`contract::ServiceDescriptor`].
const MAX_SERVICE_ID: usize = 40;

// ── The gate ─────────────────────────────────────────────────────────────────

/// Refuses with `404` when this account may not export its own data.
///
/// One function, called first in all three handlers, so "the feature is off"
/// has exactly one meaning and exactly one status. The message is the generic
/// not-found sentence: a refusal that explained itself would defeat the point of
/// choosing `404` in the first place.
async fn gate(state: &AppState, user_id: Uuid) -> Result<(), AppError> {
    if policy::self_service_enabled(&state.db, user_id).await {
        return Ok(());
    }
    Err(AppError::NotFound("Resource not found".into()))
}

/// The denormalised name the archive and the history keep.
fn label_of(user: &User) -> String {
    user.display_name
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| user.username.clone())
}

// ── Reading the page ─────────────────────────────────────────────────────────

/// `GET /api/v1/me/export` - what can be exported, what is under way, what is
/// still downloadable.
pub async fn get_my_export(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Value>, AppError> {
    gate(&state, user.id).await?;

    // A run left `running` by a process that died would otherwise hold this
    // account's single slot for ever - the personal equivalent of the console's
    // stuck "export in progress".
    if let Err(e) = runs::close_stalled(&state.db).await {
        tracing::error!(error = %e, "export: reprise des exécutions interrompues");
    }

    let pol = policy::load_self(&state.db).await;
    let active = runs::active_for_user(&state.db, user.id).await?;
    let history = runs::list_own(&state.db, user.id, HISTORY).await?;
    let now = Utc::now();

    // What the LIVE modules offer, asked now - the same discovery the console
    // uses. A module that is not installed, not running, or has not implemented
    // the contract simply does not appear, and nothing here names one.
    let offers = contract::describe_all(&state.db, &state.settings.server).await;

    let progress = active.as_ref().map(|r| {
        json!({
            "subjects_total": r.subjects_total,
            "subjects_done":  r.subjects_done,
            "percent": if r.subjects_total > 0 {
                (r.subjects_done as f64 / r.subjects_total as f64 * 100.0).round() as i64
            } else { 0 },
        })
    });

    Ok(Json(json!({
        "services": services_payload(&offers),
        "policy": {
            "hold_hours":     pol.hold_hours,
            "retention_days": pol.retention_days,
            "max_downloads":  pol.max_downloads,
            "max_file_mb":    pol.max_file_mb,
        },
        // The archive format, stated rather than offered: one format is produced,
        // and a picker with a single entry would suggest otherwise.
        "format": "zip",
        "active":   active.as_ref().map(|r| run_payload(r, now)),
        "progress": progress,
        "history":  history.iter().map(|r| run_payload(r, now)).collect::<Vec<_>>(),
        "now":      now,
        "covers":     crate::data_export::COVERED,
        "not_covers": crate::data_export::NOT_COVERED,
    })))
}

/// One run, plus the two facts the page needs and must not derive itself:
/// whether it can be fetched *right now*, and how many fetches are left.
///
/// Resolved server-side because both depend on the current time and on a
/// ceiling: a browser with a skewed clock would otherwise offer a button the
/// server refuses, which reads as a defect rather than as a rule.
fn run_payload(run: &runs::ExportRun, now: chrono::DateTime<chrono::Utc>) -> Value {
    let mut value = match serde_json::to_value(run) {
        Ok(Value::Object(map)) => map,
        _ => {
            tracing::error!(export_id = %run.id, "export: sérialisation d'une demande impossible");
            serde_json::Map::new()
        }
    };
    value.insert(
        "downloadable".into(),
        json!(run.is_downloadable(now) && !run.download_exhausted()),
    );
    value.insert("downloads_left".into(), json!(run.downloads_left()));
    Value::Object(value)
}

/// The service picker: the core first, then one entry per module service.
///
/// A module declaring several services is what "refine the sub-categories" means
/// in this product - the contract lets it split its data into separately
/// selectable bodies, and the interface groups them under the module that
/// declared them.
fn services_payload(offers: &[contract::ModuleOffer]) -> Vec<Value> {
    let mut out = vec![json!({
        "id":        jobs::CORE_SERVICE,
        "module_id": "core",
        "label":     "Mon compte",
        "format":    "JSON + CSV",
        "description": "Le profil, les appartenances, les appareils connus et le journal de vos actions.",
        // Never unticked: an archive without it would carry a module's data about
        // a person the archive never names.
        "required":  true,
    })];
    for offer in offers {
        for service in &offer.services {
            out.push(json!({
                "id":          service.id,
                "module_id":   offer.module_id,
                "label":       service.label,
                "format":      service.format,
                "description": service.description,
                "required":    false,
            }));
        }
    }
    out
}

// ── Asking for one ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RequestMyExportDto {
    /// Service ids kept, as the page offered them. `core` is added whether or
    /// not it is listed.
    #[serde(default)]
    pub services: Vec<String>,
    /// Per-file ceiling, in MiB. Absent means "the instance's". A larger value
    /// than the instance's is tightened to it rather than refused: it is a
    /// preference, and refusing a preference for being too generous only
    /// produces a form nobody can submit.
    #[serde(default)]
    pub max_file_mb: Option<i64>,
}

/// `POST /api/v1/me/export` - produce an archive of **my** data.
///
/// Returns the run, not the archive: production takes minutes on a small account
/// and much longer on a large one, and the page follows the progress.
pub async fn request_my_export(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    parts: Parts,
    Json(dto): Json<RequestMyExportDto>,
) -> Result<Json<Value>, AppError> {
    gate(&state, user.id).await?;

    // ── Validation, before anything is read from the database ───────────────
    if dto.services.len() > MAX_SERVICES {
        return Err(AppError::Validation(
            "Too many services requested in a single request".into(),
        ));
    }
    if dto.services.iter().any(|s| s.len() > MAX_SERVICE_ID) {
        return Err(AppError::Validation(
            "Invalid service identifier".into(),
        ));
    }

    let pol = policy::load_self(&state.db).await;
    let destination = policy::validate_destination(&policy::load(&state.db).await.destination)?;

    // One at a time, per account. The unique index refuses the second one
    // whatever happens; this exists so the ordinary case gets a sentence.
    if let Some(run) = runs::active_for_user(&state.db, user.id).await? {
        return Err(AppError::Conflict(format!(
            "A request has been in progress since {}. Wait for it to finish before submitting another.",
            run.requested_at.format("%d/%m/%Y %H:%M UTC")
        )));
    }

    // Services are intersected with what the live modules actually offer: a
    // request naming a service nobody serves would produce an archive whose
    // manifest is a list of absences.
    let offers = contract::describe_all(&state.db, &state.settings.server).await;
    let available: HashSet<&str> = offers
        .iter()
        .flat_map(|o| o.services.iter().map(|s| s.id.as_str()))
        .collect();

    let mut services: Vec<String> = dto
        .services
        .iter()
        .filter(|s| available.contains(s.as_str()))
        .cloned()
        .collect();
    services.sort();
    services.dedup();
    services.insert(0, jobs::CORE_SERVICE.to_string());

    let max_file_mb = pol.resolve_max_file_mb(dto.max_file_mb);
    let (available_at, expires_at) = pol.window_from(Utc::now());
    let label = label_of(&user);

    let mut taken = HashSet::new();
    let folder = archive::folder_for(&user.username, user.id, &mut taken);

    let export_id = runs::create(
        &state.db,
        &runs::NewExport {
            // An `accounts` scope of one - the shape the machinery was built
            // around, so this path can never drift from the administrative one.
            scope: "accounts".into(),
            origin: runs::ORIGIN_SELF,
            services: services.clone(),
            // Never: the instance referentials name every other account, and
            // "my data" is not "the organisation's directory".
            with_instance: false,
            requested_by: user.id,
            actor_label: label.clone(),
            available_at,
            expires_at,
            destination,
            download_limit: Some(pol.max_downloads.clamp(1, i32::MAX as i64) as i32),
            max_file_mb: Some(max_file_mb.clamp(1, i32::MAX as i64) as i32),
            subjects: vec![(user.id, label, folder)],
        },
    )
    .await?;

    // Audited, like the administrative request - and for a reason that survives
    // the difference between them: "an archive of this account was produced on
    // that day" is the fact an investigation starts from, whoever asked for it.
    //
    // No alert, though. `notify::announce` tells every administrator because an
    // administrative export concentrates everybody's data; one person asking for
    // their own is ordinary, and an alert per request would train operators to
    // dismiss the alert that matters.
    context_from(&parts, &user)
        .record(
            &state.db,
            AuditEntry::new("core.data_export.self_request")
                .module("core")
                .target(target::SETTING, export_id, "Export de mes données".to_string())
                .detail(format!(
                    "Export personnel demandé - services : {}, disponible le {}, \
                     expire le {}",
                    services.join(", "),
                    available_at.format("%d/%m/%Y %H:%M UTC"),
                    expires_at.format("%d/%m/%Y %H:%M UTC"),
                )),
        )
        .await;

    // The previous archive of this account goes, now that a new one is on its
    // way. Done AFTER the new run exists, so a refused request never destroys
    // what the person already had.
    //
    // This is what bounds the disk: without it, an account could ask again the
    // moment each archive finished and leave a week's worth of copies of itself
    // on the volume - every one of them a full extract of a mailbox and a drive.
    // One live archive per account, and asking for a new one is how you replace
    // it, which is also how the interface describes the button.
    discard_previous(&state, user.id, export_id).await;

    let job_id = jobs::enqueue_run(&state.db, export_id).await?;

    Ok(Json(json!({
        "message":      "Request saved",
        "export_id":    export_id,
        "job_id":       job_id,
        "services":     services,
        "available_at": available_at,
        "expires_at":   expires_at,
    })))
}

/// Removes the archives this account already had, keeping their history rows.
///
/// Best-effort throughout: a file that could not be unlinked is logged and the
/// retention pass will take it at `expires_at` anyway. Failing the request over
/// it would refuse somebody their data because of a stale file.
async fn discard_previous(state: &AppState, user_id: Uuid, keep: Uuid) {
    let previous = match runs::list_own(&state.db, user_id, HISTORY).await {
        Ok(runs) => runs,
        Err(_) => return, // already logged
    };

    for run in previous
        .iter()
        .filter(|r| r.id != keep && r.status == "ready" && !r.file_deleted)
    {
        if let (Some(destination), Some(file_name)) =
            (run.destination.as_deref(), run.file_name.as_deref())
        {
            // The path is rebuilt from the row and the name is re-validated by
            // `delete_archive`: a `file_name` column is not a capability to
            // unlink arbitrary paths.
            if let Err(e) =
                archive::delete_archive(std::path::Path::new(destination), file_name).await
            {
                tracing::error!(error = %format!("{e:#}"), export_id = %run.id,
                    "export: suppression de l'archive personnelle précédente impossible");
                continue;
            }
        }
        if let Err(e) = runs::mark_file_deleted(&state.db, run.id, false).await {
            tracing::error!(error = %e, export_id = %run.id,
                "export: marquage de suppression impossible");
        }
    }
}

// ── The archive itself ───────────────────────────────────────────────────────

/// `GET /api/v1/me/export/:id/download` - hand over **my** archive.
///
/// The ownership check is the `WHERE` clause of [`runs::get_own`], evaluated on
/// every request rather than once at creation: an archive belongs to one account
/// for its whole life, and the moment that matters is the moment the bytes
/// leave.
pub async fn download_my_export(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    parts: Parts,
    Path(id): Path<Uuid>,
) -> Result<Response, AppError> {
    gate(&state, user.id).await?;

    // Somebody else's export - administrative or personal - is simply not found
    // here. Not "forbidden": from this route's point of view it does not exist.
    let Some(run) = runs::get_own(&state.db, id, user.id).await? else {
        return Err(AppError::NotFound("Archive not found".into()));
    };

    let now = Utc::now();
    if run.status != "ready" {
        return Err(AppError::Conflict("This archive is not ready".into()));
    }
    if run.file_deleted {
        return Err(AppError::NotFound(
            "This archive has been deleted from the server".into(),
        ));
    }
    if now < run.available_at {
        return Err(AppError::Conflict(format!(
            "This archive will be available from {}",
            run.available_at.format("%d/%m/%Y %H:%M UTC")
        )));
    }
    if now >= run.expires_at {
        return Err(AppError::NotFound(
            "This archive has expired. Request a new one.".into(),
        ));
    }
    if run.download_exhausted() {
        return Err(AppError::Conflict(
            "This archive has reached its download limit. Request a new one."
                .into(),
        ));
    }

    let (Some(destination), Some(file_name)) =
        (run.destination.as_deref(), run.file_name.as_deref())
    else {
        return Err(AppError::NotFound("Archive not found on disk".into()));
    };
    // Re-validated even though it came from our own row: this is the one handler
    // here that turns a database string into an open file descriptor.
    if !archive::is_export_file(file_name) {
        tracing::error!(export_id = %id, "export: nom d'archive non reconnu - téléchargement refusé");
        return Err(AppError::NotFound("Archive not found on disk".into()));
    }

    let path = std::path::Path::new(destination).join(file_name);
    // Opened BEFORE the counter is claimed: an archive the disk no longer holds
    // must not cost the person one of their downloads.
    let file = tokio::fs::File::open(&path).await.map_err(|e| {
        tracing::error!(error = %e, export_id = %id, "export: ouverture de l'archive impossible");
        AppError::NotFound("Archive not found on disk".into())
    })?;

    // The ceiling, claimed atomically. `None` means another request took the last
    // one between the check above and here - the exact race a read-then-write
    // would lose.
    let Some(left) = runs::claim_download(&state.db, id, user.id).await? else {
        return Err(AppError::Conflict(
            "This archive has reached its download limit. Request a new one."
                .into(),
        ));
    };

    // Audited BEFORE the bytes leave: a download interrupted halfway still
    // transferred data, and a trail written only on completion would miss it.
    context_from(&parts, &user)
        .record(
            &state.db,
            AuditEntry::new("core.data_export.self_download")
                .module("core")
                .target(target::SETTING, id, "Export de mes données".to_string())
                .detail(format!(
                    "Archive personnelle téléchargée ({} octets, {} téléchargement(s) restant(s))",
                    run.size_bytes.unwrap_or(0),
                    left
                )),
        )
        .await;

    let stream = tokio_util::io::ReaderStream::with_capacity(file, 64 * 1024);
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{file_name}\""),
            ),
            // Never cached anywhere between here and the person's disk.
            (
                header::CACHE_CONTROL,
                "no-store, no-cache, must-revalidate, private".to_string(),
            ),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}
