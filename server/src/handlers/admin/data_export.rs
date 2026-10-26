//! The data-export page: what an export would cover, what has been produced,
//! and the four things an operator can do about it.
//!
//! ## No write path for the policy
//!
//! The seven settings are edited through `PUT /admin/settings/scoped/:key`, like
//! every other setting: one audited writer, one validator, one inheritance
//! chain. A second write path here would be a second place for the audit entry
//! to be forgotten - the same reasoning the backup and storage pages follow.
//!
//! ## The routes, and why each is separate
//!
//! * `GET /admin/data-export` - the page: policy, eligibility, what is running,
//!   history, and the services the live modules currently offer.
//! * `POST /admin/data-export` - request one. Audited, alerted, asynchronous.
//! * `POST /admin/data-export/:id/cancel` - stop one that has not been handed
//!   over. Its own route rather than a `DELETE` with a flag: cancelling a run in
//!   flight and deleting a finished archive are different acts on different
//!   objects, and a single endpoint would put them one parameter apart.
//! * `DELETE /admin/data-export/:id` - delete a produced archive now, before its
//!   retention would.
//! * `GET /admin/data-export/:id/download` - the archive itself.
//!
//! ## Why the download is a route of its own and not a static file
//!
//! Because four conditions have to hold at the moment of the request, and only
//! three of them are visible in the filesystem: the run finished, the **hold has
//! elapsed**, the file has not been deleted, and the retention has not passed.
//! Serving the directory would honour none of them. On top of that, every
//! download is audited and counted - an archive fetched three times from two
//! addresses is a fact somebody must be able to read after an incident.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use kubuno_db::{params, DbQueryBuilder};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use uuid::Uuid;

use crate::{
    audit::{redact::target, AdminAudit},
    auth::middleware::AdminUser,
    authz::{keys, AdminCtx},
    data_export::{archive, contract, notify, policy, runs},
    errors::AppError,
    state::AppState,
};

/// How many past runs the page opens on.
const DEFAULT_HISTORY: i64 = 30;

/// Largest selection of accounts one request may name. Generous for "these three
/// people are leaving", bounded so a hand-written call cannot enumerate a
/// directory into a single request body.
const MAX_SELECTED: usize = 5_000;

// ── Reading the page ─────────────────────────────────────────────────────────

/// `GET /admin/data-export` - everything the page opens on.
pub async fn get_data_export(
    State(state): State<AppState>,
    admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DATA_EXPORT_READ)?;

    // A run left `running` by a process that died would otherwise be reported as
    // "in progress" for ever, and the one-at-a-time guard would refuse every
    // request from then on.
    if let Err(e) = runs::close_stalled(&state.db).await {
        tracing::error!(error = %e, "export: reprise des exécutions interrompues");
    }

    let pol = policy::load(&state.db).await;
    let active = runs::active_admin(&state.db).await?;
    let history = runs::list(&state.db, DEFAULT_HISTORY).await?;
    let now = Utc::now();

    // The account count the console shows next to "toute l'instance", so the
    // operator knows the size of what they are about to produce before they
    // produce it.
    let backend = state.db.backend();
    let accounts: i64 = state
        .db
        .fetch_scalar::<i64>(
            &format!(
                "SELECT {} FROM core.users WHERE is_active = TRUE AND deleted_at IS NULL",
                backend.count_bigint("*"),
            ),
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "export: comptage des comptes impossible");
            AppError::Database(e)
        })?;

    // What the LIVE modules offer, asked now. Never a stored list: a module that
    // has just been uninstalled must stop being offered without a core release.
    let offers = contract::describe_all(&state.db, &state.settings.server).await;

    // Progress of the run in flight, resolved server-side: two readers deriving
    // a percentage from two integers eventually disagree, and the one that
    // disagrees is the one on screen.
    let progress = active.as_ref().map(|r| {
        json!({
            "subjects_total": r.subjects_total,
            "subjects_done":  r.subjects_done,
            "percent": if r.subjects_total > 0 {
                (r.subjects_done as f64 / r.subjects_total as f64 * 100.0).round() as i64
            } else { 0 },
        })
    });

    // Resolved before the payload is composed: `.await` inside a `json!` arm
    // works, and is exactly the kind of thing that stops working the day the
    // macro is edited by somebody reading it quickly.
    let eligibility = eligibility(&state, &admin, &pol).await;

    Ok(Json(json!({
        "policy": {
            "hold_hours":        pol.hold_hours,
            "retention_days":    pol.retention_days,
            "max_file_mb":       pol.max_file_mb,
            "module_timeout_s":  pol.module_timeout_s,
            "require_2fa":       pol.require_2fa,
            "min_admin_age_days": pol.min_admin_age_days,
            "destination":       pol.destination,
        },
        "eligibility": eligibility,
        "active":      active,
        "progress":    progress,
        "history":     history,
        "now":         now,
        "active_accounts": accounts,
        // The core is a service like any other, always first and never
        // unselectable: an archive without it would carry a module's data about
        // a person the archive never names.
        "services": services_payload(&offers),
        "covers":     crate::data_export::COVERED,
        "not_covers": crate::data_export::NOT_COVERED,
        "contract":   contract::CONTRACT_VERSION,
        "can_execute": ctx.has(keys::DATA_EXPORT_EXECUTE),
    })))
}

