use crate::{
    authz::{keys, AdminCtx},
    audit::{redact::target, snap, AdminAudit, AuditEntry},
    auth::{middleware::AdminUser, oauth},
    crypto::encryption,
    errors::AppError,
    models::oauth_provider::{
        AdminOAuthProvider, CreateOAuthProviderDto, OAuthProvider, UpdateOAuthProviderDto,
    },
    state::AppState,
};
use axum::{
    extract::{Path, State},
    Json,
};
use kubuno_db::{params, DbRow};
use serde_json::{json, Value};
use uuid::Uuid;

/// Map a raw row (a RETURNING or reselect on `core.oauth_providers`) into the
/// full provider struct. Used inside audited transactions, where `DbTx` cannot
/// decode structs directly.
fn provider_from_row(row: &DbRow) -> Result<OAuthProvider, sqlx::Error> {
    Ok(OAuthProvider {
        id:                 row.try_get("id")?,
        slug:               row.try_get("slug")?,
        display_name:       row.try_get("display_name")?,
        issuer_url:         row.try_get("issuer_url")?,
        client_id:          row.try_get("client_id")?,
        client_secret_enc:  row.try_get("client_secret_enc")?,
        scopes:             row.try_get("scopes")?,
        button_color:       row.try_get("button_color")?,
        enabled:            row.try_get("enabled")?,
        allow_signup:       row.try_get("allow_signup")?,
        position:           row.try_get("position")?,
        claim_username:     row.try_get("claim_username")?,
        claim_email:        row.try_get("claim_email")?,
        claim_display_name: row.try_get("claim_display_name")?,
        claim_groups:       row.try_get("claim_groups")?,
        sync_groups:        row.try_get("sync_groups")?,
        created_at:         row.try_get("created_at")?,
        updated_at:         row.try_get("updated_at")?,
    })
}

fn validate_slug(slug: &str) -> Result<(), AppError> {
    let ok = (2..=40).contains(&slug.len())
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(AppError::Validation(
            "Invalid slug: 2 to 40 characters; only lowercase letters, numbers, and hyphens".into(),
        ))
    }
}

/// A claim name the operator left blank falls back to the standard one rather
/// than to the empty string: an empty mapping matches nothing, and "I did not
/// fill this in" must not mean "map nothing here".
fn claim_or<'a>(value: Option<&'a str>, fallback: &'a str) -> &'a str {
    match value.map(str::trim) {
        Some(v) if !v.is_empty() => v,
        _ => fallback,
    }
}

fn validate_issuer(url: &str) -> Result<(), AppError> {
    match url::Url::parse(url) {
        Ok(u) if u.scheme() == "https" || u.scheme() == "http" => Ok(()),
        _ => Err(AppError::Validation(
            "Invalid issuer_url (expected an http(s) URL)".into(),
        )),
    }
}

/// Encrypt a client secret with the OIDC key derived from the JWT secret.
fn encrypt_secret(state: &AppState, secret: &str) -> Result<String, AppError> {
    if secret.is_empty() {
        return Ok(String::new());
    }
    let key = oauth::secret_key(&state.settings.auth.jwt_secret);
    encryption::encrypt(&key, secret.as_bytes()).map_err(AppError::Internal)
}

pub async fn list_oauth_providers(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUTH_PROVIDERS_READ)?;
    let rows = state
        .db
        .fetch_all_as::<OAuthProvider>(
            "SELECT * FROM core.oauth_providers ORDER BY position, display_name",
            params![],
        )
        .await?;

    let providers: Vec<AdminOAuthProvider> = rows.into_iter().map(Into::into).collect();
    Ok(Json(json!({ "providers": providers })))
}

