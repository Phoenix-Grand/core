//! The console side of the domain registry.
//!
//! ## One pipeline, four verbs
//!
//! A domain travels: **declared → prouvé → (promu) → retiré**. Each step is its
//! own route, because each is a different decision, and the console shows the
//! next one on the row itself rather than hiding it behind an edit form. There
//! is deliberately no `PATCH`: a domain has nothing to edit. Its name is its
//! identity, its kind changes only through a promotion, and its verification is
//! a fact about the world rather than a field.
//!
//! ## The probes are on demand
//!
//! Verification and the mail diagnosis are DNS round-trips, and they run when an
//! administrator asks - never on the read path. A list that resolved twenty
//! domains would take seconds to paint and would hammer a resolver every time
//! somebody glanced at the page.

use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{redact::target, AdminAudit, AuditEntry},
    auth::middleware::{AdminUser, InternalRequest},
    authz::{keys, AdminCtx},
    domains::{
        dns,
        model::{normalise_name, DomainKind},
        store, Domain,
    },
    errors::AppError,
    state::AppState,
};

/// One domain, plus everything the row needs to show its next step.
fn domain_json(domain: &Domain) -> Value {
    let mut value = serde_json::to_value(domain).unwrap_or_else(|_| json!({}));
    if let Some(object) = value.as_object_mut() {
        object.insert("verified".into(), json!(domain.is_verified()));
        // The record to publish, composed here so the console never has to know
        // the token's prefix.
        object.insert("expected_record".into(), json!(domain.expected_record()));
        object.insert("record_name".into(), json!(domain.name.clone()));
        object.insert("record_type".into(), json!("TXT"));
    }
    value
}

/// `GET /admin/domains`
pub async fn list(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DOMAINS_READ)?;
    let domains = store::list(&state.db).await?;
    let overview = store::overview(&state.db).await?;

    // The address the instance sends from, so the page can say whether it
    // matches a domain that has been proven. A mismatch is not an error - an
    // instance can legitimately send from a relay's domain - but it is the
    // single most useful thing this page can point out about mail.
    let from_address = crate::settings::instance_value(&state.db, "mail.from_address")
        .await
        .and_then(|v| v.as_str().map(str::to_string));
    let from_domain = from_address
        .as_deref()
        .and_then(|address| address.split('@').nth(1))
        .map(|d| d.to_ascii_lowercase());

    Ok(Json(json!({
        "domains":     domains.iter().map(domain_json).collect::<Vec<_>>(),
        "overview":    overview,
        "from_address": from_address,
        "from_domain":  from_domain,
        "token_prefix": dns::TOKEN_PREFIX,
    })))
}

// ── The registry, as a MODULE sees it ────────────────────────────────────────
//
// The mail module has to answer, on every reception, "is this name ours?". It
// used to answer from a free-text setting of its own, which is how an instance
// ended up serving a domain the console had never heard of - and kept serving
// one an administrator had just removed here.
//
// This is the single reading that ends that split. It is deliberately NOT
// limited to the verified names: a panel that only ever sees the verified ones
// cannot tell "declared, waiting for its DNS record" from "never declared", and
// those two call for opposite advice. Deciding what to *serve* stays with the
// caller - mail serves the verified ones only.
//
// Guarded by `InternalRequest`: there is no layer on `/internal`, the guard is
// per handler. Read-only by construction - a module that could write here would
// be a module that decides what the instance is called.

/// `GET /internal/domains` - every declared domain with its state.
pub async fn internal_list_domains(
    State(state): State<AppState>,
    _internal: InternalRequest,
) -> Result<Json<Value>, AppError> {
    let domains = store::list(&state.db).await?;
    let items = domains
        .iter()
        .map(|d| {
            json!({
                "name":        d.name,
                "kind":        d.kind.as_str(),
                "verified":    d.is_verified(),
                "verified_at": d.verified_at,
                // The domain an alias lends its addresses to, by name: a module
                // has no use for the core's row identifiers.
                "parent":      d.parent_name,
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({ "domains": items })))
}

/// `GET /admin/domains/:id` - the sheet, blockers included.
pub async fn get(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DOMAINS_READ)?;
    let domain = store::get(&state.db, id).await?;
    let blockers = store::removal_blockers(&state.db, &domain).await?;
    Ok(Json(json!({
        "domain":           domain_json(&domain),
        "removal_blockers": blockers,
    })))
}

#[derive(Debug, Deserialize)]
pub struct CreateDomainDto {
    name: String,
    /// `secondary` (its own accounts) or `alias` (a second address for another
    /// domain's accounts). The primary is never created here.
    kind: String,
    #[serde(default)]
    parent_id: Option<Uuid>,
}

/// `POST /admin/domains`
pub async fn create(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<CreateDomainDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DOMAINS_MANAGE)?;
    let name = normalise_name(&dto.name)?;
    let kind = DomainKind::parse(&dto.kind)?;

    let mut tx = audit.begin(&state.db).await?;
    let id = store::create(&mut tx, &name, kind, dto.parent_id, audit.admin.id).await?;
    tx.commit(
        AuditEntry::new("core.domains.create")
            .target(target::DOMAIN, id, name.clone())
            .after(json!({ "id": id, "name": name, "kind": kind.as_str(), "parent_id": dto.parent_id }))
            .reversible(),
    )
    .await?;

    // Returned whole: the console goes straight to the verification screen, and
    // that screen needs the token the row was just given.
    let domain = store::get(&state.db, id).await?;
    Ok(Json(json!({ "domain": domain_json(&domain) })))
}

