//! The console side of data migration.
//!
//! ## What each verb is for
//!
//! A campaign travels: **composée → en cours → (interrompue) → terminée**.
//! Every step is its own route because every step is a different decision, and
//! the console shows the next one on the campaign itself.
//!
//! `probe` stands apart: it is not a step, it opens a session on the source and
//! reports what is there. It exists so an administrator can see the folder list
//! *before* committing two hundred mailboxes to a range that excludes the wrong
//! thing. It runs when asked, never on a read path.
//!
//! ## The credentials
//!
//! They arrive once, in the body of `create` (or of `probe`, where they are used
//! and dropped), are sealed immediately, and are never read back out. No route
//! here returns one, no route accepts one for an existing campaign except
//! through a fresh mapping, and no handler logs the request body. The audit
//! entries name the server and the accounts; the secret is not in the
//! whitelist that governs what a trail may hold, and must not be added to it.
//!
//! ## Why `manage` is not `settings.manage`
//!
//! Starting a campaign authenticates against a third-party server on behalf of
//! an entire organisation and writes into other people's mailboxes. That is a
//! narrower thing to be trusted with than editing a setting, so it carries its
//! own key.

use axum::{
    extract::{Path, State},
    Json,
};
use chrono::NaiveDate;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{redact::target, AdminAudit, AuditEntry},
    auth::middleware::AdminUser,
    authz::{keys, AdminCtx},
    data_migration::{
        dispatch,
        model::{
            validate_exclusions, AccountMappingInput, Campaign, ServiceKind, SourceSpec,
            MAX_ACCOUNTS_PER_CAMPAIGN,
        },
        jobs, store,
    },
    errors::AppError,
    state::AppState,
};

/// A campaign plus the counters its row shows.
fn campaign_json(campaign: &Campaign, tally: Option<&crate::data_migration::model::CampaignTally>) -> Value {
    let mut value = serde_json::to_value(campaign).unwrap_or_else(|_| json!({}));
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "tally".into(),
            serde_json::to_value(tally.cloned().unwrap_or_default()).unwrap_or_else(|_| json!({})),
        );
    }
    value
}

fn actor_label(admin: &crate::models::user::User) -> String {
    admin
        .display_name
        .clone()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| admin.email.clone())
}

/// `GET /admin/data-migration`
pub async fn list(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DATA_MIGRATION_READ)?;

    let campaigns = store::list(&state.db).await?;
    let tallies = store::tallies(&state.db).await?;
    let services = store::available_services(&state.db).await?;

    Ok(Json(json!({
        "campaigns": campaigns
            .iter()
            .map(|c| campaign_json(c, tallies.get(&c.id)))
            .collect::<Vec<_>>(),
        // What this instance can migrate *today*. A service whose module is not
        // registered is listed as unavailable rather than hidden: an operator
        // looking for a mail migration on an instance without the mail module
        // needs to be told why it is not offered, not left wondering.
        "services": services
            .iter()
            .map(|(service, ready)| json!({
                "id":        service.as_str(),
                "module_id": service.module_id(),
                "available": ready,
            }))
            .collect::<Vec<_>>(),
    })))
}

/// `GET /admin/data-migration/:id`
pub async fn get(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DATA_MIGRATION_READ)?;

    let campaign = store::get(&state.db, id).await?;
    let accounts = store::accounts(&state.db, id).await?;
    let tallies = store::tallies(&state.db).await?;

    Ok(Json(json!({
        "campaign": campaign_json(&campaign, tallies.get(&id)),
        "accounts": accounts,
    })))
}

// ── Probing the source ──────────────────────────────────────────────────────

/// Deliberately not `Debug`: it holds a password.
#[derive(Deserialize)]
pub struct ProbeDto {
    service:  String,
    source:   SourceSpec,
    login:    String,
    password: String,
}

