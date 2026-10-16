//! The re-authentication token itself.
//!
//! ## It grants nothing
//!
//! This is the load-bearing property of the whole mechanism, and it is the same
//! one already documented on [`crate::auth::jwt::TotpPendingClaims`] - the
//! intermediate token issued between the password step and the TOTP step, which
//! "identifies the session awaiting validation and grants no access to the API".
//! A re-auth token follows that pattern deliberately:
//!
//!  * it is **not** an access token and can never be used as one - it is signed
//!    with a *different* key (derived below), so presenting it as a `Bearer`
//!    credential fails signature verification outright rather than relying on the
//!    claim shape to differ;
//!  * conversely an access token presented in `X-Reauth-Token` fails for the same
//!    reason. Neither key can produce a signature the other accepts;
//!  * it carries no role, no email, no scope of authority. It says one thing:
//!    "the human behind account `sub` proved presence at `iat` using `method`";
//!  * it is worthless on its own - every sensitive call still needs a valid
//!    access token *in addition*. The re-auth token is a second, orthogonal
//!    condition, never a substitute.
//!
//! ## Key derivation
//!
//! `sha256("kubuno:reauth:" || jwt_secret)`, hex-encoded - the same domain
//! separation trick [`crate::auth::totp`] uses for the TOTP encryption key. One
//! configured secret, several cryptographically independent uses, and no way for
//! a token minted for one purpose to be honoured for another.

use chrono::Utc;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::errors::AppError;

/// How presence was proved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReauthMethod {
    Password,
    Totp,
    BackupCode,
}

impl ReauthMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Totp => "totp",
            Self::BackupCode => "backup_code",
        }
    }
}

/// Claims of a re-auth token. See the module documentation: this grants nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReauthClaims {
    /// Account that proved presence.
    pub sub: Uuid,
    /// Identifier of the matching row in `core.reauth_grants` - what makes the
    /// token revocable.
    pub jti: Uuid,
    pub iat: i64,
    pub exp: i64,
    /// How presence was proved, for the audit trail.
    pub method: ReauthMethod,
    /// Constant discriminator. Redundant with the derived key, kept because a
    /// defence that costs one boolean should not be argued about.
    pub reauth: bool,
}

/// Derives the signing key. Never the configured secret itself.
fn reauth_key(jwt_secret: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"kubuno:reauth:");
    h.update(jwt_secret.as_bytes());
    hex::encode(h.finalize())
}

/// Mints a token proving presence for `ttl_seconds`.
pub fn issue(
    jwt_secret: &str,
    user_id: Uuid,
    jti: Uuid,
    method: ReauthMethod,
    ttl_seconds: i64,
) -> Result<String, AppError> {
    let now = Utc::now().timestamp();
    let claims = ReauthClaims {
        sub: user_id,
        jti,
        iat: now,
        exp: now + ttl_seconds,
        method,
        reauth: true,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(reauth_key(jwt_secret).as_bytes()),
    )
    .map_err(|e| AppError::Internal(anyhow::anyhow!("Jeton de réauthentification: {e}")))
}

/// Validates signature, expiry and discriminator. Says nothing about revocation:
/// that is a database fact, checked by [`super::store::is_live`].
pub fn validate(jwt_secret: &str, token: &str) -> Result<ReauthClaims, AppError> {
    let mut v = Validation::new(Algorithm::HS256);
    v.validate_exp = true;
    // jsonwebtoken allows 60 s of clock skew by default. That is sane for a
    // 30-day refresh token and absurd for a proof whose whole point is to be
    // minutes old: it would stretch a five-minute window to six. Both ends of
    // this check run on the same machine, so there is no skew to absorb.
    v.leeway = 0;
    v.required_spec_claims = ["exp"].iter().map(|s| s.to_string()).collect();

    let data = decode::<ReauthClaims>(
        token,
        &DecodingKey::from_secret(reauth_key(jwt_secret).as_bytes()),
        &v,
    )
    .map_err(|_| AppError::ReauthRequired)?;

    if !data.claims.reauth {
        return Err(AppError::ReauthRequired);
    }
    Ok(data.claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::jwt::JwtService;
    use crate::models::user::User;

    fn sample_user(id: Uuid) -> User {
        User {
            id,
            email: "t@example.test".into(),
            username: "t".into(),
            password_hash: None,
            display_name: None,
            avatar_url: None,
            first_name: None,
            last_name: None,
            role: "admin".into(),
            quota_bytes: 0,
            used_bytes: 0,
            is_active: true,
            email_verified: true,
            oauth_provider: None,
            oauth_id: None,
            preferences: serde_json::json!({}),
            org_unit_id: None,
            name_pronunciation: None,
            pronouns: None,
            work_location: None,
            introduction: None,
            gender: None,
            birthday: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            last_login_at: None,
            password_changed_at: None,
            totp_enabled: false,
            must_change_password: false,
            admin_2fa_grace_until: None,
            totp_secret: None,
            totp_pending_secret: None,
            ldap_directory_id: None,
            ldap_dn: None,
            ldap_uid: None,
            ldap_synced_at: None,
        }
    }

    #[test]
    fn a_fresh_token_round_trips() {
        let secret = "un-secret-de-test-suffisamment-long-pour-hs256";
        let user = Uuid::new_v4();
        let jti = Uuid::new_v4();
        let token = issue(secret, user, jti, ReauthMethod::Totp, 300).expect("émission");
        let claims = validate(secret, &token).expect("validation");
        assert_eq!(claims.sub, user);
        assert_eq!(claims.jti, jti);
        assert_eq!(claims.method, ReauthMethod::Totp);
    }

    #[test]
    fn an_expired_token_is_refused() {
        let secret = "un-secret-de-test-suffisamment-long-pour-hs256";
        // One second past expiry is enough: `validate` sets `leeway = 0`.
        let token = issue(secret, Uuid::new_v4(), Uuid::new_v4(), ReauthMethod::Password, -1)
            .expect("émission");
        assert!(matches!(validate(secret, &token), Err(AppError::ReauthRequired)));
    }

    #[test]
    fn an_access_token_cannot_pass_as_a_reauth_proof() {
        let secret = "un-secret-de-test-suffisamment-long-pour-hs256";
        let jwt = JwtService::new(secret.to_string(), std::time::Duration::from_secs(900));
        let access = jwt
            .generate_access_token(&sample_user(Uuid::new_v4()))
            .expect("access token");
        assert!(matches!(validate(secret, &access), Err(AppError::ReauthRequired)));
    }

    #[test]
    fn a_reauth_token_cannot_pass_as_an_access_token() {
        let secret = "un-secret-de-test-suffisamment-long-pour-hs256";
        let jwt = JwtService::new(secret.to_string(), std::time::Duration::from_secs(900));
        let proof = issue(secret, Uuid::new_v4(), Uuid::new_v4(), ReauthMethod::Totp, 300)
            .expect("émission");
        assert!(matches!(jwt.validate_access_token(&proof), Err(AppError::Unauthorized)));
    }

    #[test]
    fn the_totp_pending_token_is_not_a_reauth_proof_either() {
        let secret = "un-secret-de-test-suffisamment-long-pour-hs256";
        let pending = JwtService::generate_totp_session(secret, Uuid::new_v4()).expect("émission");
        assert!(matches!(validate(secret, &pending), Err(AppError::ReauthRequired)));
    }
}
