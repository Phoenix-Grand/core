//! `POST /admin/users/:id/reset-password` - the administrator's way back in.
//!
//! Deliberately a file of its own rather than another function in
//! `handlers/admin/users.rs`: it is the one administrative action that touches a
//! credential, and keeping its guards, its audit shape and its notification
//! path in one readable place is worth more than proximity to the CRUD.
//!
//! ## What one call does, atomically
//!
//! 1. replaces `password_hash` (a generated password, or one the operator typed);
//! 2. sets or clears `must_change_password`;
//! 3. **revokes every refresh token of the account** - a password change that
//!    leaves the open sessions alive protects nothing at all: whoever holds a
//!    live session keeps it, which is precisely the attacker one resets against;
//! 4. writes the audit entry, in the same commit (see [`crate::audit`]).
//!
//! ## What never reaches the trail or the logs
//!
//! The password, in any form - not the plaintext, not the argon2 hash, not its
//! length. The `USER` whitelist in `audit/redact.rs` has no field that could
//! carry it, and the `detail` line is built from counters only.
//!
//! ## Why the response *can* carry the password
//!
//! Only when the server generated it, and only then: the operator has no other
//! way to hand it to the person standing in front of them, which is the entire
//! point of "generate automatically". When the operator typed the password
//! themselves it is not echoed back - they already have it, and echoing it would
//! put it in one more place for no gain.

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use chrono::Utc;
use kubuno_db::params;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{redact, redact::target, AdminAudit, AuditEntry},
    authz::{
        guards::{ensure_can_act_on_user, user_org_unit},
        keys, AdminCtx,
    },
    crypto::password,
    errors::AppError,
    mailer,
    state::AppState,
};

/// Same floor as `CreateUserDto` and `ResetPasswordDto`: an administrator must
/// not be able to set a weaker password than a user can.
const MIN_PASSWORD_LEN: usize = 8;

/// Guards against a paste accident filling `password_hash` with a novel.
const MAX_PASSWORD_LEN: usize = 256;

#[derive(Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ResetMode {
    /// Server generates a strong password (the default, and the safe one).
    #[default]
    Generate,
    /// The operator supplies it.
    Manual,
}

#[derive(Deserialize)]
pub struct AdminResetPasswordDto {
    #[serde(default)]
    pub mode: ResetMode,
    /// Required when `mode = manual`, ignored otherwise.
    pub password: Option<String>,
    /// Ask for a new password at the next sign-in. Defaults to true - an
    /// administrator knowing a user's password is a transient state, not a
    /// steady one.
    #[serde(default = "default_true")]
    pub require_change: bool,
    /// Mail the outcome to the account (or to `email_to`).
    #[serde(default)]
    pub send_email: bool,
    /// Alternate recipient, e.g. a personal address for someone locked out of
    /// the very mailbox this instance hosts.
    pub email_to: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Hand-written for the same reason as everywhere else in this codebase: the
/// derive would print the password.
impl std::fmt::Debug for AdminResetPasswordDto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AdminResetPasswordDto")
            .field("mode", &match self.mode {
                ResetMode::Generate => "generate",
                ResetMode::Manual => "manual",
            })
            .field("password", &self.password.as_ref().map(|_| "«rédigé»"))
            .field("require_change", &self.require_change)
            .field("send_email", &self.send_email)
            .field("email_to", &self.email_to)
            .finish()
    }
}

/// Same loose syntactic check as the relay settings: reject a typo, do not
/// pretend to verify the mailbox exists.
fn validate_address(value: &str) -> Result<(), AppError> {
    let mut parts = value.split('@');
    let (local, domain) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let ok = parts.next().is_none()
        && !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !value.chars().any(char::is_whitespace)
        && value.len() <= 255;
    if ok {
        Ok(())
    } else {
        Err(AppError::Validation(format!("Adresse invalide : « {value} »")))
    }
}

/// Trail label for a user: readable without a join, still meaningful once the
/// account is deleted.
fn user_label(username: &str, email: &str, display_name: Option<&str>) -> String {
    match display_name {
        Some(name) if !name.is_empty() => format!("{name} <{email}>"),
        _ => format!("{username} <{email}>"),
    }
}

