//! Administration of the connected LDAP / Active Directory directories.
//!
//! The service password is the one value with asymmetric handling: it goes
//! **in** in clear (over the authenticated admin channel, once), is stored
//! AES-256-GCM encrypted, and never comes back out. `GET` reports
//! `has_bind_password: true`, nothing else - not a masked form, not its length,
//! since both leak.
//!
//! `POST …/test` and `POST …/test-auth` are the two synchronous probes. That is
//! the point of them: an operator debugging a directory needs the server's own
//! answer, and eleven of a dozen fields can be wrong in a way that produces the
//! same "nobody can sign in" a day later.
//!
//! Authorisation reuses `core.auth_providers.*`. A directory *is* an
//! authentication provider, and minting a second key for the same power would
//! mean an operator trusted with SSO is not trusted with LDAP for no reason
//! anybody could state.

use axum::{
    extract::{Path, State},
    Json,
};
use chrono::Utc;
use kubuno_db::{new_id, params, DbQueryBuilder};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{redact::target, snap, AdminAudit, AuditEntry},
    auth::middleware::AdminUser,
    authz::{keys, AdminCtx},
    directory::{
        config as dircfg, job, model::AdminLdapDirectory, model::CreateDirectoryDto,
        model::LdapDirectory, model::UpdateDirectoryDto, probe, sync,
    },
    errors::AppError,
    state::AppState,
};

/// Longest value accepted in any free-text field. Generous for a DN or a
/// filter, bounded so a row cannot become a blob.
const MAX_FIELD: usize = 500;
/// The certificate authority is longer by nature - a chain of three is normal.
const MAX_PEM: usize = 32_768;

// ── Validation ───────────────────────────────────────────────────────────────

fn validate_slug(slug: &str) -> Result<(), AppError> {
    let ok = (2..=40).contains(&slug.chars().count())
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(AppError::Validation(
            "Identifiant invalide : 2 à 40 caractères, minuscules, chiffres et tirets".into(),
        ))
    }
}

fn validate_field(label: &str, value: &str) -> Result<(), AppError> {
    if value.chars().count() > MAX_FIELD {
        return Err(AppError::Validation(format!(
            "{label} : {MAX_FIELD} caractères maximum"
        )));
    }
    Ok(())
}

/// A host has to be a hostname or an address, never a URL and never a filter.
///
/// Checked because the field is concatenated into an LDAP URL: a value carrying
/// a scheme, a slash or whitespace produces a URL that either fails to parse or
/// parses into something else entirely.
fn validate_host(host: &str) -> Result<(), AppError> {
    let host = host.trim();
    if host.is_empty() || host.chars().count() > 255 {
        return Err(AppError::Validation("Hôte requis (255 caractères maximum)".into()));
    }
    let bad = host.contains("://")
        || host.contains('/')
        || host.contains(' ')
        || host.contains('\\')
        || host.contains('@');
    if bad {
        return Err(AppError::Validation(
            "Hôte invalide : indiquez seulement le nom ou l'adresse (par ex. dc01.exemple.com), sans schéma ni chemin".into(),
        ));
    }
    Ok(())
}

fn validate_filter(label: &str, value: &str) -> Result<(), AppError> {
    validate_field(label, value)?;
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::Validation(format!("{label} requis")));
    }
    // Balanced parentheses is the one structural property worth checking here;
    // the directory itself is the authority on the rest of the grammar and says
    // so through the test button.
    let mut depth = 0i32;
    for c in value.chars() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return Err(AppError::Validation(format!("{label} : parenthèses déséquilibrées")));
                }
            }
            _ => {}
        }
    }
    if depth != 0 {
        return Err(AppError::Validation(format!("{label} : parenthèses déséquilibrées")));
    }
    Ok(())
}

/// The user filter additionally has to say where the login goes.
fn validate_user_filter(value: &str) -> Result<(), AppError> {
    validate_filter("Filtre de recherche", value)?;
    if !value.contains(crate::directory::filter::LOGIN_PLACEHOLDER) {
        return Err(AppError::Validation(
            "Le filtre de recherche doit contenir « {login} » - c'est là que l'identifiant saisi est inséré. \
             Sans lui, la même requête serait exécutée pour tout le monde."
                .into(),
        ));
    }
    Ok(())
}

fn clamp_port(port: i32) -> i32 {
    port.clamp(1, 65_535)
}

