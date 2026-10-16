//! OAuth / OIDC - generic providers (Keycloak, GitLab, Authentik, …).
//!
//! Public provider list, authorization redirect (PKCE) and callback. User
//! lookup/creation lives in [`super::oauth_users`].

use crate::{
    auth::{
        client_ip::ClientIp,
        jwt::JwtService,
        oauth::{self, OAuthPkce},
    },
    crypto::encryption,
    errors::AppError,
    models::oauth_provider::{OAuthProvider, PublicOAuthProvider},
    state::AppState,
};
use axum::{
    extract::{Query, State},
    http::{header, HeaderMap},
    response::{IntoResponse, Redirect},
    Json,
};
use chrono::Utc;
use kubuno_db::{params, Backend, DbPool};
use serde::Deserialize;
use serde_json::json;

use super::oauth_users::{create_oauth_user, find_oauth_user};

/// HTTP client for IdP calls (discovery, token, userinfo).
fn oidc_http_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| AppError::Internal(e.into()))
}

/// Load an enabled provider by slug, 404 otherwise.
async fn load_enabled_provider(db: &DbPool, slug: &str) -> Result<OAuthProvider, AppError> {
    db.fetch_optional_as::<OAuthProvider>(
        "SELECT * FROM core.oauth_providers WHERE slug = $1 AND enabled = TRUE",
        params![slug],
    )
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Fournisseur SSO inconnu ou désactivé: {slug}")))
}

/// Which sign-in methods the page must draw, for an anonymous visitor.
///
/// The union of every method accepted anywhere in the instance
/// ([`crate::auth::methods::active_anywhere`]), narrowed to those that have
/// something behind them. It is a property of the configuration alone: it does
/// not take a login, does not touch `core.users`, and therefore cannot be used
/// to find out whether an account exists or which unit it belongs to. The
/// per-unit rule is applied after identification - see
/// [`crate::auth::methods`] for why that ordering is the safe one.
pub async fn public_auth_methods(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let methods = crate::auth::methods::active_anywhere(&state.db).await;
    Ok(Json(json!({
        "methods": methods.to_json(),
        // The password field serves BOTH the local password and the directory
        // bind - same form, same two fields - so it is shown when either is
        // accepted somewhere.
        "password_form": methods.local || methods.directory,
    })))
}

/// Public list of enabled providers for the login page (no secrets).
pub async fn list_public_oauth_providers(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let providers = state
        .db
        .fetch_all_as::<OAuthProvider>(
            "SELECT * FROM core.oauth_providers WHERE enabled = TRUE ORDER BY position, display_name",
            params![],
        )
        .await?;

    let list: Vec<PublicOAuthProvider> = providers
        .into_iter()
        .map(|p| PublicOAuthProvider {
            slug:         p.slug,
            display_name: p.display_name,
            button_color: p.button_color,
        })
        .collect();

    Ok(Json(json!({ "providers": list })))
}

pub async fn oauth_redirect(
    axum::extract::Path(provider): axum::extract::Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let p = load_enabled_provider(&state.db, &provider).await?;

    let http = oidc_http_client()?;
    let disc = oauth::discover(&http, &p.issuer_url).await.map_err(AppError::Internal)?;

    let redirect_uri = build_oauth_redirect_uri(&headers, &p.slug);
    let pkce = OAuthPkce::generate();
    let auth_url = oauth::oidc_auth_url(&disc, &p.client_id, &p.scopes, &redirect_uri, &pkce)
        .map_err(AppError::Internal)?;

    let secure_attr = if state.settings.server.secure_cookies { "; Secure" } else { "" };
    let pkce_cookie = format!(
        "oauth_pkce={}; HttpOnly{secure_attr}; Path=/api/v1/auth; SameSite=Lax; Max-Age=600",
        pkce.to_cookie_value()
    );

    Ok((
        [(header::SET_COOKIE, pkce_cookie)],
        Redirect::to(&auth_url),
    ).into_response())
}

