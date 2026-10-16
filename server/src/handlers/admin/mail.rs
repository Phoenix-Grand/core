//! Administration of the outgoing mail relay: read, write, and prove it works.
//!
//! The password is the one value with asymmetric handling: it goes **in** in
//! clear (over the authenticated admin channel, once), is stored encrypted, and
//! never comes back out. `GET` reports `has_password: true`, nothing else - not
//! a masked form of the value, not its length, since both leak.
//!
//! `POST /admin/mail/test` is the only synchronous send in the whole module.
//! That is the point of it: an operator debugging a relay needs the server's own
//! answer ("535 5.7.8 Username and Password not accepted"), and a queued job
//! that fails three times in the background half an hour later tells them
//! nothing. The raw answer is truncated (`send::MAX_ERROR_LEN`) and passed
//! through verbatim otherwise.

use axum::{extract::State, Json};
use chrono::Utc;
use kubuno_db::{params, DbPool};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    authz::{keys, AdminCtx},
    audit::{redact, redact::target, AdminAudit, AuditEntry},
    auth::middleware::AdminUser,
    errors::AppError,
    mailer::{
        self,
        config::{self, MailConfig},
        send::{self, Outgoing},
        templates,
    },
    state::AppState,
};

/// Longest value accepted for any free-text relay field. Generous for a
/// hostname or a display name, bounded so a settings row cannot become a blob.
const MAX_FIELD: usize = 255;

/// GET /admin/mail/settings
pub async fn get_mail_settings(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::MAIL_READ)?;
    let cfg = MailConfig::load(&state.db, &state.settings.auth.jwt_secret).await?;

    Ok(Json(json!({
        "enabled":      cfg.enabled,
        "host":         cfg.host,
        "port":         cfg.port,
        "security":     cfg.security.as_str(),
        "username":     cfg.username,
        // Never the value, never a masked form of it, never its length.
        "has_password": !cfg.password.is_empty(),
        "from_address": cfg.from_address,
        "from_name":    cfg.from_name,
        "public_url":   cfg.public_url,
        // Lets the screen tell "not configured yet" from "configured but off".
        "usable":       cfg.is_usable(),
    })))
}

#[derive(Deserialize)]
pub struct UpdateMailSettingsDto {
    pub enabled:      Option<bool>,
    pub host:         Option<String>,
    pub port:         Option<u16>,
    pub security:     Option<String>,
    pub username:     Option<String>,
    /// Absent = keep the stored password. Empty string = clear it (a relay that
    /// stops requiring authentication). Any other value replaces it.
    pub password:     Option<String>,
    pub from_address: Option<String>,
    pub from_name:    Option<String>,
    pub public_url:   Option<String>,
}

/// Hand-written: `#[derive(Debug)]` on a struct holding a password is how the
/// password ends up in a log the first time anyone debugs this handler.
impl std::fmt::Debug for UpdateMailSettingsDto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpdateMailSettingsDto")
            .field("enabled", &self.enabled)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("security", &self.security)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "«rédigé»"))
            .field("from_address", &self.from_address)
            .field("from_name", &self.from_name)
            .field("public_url", &self.public_url)
            .finish()
    }
}

/// Very small syntactic check - enough to reject a typo, not a claim that the
/// mailbox exists. `lettre` parses the address for real when the message is
/// built; this only stops garbage from reaching the settings table.
fn validate_address(value: &str) -> Result<(), AppError> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(()); // clearing the sender is allowed; `is_usable` catches it
    }
    let mut parts = value.split('@');
    let (local, domain) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let ok = parts.next().is_none()
        && !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !value.chars().any(char::is_whitespace)
        && value.len() <= MAX_FIELD;
    if ok {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "Adresse invalide : « {value} »"
        )))
    }
}

fn validate_host(value: &str) -> Result<(), AppError> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(());
    }
    let ok = value.len() <= MAX_FIELD
        && !value.chars().any(char::is_whitespace)
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':');
    if ok {
        Ok(())
    } else {
        Err(AppError::Validation(
            "Hôte SMTP invalide (nom d'hôte ou adresse IP attendu)".into(),
        ))
    }
}

