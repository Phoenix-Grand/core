use std::sync::Arc;

use crate::{
    audit::ActorOrigin,
    auth::internal_secret::InternalCaller,
    auth::jwt::JwtService,
    auth::tickets,
    auth::token_scope::{self, TokenGrant},
    errors::AppError,
    models::user::User,
    state::AppState,
};
use axum::{
    extract::FromRequestParts,
    http::{HeaderMap, Method, request::Parts},
};
use kubuno_db::params;
use uuid::Uuid;

/// How the caller proved who they are - **and what that proof authorises**.
///
/// [`AuthUser`] happily accepts a JWT *or* a personal API token and yields the
/// same `User` either way, which erases the difference between a human clicking
/// in the console and a script running unattended. This record is inserted into
/// the request extensions during extraction so downstream consumers - the audit
/// trail, and now the authorisation layer - can tell the two apart.
///
/// The [`grant`](Self::grant) field is the substantive half of the fix: before
/// it, the two paths were genuinely indistinguishable *after* extraction, so no
/// amount of care further down could have narrowed a token's power. It carries
/// the token's **row identifier** and its scopes; never the token, never a hash
/// of it.
///
/// `Arc` rather than a plain `Vec` because this record is copied out of the
/// extensions on several hot paths (`context_from`, the re-auth guards) and the
/// scope list should not be cloned each time.
#[derive(Debug, Clone)]
pub struct AuthSource {
    pub origin: ActorOrigin,
    pub token_id: Option<Uuid>,
    /// `Some` exactly when `origin == ApiToken`.
    pub grant: Option<Arc<TokenGrant>>,
}

impl AuthSource {
    pub fn session() -> Self {
        Self { origin: ActorOrigin::Session, token_id: None, grant: None }
    }

    fn api_token(grant: TokenGrant) -> Self {
        Self {
            origin: ActorOrigin::ApiToken,
            token_id: Some(grant.token_id),
            grant: Some(Arc::new(grant)),
        }
    }

    /// The grant behind this request, if a token was presented.
    pub fn grant(&self) -> Option<&TokenGrant> {
        self.grant.as_deref()
    }
}

/// Extracteur injecté dans les handlers authentifiés.
#[derive(Debug, Clone)]
pub struct AuthUser(pub User);

impl AuthUser {
    pub fn user(&self) -> &User {
        &self.0
    }
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        // Already resolved by the `/admin/*` layer guard (see `crate::authz`):
        // reuse it rather than paying a second lookup for the same request.
        if let Some(existing) = parts.extensions.get::<AuthUser>() {
            return Ok(existing.clone());
        }

        // The header first. Without one, a signed ticket (`?kt=`) bound to this
        // exact path - that is how a browser-performed download of an archive
        // reaches its owner (see `crate::auth::tickets`). The deprecated
        // `access_token` cookie comes last, and only while the compatibility
        // switch is on.
        let header_token = extract_bearer(&parts.headers);
        if header_token.is_none() {
            let original = parts
                .extensions
                .get::<axum::extract::OriginalUri>()
                .map(|o| o.0.clone())
                .unwrap_or_else(|| parts.uri.clone());
            if let Some(ticket) = tickets::from_query(original.query()) {
                let (user, _claims) = tickets::authenticate(
                    state,
                    ticket,
                    "core",
                    original.path(),
                    parts.method.as_str(),
                )
                .await?;
                parts.extensions.insert(AuthSource::session());
                let auth = AuthUser(user);
                parts.extensions.insert(auth.clone());
                return Ok(auth);
            }
        }
        let token = match header_token {
            Some(t) => t,
            None => {
                let t = tickets::legacy_cookie_token(state, &parts.headers)
                    .ok_or(AppError::Unauthorized)?;
                tickets::log_legacy_cookie_use("core", parts.uri.path());
                t
            }
        };

        // Essai 1 : JWT access token
        let jwt = JwtService::new(
            state.settings.auth.jwt_secret.clone(),
            state.settings.auth.access_token_ttl,
        );
        if let Ok(claims) = jwt.validate_access_token(token) {
            let user = state
                .db
                .fetch_optional_as::<User>(
                    "SELECT * FROM core.users WHERE id = $1 AND is_active = TRUE",
                    params![claims.sub],
                )
                .await
                .map_err(AppError::Database)?
                .ok_or(AppError::Unauthorized)?;
            parts.extensions.insert(AuthSource::session());
            // Memoised for the rest of the request, symmetrically with the read
            // above: a handler taking both `AuthUser` and a privilege extractor
            // would otherwise load the same row twice.
            let auth = AuthUser(user);
            parts.extensions.insert(auth.clone());
            return Ok(auth);
        }

        // Attempt 2: personal API token (`kubuno_` prefix).
        //
        // Resolution refuses a revoked, expired or unknown token, a token whose
        // owner has been deactivated, and a legacy token past its grace window -
        // the last one with a distinguishable code so the holder knows to reissue
        // rather than to retry.
        let grant = token_scope::resolve_grant(&state.db, token).await?;

        let user = state
            .db
            .fetch_optional_as::<User>(
                "SELECT * FROM core.users WHERE id = $1 AND is_active = TRUE",
                params![grant.user_id],
            )
            .await
            .map_err(AppError::Database)?
            .ok_or(AppError::Unauthorized)?;