// ── OAuth callback ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct OAuthCallbackQuery {
    pub code:  Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

pub async fn oauth_callback(
    axum::extract::Path(provider): axum::extract::Path<String>,
    State(state): State<AppState>,
    client_ip: ClientIp,
    headers: HeaderMap,
    Query(params): Query<OAuthCallbackQuery>,
) -> Result<impl IntoResponse, AppError> {
    // Clear the PKCE cookie in every branch.
    let clear_pkce = "oauth_pkce=; HttpOnly; Path=/api/v1/auth; SameSite=Lax; Max-Age=0";

    // Error returned by the IdP → bounce to the SPA callback with a message.
    if let Some(err) = params.error {
        let desc = params.error_description.unwrap_or_default();
        tracing::warn!(provider = %provider, error = %err, description = %desc, "SSO a retourné une erreur");
        let url = format!("/auth/oauth/callback?error={}", urlencoding_encode(&format!("{err}: {desc}")));
        return Ok(([(header::SET_COOKIE, clear_pkce)], Redirect::to(&url)).into_response());
    }

    let p = load_enabled_provider(&state.db, &provider).await?;

    let code        = params.code.ok_or_else(|| AppError::Validation("Code d'autorisation manquant".into()))?;
    let state_param = params.state.ok_or_else(|| AppError::Validation("Paramètre state manquant".into()))?;

    // Read and verify the PKCE cookie (CSRF protection via `state`).
    let pkce_value = extract_cookie_value(&headers, "oauth_pkce")
        .ok_or_else(|| AppError::Validation("Session OAuth expirée - veuillez réessayer".into()))?;
    let pkce = OAuthPkce::from_cookie_value(&pkce_value)
        .ok_or_else(|| AppError::Validation("Cookie OAuth corrompu".into()))?;
    if state_param != pkce.nonce {
        return Err(AppError::Validation("Vérification CSRF échouée".into()));
    }

    // Decrypt the stored client secret (empty for public clients).
    let client_secret = if p.client_secret_enc.is_empty() {
        String::new()
    } else {
        let key = oauth::secret_key(&state.settings.auth.jwt_secret);
        let bytes = encryption::decrypt(&key, &p.client_secret_enc).map_err(AppError::Internal)?;
        String::from_utf8(bytes).map_err(|e| AppError::Internal(e.into()))?
    };

    let redirect_uri = build_oauth_redirect_uri(&headers, &p.slug);
    let http = oidc_http_client()?;
    let disc = oauth::discover(&http, &p.issuer_url).await.map_err(AppError::Internal)?;

    // Exchange code → access token, then fetch the OIDC profile.
    let tokens = oauth::oidc_exchange_code(
        &http, &disc, &p.client_id, &client_secret, &code, &redirect_uri, &pkce.code_verifier,
    )
    .await
    .map_err(AppError::Internal)?;

    let userinfo = oauth::oidc_userinfo(&http, &disc, &tokens.access_token)
        .await
        .map_err(AppError::Internal)?;

    // Claim mapping. The configured names win; the standard OpenID Connect
    // fields are the fallback, so an instance that never touched the mapping
    // behaves exactly as it did before this became configurable.
    let claims = p.claims();
    let email = oauth::claim_string(&userinfo.raw, &claims.email)
        .or(userinfo.email)
        .map(|e| e.to_lowercase())
        .ok_or_else(|| {
            AppError::Validation(format!(
                "Le profil SSO ne contient pas de revendication « {} » exploitable (scope 'email' requis)",
                claims.email
            ))
        })?;
    let preferred = oauth::claim_string(&userinfo.raw, &claims.username)
        .or(userinfo.preferred_username)
        .or(userinfo.nickname);
    let display_name = oauth::claim_string(&userinfo.raw, &claims.display_name).or(userinfo.name);
    let group_names = if p.sync_groups {
        oauth::claim_list(&userinfo.raw, &claims.groups)
    } else {
        Vec::new()
    };

    // Find (or link) an existing user; otherwise create one if signup is allowed.
    let user = match find_oauth_user(&state.db, &p.slug, &userinfo.sub, &email).await? {
        Some(u) => u,
        None if !p.allow_signup => {
            let url = format!(
                "/auth/oauth/callback?error={}",
                urlencoding_encode("Création de compte via SSO désactivée pour ce fournisseur")
            );
            return Ok(([(header::SET_COOKIE, clear_pkce)], Redirect::to(&url)).into_response());
        }
        None => {
            create_oauth_user(&state.db, &p.slug, &userinfo.sub, &email, preferred.as_deref(), display_name.as_deref())
                .await?
        }
    };

    // The unit's policy applies here too. It is checked *after* the identity
    // provider has authenticated the person - which is the only point at which
    // the account, and therefore its unit, is known. Saying so plainly is safe
    // at this stage: reaching it required valid credentials at the provider, so
    // the message cannot be used to probe for accounts from outside.
    let methods = crate::auth::methods::for_user(&state.db, user.id).await;
    if !methods.sso {
        tracing::info!(
            user_id = %user.id,
            provider = %p.slug,
            "Connexion SSO refusée : méthode non acceptée pour l'unité du compte"
        );
        let url = format!(
            "/auth/oauth/callback?error={}",
            urlencoding_encode(
                "La connexion par fournisseur d'identité n'est pas autorisée pour votre unité organisationnelle."
            )
        );
        return Ok(([(header::SET_COOKIE, clear_pkce)], Redirect::to(&url)).into_response());
    }

    // Groups the identity provider claims for this person. Applied after the
    // account exists and before the session is issued, so the very first
    // sign-in already carries the right memberships - and so a role assignment
    // attached to an imported group takes effect immediately.
    if p.sync_groups {
        super::oauth_users::apply_claimed_groups(&state.db, &p.slug, user.id, &group_names).await;
    }

    // Issue Kubuno tokens.
    let jwt = JwtService::new(
        state.settings.auth.jwt_secret.clone(),
        state.settings.auth.access_token_ttl,
    );
    // The session row id is minted here so the access token can name it:
    // download/stream tickets minted from it then die with the session.
    let session_id = kubuno_db::new_id();
    let access_token = jwt.generate_access_token_for_session(&user, Some(session_id))?;
    let (refresh_raw, refresh_hash) = JwtService::generate_refresh_token();

    // Same trusted-proxy aware resolution as the password sign-in path.
    let ip_owned = client_ip.to_inet_string();
    let ip = ip_owned.as_deref();
    let ua = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("");
    let expires_at = Utc::now() + state.settings.auth.refresh_token_ttl;
    let device_name = format!("{} SSO", p.display_name);

    // An SSO sign-in joins the same inventory as every other one; a device that
    // only ever authenticates through the identity provider must not be missing
    // from the operator's list.
    let normalised = crate::devices::normalise(ua);
    let cookies = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    let device_key = crate::devices::correlate::resolve(
        headers
            .get(crate::devices::correlate::DEVICE_HEADER)
            .and_then(|v| v.to_str().ok()),
        cookies,
        user.id,
        "web",
        &normalised,
        true,
    );
    let country = client_ip.0.and_then(crate::devices::geoip::lookup);
    let touched = crate::devices::correlate::upsert(
        &state.db,
        user.id,
        &device_key,
        &normalised,
        ua,
        "web",
        ip,
        country.as_deref(),
    )
    .await?;

    if touched.approval == crate::devices::Approval::Blocked.as_str()
        && crate::devices::declared::block_denies_refresh(&state.db).await
    {
        tracing::warn!(user_id = %user.id, "Connexion SSO refusée : appareil bloqué");
        return Err(AppError::Forbidden);
    }

    // NOTE (migration consolidation): `::inet` is a PostgreSQL-only cast; the
    // other engines store `ip_address` as text, so the cast is dropped there.
    let inet = if matches!(state.db.backend(), Backend::Postgres) {
        "::inet"
    } else {
        ""
    };
    let insert_sql = format!(
        r#"INSERT INTO core.refresh_tokens
           (id, user_id, token_hash, device_name, device_type, ip_address, user_agent, expires_at,
            device_id, country, auth_strength)
           VALUES ($1, $2, $3, $4, 'web', $5{inet}, $6, $7, $8, $9, $10)"#
    );
    state
        .db
        .execute(
            &insert_sql,
            params![
                session_id,
                user.id,
                &refresh_hash,
                &device_name,
                ip,
                ua,
                expires_at,
                touched.device_id,
                country.as_deref(),
                crate::devices::AuthStrength::Sso.as_str(),
            ],
        )
        .await?;

    crate::devices::correlate::record_event(
        &state.db,
        touched.device_id,
        crate::devices::event_kind::SESSION_OPENED,
        ip,
        country.as_deref(),
        Some(user.id),
        None,
        Some(crate::devices::AuthStrength::Sso.as_str()),
    )
    .await;

    state
        .db
        .execute(
            "UPDATE core.users SET last_login_at = $1 WHERE id = $2",
            params![Utc::now(), user.id],
        )
        .await?;

    let secure = if state.settings.server.secure_cookies { "; Secure" } else { "" };
    let refresh_cookie = format!(
        "refresh_token={refresh_raw}; HttpOnly{secure}; Path=/api/v1/auth; SameSite=Strict; Max-Age={}",
        state.settings.auth.refresh_token_ttl.as_secs()
    );
    // The access token is NOT handed over in a cookie (a script-readable one was
    // used before): the landing page's bootstrap refreshes from the HttpOnly
    // refresh cookie set here, a same-origin request that does carry it. Any
    // `oauth_token` cookie left by an older version is erased.
    let clear_token_cookie = "oauth_token=; Path=/auth/oauth/callback; SameSite=Strict; Max-Age=0";

    let mut resp_headers = axum::http::HeaderMap::new();
    resp_headers.append(header::SET_COOKIE, clear_pkce.parse().unwrap());
    resp_headers.append(header::SET_COOKIE, refresh_cookie.parse().unwrap());
    resp_headers.append(header::SET_COOKIE, header::HeaderValue::from_static(clear_token_cookie));
    // Deprecated compatibility cookie (HttpOnly), see `crate::auth::tickets`.
    if let Some(value) = crate::auth::tickets::legacy_cookie(
        &state,
        &access_token,
        state.settings.auth.access_token_ttl.as_secs(),
    )
    .and_then(|c| header::HeaderValue::from_str(&c).ok())
    {
        resp_headers.append(header::SET_COOKIE, value);
    }

    // The minted correlation cookie rides along, otherwise the next SSO sign-in
    // from this browser falls back to the fingerprint and splits the inventory.
    if let Some(minted) = device_key.mint.as_deref() {
        let value = crate::devices::correlate::mint_cookie(
            minted,
            state.settings.server.secure_cookies,
        );
        if let Ok(parsed) = header::HeaderValue::from_str(&value) {
            resp_headers.append(header::SET_COOKIE, parsed);
        }
    }

    Ok((resp_headers, Redirect::to("/auth/oauth/callback")).into_response())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn build_oauth_redirect_uri(headers: &HeaderMap, provider: &str) -> String {
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get("host"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(if host.contains("localhost") { "http" } else { "https" });
    format!("{scheme}://{host}/api/v1/auth/oauth/{provider}/callback")
}

fn extract_cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get("cookie")?.to_str().ok()?;
    let prefix = format!("{name}=");
    raw.split(';')
        .find_map(|part| part.trim().strip_prefix(&prefix))
        .map(str::to_string)
}

fn urlencoding_encode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}