fn validate_public_url(value: &str) -> Result<(), AppError> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(());
    }
    match url::Url::parse(value) {
        Ok(u) if (u.scheme() == "https" || u.scheme() == "http") && u.host().is_some() => Ok(()),
        _ => Err(AppError::Validation(
            "URL publique invalide (URL http(s) absolue attendue)".into(),
        )),
    }
}

/// Writes one setting inside the audited transaction and queues its trail entry.
///
/// The whole point of routing through `redact::setting` is that
/// `mail.smtp_password` is *not* on the value whitelist, so its entry records
/// that the key changed with «rédigé» on both sides - the reader learns a
/// credential rotated without learning it.
async fn write_setting(
    tx: &mut crate::audit::AuditTx,
    admin_id: uuid::Uuid,
    key: &str,
    value: Value,
    entries: &mut Vec<AuditEntry>,
) -> Result<(), AppError> {
    // FOR UPDATE read inside the audited transaction (`DbTx` methods reached
    // through the `AuditTx` deref).
    let for_update = tx.backend().for_update();
    let previous: Option<Value> = tx
        .fetch_optional_scalar::<Value>(
            &format!(
                "SELECT value FROM core.settings WHERE \"key\" = $1{}",
                for_update
            ),
            params![key],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, key = %key, "mail settings: lecture");
            AppError::Database(e)
        })?;

    // A relay setting missing from `core.settings` means migration 000043 did
    // not run; inserting it here keeps the screen usable instead of 404-ing.
    let previous = match previous {
        Some(v) => v,
        None => {
            // The stored value is a JSON null; it is bound as a parameter rather
            // than written as PostgreSQL's `'null'::jsonb` literal, and the
            // conflict clause is spelt per engine.
            let backend = tx.backend();
            let sql = format!(
                "INSERT {}INTO core.settings (\"key\", value, category, is_public) \
                 VALUES ($1, $2, 'mail', FALSE){}",
                backend.insert_ignore_prefix(),
                backend.on_conflict_do_nothing(&["key"]),
            );
            tx.execute(&sql, params![key, Value::Null])
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, key = %key, "mail settings: création");
                    AppError::Database(e)
                })?;
            Value::Null
        }
    };

    if previous == value {
        return Ok(()); // nothing changed: no write, no trail noise
    }

    tx.execute(
        "UPDATE core.settings SET value = $1, updated_at = $2, updated_by = $3 WHERE \"key\" = $4",
        params![value.clone(), Utc::now(), admin_id, key],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, key = %key, "mail settings: écriture");
        AppError::Database(e)
    })?;

    entries.push(
        AuditEntry::new("core.mail.settings.change")
            .target(target::SETTING, key, key.to_string())
            .before(redact::setting(key, &previous))
            .after(redact::setting(key, &value))
            .reversible(),
    );
    Ok(())
}