        let source = AuthSource::api_token(grant);
        let recorded = source.grant.clone();
        // Inserted *before* the entry is written: `context_from` reads the source
        // back out of the extensions to attribute the entry to the token.
        parts.extensions.insert(source);

        // Each use of a credential running on a withdrawn policy leaves a trace:
        // the operator has a deadline to meet and needs to find the callers.
        if let Some(g) = recorded.as_deref().filter(|g| g.is_legacy) {
            let ctx = crate::audit::context_from(parts, &user);
            token_scope::grant::audit_legacy_use(&state.db, &ctx, g, parts.uri.path()).await;
        }
        let auth = AuthUser(user);
        parts.extensions.insert(auth.clone());
        Ok(auth)
    }
}

/// Extracteur pour les handlers admin uniquement.
///
/// Admits either an **instance administrator** (`users.role = 'admin'`, the
/// denormalised cache of "holds an instance-scoped superuser role") or a
/// **delegated administrator** - someone holding at least one administrative
/// privilege through `crate::authz`, whose `role` stays `'user'` on purpose so
/// their power does not travel to the modules through `X-Kubuno-User-Role`.
///
/// This extractor answers "may this caller enter the administration surface at
/// all". It deliberately does **not** answer "may they perform *this*
/// operation": that is the handler's `AdminCtx` privilege check, and keeping the
/// two apart is what makes the layer guard and the extractor complementary
/// rather than duplicated.
///
/// Scope of the `must_change_password` lock: an account that still carries the
/// password it was seeded with keeps read access (so the operator can see the
/// instance and reach `/me/password`), but every administrative *write* is
/// refused. That is where the damage would be done - creating users, flipping
/// settings, installing modules - and it stays closed even if the frontend
/// guard is bypassed. Client-detectable via the `PASSWORD_CHANGE_REQUIRED` code.
pub struct AdminUser(pub User);

#[axum::async_trait]
impl FromRequestParts<AppState> for AdminUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let AuthUser(user) = AuthUser::from_request_parts(parts, state).await?;

        // The one refusal with no grace window. Checked before the privilege
        // resolution below because it does not depend on it: an unscoped
        // credential writing to the administration surface is refused whatever
        // its owner holds, and that is the defect this whole change exists to
        // close. See `auth::token_scope::deny_legacy_admin_write`.
        let grant = parts.extensions.get::<AuthSource>().and_then(|s| s.grant.clone());
        if let Err(e) = crate::auth::token_scope::deny_legacy_admin_write(
            grant.as_deref(),
            &parts.method,
        ) {
            crate::audit::record_refusal(state, parts, &user, "legacy_api_token_admin_write").await;
            return Err(e);
        }

        // Refusals are audited here rather than in each handler: this is the one
        // choke point every administrative route goes through, so a route added
        // tomorrow is covered without anyone remembering to instrument it. Only
        // *identified* callers are recorded - an anonymous 401 carries no actor
        // and would let a stranger flood the trail.
        if user.role != "admin" {
            // Delegated administrators are `role = 'user'`; ask the privilege
            // model whether they hold anything at all before refusing.
            let ctx = crate::authz::guard::context_for_account(state, parts, &user).await?;
            if !ctx.is_admin() {
                crate::audit::record_refusal(state, parts, &user, "role_not_admin").await;
                return Err(AppError::Forbidden);
            }
            parts.extensions.insert(ctx);
        }
        // Instance requirement: an administrator without a second factor loses the
        // console once their grace window closes. Checked here, at the single
        // choke point, for the same reason as the refusals above - and *after* the
        // role check, so a non-administrator never arms a deadline it will never
        // need. Read and write are both refused: the account can still reach
        // Paramètres → Sécurité, which is not an administrative route.
        if let Err(e) = crate::auth::admin_2fa::enforce(&state.db, &user).await {
            crate::audit::record_refusal(state, parts, &user, "admin_2fa_required").await;
            return Err(e);
        }
        if user.must_change_password && is_write_method(&parts.method) {
            tracing::warn!(
                user_id = %user.id,
                method = %parts.method,
                path = %parts.uri.path(),
                "Administrative write refused: the account must change its password first"
            );
            crate::audit::record_refusal(state, parts, &user, "password_change_required").await;
            return Err(AppError::PasswordChangeRequired);
        }
        Ok(AdminUser(user))
    }
}

/// True for HTTP methods that mutate state.
fn is_write_method(method: &Method) -> bool {
    !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

/// Extracteur pour les appels internes (modules → core).
///
/// Porte l'identité de l'appelant : le module qui a présenté son secret dérivé,
/// ou [`InternalCaller::Master`] pour le secret maître (core lui-même, outil
/// d'exploitation, module lancé hors supervision). Le secret n'est jamais
/// conservé ni journalisé.
pub struct InternalRequest(pub InternalCaller);

impl InternalRequest {
    /// Identifiant du module appelant, `None` si l'appelant n'est pas identifié.
    pub fn module_id(&self) -> Option<&str> {
        self.0.module_id()
    }
}

#[axum::async_trait]
impl FromRequestParts<AppState> for InternalRequest {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let secret = parts
            .headers
            .get("x-internal-secret")
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;

        let caller = state
            .settings
            .server
            .authenticate_internal(secret)
            .ok_or(AppError::Unauthorized)?;

        tracing::debug!(
            caller = %caller.label(),
            path = %parts.uri.path(),
            "Internal call authenticated"
        );
        Ok(InternalRequest(caller))
    }
}

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