pub async fn create_oauth_provider(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<CreateOAuthProviderDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUTH_PROVIDERS_MANAGE)?;
    let slug = dto.slug.trim().to_lowercase();
    validate_slug(&slug)?;
    validate_issuer(dto.issuer_url.trim())?;
    if dto.display_name.trim().is_empty() || dto.client_id.trim().is_empty() {
        return Err(AppError::Validation("display_name and client_id are required".into()));
    }

    let secret_enc = encrypt_secret(&state, &dto.client_secret)?;
    let scopes = dto
        .scopes
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "openid email profile".into());

    let mut tx = audit.begin(&state.db).await?;

    // The key is generated here rather than by the database: MySQL and SQLite
    // have no `RETURNING`, so a process-side id is the only portable way to know
    // the row's identity for the reselect and the audit target.
    let id = kubuno_db::new_id();
    let raw = kubuno_db::returning::insert_returning_row(
        &mut tx,
        r#"INSERT INTO core.oauth_providers
               (id, slug, display_name, issuer_url, client_id, client_secret_enc,
                scopes, button_color, enabled, allow_signup, position,
                claim_username, claim_email, claim_display_name, claim_groups, sync_groups)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)"#,
        params![
            id,
            &slug,
            dto.display_name.trim(),
            dto.issuer_url.trim(),
            dto.client_id.trim(),
            &secret_enc,
            &scopes,
            dto.button_color.as_deref(),
            dto.enabled,
            dto.allow_signup,
            dto.position,
            claim_or(dto.claim_username.as_deref(), "preferred_username"),
            claim_or(dto.claim_email.as_deref(), "email"),
            claim_or(dto.claim_display_name.as_deref(), "name"),
            claim_or(dto.claim_groups.as_deref(), "groups"),
            dto.sync_groups
        ],
        "*",
        &kubuno_db::returning::reselect_by_id("core.oauth_providers", "*"),
        params![id],
    )
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            AppError::Conflict(format!("A provider with slug '{slug}' already exists"))
        }
        _ => {
            tracing::error!(error = %e, "create_oauth_provider");
            AppError::from(e)
        }
    })?;
    let row = provider_from_row(&raw)?;

    // `AdminOAuthProvider` already drops the secret, and the whitelist drops it
    // again: the client secret has no path into the trail.
    let public = AdminOAuthProvider::from(row.clone());
    tx.commit(
        AuditEntry::new("core.auth_providers.create")
            .target(target::OAUTH_PROVIDER, row.id, row.display_name.clone())
            .after(snap(target::OAUTH_PROVIDER, &public))
            .reversible(),
    )
    .await?;

    tracing::info!(slug = %row.slug, "Fournisseur SSO créé");
    Ok(Json(json!({ "provider": public })))
}

pub async fn update_oauth_provider(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<UpdateOAuthProviderDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUTH_PROVIDERS_MANAGE)?;
    if let Some(issuer) = dto.issuer_url.as_deref() {
        validate_issuer(issuer.trim())?;
    }

    // Encrypt only when a non-empty new secret is provided; otherwise keep the
    // existing one (NULL → COALESCE keeps the stored value).
    let secret_enc: Option<String> = match dto.client_secret.as_deref() {
        Some(s) if !s.is_empty() => Some(encrypt_secret(&state, s)?),
        _ => None,
    };

    let mut tx = audit.begin(&state.db).await?;

    let for_update = tx.backend().for_update();
    let prev_raw = tx
        .fetch_optional_row(
            &format!(
                "SELECT * FROM core.oauth_providers WHERE id = $1{}",
                for_update
            ),
            params![id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "update_oauth_provider: lecture"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound("SSO provider not found".into()))?;
    let previous = provider_from_row(&prev_raw)?;

    let updated_raw = kubuno_db::returning::update_returning_row(
        &mut tx,
        r#"UPDATE core.oauth_providers SET
               display_name      = COALESCE($2,  display_name),
               issuer_url        = COALESCE($3,  issuer_url),
               client_id         = COALESCE($4,  client_id),
               scopes            = COALESCE($5,  scopes),
               button_color      = COALESCE($6,  button_color),
               enabled           = COALESCE($7,  enabled),
               allow_signup      = COALESCE($8,  allow_signup),
               position          = COALESCE($9,  position),
               client_secret_enc = COALESCE($10, client_secret_enc),
               claim_username     = COALESCE($11, claim_username),
               claim_email        = COALESCE($12, claim_email),
               claim_display_name = COALESCE($13, claim_display_name),
               claim_groups       = COALESCE($14, claim_groups),
               sync_groups        = COALESCE($15, sync_groups)
           WHERE id = $1"#,
        params![
            id,
            dto.display_name.as_deref().map(str::trim),
            dto.issuer_url.as_deref().map(str::trim),
            dto.client_id.as_deref().map(str::trim),
            dto.scopes.as_deref(),
            dto.button_color.as_deref(),
            dto.enabled,
            dto.allow_signup,
            dto.position,
            secret_enc.as_deref(),
            dto.claim_username.as_deref().map(str::trim).filter(|s| !s.is_empty()),
            dto.claim_email.as_deref().map(str::trim).filter(|s| !s.is_empty()),
            dto.claim_display_name.as_deref().map(str::trim).filter(|s| !s.is_empty()),
            dto.claim_groups.as_deref().map(str::trim).filter(|s| !s.is_empty()),
            dto.sync_groups
        ],
        "*",
        &kubuno_db::returning::reselect_by_id("core.oauth_providers", "*"),
        params![id],
    )
    .await
    .map_err(|e| { tracing::error!(error = %e, "update_oauth_provider: écriture"); AppError::Database(e) })?
    .ok_or_else(|| AppError::NotFound("SSO provider not found".into()))?;
    let row = provider_from_row(&updated_raw)?;

    let public = AdminOAuthProvider::from(row.clone());
    let mut entry = AuditEntry::new("core.auth_providers.update")
        .target(target::OAUTH_PROVIDER, row.id, row.display_name.clone())
        .before(snap(target::OAUTH_PROVIDER, &AdminOAuthProvider::from(previous)))
        .after(snap(target::OAUTH_PROVIDER, &public))
        .reversible();
    // A rotated secret is worth knowing about even though its value never
    // appears: the note says "the credential changed", nothing more.
    if secret_enc.is_some() {
        entry = entry.detail("secret client renouvelé");
    }
    tx.commit(entry).await?;

    tracing::info!(slug = %row.slug, "Fournisseur SSO mis à jour");
    Ok(Json(json!({ "provider": public })))
}