/// The service picker, core first, then one entry per module service.
fn services_payload(offers: &[contract::ModuleOffer]) -> Vec<Value> {
    let mut out = vec![json!({
        "id":        crate::data_export::jobs::CORE_SERVICE,
        "module_id": "core",
        "label":     "Compte et annuaire",
        "format":    "JSON + CSV",
        "description": "Le profil, les appartenances, les appareils connus et le journal d'audit du compte.",
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

// ── Eligibility ──────────────────────────────────────────────────────────────

/// Why this operator may, or may not, trigger an export right now.
///
/// Computed server-side and served as a list of stable reasons the console
/// translates, rather than as a single boolean: "you cannot" with no sentence
/// after it is how an operator concludes the console is broken, and every one of
/// these refusals has a fix the person can act on.
async fn eligibility(state: &AppState, admin: &AdminUser, pol: &policy::Policy) -> Value {
    let mut blockers: Vec<Value> = Vec::new();

    if pol.require_2fa && !admin.0.totp_enabled {
        blockers.push(json!({ "reason": "second_factor_required" }));
    }

    let age_days = (Utc::now() - admin.0.created_at).num_days();
    if age_days < pol.min_admin_age_days {
        blockers.push(json!({
            "reason":   "account_too_recent",
            "days":     age_days,
            "required": pol.min_admin_age_days,
        }));
    }

    if let Err(e) = policy::validate_destination(&pol.destination) {
        blockers.push(json!({ "reason": "destination_invalid", "detail": e.to_string() }));
    }

    match runs::active_admin(&state.db).await {
        Ok(Some(run)) => blockers.push(json!({ "reason": "export_in_progress", "export_id": run.id })),
        Ok(None) => {}
        Err(_) => { /* already logged; not a blocker an operator can act on */ }
    }

    json!({ "ok": blockers.is_empty(), "blockers": blockers })
}

// ── Requesting one ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RequestExportDto {
    /// `"instance"` or `"accounts"`.
    pub scope: String,
    /// The accounts, when the scope is `accounts`. A single-element list is the
    /// portability request, and is deliberately not a third scope.
    #[serde(default)]
    pub user_ids: Vec<Uuid>,
    /// Service ids kept, as the page offered them. `core` is added whether or not
    /// it is listed.
    #[serde(default)]
    pub services: Vec<String>,
    /// Include the instance-level referentials (directory, settings, audit).
    #[serde(default)]
    pub with_instance: bool,
}

/// `POST /admin/data-export` - produce an archive.
///
/// Returns the run id rather than the archive: production is hours on a real
/// instance, and the hold means the file is not downloadable when the request
/// returns anyway.
pub async fn request_export(
    State(state): State<AppState>,
    admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<RequestExportDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DATA_EXPORT_EXECUTE)?;

    let pol = policy::load(&state.db).await;

    // ── Prerequisites ───────────────────────────────────────────────────────
    // Checked here and not only in the console: the console's copy exists to
    // explain, this one exists to refuse. A control enforced by the surface that
    // displays it is not a control.
    if pol.require_2fa && !admin.0.totp_enabled {
        return Err(AppError::Forbidden);
    }
    if (Utc::now() - admin.0.created_at).num_days() < pol.min_admin_age_days {
        return Err(AppError::Forbidden);
    }
    let destination = policy::validate_destination(&pol.destination)?;

    // ── Validation ──────────────────────────────────────────────────────────
    if dto.scope != "instance" && dto.scope != "accounts" {
        return Err(AppError::Validation(
            "Invalid scope: expected 'instance' or 'accounts'".into(),
        ));
    }
    if dto.scope == "accounts" && dto.user_ids.is_empty() {
        return Err(AppError::Validation(
            "Select at least one account to export".into(),
        ));
    }
    if dto.user_ids.len() > MAX_SELECTED {
        return Err(AppError::Validation(format!(
            "Selection too large: maximum {MAX_SELECTED} accounts per export"
        )));
    }

    // One at a time, instance-wide - and checked before anything is written, so a
    // double-click produces one export and one clear refusal.
    if runs::active_admin(&state.db).await?.is_some() {
        return Err(AppError::Conflict("An export is already in progress".into()));
    }

    // Services are intersected with what the live modules actually offer: a
    // request naming a service nobody serves would produce an archive whose
    // manifest is a list of absences.
    let offers = contract::describe_all(&state.db, &state.settings.server).await;
    let available: HashSet<String> = offers
        .iter()
        .flat_map(|o| o.services.iter().map(|s| s.id.clone()))
        .collect();

    let mut services: Vec<String> = dto
        .services
        .iter()
        .filter(|s| available.contains(*s))
        .cloned()
        .collect();
    services.sort();
    services.dedup();
    // The core is never optional: every other file in the archive refers to the
    // account sheet it writes.
    services.insert(0, crate::data_export::jobs::CORE_SERVICE.to_string());

    // ── The subjects ────────────────────────────────────────────────────────
    let rows: Vec<(Uuid, String, String)> = if dto.scope == "instance" {
        state
            .db
            .fetch_all_as::<(Uuid, String, String)>(
                "SELECT id, username, COALESCE(display_name, username) \
                   FROM core.users WHERE deleted_at IS NULL ORDER BY username",
                params![],
            )
            .await
    } else {
        // `= ANY($1)` has no cross-engine form; the id set becomes a variadic
        // `IN (...)` built by the query builder.
        let mut qb = DbQueryBuilder::new(
            state.db.backend(),
            "SELECT id, username, COALESCE(display_name, username) \
               FROM core.users WHERE deleted_at IS NULL AND id",
        );
        qb.push_in(dto.user_ids.iter().copied());
        qb.push_order_by("username");
        qb.fetch_all_as::<(Uuid, String, String)>(&state.db).await
    }
    .map_err(|e| {
        tracing::error!(error = %e, "export: résolution des comptes impossible");
        AppError::Database(e)
    })?;

    if rows.is_empty() {
        return Err(AppError::Validation(
            "No existing accounts in this selection".into(),
        ));
    }

    let mut taken = HashSet::new();
    let subjects: Vec<(Uuid, String, String)> = rows
        .into_iter()
        .map(|(id, username, label)| {
            let folder = archive::folder_for(&username, id, &mut taken);
            (id, label, folder)
        })
        .collect();

    let (available_at, expires_at) = pol.window_from(Utc::now());
    let actor_label = admin
        .0
        .display_name
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| admin.0.username.clone());

    let export_id = runs::create(
        &state.db,
        &runs::NewExport {
            scope: dto.scope.clone(),
            origin: runs::ORIGIN_ADMIN,
            services: services.clone(),
            with_instance: dto.with_instance,
            requested_by: admin.0.id,
            actor_label: actor_label.clone(),
            available_at,
            expires_at,
            destination,
            // No ceiling: an operator's archive is governed by the audit trail
            // and by the hold, not by a counter - and a legitimate hand-over
            // often means fetching the same file from two machines.
            download_limit: None,
            // The policy's ceiling, read when the job runs. The console offers no
            // per-request value: widening or tightening it is a *policy*
            // decision, made once, in the settings.
            max_file_mb: None,
            subjects: subjects.clone(),
        },
    )
    .await?;

    // ── The trail, the alert, the work - in that order ──────────────────────
    // The audit entry is written FIRST and is the record that cannot be lost:
    // the alert is best-effort by design, and the job may not start for minutes.
    audit
        .record(
            &state.db,
            crate::audit::AuditEntry::new("core.data_export.request")
                .target(target::SETTING, export_id, "Export de données".to_string())
                .detail(format!(
                    "Export demandé - périmètre : {} ({} compte(s)), services : {}, \
                     référentiels d'instance : {}, disponible le {}",
                    dto.scope,
                    subjects.len(),
                    services.join(", "),
                    if dto.with_instance { "oui" } else { "non" },
                    available_at.format("%d/%m/%Y %H:%M UTC"),
                )),
        )
        .await;

    notify::announce(
        &state.db,
        export_id,
        admin.0.id,
        &actor_label,
        &dto.scope,
        subjects.len(),
        available_at,
    )
    .await;

    let job_id = crate::data_export::jobs::enqueue_run(&state.db, export_id).await?;

    Ok(Json(json!({
        "message":      "Export requested",
        "export_id":    export_id,
        "job_id":       job_id,
        "available_at": available_at,
        "expires_at":   expires_at,
        "accounts":     subjects.len(),
    })))
}

// ── Cancelling and deleting ──────────────────────────────────────────────────

/// `POST /admin/data-export/:id/cancel` - stop a run that has not finished.
///
/// This is the far half of the notification: an administrator who did not ask
/// for this export has until `available_at` to press it, and pressing it stops
/// the remaining batches and destroys what has been staged.
pub async fn cancel_export(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DATA_EXPORT_EXECUTE)?;

    let Some(run) = runs::get_admin(&state.db, id).await? else {
        return Err(AppError::NotFound("Export not found".into()));
    };

    let label = audit
        .admin
        .display_name
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| audit.admin.username.clone());

    if !runs::cancel(&state.db, id, &format!("Annulé par {label}")).await? {
        return Err(AppError::Conflict(
            "This export has already finished and can no longer be canceled".into(),
        ));
    }

    // The staging tree goes immediately. The job will notice the status at its
    // next batch and stop, but "the operator cancelled and the half-built archive
    // stayed on the disk for another ten minutes" is not an acceptable answer to
    // somebody who has just decided an export is hostile.
    if let Some(destination) = run.destination.as_deref() {
        archive::discard_staging(std::path::Path::new(destination), id).await;
    }

    audit
        .record(
            &state.db,
            crate::audit::AuditEntry::new("core.data_export.cancel")
                .target(target::SETTING, id, "Export de données".to_string())
                .detail(format!(
                    "Export annulé (demandé par {}, {} compte(s))",
                    run.actor_label.as_deref().unwrap_or("-"),
                    run.subjects_total
                )),
        )
        .await;

    Ok(Json(json!({ "message": "Export canceled" })))
}