/// PATCH /admin/mail/settings
pub async fn update_mail_settings(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<UpdateMailSettingsDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::MAIL_MANAGE)?;
    // Every input is validated before a single row is touched.
    if let Some(host) = &dto.host {
        validate_host(host)?;
    }
    if let Some(from) = &dto.from_address {
        validate_address(from)?;
    }
    if let Some(url) = &dto.public_url {
        validate_public_url(url)?;
    }
    if let Some(security) = &dto.security {
        if !["none", "starttls", "tls"].contains(&security.as_str()) {
            return Err(AppError::Validation(
                "Chiffrement invalide : aucun, starttls ou tls".into(),
            ));
        }
    }
    if let Some(port) = dto.port {
        if port == 0 {
            return Err(AppError::Validation("Port SMTP invalide".into()));
        }
    }
    for (label, value) in [
        ("Identifiant SMTP", dto.username.as_deref()),
        ("Nom d'expédition", dto.from_name.as_deref()),
    ] {
        if value.is_some_and(|v| v.len() > MAX_FIELD) {
            return Err(AppError::Validation(format!("{label} : 255 caractères maximum")));
        }
    }
    if dto.password.as_deref().is_some_and(|p| p.len() > 512) {
        return Err(AppError::Validation(
            "Mot de passe SMTP : 512 caractères maximum".into(),
        ));
    }

    // The password is encrypted before the transaction opens, so a crypto
    // failure cannot leave a half-written configuration behind.
    let password_blob = match dto.password.as_deref() {
        None => None,
        Some(plain) => Some(config::encrypt_password(
            &state.settings.auth.jwt_secret,
            plain,
        )?),
    };

    let mut tx = audit.begin(&state.db).await?;
    let admin_id = audit.admin.id;
    let mut entries: Vec<AuditEntry> = Vec::new();

    if let Some(v) = dto.enabled {
        write_setting(&mut tx, admin_id, config::KEY_ENABLED, json!(v), &mut entries).await?;
    }
    if let Some(v) = &dto.host {
        write_setting(&mut tx, admin_id, config::KEY_HOST, json!(v.trim()), &mut entries).await?;
    }
    if let Some(v) = dto.port {
        write_setting(&mut tx, admin_id, config::KEY_PORT, json!(v), &mut entries).await?;
    }
    if let Some(v) = &dto.security {
        write_setting(&mut tx, admin_id, config::KEY_SECURITY, json!(v), &mut entries).await?;
    }
    if let Some(v) = &dto.username {
        write_setting(&mut tx, admin_id, config::KEY_USERNAME, json!(v), &mut entries).await?;
    }
    if let Some(blob) = &password_blob {
        write_setting(&mut tx, admin_id, config::KEY_PASSWORD, json!(blob), &mut entries).await?;
    }
    if let Some(v) = &dto.from_address {
        write_setting(&mut tx, admin_id, config::KEY_FROM_ADDRESS, json!(v.trim()), &mut entries).await?;
    }
    if let Some(v) = &dto.from_name {
        write_setting(&mut tx, admin_id, config::KEY_FROM_NAME, json!(v), &mut entries).await?;
    }
    if let Some(v) = &dto.public_url {
        let trimmed = v.trim().trim_end_matches('/');
        write_setting(&mut tx, admin_id, config::KEY_PUBLIC_URL, json!(trimmed), &mut entries).await?;
    }

    // `AuditTx` cannot be committed without an entry - a PATCH that changed
    // nothing has nothing to write either.
    let Some(last) = entries.pop() else {
        return Ok(Json(json!({ "message": "Aucun réglage modifié", "updated": 0 })));
    };
    let updated = entries.len() + 1;
    for entry in entries {
        tx.also(entry);
    }
    tx.commit(last).await?;

    // Reconfiguring the relay invalidates the "it was tested" verdict, and the
    // health report caches it.
    crate::health::invalidate();

    Ok(Json(json!({ "message": "Relais de courriel mis à jour", "updated": updated })))
}

#[derive(Debug, Deserialize)]
pub struct TestMailDto {
    /// Recipient of the probe. Defaults to the administrator's own address -
    /// the only address we know for certain they can read.
    pub to: Option<String>,
}