// ── Read ─────────────────────────────────────────────────────────────────────

pub async fn list_directories(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUTH_PROVIDERS_READ)?;
    let rows = state
        .db
        .fetch_all_as::<LdapDirectory>(
            "SELECT * FROM core.ldap_directories ORDER BY position, display_name",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "list_directories");
            AppError::Database(e)
        })?;

    // How many accounts each directory governs, so the console can say what a
    // deletion would deactivate before the operator clicks it.
    let counts_sql = format!(
        "SELECT ldap_directory_id, {} FROM core.users \
          WHERE ldap_directory_id IS NOT NULL GROUP BY ldap_directory_id",
        state.db.backend().count_bigint("*"),
    );
    let counts: Vec<(Uuid, i64)> = state
        .db
        .fetch_all_as::<(Uuid, i64)>(&counts_sql, params![])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "list_directories: count");
            AppError::Database(e)
        })?;

    let directories: Vec<Value> = rows
        .into_iter()
        .map(|d| {
            let id = d.id;
            let view = AdminLdapDirectory::from(d);
            let governed = counts.iter().find(|(k, _)| *k == id).map(|(_, n)| *n).unwrap_or(0);
            let mut value = serde_json::to_value(&view).unwrap_or_else(|_| json!({}));
            if let Some(obj) = value.as_object_mut() {
                obj.insert("governed_accounts".into(), json!(governed));
            }
            value
        })
        .collect();

    Ok(Json(json!({ "directories": directories })))
}

// ── Create ───────────────────────────────────────────────────────────────────