/// `POST /admin/data-migration/probe` - what does the source hold?
///
/// Carries `manage` rather than `read`: it authenticates against a third-party
/// server with a credential the caller supplies, which is an action, not a
/// consultation.
pub async fn probe(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Json(dto): Json<ProbeDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DATA_MIGRATION_MANAGE)?;

    let service = ServiceKind::parse(&dto.service)?;
    dto.source.validate()?;
    if dto.login.trim().is_empty() || dto.password.is_empty() {
        return Err(AppError::Validation(
            "Indiquez un compte source et son mot de passe pour tester la connexion.".into(),
        ));
    }

    let base_url = module_url(&state, service).await?;
    let credentials = dispatch::SourceCredentials {
        host:     dto.source.host.trim().to_string(),
        port:     dto.source.port.clamp(1, 65535) as u16,
        security: dto.source.security.clone(),
        username: dto.login.trim().to_string(),
        password: dto.password.clone(),
    };

    match dispatch::probe(
        &state.settings.server,
        service.module_id(),
        &base_url,
        &credentials,
    )
    .await?
    {
        Ok(folders) => Ok(Json(json!({ "ok": true, "folders": folders }))),
        // A refused credential is an answer, not a server error: the form shows
        // it next to the field and the administrator fixes it.
        Err(message) => Ok(Json(json!({ "ok": false, "error": message }))),
    }
}

// ── Composing a campaign ────────────────────────────────────────────────────

/// Deliberately not `Debug`: `accounts` hold passwords.
#[derive(Deserialize)]
pub struct CreateCampaignDto {
    name:    String,
    service: String,
    source:  SourceSpec,
    #[serde(default)]
    since:   Option<NaiveDate>,
    #[serde(default)]
    exclude_folders: Vec<String>,
    #[serde(default)]
    accounts: Vec<AccountMappingInput>,
    /// Start it as soon as it is written. The console's "créer et lancer".
    #[serde(default)]
    start: bool,
}

/// `POST /admin/data-migration`
pub async fn create(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<CreateCampaignDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DATA_MIGRATION_MANAGE)?;

    // Everything is validated before a single row is written: a campaign that
    // is half-created because the hundredth mapping was malformed is worse than
    // one that was refused.
    let name = dto.name.trim();
    if name.is_empty() || name.len() > 200 {
        return Err(AppError::Validation(
            "Donnez un nom à la campagne (200 caractères au maximum).".into(),
        ));
    }
    let service = ServiceKind::parse(&dto.service)?;
    dto.source.validate()?;
    validate_exclusions(&dto.exclude_folders)?;

    if dto.accounts.is_empty() {
        return Err(AppError::Validation(
            "Une campagne sans correspondance de comptes ne migrerait rien.".into(),
        ));
    }
    if dto.accounts.len() > MAX_ACCOUNTS_PER_CAMPAIGN {
        return Err(AppError::Validation(format!(
            "Trop de comptes dans une seule campagne ({} au maximum).",
            MAX_ACCOUNTS_PER_CAMPAIGN
        )));
    }
    for mapping in &dto.accounts {
        mapping.validate()?;
    }

    // Refused here rather than queued: a campaign whose module is not installed
    // would sit at "en cours" for ever with nothing coming for it.
    let _ = module_url(&state, service).await?;

    let source = SourceSpec {
        kind:     dto.source.kind.clone(),
        host:     dto.source.host.trim().to_string(),
        port:     dto.source.port,
        security: dto.source.security.clone(),
    };

    let label = actor_label(&audit.admin);
    let mut tx = audit.begin(&state.db).await?;
    let id = store::create_campaign(
        &mut tx,
        name,
        service,
        &source,
        dto.since,
        &dto.exclude_folders,
        audit.admin.id,
        &label,
    )
    .await?;
    store::add_accounts(&mut tx, id, &dto.accounts, &state.settings.auth.jwt_secret).await?;

    tx.commit(
        AuditEntry::new("core.data_migration.create")
            .target(target::MIGRATION_CAMPAIGN, id, name.to_string())
            // The server and the size of the operation - never a credential,
            // never the mapping's passwords.
            .after(json!({
                "id":          id,
                "name":        name,
                "service":     service.as_str(),
                "source_host": source.host,
                "source_port": source.port,
                "accounts":    dto.accounts.len(),
            }))
            .reversible(),
    )
    .await?;

    if dto.start {
        store::set_campaign_status(&state.db, id, "running", None).await?;
        jobs::kick(&state.db).await;
        audit
            .record(
                &state.db,
                AuditEntry::new("core.data_migration.execute")
                    .target(target::MIGRATION_CAMPAIGN, id, name.to_string())
                    .after(json!({ "status": "running" })),
            )
            .await;
    }

    let campaign = store::get(&state.db, id).await?;
    Ok(Json(json!({ "campaign": campaign_json(&campaign, None) })))
}

// ── Running it ──────────────────────────────────────────────────────────────