/// POST /admin/mail/test - sends one message, synchronously, and reports the
/// relay's own answer.
pub async fn test_mail(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<TestMailDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::MAIL_MANAGE)?;
    let to = dto
        .to
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&audit.admin.email)
        .to_string();
    validate_address(&to)?;

    let cfg = MailConfig::load(&state.db, &state.settings.auth.jwt_secret).await?;

    // Refuse early with a sentence that says which field is missing, rather than
    // letting lettre fail with "invalid hostname" on an empty string.
    if cfg.host.is_empty() {
        return Err(AppError::Validation(
            "Renseignez l'hôte SMTP avant d'envoyer un test".into(),
        ));
    }
    if cfg.from_address.is_empty() {
        return Err(AppError::Validation(
            "Renseignez l'adresse d'expédition avant d'envoyer un test".into(),
        ));
    }

    // The test message goes to the administrator running the test, so it is
    // rendered exactly like a real one: their language if they chose one, the
    // instance's otherwise, dated in the instance zone.
    let audience = mailer::audience(&state.db, Some(audit.admin.id), &audit.admin.preferences).await;
    let display = audit
        .admin
        .display_name
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| audit.admin.username.clone());
    let rendered = templates::test_message(audience.locale, &cfg, &display, audience.stamp());

    let started = std::time::Instant::now();
    let outcome = send::deliver(
        &cfg,
        &Outgoing {
            to:      to.clone(),
            to_name: Some(display),
            subject: rendered.subject,
            html:    rendered.html,
            text:    rendered.text,
        },
    )
    .await;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    // The probe mutates nothing, so it takes the standalone-entry path. It is
    // still recorded: "who tried to reach which relay, with what result" is
    // exactly what an operator wants after a support call. The recipient is on
    // the entry; the message body never is.
    let base = AuditEntry::new("core.mail.test")
        .target_kind(target::SETTING, format!("{}:{}", cfg.host, cfg.port));

    match outcome {
        Ok(()) => {
            record_successful_test(&state.db).await;
            audit
                .record(&state.db, base.detail(format!("Test envoyé à {to}")))
                .await;
            Ok(Json(json!({
                "ok":         true,
                "message":    format!("Message de test envoyé à {to}."),
                "to":         to,
                "host":       cfg.host,
                "port":       cfg.port,
                "security":   cfg.security.as_str(),
                "elapsed_ms": elapsed_ms,
            })))
        }
        Err(err) => {
            audit
                .record(&state.db, base.failed(format!("{} - {}", err.stage, err.raw)))
                .await;
            // 200 with `ok: false`, not a 5xx: the request itself succeeded, and
            // the screen needs the payload to display the diagnosis.
            Ok(Json(json!({
                "ok":         false,
                "message":    err.stage,
                "detail":     err.raw,
                "to":         to,
                "host":       cfg.host,
                "port":       cfg.port,
                "security":   cfg.security.as_str(),
                "elapsed_ms": elapsed_ms,
                "hint":       hint_for(&err, &cfg),
            })))
        }
    }
}

/// Turns the most common failures into the one sentence that fixes them.
/// Purely advisory - the raw relay answer is always shown next to it.
fn hint_for(err: &send::SendError, cfg: &MailConfig) -> Option<String> {
    let raw = err.raw.to_lowercase();
    if raw.contains("connection refused") || raw.contains("refused") {
        return Some(format!(
            "Aucun service n'écoute sur {}:{}. Vérifiez l'hôte et le port.",
            cfg.host, cfg.port
        ));
    }
    if raw.contains("timed out") || raw.contains("timeout") {
        return Some(
            "Le relais ne répond pas : pare-feu, port bloqué, ou hôte injoignable.".into(),
        );
    }
    if raw.contains("535") || raw.contains("authentication") || raw.contains("auth") {
        return Some(
            "Le relais a refusé les identifiants. Vérifiez l'identifiant et le mot de passe \
             (certains fournisseurs exigent un mot de passe d'application)."
                .into(),
        );
    }
    if raw.contains("tls") || raw.contains("certificate") || raw.contains("handshake") {
        return Some(format!(
            "Échec TLS avec le mode « {} ». Essayez starttls sur le port 587, ou tls sur le 465.",
            cfg.security.as_str()
        ));
    }
    if raw.contains("relay") && raw.contains("denied") {
        return Some(
            "Le relais refuse de router ce message : l'adresse d'expédition n'est probablement \
             pas autorisée sur ce serveur."
                .into(),
        );
    }
    None
}

/// Records that the relay actually delivered something, just now.
///
/// Written outside the audit transaction on purpose: the test itself already
/// succeeded, and failing to bookkeep must never turn a working relay into an
/// error on screen. A failure here is logged and the health check simply falls
/// back to the audit trail, which is where this fact used to live exclusively.
async fn record_successful_test(db: &DbPool) {
    let now = Utc::now().to_rfc3339();
    if let Err(e) = db
        .execute(
            "UPDATE core.settings SET value = $1, updated_at = $2 WHERE \"key\" = $3",
            params![json!(now), Utc::now(), mailer::config::KEY_LAST_TEST_OK],
        )
        .await
    {
        tracing::error!(error = %e, "mail: enregistrement du dernier test réussi");
    }
    // The health report caches "has this relay ever delivered?" for a minute.
    crate::health::invalidate();
}