pub async fn create_directory(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<CreateDirectoryDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUTH_PROVIDERS_MANAGE)?;

    let slug = dto.slug.trim().to_lowercase();
    validate_slug(&slug)?;
    if dto.display_name.trim().is_empty() {
        return Err(AppError::Validation("Nom affiché requis".into()));
    }
    validate_host(&dto.host)?;
    if dto.base_dn.trim().is_empty() {
        return Err(AppError::Validation("DN de base requis".into()));
    }
    validate_field("DN de base", &dto.base_dn)?;
    validate_field("DN du compte de service", &dto.bind_dn)?;
    if dto.ca_certificate.chars().count() > MAX_PEM {
        return Err(AppError::Validation("Autorité de certification trop volumineuse".into()));
    }

    let security = crate::directory::Security::parse(dto.security.as_deref().unwrap_or("starttls"));
    let user_filter = dto
        .user_filter
        .filter(|f| !f.trim().is_empty())
        .unwrap_or_else(|| "(&(objectClass=inetOrgPerson)(uid={login}))".into());
    validate_user_filter(&user_filter)?;
    let group_filter = dto
        .group_filter
        .filter(|f| !f.trim().is_empty())
        .unwrap_or_else(|| "(objectClass=groupOfNames)".into());
    validate_filter("Filtre de groupes", &group_filter)?;

    let password_enc = dircfg::encrypt_password(&state.settings.auth.jwt_secret, &dto.bind_password)?;

    let mut tx = audit.begin(&state.db).await?;

    // Every stored value is settled here in Rust, so the inserted row can be
    // reconstructed without a `RETURNING *` (which MySQL lacks): the primary key
    // is generated locally and the timestamps are bound rather than defaulted.
    let id = new_id();
    let now = Utc::now();
    let display_name = dto.display_name.trim().to_string();
    let host = dto.host.trim().to_string();
    let port = clamp_port(dto.port.unwrap_or(security.default_port() as i32));
    let security_s = security.as_str().to_string();
    let ca_certificate = dto.ca_certificate.trim().to_string();
    let connect_timeout_s = dto.connect_timeout_s.unwrap_or(10).clamp(1, 120);
    let bind_dn = dto.bind_dn.trim().to_string();
    let base_dn = dto.base_dn.trim().to_string();
    let user_filter_s = user_filter.trim().to_string();
    let user_scope =
        crate::directory::model::Scope::parse(dto.user_scope.as_deref().unwrap_or("subtree"))
            .as_str()
            .to_string();
    let attr_username = dto.attr_username.as_deref().unwrap_or("uid").trim().to_string();
    let attr_email = dto.attr_email.as_deref().unwrap_or("mail").trim().to_string();
    let attr_display_name = dto.attr_display_name.as_deref().unwrap_or("cn").trim().to_string();
    let attr_unique_id = dto.attr_unique_id.as_deref().unwrap_or("entryUUID").trim().to_string();
    let attr_member_of = dto.attr_member_of.as_deref().unwrap_or("").trim().to_string();
    let group_base_dn = dto.group_base_dn.as_deref().unwrap_or("").trim().to_string();
    let group_filter_s = group_filter.trim().to_string();
    let attr_group_name = dto.attr_group_name.as_deref().unwrap_or("cn").trim().to_string();
    let attr_group_member = dto.attr_group_member.as_deref().unwrap_or("member").trim().to_string();
    let sync_interval_min = dto.sync_interval_min.unwrap_or(60).clamp(5, 10_080);
    let on_missing =
        crate::directory::OnMissing::parse(dto.on_missing.as_deref().unwrap_or("disable"))
            .as_str()
            .to_string();

    tx.execute(
        r#"INSERT INTO core.ldap_directories
               (id, slug, display_name, enabled, host, port, security, verify_certificate,
                ca_certificate, connect_timeout_s, bind_dn, bind_password_enc, base_dn,
                user_filter, user_scope, attr_username, attr_email, attr_display_name,
                attr_unique_id, attr_member_of, sync_groups, group_base_dn, group_filter,
                attr_group_name, attr_group_member, sync_enabled, sync_interval_min,
                on_missing, allow_signup, position, default_org_unit_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                   $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)"#,
        params![
            id,
            &slug,
            &display_name,
            dto.enabled,
            &host,
            port,
            &security_s,
            dto.verify_certificate,
            &ca_certificate,
            connect_timeout_s,
            &bind_dn,
            &password_enc,
            &base_dn,
            &user_filter_s,
            &user_scope,
            &attr_username,
            &attr_email,
            &attr_display_name,
            &attr_unique_id,
            &attr_member_of,
            dto.sync_groups,
            &group_base_dn,
            &group_filter_s,
            &attr_group_name,
            &attr_group_member,
            dto.sync_enabled,
            sync_interval_min,
            &on_missing,
            dto.allow_signup,
            dto.position,
            dto.default_org_unit_id,
            now,
            now,
        ],
    )
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            AppError::Conflict(format!("Un annuaire portant l'identifiant « {slug} » existe déjà"))
        }
        _ => {
            tracing::error!(error = %e, "create_directory");
            AppError::Database(e)
        }
    })?;

    // Reconstruct the freshly inserted row from the values just bound.
    let row = LdapDirectory {
        id,
        slug: slug.clone(),
        display_name,
        enabled: dto.enabled,
        host,
        port,
        security: security_s,
        verify_certificate: dto.verify_certificate,
        ca_certificate,
        connect_timeout_s,
        bind_dn,
        bind_password_enc: password_enc,
        base_dn,
        user_filter: user_filter_s,
        user_scope,
        attr_username,
        attr_email,
        attr_display_name,
        attr_unique_id,
        attr_member_of,
        sync_groups: dto.sync_groups,
        group_base_dn,
        group_filter: group_filter_s,
        attr_group_name,
        attr_group_member,
        sync_enabled: dto.sync_enabled,
        sync_interval_min,
        on_missing,
        allow_signup: dto.allow_signup,
        last_sync_at: None,
        last_sync_status: None,
        last_sync_detail: None,
        default_org_unit_id: dto.default_org_unit_id,
        position: dto.position,
        created_at: now,
        updated_at: now,
    };

    // The view already drops the encrypted password, and the audit whitelist
    // drops it again: the credential has no path into the trail.
    let view = AdminLdapDirectory::from(row.clone());
    tx.commit(
        AuditEntry::new("core.directory.create")
            .target(target::LDAP_DIRECTORY, row.id, row.display_name.clone())
            .after(snap(target::LDAP_DIRECTORY, &view))
            .reversible(),
    )
    .await?;

    if row.enabled && row.sync_enabled {
        job::schedule_one(&state.db, row.id).await;
    }

    tracing::info!(directory = %row.slug, "Annuaire créé");
    Ok(Json(json!({ "directory": view })))
}

// ── Update ───────────────────────────────────────────────────────────────────