/// `POST /admin/data-migration/:id/start` - also the "reprendre" of a paused
/// campaign, and the "relancer" of a finished one that has failures left.
pub async fn start(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DATA_MIGRATION_MANAGE)?;

    let campaign = store::get(&state.db, id).await?;
    if campaign.status == "running" {
        return Err(AppError::Conflict("Cette campagne est déjà en cours.".into()));
    }

    // Checked again at every start: a module removed between two runs must stop
    // the campaign here, with a sentence, rather than in a background job.
    let service = ServiceKind::parse(&campaign.service)?;
    let _ = module_url(&state, service).await?;

    store::set_campaign_status(&state.db, id, "running", None).await?;
    jobs::kick(&state.db).await;

    audit
        .record(
            &state.db,
            AuditEntry::new("core.data_migration.execute")
                .target(target::MIGRATION_CAMPAIGN, id, campaign.name.clone())
                .before(json!({ "status": campaign.status }))
                .after(json!({ "status": "running" })),
        )
        .await;

    let campaign = store::get(&state.db, id).await?;
    Ok(Json(json!({ "campaign": campaign_json(&campaign, None) })))
}

/// `POST /admin/data-migration/:id/pause` - stop between chunks.
///
/// Nothing is undone and no cursor is dropped: the accounts keep their
/// position, the job stops claiming them, and a later `start` carries on. There
/// is no way to abort a chunk already in flight, and there should not be - the
/// module is mid-write, and interrupting it is how a mailbox ends up half
/// copied with no record of where.
pub async fn pause(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DATA_MIGRATION_MANAGE)?;

    let campaign = store::get(&state.db, id).await?;
    if campaign.status != "running" {
        return Err(AppError::Conflict(
            "Cette campagne n'est pas en cours : il n'y a rien à interrompre.".into(),
        ));
    }

    store::set_campaign_status(&state.db, id, "paused", None).await?;

    audit
        .record(
            &state.db,
            AuditEntry::new("core.data_migration.update")
                .target(target::MIGRATION_CAMPAIGN, id, campaign.name.clone())
                .before(json!({ "status": "running" }))
                .after(json!({ "status": "paused" })),
        )
        .await;

    let campaign = store::get(&state.db, id).await?;
    Ok(Json(json!({ "campaign": campaign_json(&campaign, None) })))
}

/// `POST /admin/data-migration/:id/accounts/:account_id/retry`
pub async fn retry_account(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path((id, account_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DATA_MIGRATION_MANAGE)?;

    let campaign = store::get(&state.db, id).await?;
    store::retry_account(&state.db, id, account_id).await?;

    // A retry on a finished campaign has to reopen it, or the job would never
    // look at the row that was just put back.
    if campaign.status != "running" {
        store::set_campaign_status(&state.db, id, "running", None).await?;
    }
    jobs::kick(&state.db).await;

    audit
        .record(
            &state.db,
            AuditEntry::new("core.data_migration.execute")
                .target(target::MIGRATION_CAMPAIGN, id, campaign.name.clone())
                .after(json!({ "retried_account": account_id })),
        )
        .await;

    let accounts = store::accounts(&state.db, id).await?;
    Ok(Json(json!({ "accounts": accounts })))
}

/// `DELETE /admin/data-migration/:id`
///
/// Removes the campaign and, with it, every stored source credential. What was
/// already copied stays where it was copied: this deletes the plan, never the
/// mail - and saying so on the confirmation is the difference between a tidy-up
/// and a disaster.
pub async fn delete(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DATA_MIGRATION_MANAGE)?;

    let campaign = store::get(&state.db, id).await?;
    if campaign.status == "running" {
        return Err(AppError::Conflict(
            "Interrompez la campagne avant de la supprimer.".into(),
        ));
    }

    let mut tx = audit.begin(&state.db).await?;
    store::delete_campaign(&mut tx, id).await?;
    tx.commit(
        AuditEntry::new("core.data_migration.delete")
            .target(target::MIGRATION_CAMPAIGN, id, campaign.name.clone())
            .before(json!({
                "id":          id,
                "name":        campaign.name,
                "service":     campaign.service,
                "source_host": campaign.source_host,
            })),
    )
    .await?;

    Ok(Json(json!({ "deleted": true })))
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Where the module that owns this service answers, or a sentence saying why
/// the operation cannot happen.
async fn module_url(state: &AppState, service: ServiceKind) -> Result<String, AppError> {
    store::module_base_url(&state.db, service.module_id())
        .await?
        .ok_or_else(|| {
            AppError::Validation(format!(
                "Le module chargé de ce service (« {} ») n'est pas actif : \
                 installez-le et réessayez.",
                service.module_id()
            ))
        })
}