pub async fn reset_user_password(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Path(user_id): Path<Uuid>,
    headers: HeaderMap,
    Json(dto): Json<AdminResetPasswordDto>,
) -> Result<Json<Value>, AppError> {
    // ── Authorisation, before anything expensive ─────────────────────────────
    // This is the route guard 3 exists for. `core.user_password.execute` over the
    // root unit covers *every* account, super-administrators included, and a
    // password reset on a super-administrator is a complete takeover dressed up
    // as account maintenance. So: the privilege over the target's unit, AND the
    // target must not hold anything the caller does not hold.
    {
        let unit = user_org_unit(&state.db, user_id).await?;
        ctx.require_for_unit(keys::USER_PASSWORD, unit)?;
        ensure_can_act_on_user(&state.db, &ctx, user_id).await?;
    }

    // ── Validate before touching the database ────────────────────────────────
    //
    // Against the policy of the TARGET's scope (migration `000115`), not the
    // caller's: the account that will carry this password is the one the policy
    // is about. `MIN_PASSWORD_LEN` remains the floor the policy itself can never
    // go under, so this route can only ever become stricter, never weaker.
    let policy =
        crate::settings::password_policy::PasswordPolicy::for_user(&state.db, user_id).await?;

    let (new_password, generated) = match dto.mode {
        ResetMode::Generate => {
            // A generated password must satisfy the policy it is generated
            // under - an operator pressing "generate" and getting something the
            // instance then refuses would have no way to tell what happened.
            // Length is raised to the minimum; a "strong" requirement is met by
            // drawing again, the alphabet carrying all four families.
            let length = policy.min_length.max(password::GENERATED_LENGTH);
            let mut candidate = password::generate_password(length);
            for _ in 0..16 {
                if policy.check(&candidate).is_ok() {
                    break;
                }
                candidate = password::generate_password(length);
            }
            // Reachable only if the policy is unsatisfiable by the generator -
            // a minimum above what it can produce. Said plainly rather than
            // returning a password the next line would reject.
            policy.check(&candidate).map_err(|_| {
                tracing::error!(
                    min_length = policy.min_length,
                    "reset_user_password: la politique rend la génération impossible"
                );
                AppError::Validation(
                    "Impossible de générer un mot de passe satisfaisant la politique en vigueur : \
                     assouplissez-la ou saisissez le mot de passe manuellement."
                        .into(),
                )
            })?;
            (candidate, true)
        }
        ResetMode::Manual => {
            let supplied = dto
                .password
                .as_deref()
                .ok_or_else(|| AppError::Validation("Mot de passe requis en saisie manuelle".into()))?;
            if supplied.chars().count() < MIN_PASSWORD_LEN {
                return Err(AppError::Validation(format!(
                    "Mot de passe : {MIN_PASSWORD_LEN} caractères minimum"
                )));
            }
            if supplied.len() > MAX_PASSWORD_LEN {
                return Err(AppError::Validation(format!(
                    "Mot de passe : {MAX_PASSWORD_LEN} caractères maximum"
                )));
            }
            policy.check(supplied)?;
            // Only on a typed password: a generated one is 94 bits of CSPRNG
            // and paying N argon2id verifications to discover it is not one of
            // the account's five previous passwords is work for nothing.
            crate::settings::password_policy::reject_reuse(
                &state.db, &policy, user_id, supplied,
            )
            .await?;
            (supplied.to_string(), false)
        }
    };

    let email_override = match dto.email_to.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(addr) => {
            validate_address(addr)?;
            Some(addr.to_string())
        }
        None => None,
    };

    // Hashing is deliberate work (argon2id); doing it before `BEGIN` keeps the
    // transaction - and the row lock on the user - as short as possible.
    let hash = password::hash_password(&new_password).map_err(AppError::Internal)?;

    // ── Mutate, atomically, with the trail entry ─────────────────────────────
    let mut tx = audit.begin(&state.db).await?;

    // FOR UPDATE row read inside the transaction: `DbTx` cannot decode a struct,
    // so the columns are mapped by hand from a raw row.
    let for_update = tx.backend().for_update();
    let target_row = tx
        .fetch_optional_row(
            &format!(
                "SELECT username, email, display_name, must_change_password, role, preferences \
                 FROM core.users WHERE id = $1{}",
                for_update
            ),
            params![user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "reset_user_password: lecture de la cible");
            AppError::Database(e)
        })?;

    let Some(row) = target_row else {
        return Err(AppError::NotFound("Utilisateur introuvable".into()));
    };
    let username: String = row.try_get("username").map_err(AppError::Database)?;
    let email: String = row.try_get("email").map_err(AppError::Database)?;
    let display_name: Option<String> = row.try_get("display_name").map_err(AppError::Database)?;
    let was_must_change: bool = row.try_get("must_change_password").map_err(AppError::Database)?;
    let role: String = row.try_get("role").map_err(AppError::Database)?;
    let preferences: Value = row.try_get("preferences").map_err(AppError::Database)?;

    tx.execute(
        "UPDATE core.users \
            SET password_hash = $1, must_change_password = $2, password_changed_at = $3 \
          WHERE id = $4",
        params![&hash, dto.require_change, Utc::now(), user_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, user_id = %user_id, "reset_user_password: écriture");
        AppError::Database(e)
    })?;

    // Inside the audited transaction, like the write it describes.
    crate::settings::password_policy::remember(&mut tx, user_id, &hash, policy.history_depth)
        .await?;

    // The step that makes the reset mean anything.
    let revoked = tx
        .execute(
            "UPDATE core.refresh_tokens \
             SET revoked_at = $1, revoke_reason = 'password_change' \
             WHERE user_id = $2 AND revoked_at IS NULL",
            params![Utc::now(), user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "reset_user_password: révocation des sessions");
            AppError::Database(e)
        })?;

    let label = user_label(&username, &email, display_name.as_deref());
    let snap = |must_change: bool| {
        redact::snapshot(
            target::USER,
            &json!({
                "id": user_id, "username": username, "email": email,
                "role": role, "must_change_password": must_change,
            }),
        )
    };

    tx.commit(
        AuditEntry::new("core.users.password_reset")
            .target(target::USER, user_id, label)
            .before(snap(was_must_change))
            .after(snap(dto.require_change))
            // Counters and flags only. Nothing here can carry the password:
            // the USER whitelist has no field for it and this line is built
            // from booleans.
            .detail(format!(
                "Mot de passe réinitialisé ({}), {revoked} session(s) révoquée(s){}",
                if generated { "généré" } else { "saisi" },
                if dto.require_change { ", changement imposé à la prochaine connexion" } else { "" },
            )),
    )
    .await?;

    tracing::info!(
        user_id = %user_id, generated, revoked,
        "Mot de passe réinitialisé par un administrateur"
    );

    // ── Optional notification ────────────────────────────────────────────────
    // Queued after the commit on purpose: the reset must stand even if the relay
    // is down, and a message about a change that got rolled back would be a lie.
    let mut email_status = json!({ "requested": dto.send_email });
    if dto.send_email {
        let cfg = mailer::load_config(&state.db, &state.settings.auth.jwt_secret).await?;
        let recipient_address = email_override.clone().unwrap_or_else(|| email.clone());
        if !cfg.is_usable() {
            email_status = json!({
                "requested": true,
                "queued":    false,
                "reason":    "relay_not_configured",
            });
        } else {
            let instance = mailer::instance_name(&state.db).await;
            let base = cfg.base_url(&mailer::origin_from_headers(&headers));
            let audience = mailer::audience(&state.db, Some(user_id), &preferences).await;
            let recipient = mailer::Recipient {
                email:    recipient_address.clone(),
                name:     display_name.clone().unwrap_or_else(|| username.clone()),
                locale:   audience.locale,
                timezone: audience.timezone,
            };
            let queued = mailer::queue_admin_password_reset(
                &state.db,
                &cfg,
                &instance,
                &recipient,
                &new_password,
                dto.require_change,
                &format!("{base}/login"),
            )
            .await;
            email_status = json!({
                "requested": true,
                "queued":    queued,
                "to":        recipient_address,
            });
        }
    }

    Ok(Json(json!({
        "ok":               true,
        "user_id":          user_id,
        // Present only when the server generated it: the operator has no other
        // copy. Never returned for a password they typed themselves.
        "password":         if generated { Some(new_password) } else { None },
        "generated":        generated,
        "must_change":      dto.require_change,
        "sessions_revoked": revoked,
        "email":            email_status,
    })))
}