pub async fn update_directory(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<UpdateDirectoryDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUTH_PROVIDERS_MANAGE)?;

    if let Some(host) = dto.host.as_deref() {
        validate_host(host)?;
    }
    if let Some(f) = dto.user_filter.as_deref() {
        validate_user_filter(f)?;
    }
    if let Some(f) = dto.group_filter.as_deref() {
        validate_filter("Filtre de groupes", f)?;
    }
    if let Some(dn) = dto.base_dn.as_deref() {
        validate_field("DN de base", dn)?;
        if dn.trim().is_empty() {
            return Err(AppError::Validation("DN de base requis".into()));
        }
    }
    if let Some(dn) = dto.bind_dn.as_deref() {
        validate_field("DN du compte de service", dn)?;
    }
    if let Some(pem) = dto.ca_certificate.as_deref() {
        if pem.chars().count() > MAX_PEM {
            return Err(AppError::Validation("Autorité de certification trop volumineuse".into()));
        }
    }

    // Absent = keep. Empty string = clear (a directory that accepts anonymous
    // searches). Anything else replaces.
    let password_enc: Option<String> = match dto.bind_password.as_deref() {
        Some(p) => Some(dircfg::encrypt_password(&state.settings.auth.jwt_secret, p)?),
        None => None,
    };

    // Read the existing row up front (the struct cannot be read back inside the
    // transaction: DbTx has no typed-row read). The subsequent write locks it.
    let previous = state
        .db
        .fetch_optional_as::<LdapDirectory>(
            "SELECT * FROM core.ldap_directories WHERE id = $1",
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "update_directory: read");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Annuaire introuvable".into()))?;

    let mut tx = audit.begin(&state.db).await?;

    // The `COALESCE(new, existing)` merge PostgreSQL performed in SQL is done here
    // in Rust, so the updated row can be reconstructed without a `RETURNING *`.
    let now = Utc::now();
    let display_name = dto
        .display_name
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.display_name.clone());
    let enabled = dto.enabled.unwrap_or(previous.enabled);
    let host = dto
        .host
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.host.clone());
    let port = dto.port.map(clamp_port).unwrap_or(previous.port);
    let security = dto
        .security
        .as_deref()
        .map(|s| crate::directory::Security::parse(s).as_str().to_string())
        .unwrap_or_else(|| previous.security.clone());
    let verify_certificate = dto.verify_certificate.unwrap_or(previous.verify_certificate);
    let ca_certificate = dto
        .ca_certificate
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.ca_certificate.clone());
    let connect_timeout_s = dto
        .connect_timeout_s
        .map(|v| v.clamp(1, 120))
        .unwrap_or(previous.connect_timeout_s);
    let bind_dn = dto
        .bind_dn
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.bind_dn.clone());
    let bind_password_enc = password_enc
        .clone()
        .unwrap_or_else(|| previous.bind_password_enc.clone());
    let base_dn = dto
        .base_dn
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.base_dn.clone());
    let user_filter = dto
        .user_filter
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.user_filter.clone());
    let user_scope = dto
        .user_scope
        .as_deref()
        .map(|s| crate::directory::model::Scope::parse(s).as_str().to_string())
        .unwrap_or_else(|| previous.user_scope.clone());
    let attr_username = dto
        .attr_username
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.attr_username.clone());
    let attr_email = dto
        .attr_email
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.attr_email.clone());
    let attr_display_name = dto
        .attr_display_name
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.attr_display_name.clone());
    let attr_unique_id = dto
        .attr_unique_id
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.attr_unique_id.clone());
    let attr_member_of = dto
        .attr_member_of
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.attr_member_of.clone());
    let sync_groups = dto.sync_groups.unwrap_or(previous.sync_groups);
    let group_base_dn = dto
        .group_base_dn
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.group_base_dn.clone());
    let group_filter = dto
        .group_filter
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.group_filter.clone());
    let attr_group_name = dto
        .attr_group_name
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.attr_group_name.clone());
    let attr_group_member = dto
        .attr_group_member
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| previous.attr_group_member.clone());
    let sync_enabled = dto.sync_enabled.unwrap_or(previous.sync_enabled);
    let sync_interval_min = dto
        .sync_interval_min
        .map(|v| v.clamp(5, 10_080))
        .unwrap_or(previous.sync_interval_min);
    let on_missing = dto
        .on_missing
        .as_deref()
        .map(|s| crate::directory::OnMissing::parse(s).as_str().to_string())
        .unwrap_or_else(|| previous.on_missing.clone());
    let allow_signup = dto.allow_signup.unwrap_or(previous.allow_signup);
    let position = dto.position.unwrap_or(previous.position);
    let default_org_unit_id = if dto.clear_default_org_unit {
        None
    } else {
        dto.default_org_unit_id.or(previous.default_org_unit_id)
    };

    tx.execute(
        r#"UPDATE core.ldap_directories SET
               display_name = $2, enabled = $3, host = $4, port = $5, security = $6,
               verify_certificate = $7, ca_certificate = $8, connect_timeout_s = $9,
               bind_dn = $10, bind_password_enc = $11, base_dn = $12, user_filter = $13,
               user_scope = $14, attr_username = $15, attr_email = $16, attr_display_name = $17,
               attr_unique_id = $18, attr_member_of = $19, sync_groups = $20, group_base_dn = $21,
               group_filter = $22, attr_group_name = $23, attr_group_member = $24,
               sync_enabled = $25, sync_interval_min = $26, on_missing = $27, allow_signup = $28,
               position = $29, default_org_unit_id = $30, updated_at = $31
           WHERE id = $1"#,
        params![
            id,
            &display_name,
            enabled,
            &host,
            port,
            &security,
            verify_certificate,
            &ca_certificate,
            connect_timeout_s,
            &bind_dn,
            &bind_password_enc,
            &base_dn,
            &user_filter,
            &user_scope,
            &attr_username,
            &attr_email,
            &attr_display_name,
            &attr_unique_id,
            &attr_member_of,
            sync_groups,
            &group_base_dn,
            &group_filter,
            &attr_group_name,
            &attr_group_member,
            sync_enabled,
            sync_interval_min,
            &on_missing,
            allow_signup,
            position,
            default_org_unit_id,
            now,
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "update_directory: write");
        AppError::Database(e)
    })?;

    // Reconstruct the updated row from the merged values just written.
    let row = LdapDirectory {
        id: previous.id,
        slug: previous.slug.clone(),
        display_name,
        enabled,
        host,
        port,
        security,
        verify_certificate,
        ca_certificate,
        connect_timeout_s,
        bind_dn,
        bind_password_enc,
        base_dn,
        user_filter,
        user_scope,
        attr_username,
        attr_email,
        attr_display_name,
        attr_unique_id,
        attr_member_of,
        sync_groups,
        group_base_dn,
        group_filter,
        attr_group_name,
        attr_group_member,
        sync_enabled,
        sync_interval_min,
        on_missing,
        allow_signup,
        last_sync_at: previous.last_sync_at,
        last_sync_status: previous.last_sync_status.clone(),
        last_sync_detail: previous.last_sync_detail.clone(),
        default_org_unit_id,
        position,
        created_at: previous.created_at,
        updated_at: now,
    };

    let view = AdminLdapDirectory::from(row.clone());
    let mut entry = AuditEntry::new("core.directory.update")
        .target(target::LDAP_DIRECTORY, row.id, row.display_name.clone())
        .before(snap(target::LDAP_DIRECTORY, &AdminLdapDirectory::from(previous)))
        .after(snap(target::LDAP_DIRECTORY, &view))
        .reversible();
    // A rotated credential is worth knowing about even though its value never
    // appears: the note says "it changed", nothing more.
    if let Some(p) = password_enc.as_deref() {
        entry = entry.detail(if p.is_empty() {
            "mot de passe du compte de service effacé"
        } else {
            "mot de passe du compte de service renouvelé"
        });
    }
    tx.commit(entry).await?;

    if row.enabled && row.sync_enabled {
        job::schedule_one(&state.db, row.id).await;
    }

    tracing::info!(directory = %row.slug, "Annuaire mis à jour");
    Ok(Json(json!({ "directory": view })))
}