/// True when `key` belongs to the relay, and must therefore be refused by the
/// generic settings route. Exposed for `handlers::admin::settings`.
pub fn owns_setting(key: &str) -> bool {
    mailer::config::ALL_KEYS.contains(&key)
}

/// Category of the relay settings, hidden from the generic settings list for
/// the same reason module-owned settings are.
pub const CATEGORY: &str = "mail";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mailer::config::Security;

    #[test]
    fn addresses_are_checked_loosely_but_usefully() {
        assert!(validate_address("a@b.co").is_ok());
        assert!(validate_address("prenom.nom+tag@sous.domaine.fr").is_ok());
        assert!(validate_address("").is_ok()); // clearing is allowed
        assert!(validate_address("sans-arobase").is_err());
        assert!(validate_address("deux@@arobases.fr").is_err());
        assert!(validate_address("a@nodot").is_err());
        assert!(validate_address("a b@c.fr").is_err());
        assert!(validate_address("a@.fr").is_err());
    }

    #[test]
    fn hosts_reject_urls_and_whitespace() {
        assert!(validate_host("smtp.exemple.com").is_ok());
        assert!(validate_host("127.0.0.1").is_ok());
        assert!(validate_host("").is_ok());
        assert!(validate_host("smtp exemple").is_err());
        assert!(validate_host("https://smtp.exemple.com").is_err());
    }

    #[test]
    fn public_url_must_be_absolute_http() {
        assert!(validate_public_url("https://cloud.exemple.com").is_ok());
        assert!(validate_public_url("http://localhost:8080").is_ok());
        assert!(validate_public_url("").is_ok());
        assert!(validate_public_url("cloud.exemple.com").is_err());
        assert!(validate_public_url("ftp://cloud.exemple.com").is_err());
    }

    #[test]
    fn relay_keys_are_recognised_as_owned() {
        assert!(owns_setting("mail.smtp_password"));
        assert!(owns_setting("mail.smtp_host"));
        assert!(!owns_setting("security.max_sessions"));
    }

    #[test]
    fn hints_point_at_the_actual_fix() {
        let cfg = MailConfig {
            enabled: true, host: "smtp.exemple.com".into(), port: 587,
            security: Security::Starttls, username: "u".into(), password: "p".into(),
            from_address: "a@b.co".into(), from_name: "K".into(), public_url: String::new(),
        };
        let refused = send::SendError { stage: "Envoi SMTP", raw: "Connection refused (os error 111)".into() };
        assert!(hint_for(&refused, &cfg).unwrap_or_default().contains("587"));

        let auth = send::SendError { stage: "Envoi SMTP", raw: "535 5.7.8 Authentication failed".into() };
        assert!(hint_for(&auth, &cfg).unwrap_or_default().contains("identifiants"));

        let unknown = send::SendError { stage: "Envoi SMTP", raw: "quelque chose d'inédit".into() };
        assert!(hint_for(&unknown, &cfg).is_none());
    }

    #[test]
    fn the_dto_debug_never_prints_a_password() {
        let dto = UpdateMailSettingsDto {
            enabled: Some(true), host: Some("smtp.exemple.com".into()), port: Some(587),
            security: Some("starttls".into()), username: Some("u".into()),
            password: Some("hunter2".into()), from_address: None, from_name: None,
            public_url: None,
        };
        let rendered = format!("{dto:?}");
        assert!(!rendered.contains("hunter2"), "mot de passe fuité : {rendered}");
        assert!(rendered.contains("«rédigé»"));
        // A DTO without a password says so, rather than pretending one exists.
        let empty = UpdateMailSettingsDto {
            enabled: None, host: None, port: None, security: None, username: None,
            password: None, from_address: None, from_name: None, public_url: None,
        };
        assert!(format!("{empty:?}").contains("password: None"));
    }
}