pub async fn delete_oauth_provider(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUTH_PROVIDERS_MANAGE)?;
    let mut tx = audit.begin(&state.db).await?;

    let for_update = tx.backend().for_update();
    let prev_raw = tx
        .fetch_optional_row(
            &format!(
                "SELECT * FROM core.oauth_providers WHERE id = $1{}",
                for_update
            ),
            params![id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "delete_oauth_provider: lecture"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound("SSO provider not found".into()))?;
    let previous = provider_from_row(&prev_raw)?;

    tx.execute("DELETE FROM core.oauth_providers WHERE id = $1", params![id])
        .await
        .map_err(|e| { tracing::error!(error = %e, "delete_oauth_provider"); AppError::Database(e) })?;

    let label = previous.display_name.clone();
    tx.commit(
        AuditEntry::new("core.auth_providers.delete")
            .target(target::OAUTH_PROVIDER, id, label)
            .before(snap(target::OAUTH_PROVIDER, &AdminOAuthProvider::from(previous))),
    )
    .await?;

    Ok(Json(json!({ "message": "Provider deleted" })))
}

// ── Diagnostic ───────────────────────────────────────────────────────────────

/// Fetches the provider's discovery document and reports what came back.
///
/// The counterpart of the directory's connection probe, and it exists for the
/// same reason: an issuer URL that is off by one path segment produces a
/// redirect that fails minutes later, in the browser, with an error page nobody
/// controls. This says so in one click, with the provider's own answer.
pub async fn test_oauth_provider(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUTH_PROVIDERS_READ)?;

    let provider = state
        .db
        .fetch_optional_as::<OAuthProvider>(
            "SELECT * FROM core.oauth_providers WHERE id = $1",
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "test_oauth_provider: lecture");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("SSO provider not found".into()))?;

    let started = std::time::Instant::now();
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| AppError::Internal(e.into()))?;

    let result = match oauth::discover(&http, &provider.issuer_url).await {
        Ok(disc) => json!({
            "ok": true,
            "message": "Discovery document retrieved",
            "issuer_url": provider.issuer_url,
            "authorization_endpoint": disc.authorization_endpoint,
            "token_endpoint": disc.token_endpoint,
            "userinfo_endpoint": disc.userinfo_endpoint,
            "end_session_endpoint": disc.end_session_endpoint,
            "has_secret": !provider.client_secret_enc.is_empty(),
            "claims": {
                "username": provider.claim_username,
                "email": provider.claim_email,
                "display_name": provider.claim_display_name,
                "groups": provider.claim_groups,
                "sync_groups": provider.sync_groups,
            },
            "elapsed_ms": started.elapsed().as_millis() as u64,
        }),
        Err(e) => json!({
            "ok": false,
            "message": "OIDC discovery failed",
            // The provider's own answer, truncated and verbatim: the useful part
            // is usually its 404 body or the TLS alert, not our phrasing.
            "detail": crate::directory::client::truncate(&e.to_string()),
            "hint": "The issuer URL must be the base URL, without '/.well-known/openid-configuration'; the core adds that path. For Keycloak, it ends with /realms/<realm>.",
            "issuer_url": provider.issuer_url,
            "elapsed_ms": started.elapsed().as_millis() as u64,
        }),
    };

    audit
        .record(
            &state.db,
            AuditEntry::new("core.auth_providers.test")
                .target(target::OAUTH_PROVIDER, provider.id, provider.display_name.clone())
                .detail(
                    result
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("essai")
                        .to_string(),
                ),
        )
        .await;

    Ok(Json(result))
}