// ── Delete ───────────────────────────────────────────────────────────────────

/// Removes a directory. Accounts it governed are **deactivated**, never deleted.
///
/// Deactivating them first is not politeness, it is what makes the deletion
/// possible: `ldap_directory_id` is `ON DELETE SET NULL`, so an account with no
/// password hash and no OIDC subject would end up naming no authenticator at
/// all, and the `password_or_external` constraint refuses that unless the
/// account is inactive. Accounts that still hold a local password keep working
/// exactly as before.
pub async fn delete_directory(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUTH_PROVIDERS_MANAGE)?;

    // The struct cannot be read back inside the transaction (DbTx has no typed
    // read); the directory is read up front and the writes lock it.
    let previous = state
        .db
        .fetch_optional_as::<LdapDirectory>(
            "SELECT * FROM core.ldap_directories WHERE id = $1",
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "delete_directory: read");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Annuaire introuvable".into()))?;

    let mut tx = audit.begin(&state.db).await?;

    let deactivated = tx
        .execute(
            "UPDATE core.users SET is_active = FALSE
              WHERE ldap_directory_id = $1 AND password_hash IS NULL AND oauth_provider IS NULL",
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "delete_directory: deactivating governed accounts");
            AppError::Database(e)
        })?;

    // Imported groups lose their link but keep their members: a group somebody
    // built a share on must not evaporate because a directory was detached.
    tx.execute(
        "UPDATE core.user_group_members SET source = 'manual' WHERE group_id IN (SELECT id FROM core.user_groups WHERE ldap_directory_id = $1)",
        params![id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "delete_directory: imported memberships");
        AppError::Database(e)
    })?;

    tx.execute("DELETE FROM core.ldap_directories WHERE id = $1", params![id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "delete_directory");
            AppError::Database(e)
        })?;

    let label = previous.display_name.clone();
    tx.commit(
        AuditEntry::new("core.directory.delete")
            .target(target::LDAP_DIRECTORY, id, label)
            .before(snap(target::LDAP_DIRECTORY, &AdminLdapDirectory::from(previous)))
            .detail(format!(
                "{deactivated} compte(s) sans mot de passe local désactivé(s) - aucune donnée supprimée"
            )),
    )
    .await?;

    Ok(Json(json!({
        "message": "Annuaire supprimé",
        "deactivated_accounts": deactivated,
    })))
}