// ── Forcing a change without replacing the password ─────────────────────────

#[derive(Deserialize)]
pub struct RequirePasswordChangeDto {
    /// `true` arms the forced-change screen, `false` lifts it.
    pub required: bool,
}

/// `POST /admin/users/:id/require-password-change`
///
/// The reset above answers "this password is gone". This one answers a
/// different question - "this password is *suspect*" - and the two must not be
/// the same button. Arming the flag alone leaves the account signed in, leaves
/// its password working exactly once more, and makes the next sign-in end on the
/// change screen (`auth::middleware` already closes every write behind that
/// flag). An administrator who wanted to hand out a new password has the reset
/// route; one who suspects a password was shared over a chat does not want to
/// invent one, phone the person and dictate it.
///
/// Same guards as the reset: the privilege over the target's own unit, and the
/// target must hold nothing the caller does not hold. Forcing a
/// super-administrator to change their password is not a takeover, but it is a
/// denial of service against the one account that can undo it.
pub async fn require_password_change(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Path(user_id): Path<Uuid>,
    Json(dto): Json<RequirePasswordChangeDto>,
) -> Result<Json<Value>, AppError> {
    {
        let unit = user_org_unit(&state.db, user_id).await?;
        ctx.require_for_unit(keys::USER_PASSWORD, unit)?;
        ensure_can_act_on_user(&state.db, &ctx, user_id).await?;
    }

    let mut tx = audit.begin(&state.db).await?;

    // FOR UPDATE row read inside the transaction: mapped by hand from a raw row.
    let for_update = tx.backend().for_update();
    let target_row = tx
        .fetch_optional_row(
            &format!(
                "SELECT username, must_change_password, password_hash \
                 FROM core.users WHERE id = $1{}",
                for_update
            ),
            params![user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "require_password_change: lecture");
            AppError::Database(e)
        })?;

    let Some(row) = target_row else {
        return Err(AppError::NotFound("Utilisateur introuvable".into()));
    };
    let username: String = row.try_get("username").map_err(AppError::Database)?;
    let was_required: bool = row.try_get("must_change_password").map_err(AppError::Database)?;
    let password_hash: Option<String> = row.try_get("password_hash").map_err(AppError::Database)?;

    // An account with no local password has nothing to change: arming the flag
    // would close every write for somebody the change screen cannot help,
    // because that screen asks for a current password they do not have.
    if dto.required && password_hash.is_none() {
        return Err(AppError::Validation(
            "Ce compte n'a pas de mot de passe local : son authentification est gouvernée \
             par un annuaire ou un fournisseur d'identité."
                .into(),
        ));
    }

    if was_required == dto.required {
        // Nothing to write, and nothing to say in the trail: an entry recording
        // a change that did not happen is noise in the one log that must stay
        // readable.
        return Ok(Json(json!({ "ok": true, "user_id": user_id, "required": dto.required })));
    }

    tx.execute(
        "UPDATE core.users SET must_change_password = $1 WHERE id = $2",
        params![dto.required, user_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, user_id = %user_id, "require_password_change: écriture");
        AppError::Database(e)
    })?;

    tx.commit(
        AuditEntry::new("core.users.require_password_change")
            .target(target::USER, user_id, username)
            .before(redact::snapshot(
                target::USER,
                &json!({ "must_change_password": was_required }),
            ))
            .after(redact::snapshot(
                target::USER,
                &json!({ "must_change_password": dto.required }),
            ))
            .detail(if dto.required {
                "Changement de mot de passe imposé à la prochaine connexion".to_string()
            } else {
                "Changement de mot de passe imposé : levé".to_string()
            }),
    )
    .await?;

    tracing::info!(
        user_id = %user_id, required = dto.required,
        "Changement de mot de passe imposé modifié par un administrateur"
    );

    Ok(Json(json!({ "ok": true, "user_id": user_id, "required": dto.required })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dto_debug_never_prints_a_password() {
        let dto = AdminResetPasswordDto {
            mode: ResetMode::Manual,
            password: Some("le-mot-de-passe-en-clair".into()),
            require_change: true,
            send_email: false,
            email_to: None,
        };
        let rendered = format!("{dto:?}");
        assert!(!rendered.contains("le-mot-de-passe-en-clair"), "fuite : {rendered}");
        assert!(rendered.contains("«rédigé»"));
    }

    #[test]
    fn default_mode_is_generate_and_change_is_required() {
        let dto: AdminResetPasswordDto = serde_json::from_value(json!({})).expect("défauts");
        assert!(matches!(dto.mode, ResetMode::Generate));
        assert!(dto.require_change);
        assert!(!dto.send_email);
    }

    #[test]
    fn addresses_are_validated() {
        assert!(validate_address("a@b.co").is_ok());
        assert!(validate_address("pas-une-adresse").is_err());
        assert!(validate_address("a b@c.fr").is_err());
    }

    #[test]
    fn the_audit_snapshot_cannot_carry_a_credential() {
        // Even handed the fields it must never record, the whitelist drops them.
        let snapshot = redact::snapshot(
            target::USER,
            &json!({
                "id": "11111111-1111-1111-1111-111111111111",
                "username": "alice",
                "email": "a@b.co",
                "must_change_password": true,
                "password": "en-clair",
                "password_hash": "$argon2id$v=19$...",
            }),
        );
        let rendered = snapshot.to_string();
        assert!(!rendered.contains("en-clair"));
        assert!(!rendered.contains("argon2"));
        assert_eq!(snapshot["must_change_password"], json!(true));
    }

    #[test]
    fn user_label_prefers_the_display_name() {
        assert_eq!(user_label("alice", "a@b.co", Some("Alice L.")), "Alice L. <a@b.co>");
        assert_eq!(user_label("alice", "a@b.co", Some("")), "alice <a@b.co>");
        assert_eq!(user_label("alice", "a@b.co", None), "alice <a@b.co>");
    }
}
