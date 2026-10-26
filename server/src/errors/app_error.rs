use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Not authenticated")]
    Unauthorized,

    #[error("Access denied")]
    Forbidden,

    /// The account still carries the password it was seeded with: administrative
    /// writes stay closed until the owner picks a new one.
    #[error("You must change your password before performing administrative actions")]
    PasswordChangeRequired,

    /// The action is sensitive and the caller has not proved presence recently.
    ///
    /// Distinct from [`AppError::Forbidden`] on purpose: a bare "accès refusé" is
    /// indistinguishable from a genuine lack of authorisation, so a client cannot
    /// tell whether to offer a way forward. This one carries a code the client
    /// acts on - open the re-authentication dialog, then replay the request.
    #[error("Reauthentication is required for this sensitive action")]
    ReauthRequired,

    /// The caller is a personal API token: no second factor, nobody at the
    /// keyboard, so the challenge can never be met. Final, not retryable - a
    /// `ReauthRequired` here would send an unattended script into a loop.
    #[error("This sensitive action requires a person; an API token cannot perform it")]
    ReauthImpossible,

    /// A personal API token issued before scopes existed, presented after its
    /// migration grace window closed.
    ///
    /// Distinguishable from a plain 401 on purpose: nothing is wrong with the
    /// network, the account or the token's own expiry - the credential belongs to
    /// a policy that has been withdrawn, and the only way forward is to reissue
    /// one with explicit scopes. A 401 would send the holder debugging the wrong
    /// thing, and the client's refresh interceptor chasing a token it cannot mint.
    #[error(
        "This API token was issued before scopes were introduced and its transition period has ended. Issue a new token with explicitly selected scopes (Settings → API tokens)."
    )]
    ApiTokenLegacyExpired,

    /// A legacy token attempting an administrative write. Refused immediately,
    /// with no grace period - this is the defect the scoping work exists to close.
    #[error(
        "An API token without scopes cannot make administrative changes. Issue a new token with explicitly selected scopes."
    )]
    ApiTokenLegacyAdminWrite,

    /// The token authenticated, but does not carry the scope this route needs.
    #[error("This API token does not have the scope required for this operation: {0}")]
    ApiTokenScopeMissing(String),

    /// The instance requires administrators to carry a second factor and this
    /// account's grace window has closed.
    #[error(
        "Two-factor authentication is required for administrators and the grace period has ended. Configure it in Settings → Security to regain administrative access."
    )]
    TwoFactorRequired,

    /// A more general scope has locked this setting. Distinct from a plain
    /// [`AppError::Forbidden`] on purpose: nothing is wrong with the caller's
    /// privileges, so "accès refusé" would send an administrator auditing roles
    /// instead of looking one level up in the organisational tree. The dedicated
    /// code is what lets the console name the level that holds the lock.
    #[error("{0}")]
    SettingLocked(String),

    #[error("Resource not found: {0}")]
    NotFound(String),

    #[error("Invalid data: {0}")]
    Validation(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    /// Sign-in is refused because the account has failed enough times that a
    /// CAPTCHA is now required and none (or a wrong one) was provided. The
    /// user-facing message is the SAME generic "invalid credentials" as every
    /// other sign-in failure - only the machine `code` differs, so the login
    /// form knows to show the CAPTCHA. See `handlers::auth::login`.
    #[error("Invalid credentials")]
    CaptchaRequired,

    #[error("Quota exceeded")]
    QuotaExceeded,

    /// A remote mount's stored credentials can no longer be decrypted, because
    /// `server.internal_secret` is not the one that sealed them. Unrecoverable
    /// by design, but not a server fault and not a dead end: the owner can
    /// reconnect the mount. It gets its own code so the client can say that
    /// instead of showing a bare failure.
    #[error(
        "The credentials for this remote storage can no longer be decrypted because the instance's internal secret has changed since they were saved. Reconnect the mount to enter them again."
    )]
    RemoteMountUnreadable,

    /// A remote storage provider was unreachable, refused us, or answered
    /// something unusable. The failure is upstream: reporting it as a 500 sends
    /// whoever reads it auditing Kubuno's own logs for a fault that is not here.
    #[error("Remote storage unreachable: {0}")]
    RemoteUnavailable(String),

    #[error("Database error")]
    Database(#[from] sqlx::Error),

    #[error("Internal error")]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    /// The full cause chain, for the surfaces only an administrator reads: the
    /// server log, the audit trail and the install progress endpoint.
    ///
    /// `Display` stays deliberately generic on `Internal` and `Database` so that
    /// a response body never leaks internals. That genericity used to reach the
    /// logs and the audit trail too, which left an administrator facing
    /// "Internal error" on four surfaces at once with no way to diagnose the
    /// failure - even with full shell access to the server.
    pub fn detail(&self) -> String {
        match self {
            // anyhow's alternate form prints the whole chain, "outer: inner: root".
            AppError::Internal(e) => format!("{e:#}"),
            AppError::Database(e) => format!("{self} : {e}"),
            other => other.to_string(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            AppError::Unauthorized    => (StatusCode::UNAUTHORIZED,            "UNAUTHORIZED",     self.to_string()),
            AppError::Forbidden       => (StatusCode::FORBIDDEN,               "FORBIDDEN",        self.to_string()),
            AppError::PasswordChangeRequired => {
                (StatusCode::FORBIDDEN, "PASSWORD_CHANGE_REQUIRED", self.to_string())
            }
            // 403 rather than 401: a 401 is what the client's refresh interceptor
            // reacts to, and re-minting the access token is precisely what does
            // NOT help here. The dedicated codes below are what the client keys on.
            AppError::ReauthRequired  => (StatusCode::FORBIDDEN,               "REAUTH_REQUIRED",      self.to_string()),
            AppError::ReauthImpossible => (StatusCode::FORBIDDEN,              "REAUTH_NOT_AVAILABLE", self.to_string()),
            // 401 rather than 403: the credential itself is no longer accepted,
            // which is what the code says. The client must stop replaying it.
            AppError::ApiTokenLegacyExpired => {
                (StatusCode::UNAUTHORIZED, "API_TOKEN_LEGACY_EXPIRED", self.to_string())
            }
            AppError::ApiTokenLegacyAdminWrite => {
                (StatusCode::FORBIDDEN, "API_TOKEN_LEGACY_ADMIN_WRITE", self.to_string())
            }
            AppError::ApiTokenScopeMissing(_) => {
                (StatusCode::FORBIDDEN, "API_TOKEN_SCOPE_MISSING", self.to_string())
            }
            AppError::TwoFactorRequired => (StatusCode::FORBIDDEN,             "TWO_FACTOR_REQUIRED",  self.to_string()),
            AppError::SettingLocked(_) => (StatusCode::FORBIDDEN,              "SETTING_LOCKED",   self.to_string()),
            AppError::NotFound(_)     => (StatusCode::NOT_FOUND,               "NOT_FOUND",        self.to_string()),
            AppError::Validation(_)   => (StatusCode::UNPROCESSABLE_ENTITY,    "VALIDATION_ERROR", self.to_string()),
            AppError::Conflict(_)     => (StatusCode::CONFLICT,                "CONFLICT",         self.to_string()),
            AppError::CaptchaRequired => (StatusCode::UNPROCESSABLE_ENTITY,    "CAPTCHA_REQUIRED", self.to_string()),
            AppError::QuotaExceeded   => (StatusCode::INSUFFICIENT_STORAGE,    "QUOTA_EXCEEDED",   self.to_string()),
            // 409 rather than 500: the stored state conflicts with the current
            // secret, and the client can offer a way out of it.
            AppError::RemoteMountUnreadable => {
                (StatusCode::CONFLICT, "MOUNT_CONFIG_UNREADABLE", self.to_string())
            }
            AppError::RemoteUnavailable(_) => {
                (StatusCode::BAD_GATEWAY, "REMOTE_UNAVAILABLE", self.to_string())
            }
            AppError::Database(e) => {
                tracing::error!(error = %e, "Database error");
                (StatusCode::INTERNAL_SERVER_ERROR, "DATABASE_ERROR", "Database error".to_string())
            }
            AppError::Internal(e) => {
                // The chain, not just the outermost message: the response body
                // below stays generic, so this log is the only place the cause
                // survives.
                tracing::error!(error = %format!("{e:#}"), "Internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Internal error".to_string())
            }
        };

        (status, Json(json!({ "error": code, "message": message }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detail_keeps_the_whole_cause_chain_that_display_hides() {
        let root = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Permission denied (os error 13)");
        let err: AppError = anyhow::Error::new(root)
            .context("création staging /var/lib/kubuno/modules-store/.staging/mail")
            .into();

        // What the response body and the old logs showed: nothing usable.
        assert_eq!(err.to_string(), "Internal error");

        // What an administrator now gets on the log, the audit trail and the
        // install status endpoint: the operation AND its root cause.
        let detail = err.detail();
        assert!(detail.contains("création staging"), "chaîne perdue : {detail}");
        assert!(detail.contains("Permission denied"), "cause racine perdue : {detail}");
    }

    #[test]
    fn detail_of_a_plain_variant_is_its_message() {
        let err = AppError::NotFound("module « mail »".into());
        assert_eq!(err.detail(), err.to_string());
    }
}