// ── Probes ───────────────────────────────────────────────────────────────────

pub async fn test_directory(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUTH_PROVIDERS_READ)?;
    let dir = dircfg::load(&state.db, id).await?;
    let result = probe::probe_connection(&state.settings.auth.jwt_secret, &dir).await;

    audit
        .record(
            &state.db,
            AuditEntry::new("core.directory.test")
                .target(target::LDAP_DIRECTORY, dir.id, dir.display_name.clone())
                .detail(crate::directory::client::truncate(&result.message)),
        )
        .await;

    Ok(Json(serde_json::to_value(result).unwrap_or_else(|_| json!({}))))
}

#[derive(Deserialize)]
pub struct TestAuthDto {
    pub login: String,
    pub password: String,
}

/// Hand-written: a derived `Debug` on a struct holding somebody's password is
/// how that password reaches the first log line added while debugging.
impl std::fmt::Debug for TestAuthDto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TestAuthDto")
            .field("login", &self.login)
            .field("password", &crate::audit::redact::REDACTED)
            .finish()
    }
}

pub async fn test_directory_auth(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<TestAuthDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUTH_PROVIDERS_MANAGE)?;
    if dto.login.trim().is_empty() || dto.password.is_empty() {
        return Err(AppError::Validation("Identifiant et mot de passe requis".into()));
    }
    let dir = dircfg::load(&state.db, id).await?;
    let result = probe::probe_authentication(
        &state.db,
        &state.settings.auth.jwt_secret,
        &dir,
        dto.login.trim(),
        &dto.password,
    )
    .await;

    // The login is recorded, the password is not - and never was: it exists in
    // one stack frame and is dropped there.
    audit
        .record(
            &state.db,
            AuditEntry::new("core.directory.test_auth")
                .target(target::LDAP_DIRECTORY, dir.id, dir.display_name.clone())
                .detail(format!(
                    "essai d'authentification pour « {} » : {}",
                    dto.login.trim(),
                    result.message
                )),
        )
        .await;

    Ok(Json(serde_json::to_value(result).unwrap_or_else(|_| json!({}))))
}

// ── Synchronise now ──────────────────────────────────────────────────────────

pub async fn sync_directory(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUTH_PROVIDERS_MANAGE)?;
    let dir = dircfg::load(&state.db, id).await?;

    // Synchronous on purpose: the operator pressed a button and wants the count.
    // `sync::run` writes its own audit entry and its own `last_sync_*`.
    let report = sync::run(&state.db, &state.settings.auth.jwt_secret, &dir).await?;

    audit
        .record(
            &state.db,
            AuditEntry::new("core.directory.sync_requested")
                .target(target::LDAP_DIRECTORY, dir.id, dir.display_name.clone())
                .detail(report.summary()),
        )
        .await;

    Ok(Json(json!({ "report": report })))
}