/// `POST /admin/domains/:id/verify` - read the DNS now.
///
/// Not audited as a *change*: it records what the world says, and running it is
/// not a decision. The transition to verified is what the entry below reports,
/// and only when it actually happens.
pub async fn verify(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DOMAINS_MANAGE)?;
    let before = store::get(&state.db, id).await?;
    let domain = store::verify(&state.db, id).await?;

    if domain.is_verified() && !before.is_verified() {
        audit
            .record(
                &state.db,
                AuditEntry::new("core.domains.update")
                    .target(target::DOMAIN, id, domain.name.clone())
                    .before(json!({ "verified": false }))
                    .after(json!({ "verified": true, "name": domain.name })),
            )
            .await;
    }

    Ok(Json(json!({ "domain": domain_json(&domain) })))
}

/// Tells the mail module a domain is ready to host mailboxes.
///
/// Emitted the moment the PRIMARY domain has both its ownership proof (TXT) and
/// routable mail (MX). The mail module subscribes and, on this signal,
/// provisions an address for every account that has none - the automatic
/// mailbox attribution the administrator configured. Idempotent on the mail
/// side: an account that already has an address is left alone, so re-emitting
/// (a second MX check, a re-promotion) provisions only what is new.
async fn announce_mail_ready(state: &AppState, domain: &crate::domains::Domain) {
    if !domain.mail_ready() {
        return;
    }
    state
        .events
        .publish_and_log(
            crate::events::AppEvent::Custom {
                event_type: "domain.mail_ready".into(),
                module_id: "core".into(),
                payload: json!({ "domain": domain.name }),
            },
            &state.db,
        )
        .await;
}

/// `POST /admin/domains/:id/mail-check` - refresh the MX / SPF / DMARC reading.
pub async fn mail_check(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DOMAINS_READ)?;
    let domain = store::refresh_mail(&state.db, id).await?;
    announce_mail_ready(&state, &domain).await;
    Ok(Json(json!({ "domain": domain_json(&domain) })))
}

/// `POST /admin/domains/:id/primary` - promote a verified domain.
///
/// The most consequential button on the page: it changes what the instance
/// calls itself. It changes **no account address** - the console says so before
/// the click, and this handler is the reason it can say it truthfully.
pub async fn promote(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DOMAINS_MANAGE)?;

    let mut tx = audit.begin(&state.db).await?;
    let (name, previous) = store::promote(&mut tx, id).await?;
    tx.commit(
        AuditEntry::new("core.domains.update")
            .target(target::DOMAIN, id, name.clone())
            .before(json!({ "primary": previous }))
            .after(json!({ "primary": name, "kind": "primary" }))
            .reversible(),
    )
    .await?;

    // The promoted domain may already have MX proven; a promotion is exactly when
    // it becomes THE primary, so a mailbox back-fill can now target it.
    if let Ok(promoted) = store::get(&state.db, id).await {
        announce_mail_ready(&state, &promoted).await;
    }

    Ok(Json(json!({ "ok": true, "primary": name, "previous": previous })))
}

/// `DELETE /admin/domains/:id`
///
/// Refuses with the *list* of what stands in the way rather than a bare "non":
/// an administrator who is told "3 comptes portent une adresse ici" knows what
/// to do next, and one who is told "impossible" does not.
pub async fn delete(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::DOMAINS_MANAGE)?;
    let domain = store::get(&state.db, id).await?;
    let blockers = store::removal_blockers(&state.db, &domain).await?;
    if !blockers.is_empty() {
        return Err(AppError::Validation(blockers.join(" ")));
    }

    let mut tx = audit.begin(&state.db).await?;
    store::delete(&mut tx, id).await?;
    tx.commit(
        AuditEntry::new("core.domains.delete")
            .target(target::DOMAIN, id, domain.name.clone())
            .before(json!({ "id": id, "name": domain.name, "kind": domain.kind.as_str() })),
    )
    .await?;

    Ok(Json(json!({ "ok": true })))
}