/// `DELETE /admin/data-export/:id` - remove a produced archive now.
pub async fn delete_export(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DATA_EXPORT_EXECUTE)?;

    let Some(run) = runs::get_admin(&state.db, id).await? else {
        return Err(AppError::NotFound("Export not found".into()));
    };

    if let (Some(destination), Some(file_name)) = (run.destination.as_deref(), run.file_name.as_deref())
    {
        // The path is rebuilt from the row, and the file name is re-validated by
        // `delete_archive`: a `file_name` column is not a capability to unlink
        // arbitrary paths.
        archive::delete_archive(std::path::Path::new(destination), file_name)
            .await
            .map_err(|e| {
                tracing::error!(error = %format!("{e:#}"), export_id = %id,
                    "export: suppression de l'archive impossible");
                AppError::Internal(anyhow::anyhow!("Suppression de l'archive impossible"))
            })?;
    }
    runs::mark_file_deleted(&state.db, id, false).await?;

    audit
        .record(
            &state.db,
            crate::audit::AuditEntry::new("core.data_export.delete")
                .target(target::SETTING, id, "Export de données".to_string())
                .detail(format!(
                    "Archive supprimée avant expiration ({} compte(s), demandée par {})",
                    run.subjects_total,
                    run.actor_label.as_deref().unwrap_or("-")
                )),
        )
        .await;

    Ok(Json(json!({ "message": "Archive deleted" })))
}