// ── Handing an account over to the directory ─────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct GovernDto {
    /// Accounts to hand over. Empty with `all = true` means every account this
    /// directory already governs and that still holds a local password.
    #[serde(default)]
    pub user_ids: Vec<Uuid>,
    #[serde(default)]
    pub all: bool,
}

/// Clears the local password of accounts the directory governs, so the
/// directory becomes their sole authority.
///
/// This is deliberately an explicit action rather than something a
/// synchronisation does. A sync that seized every account it matched would make
/// the console itself depend on the directory being reachable the first time it
/// ran over the administrator's address - which is exactly the failure mode this
/// whole subsystem is written to avoid.
///
/// The guard below is the same idea one level down: whatever the operator asks
/// for, at least one **active administrator with a local password** has to
/// remain. There is always a way back in.
pub async fn govern_accounts(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<GovernDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUTH_PROVIDERS_MANAGE)?;
    let dir = dircfg::load(&state.db, id).await?;

    if dto.user_ids.is_empty() && !dto.all {
        return Err(AppError::Validation("Aucun compte désigné".into()));
    }

    let backend = state.db.backend();

    // Candidates: governed by this directory, still holding a local password.
    // Read on the pool because `= ANY(array)` (a PostgreSQL-only construct) is
    // replaced by a variadic `IN (...)` a query builder emits, and DbTx offers no
    // multi-row read. The `FOR UPDATE` lock is therefore given up here; the
    // decisive guard and the write below still run together in the transaction.
    let mut qb = DbQueryBuilder::new(backend, "SELECT id, username, role FROM core.users");
    qb.push(" WHERE ldap_directory_id = ").push_bind(id);
    qb.push(" AND password_hash IS NOT NULL AND (")
        .push_bind(dto.all)
        .push(" OR id")
        .push_in(dto.user_ids.clone())
        .push(")");
    let candidates: Vec<(Uuid, String, String)> = qb.fetch_all_as(&state.db).await.map_err(|e| {
        tracing::error!(error = %e, "govern_accounts: reading candidates");
        AppError::Database(e)
    })?;

    if candidates.is_empty() {
        return Err(AppError::Validation(
            "Aucun compte concerné : ces comptes n'ont pas de mot de passe local, ou ne dépendent pas de cet annuaire".into(),
        ));
    }

    let ids: Vec<Uuid> = candidates.iter().map(|(id, _, _)| *id).collect();

    let mut tx = audit.begin(&state.db).await?;

    // How many active administrators would still hold a local password
    // afterwards. Zero is refused, whatever was asked.
    let count_sql = format!(
        "SELECT {} FROM core.users \
          WHERE role = 'admin' AND is_active = TRUE AND password_hash IS NOT NULL AND NOT (id",
        backend.count_bigint("*"),
    );
    let mut qb = DbQueryBuilder::new(backend, count_sql);
    qb.push_in(ids.clone()).push(")");
    let remaining_local_admins: i64 = qb
        .tx_fetch_optional_scalar::<i64>(&mut tx)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "govern_accounts: counting local administrators");
            AppError::Database(e)
        })?
        .unwrap_or(0);

    if remaining_local_admins <= 0 {
        return Err(AppError::Validation(
            "Refusé : plus aucun administrateur ne pourrait se connecter sans l'annuaire. \
             Conservez au moins un compte d'administration avec un mot de passe local."
                .into(),
        ));
    }

    let mut qb = DbQueryBuilder::new(
        backend,
        "UPDATE core.users SET password_hash = NULL, must_change_password = FALSE WHERE id",
    );
    qb.push_in(ids.clone());
    let affected = qb.tx_execute(&mut tx).await.map_err(|e| {
        tracing::error!(error = %e, "govern_accounts: clearing local passwords");
        AppError::Database(e)
    })?;

    let names: Vec<String> = candidates.iter().map(|(_, n, _)| n.clone()).collect();
    tx.commit(
        AuditEntry::new("core.directory.govern")
            .target(target::LDAP_DIRECTORY, dir.id, dir.display_name.clone())
            .detail(crate::directory::client::truncate(&format!(
                "{affected} compte(s) désormais authentifié(s) uniquement par l'annuaire : {}",
                names.join(", ")
            )))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({
        "message": "Comptes confiés à l'annuaire",
        "affected": affected,
        "remaining_local_admins": remaining_local_admins,
    })))
}
