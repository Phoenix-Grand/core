//! The layer guard over `/admin/*`, and the extractor that hands the resolved
//! context to a handler.
//!
//! ## Why a layer *and* the per-handler extractors
//!
//! The 38 administrative routes were guarded only by convention: each handler
//! took an `AdminUser` extractor, and a signature written tomorrow that forgot
//! it would compile and serve. A layer makes the floor structural - every route
//! mounted under the sub-router is guarded whether or not anyone remembered.
//!
//! The extractors stay. Defence in depth, with a clean division: the **layer**
//! guarantees "at least an administrator", the **handler** narrows it to the
//! privilege the operation actually needs. Removing either one leaves a real
//! hole, so neither is redundant.
//!
//! ## One resolution per request
//!
//! The layer resolves the caller once and puts both the `AuthUser` and the
//! [`AdminContext`] into the request extensions. `AuthUser`, `AdminUser`,
//! `AdminAudit` and [`AdminCtx`] all read them back from there, so a request
//! that used to cost one user lookup still costs one.

use axum::{
    body::Body,
    extract::FromRequestParts,
    http::{Request, request::Parts},
    middleware::Next,
    response::{IntoResponse, Response},
};

use super::context::{self, AdminContext};
use crate::{
    auth::middleware::{AuthSource, AuthUser},
    errors::AppError,
    models::user::User,
    state::AppState,
};

/// Resolves the caller's administrative context, skipping the work entirely for
/// an account that holds no assignment.
///
/// Same answer as [`context_for`], reached without a query when the roster
/// (see [`super::context::holds_any_assignment`]) can prove there is nothing to
/// resolve. The account row is needed rather than just an id because the empty
/// context still carries the caller's own organisational unit, and the row that
/// authenticated the request already has it.
///
/// This is what makes `GET /api/v1/me` affordable: it is called on every page
/// load by every account, and almost none of them administer anything.
pub async fn context_for_account(
    state: &AppState,
    parts: &Parts,
    user: &User,
) -> Result<AdminContext, AppError> {
    // `role = 'admin'` is the denormalised "holds an instance-scoped super-user
    // role": such an account is in the roster by construction, and excluding it
    // here costs nothing while making the fast path safe against any drift
    // between the flag and the assignment it caches.
    if user.role != "admin"
        && !context::holds_any_assignment(&state.db, user.id).await?
    {
        let source = parts
            .extensions
            .get::<AuthSource>()
            .cloned()
            .unwrap_or_else(AuthSource::session);

        let mut ctx = AdminContext::empty(user.id, source.origin, source.token_id);
        ctx.org_unit_id = user.org_unit_id;
        // Narrowed like any other context: a token belonging to an account that
        // holds nothing exercises nothing, and the deny-list stays truthful.
        return Ok(crate::auth::token_scope::narrow(ctx, source.grant()));
    }

    context_for(state, parts, user.id).await
}

/// Resolves the caller's administrative context, using the short-lived cache.
pub async fn context_for(
    state: &AppState,
    parts: &Parts,
    user_id: uuid::Uuid,
) -> Result<AdminContext, AppError> {
    let source = parts
        .extensions
        .get::<AuthSource>()
        .cloned()
        .unwrap_or_else(AuthSource::session);

    // What the *subject* holds - cacheable, because it is a property of the
    // account and not of the request.
    let subject = match super::cache::get(user_id) {
        // The authentication origin belongs to this request and is refreshed
        // from it; `denied` likewise, since it describes the credential.
        Some(cached) => AdminContext {
            origin: source.origin,
            token_id: source.token_id,
            denied: Default::default(),
            ..cached
        },
        None => {
            let ctx =
                context::resolve(&state.db, user_id, source.origin, source.token_id).await?;
            super::cache::put(user_id, &ctx);
            ctx
        }
    };

    // The intersection with the presented credential's scopes is applied **after**
    // the cache, never inside it. That ordering is what makes the guarantee real:
    // the cache holds "what this account holds", the narrowing holds "what this
    // key may exercise", and the second is recomputed on every single request. A
    // privilege withdrawn from the owner is gone from the token on the next call -
    // intersection, never a copy frozen when the token was minted.
    Ok(crate::auth::token_scope::narrow(subject, source.grant()))
}

/// Layer applied to the whole `/admin` sub-router.
///
/// Authenticates, resolves, and refuses anyone who is neither an instance
/// administrator (`users.role = 'admin'`, the denormalised cache) nor the holder
/// of a single administrative privilege.
pub async fn admin_layer(
    axum::extract::State(state): axum::extract::State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let (mut parts, body) = req.into_parts();

    let user = match AuthUser::from_request_parts(&mut parts, &state).await {
        Ok(AuthUser(user)) => user,
        Err(e) => return e.into_response(),
    };

    // Structural, and ahead of any privilege reasoning: an API token issued
    // before scopes existed may read this surface until its deadline, and may
    // never write to it. No grace - see `auth::token_scope`.
    let grant = parts.extensions.get::<AuthSource>().and_then(|s| s.grant.clone());
    if let Err(e) = crate::auth::token_scope::deny_legacy_admin_write(grant.as_deref(), &parts.method)
    {
        crate::audit::record_refusal(&state, &parts, &user, "legacy_api_token_admin_write").await;
        return e.into_response();
    }

    let ctx = match context_for_account(&state, &parts, &user).await {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };

    // `users.role = 'admin'` is kept in step with "holds an instance-scoped
    // superuser role", so in practice the two agree; the disjunction is what
    // lets a delegated administrator - who is `role = 'user'` on purpose -
    // through the door.
    if user.role != "admin" && !ctx.is_admin() {
        crate::audit::record_refusal(&state, &parts, &user, "no_admin_privilege").await;
        return AppError::Forbidden.into_response();
    }

    // Handed downstream so the extractors do not query again.
    parts.extensions.insert(AuthUser(user));
    parts.extensions.insert(ctx);

    next.run(Request::from_parts(parts, body)).await
}

/// Extractor giving a handler the caller's resolved privileges.
///
/// Inside `/admin/*` this is a pure extension read - the layer already did the
/// work. Outside it (the handful of privileged surfaces that live elsewhere) it
/// resolves on demand.
pub struct AdminCtx(pub AdminContext);

impl std::ops::Deref for AdminCtx {
    type Target = AdminContext;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AdminCtx {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if let Some(ctx) = parts.extensions.get::<AdminContext>() {
            return Ok(Self(ctx.clone()));
        }
        let AuthUser(user) = AuthUser::from_request_parts(parts, state).await?;
        let ctx = context_for_account(state, parts, &user).await?;
        parts.extensions.insert(ctx.clone());
        Ok(Self(ctx))
    }
}
