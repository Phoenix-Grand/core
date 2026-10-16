use crate::{errors::AppError, models::user::User};
use anyhow::Result;
use chrono::Utc;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use uuid::Uuid;

/// Jeton court-terme (5 min) émis après vérification du mot de passe
/// quand l'utilisateur a activé la 2FA. Il identifie la session en attente
/// de validation TOTP - il n'octroie aucun accès à l'API.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TotpPendingClaims {
    pub sub:  Uuid,
    pub exp:  i64,
    pub totp: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AccessClaims {
    pub sub:   Uuid,
    pub email: String,
    pub role:  String,
    pub exp:   i64,
    pub iat:   i64,
    pub jti:   Uuid,
    /// The browser/device session (refresh-token family) this access token was
    /// minted for. Absent on tokens issued before the claim existed. Download and
    /// stream tickets copy it, so that signing out revokes them at once (see
    /// `crate::auth::tickets`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sid:   Option<Uuid>,
}

pub struct JwtService {
    secret:           String,
    access_token_ttl: Duration,
}

impl JwtService {
    pub fn new(secret: String, access_token_ttl: Duration) -> Self {
        Self { secret, access_token_ttl }
    }

    pub fn generate_access_token(&self, user: &User) -> Result<String, AppError> {
        self.generate_access_token_for_session(user, None)
    }

    /// Access token bound to a session: `sid` is the refresh-token family, or
    /// the session row id when the row has no family. Prefer this over
    /// [`Self::generate_access_token`] wherever the session is known.
    pub fn generate_access_token_for_session(
        &self,
        user: &User,
        sid: Option<Uuid>,
    ) -> Result<String, AppError> {
        let now = Utc::now().timestamp();
        let exp = now + self.access_token_ttl.as_secs() as i64;
        let claims = AccessClaims {
            sub:   user.id,
            email: user.email.clone(),
            role:  user.role.clone(),
            exp,
            iat:   now,
            jti:   Uuid::new_v4(),
            sid,
        };
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(self.secret.as_bytes()),
        )
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Génération JWT: {e}")))
    }

    pub fn validate_access_token(&self, token: &str) -> Result<AccessClaims, AppError> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_exp = true;
        decode::<AccessClaims>(
            token,
            &DecodingKey::from_secret(self.secret.as_bytes()),
            &validation,
        )
        .map(|data| data.claims)
        .map_err(|_| AppError::Unauthorized)
    }

    /// Retourne (token_brut, token_hash_hex).
    pub fn generate_refresh_token() -> (String, String) {
        crate::crypto::token::generate_token()
    }

    /// Génère un jeton de session TOTP (5 min).
    pub fn generate_totp_session(secret: &str, user_id: Uuid) -> Result<String, AppError> {
        let now = Utc::now().timestamp();
        let claims = TotpPendingClaims { sub: user_id, exp: now + 300, totp: true };
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .map_err(|e| AppError::Internal(anyhow::anyhow!("TOTP session JWT: {e}")))
    }

    /// Valide un jeton de session TOTP.
    pub fn validate_totp_session(secret: &str, token: &str) -> Result<TotpPendingClaims, AppError> {
        let mut v = Validation::new(Algorithm::HS256);
        v.validate_exp = true;
        v.required_spec_claims = ["exp"].iter().map(|s| s.to_string()).collect();
        decode::<TotpPendingClaims>(
            token,
            &DecodingKey::from_secret(secret.as_bytes()),
            &v,
        )
        .map(|d| {
            if !d.claims.totp {
                return Err(AppError::Unauthorized);
            }
            Ok(d.claims)
        })
        .map_err(|_| AppError::Unauthorized)?
    }
}