// ── The archive itself ───────────────────────────────────────────────────────

/// `GET /admin/data-export/:id/download` - hand over the archive.
///
/// Every refusal below is a `403`/`404`/`409` with a sentence, never a silent
/// empty response: an operator whose download is refused must learn *which* of
/// the four conditions failed, or they will press the button again tomorrow.
pub async fn download_export(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Response, AppError> {
    ctx.require(keys::DATA_EXPORT_READ)?;

    let Some(run) = runs::get_admin(&state.db, id).await? else {
        return Err(AppError::NotFound("Export not found".into()));
    };

    let now = Utc::now();
    if run.status != "ready" {
        return Err(AppError::Conflict(
            "This archive is not ready".into(),
        ));
    }
    if run.file_deleted {
        return Err(AppError::NotFound(
            "This archive has been deleted from the server".into(),
        ));
    }
    if now < run.available_at {
        // The hold. The one refusal that is not a defect and is worded as such.
        return Err(AppError::Conflict(format!(
            "This archive will only be available from {} (security delay)",
            run.available_at.format("%d/%m/%Y %H:%M UTC")
        )));
    }
    if now >= run.expires_at {
        return Err(AppError::NotFound(
            "This archive has expired and is no longer available".into(),
        ));
    }

    let (Some(destination), Some(file_name)) = (run.destination.as_deref(), run.file_name.as_deref())
    else {
        return Err(AppError::NotFound("Archive not found on disk".into()));
    };
    // Re-validated even though it came from our own row: this is the one handler
    // that turns a database string into an open file descriptor.
    if !archive::is_export_file(file_name) {
        tracing::error!(export_id = %id, "export: nom d'archive non reconnu - téléchargement refusé");
        return Err(AppError::NotFound("Archive not found on disk".into()));
    }

    let path = std::path::Path::new(destination).join(file_name);
    let file = tokio::fs::File::open(&path).await.map_err(|e| {
        tracing::error!(error = %e, export_id = %id, "export: ouverture de l'archive impossible");
        AppError::NotFound("Archive not found on disk".into())
    })?;

    // Audited BEFORE the bytes leave: a download interrupted halfway still
    // transferred data, and a trail written only on completion would miss it.
    audit
        .record(
            &state.db,
            crate::audit::AuditEntry::new("core.data_export.download")
                .target(target::SETTING, id, "Export de données".to_string())
                .detail(format!(
                    "Archive téléchargée ({} compte(s), {} octets)",
                    run.subjects_total,
                    run.size_bytes.unwrap_or(0)
                )),
        )
        .await;
    runs::record_download(&state.db, id, audit.admin.id).await;

    let stream = tokio_util::io::ReaderStream::with_capacity(file, 64 * 1024);
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{file_name}\""),
            ),
            // Never cached anywhere between here and the operator's disk.
            (
                header::CACHE_CONTROL,
                "no-store, no-cache, must-revalidate, private".to_string(),
            ),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

/// `GET /admin/data-export/:id/subjects` - which accounts an export covered, and
/// what each of them produced.
///
/// Its own route rather than a field of the history: an instance-wide export has
/// thousands of subjects and the page opens on thirty runs.
pub async fn export_subjects(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DATA_EXPORT_READ)?;
    let subjects = runs::subjects(&state.db, id).await?;
    Ok(Json(json!({ "subjects": subjects })))
}
