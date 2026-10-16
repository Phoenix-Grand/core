use crate::{
    auth::jwt::JwtService,
    auth::middleware::InternalRequest,
    auth::tickets,
    auth::token_scope::{self, TokenGrant},
    errors::AppError,
    models::user::User,
    state::AppState,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use kubuno_db::params;
use axum::{
    body::Body,
    extract::{FromRequestParts, Path, State, WebSocketUpgrade},
    http::{HeaderName, HeaderValue, Request, Response, StatusCode},
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite;

pub async fn proxy_to_module(
    state: &AppState,
    module_id: &str,
    mut req: Request<Body>,
) -> Result<Response<Body>, AppError> {
    let registry = state.modules.read().await;
    let instance = registry
        .get(module_id)
        .ok_or_else(|| AppError::NotFound(format!("Module '{module_id}' non actif")))?;

    let base_url = instance.base_url.trim_end_matches('/').to_owned();
    drop(registry);

    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");

    // Le path a déjà été stripped de /api/v1 par le nest Axum.
    // On retire aussi le préfixe /{module_id} pour que le module reçoive ses propres routes.
    // Ex: /files/folders → /folders, /files → /
    let stripped = path_and_query
        .strip_prefix(&format!("/{module_id}"))
        .map(|s| if s.is_empty() { "/" } else { s })
        .unwrap_or(path_and_query)
        .to_owned();

    // A signed ticket (`?kt=`) is the core's business: the module never sees it.
    let target_url = format!("{base_url}{}", tickets::strip_from_path_and_query(&stripped));

    // ── Authentification interne module→module ───────────────────────────────
    // Un module (ex: Flow) peut appeler un autre module au nom d'un utilisateur,
    // de façon asynchrone (sans JWT). Il présente alors son secret interne
    // + l'identité voulue via X-Kubuno-User-Id. On lui fait confiance : ces appels
    // proviennent du réseau interne et le secret n'est jamais exposé au client.
    //
    // Le secret présenté identifie désormais l'appelant (secret dérivé par
    // module) ; le secret maître reste accepté sans identification.
    let caller = req
        .headers()
        .get("x-internal-secret")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| state.settings.server.authenticate_internal(s));

    // Resolve the real client IP for a direct (non-module) call, using the
    // hardened trusted-proxy logic (honours X-Forwarded-For / X-Real-IP only from
    // a trusted peer). Computed here, while `req` is still immutably borrowable,
    // and injected below as `x-kubuno-client-ip` so a module can implement IP
    // bans / abuse control without ever seeing a client-supplied, unvalidated
    // header. For a module→module call we let the caller propagate whatever IP it
    // already set (it forwards the original end-user address on the user's behalf).
    let resolved_client_ip =
        if caller.is_none() { crate::auth::client_ip::client_ip(&req) } else { None };

    // ── Strip client-supplied identity headers ───────────────────────────────
    // Only an authenticated internal caller (a module presenting a valid secret,
    // `caller` above) may carry a pre-set X-Kubuno-User-* - that is how one
    // module acts on a user's behalf. For everyone else these headers are the
    // core's to set from the verified token, and the signed X-Kubuno-Auth is the
    // core's alone to mint: an incoming copy is a forgery and is dropped here,
    // before any code path could forward it unresolved (e.g. an anonymous
    // request to a public module route, which no branch below overwrites).
    if caller.is_none() {
        let h = req.headers_mut();
        h.remove("x-kubuno-user-id");
        h.remove("x-kubuno-user-role");
        h.remove("x-kubuno-user-email");
        h.remove("x-kubuno-client-ip");
        h.remove(kubuno_modauth::TOKEN_HEADER);
    }

    // ── A module's internal and IPC routes are not public ──────────────────
    // Further down, the proxy REPLACES X-Internal-Secret with the target module's
    // secret, so every request reaches the module with a valid secret. Its
    // `/internal/*` and `/ipc/*` routes (which act for the instance or another
    // module, without an account) would then be reachable by any client. Only an
    // authenticated module→module caller (`caller`) may use them; module IPC
    // normally goes through `ipc_relay`. The path is normalised first so that
    // `/./ipc`, `//ipc` or `%2Fipc` cannot slip through.
    if caller.is_none() && is_private_module_path(&stripped) {
        tracing::warn!(
            module = %module_id,
            "Accès refusé à une route interne de module depuis une requête client"
        );
        return Err(AppError::NotFound(format!(
            "Route inconnue pour le module '{module_id}'"
        )));
    }

    let internal_user_id = caller.as_ref().and_then(|c| {
        tracing::debug!(
            caller = %c.label(),
            target = %module_id,
            "Appel interne module→module authentifié"
        );
        req.headers()
            .get("x-kubuno-user-id")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
    });

    if let Some(uid) = internal_user_id {
        let resolved_user = state
            .db
            .fetch_optional_as::<User>(
                "SELECT * FROM core.users WHERE id = $1 AND is_active = TRUE",
                params![uid],
            )
            .await
            .ok()
            .flatten();

        if let Some(user) = resolved_user {
            let headers = req.headers_mut();
            if let Ok(v) = HeaderValue::from_str(&user.id.to_string()) {
                headers.insert(HeaderName::from_static("x-kubuno-user-id"), v);
            }
            if let Ok(v) = HeaderValue::from_str(&user.role) {
                headers.insert(HeaderName::from_static("x-kubuno-user-role"), v);
            }
            if let Ok(v) = HeaderValue::from_str(&user.email) {
                headers.insert(HeaderName::from_static("x-kubuno-user-email"), v);
            }
        }
    }

    // Resolve the caller for the identity headers. In order:
    //  1. `Authorization: Bearer` - a session JWT or a personal API token;
    //  2. a signed ticket `?kt=` - what a browser presents where it cannot set a
    //     header (`<img>`, `<video>` and its Range requests, a download
    //     navigation, `EventSource`). Bound to THIS module, path and method: a
    //     ticket minted for drive is refused here when the path is photos';
    //  3. the deprecated `access_token` cookie, only while
    //     `auth.legacy_access_cookie` is on, with a deprecation warning.
    let header_bearer = req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_owned());
    let mut ticket_used = false;

    if internal_user_id.is_none() {
    let ticket = if header_bearer.is_none() {
        tickets::from_query(req.uri().query()).map(str::to_owned)
    } else {
        None
    };
    let resolved: Option<(User, Option<TokenGrant>)> = if let Some(t) = ticket {
        let full_path = format!("/api/v1{}", req.uri().path());
        let (user, _claims) =
            tickets::authenticate(state, &t, module_id, &full_path, req.method().as_str()).await?;
        ticket_used = true;
        Some((user, None))
    } else {
        let bearer = header_bearer.or_else(|| {
            let t = tickets::legacy_cookie_token(state, req.headers())?;
            tickets::log_legacy_cookie_use(module_id, req.uri().path());
            Some(t.to_owned())
        });
        match bearer {
            Some(token) => {
                let (resolved_user, grant) = resolve_caller(state, &token).await;
                resolved_user.map(|u| (u, grant))
            }
            None => None,
        }
    };

    {
        if let Some((user, grant)) = resolved {
            // The role a module sees. For a session it is the account's own; for
            // an API token it is derived from the token's scopes, because
            // forwarding the owner's role verbatim is what made a personal token
            // an administration key inside every module at once.
            let role = match grant.as_ref() {
                Some(g) => token_scope::module_role_for(g, &user.role),
                None => user.role.clone(),
            };
            let headers = req.headers_mut();
            if let Ok(v) = HeaderValue::from_str(&user.id.to_string()) {
                headers.insert(HeaderName::from_static("x-kubuno-user-id"), v);
            }
            if let Ok(v) = HeaderValue::from_str(&role) {
                headers.insert(HeaderName::from_static("x-kubuno-user-role"), v);
            }
            if let Ok(v) = HeaderValue::from_str(&user.email) {
                headers.insert(HeaderName::from_static("x-kubuno-user-email"), v);
            }
            annotate_origin(headers, grant.as_ref());
            if ticket_used {
                headers.insert(
                    HeaderName::from_static("x-kubuno-auth-origin"),
                    HeaderValue::from_static("ticket"),
                );
            }

            // Attendance. Counted HERE and nowhere else: this is the one line of
            // the whole system where an account and an application are known at
            // the same time, and it costs a hash-map insert - the response is
            // never made to wait for a measurement (see `modules::usage`).
            //
            // Deliberately NOT counted on the module→module branch above: a call
            // Flow makes to Drive on somebody's behalf is an automation running,
            // not a person opening an application, and folding the two together
            // would make a busy rule look like a popular module.
            state.usage.record(module_id, user.id);
        }
    }
    } // fin: authentification par token (ignorée si auth interne module→module)

    // ── Sign the forwarded identity (core → module trust boundary) ───────────
    // The per-module secret both authenticates the hop and keys a short-lived,
    // audience-bound identity token (kubuno-modauth). Binding the identity to the
    // secret is what closes the forgery: a process reaching the module's loopback
    // port directly can set X-Kubuno-User-* freely, but cannot produce a valid
    // X-Kubuno-Auth without the module's secret, and a token minted for one
    // module does not validate at another. The plain X-Kubuno-User-* headers are
    // still forwarded for modules not yet migrated to verify the token.
    let module_secret = state.settings.server.module_secret(module_id);
    let signed_identity = {
        let h = req.headers();
        h.get("x-kubuno-user-id")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .map(|id| {
                let role = h
                    .get("x-kubuno-user-role")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("user")
                    .to_owned();
                let email = h
                    .get("x-kubuno-user-email")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_owned();
                let user = kubuno_modauth::ModuleUser { id, role, email };
                kubuno_modauth::sign(module_secret.as_bytes(), &user, module_id)
            })
    };

    // Remplacer Authorization par le secret interne du module cible (celui qu'il
    // possède : le module compare le header reçu à sa propre valeur).
    let headers = req.headers_mut();
    headers.remove("authorization");

    // The real client IP, resolved above, for a module's abuse control (IP bans).
    // Set only for direct client calls; a module→module hop keeps whatever the
    // caller forwarded.
    if let Some(ip) = resolved_client_ip {
        if let Ok(v) = HeaderValue::from_str(&ip.to_string()) {
            headers.insert(HeaderName::from_static("x-kubuno-client-ip"), v);
        }
    }
    // Re-mint from scratch: the client must never supply a token of its own.
    headers.remove(kubuno_modauth::TOKEN_HEADER);
    if let Some(token) = signed_identity {
        if let Ok(v) = HeaderValue::from_str(&token) {
            headers.insert(HeaderName::from_static(kubuno_modauth::TOKEN_HEADER), v);
        }
    }
    if let Ok(v) = HeaderValue::from_str(&module_secret) {
        headers.insert(HeaderName::from_static("x-internal-secret"), v);
    }

    // Construire la requête vers le module
    let client = reqwest::Client::new();
    let method = reqwest::Method::from_bytes(req.method().as_str().as_bytes())
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Méthode HTTP invalide: {e}")))?;

    // Cloner les headers modifiés avant de consommer le body.
    // Supprimer les hop-by-hop headers qui ne doivent pas être forwardés.
    let mut forwarded_headers = req.headers().clone();
    for h in &["host", "connection", "transfer-encoding", "te", "upgrade", "keep-alive",
               "content-length"] {
        forwarded_headers.remove(*h);
    }

    let body_bytes = axum::body::to_bytes(req.into_body(), usize::MAX)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Lecture body: {e}")))?;

    let resp = client
        .request(method, &target_url)
        .headers(forwarded_headers)
        .body(body_bytes)
        .send()
        .await
        .map_err(|e| {
            tracing::error!(error = %e, module_id = %module_id, "Proxy module échoué");
            AppError::Internal(anyhow::anyhow!("Module injoignable: {e}"))
        })?;

    let status = StatusCode::from_u16(resp.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);

    // Forwarder les headers de réponse du module (Content-Type, etc.)
    // sauf les hop-by-hop headers
    let mut builder = Response::builder().status(status);
    for (name, value) in resp.headers() {
        let n = name.as_str();
        // The Referrer-Policy is the core's to decide (set below for a ticketed
        // request, else by the global security layer), never a module's.
        if matches!(n, "connection" | "transfer-encoding" | "keep-alive" | "te" | "upgrade" | "referrer-policy") {
            continue;
        }
        // A ticketed URL is a per-user capability: no shared cache (reverse
        // proxy, CDN) may keep its response under that URL.
        if ticket_used && n == "cache-control" {
            builder = builder.header(name, privatise_cache_control(value));
            continue;
        }
        builder = builder.header(name, value);
    }
    if ticket_used {
        if !resp.headers().contains_key("cache-control") {
            builder = builder.header("cache-control", "private, no-cache");
        }
        // The ticket sits in the URL: never let it travel on as a Referer
        // (e.g. a PDF or HTML document opened in a tab, linking elsewhere).
        builder = builder.header("referrer-policy", "no-referrer");
    }

    // Stream the module response instead of buffering it fully: required for
    // infinite responses (live radio/audio streams) and avoids holding large
    // files in memory. Hop-by-hop headers were already stripped above.
    let body = Body::from_stream(resp.bytes_stream());

    Ok(builder.body(body).unwrap())
}

/// Module→module IPC relay: `ANY /internal/ipc/:target/*rest`.
///
/// A module cannot authenticate directly to another when secrets are derived
/// (`server.derive_module_secrets`): each holds only its own and compares it by
/// equality, and only the core knows the target's. So the call transits the
/// core, which authenticates the CALLER (derived or master secret), re-injects
/// the TARGET's secret, and relays to `{target}/ipc/<rest>`.
///
/// The relay is BOUNDED to the target's `/ipc/` surface - the core prepends
/// `/ipc/` - so a module can reach neither the user routes nor `/internal/*` of
/// another module through it. It works identically whether secrets are derived
/// or shared: the core presents whatever value the target expects.
///
/// Errors: 401 when the caller is not a valid internal caller (handled by the
/// `InternalRequest` extractor); 503 when the target has no active instance;
/// otherwise the target's own `/ipc` response streams back verbatim.
pub async fn ipc_relay(
    State(state): State<AppState>,
    caller: InternalRequest,
    Path((target, rest)): Path<(String, String)>,
    req: Request<Body>,
) -> Result<Response<Body>, AppError> {
    // The registry only tracks ACTIVE instances (not installed-but-stopped
    // modules), so an absent target means "not currently available" → 503.
    let base_url = {
        let registry = state.modules.read().await;
        match registry.get(&target) {
            Some(inst) => inst.base_url.trim_end_matches('/').to_owned(),
            None => {
                tracing::warn!(caller = %caller.0.label(), target = %target,
                    "IPC relay: cible sans instance active");
                return Ok(Response::builder()
                    .status(StatusCode::SERVICE_UNAVAILABLE)
                    .body(Body::from(format!(
                        "Module cible '{target}' sans instance active"
                    )))
                    .unwrap());
            }
        }
    };

    // `{base}/ipc/<rest>[?query]`. `rest` is the path AFTER the target id; the
    // core imposes the `/ipc/` prefix, which is what bounds the reachable
    // surface to the module's IPC routes.
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let target_url = format!("{base_url}/ipc/{rest}{query}");

    // Re-inject the TARGET's secret (the value it compares against its own), and
    // re-sign the identity token for the target when the caller set an
    // X-Kubuno-User-Id. The caller is authenticated (InternalRequest), so it is
    // trusted for the identity it presents - the same trust the user→module
    // proxy grants an authenticated internal caller. Drive's /ipc routes take the
    // user id from the path/body, so they need none of this; it is here so a
    // module that DOES verify X-Kubuno-Auth works through the relay too.
    let module_secret = state.settings.server.module_secret(&target);
    let signed_identity = {
        let h = req.headers();
        h.get("x-kubuno-user-id")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .map(|id| {
                let role = h
                    .get("x-kubuno-user-role")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("user")
                    .to_owned();
                let email = h
                    .get("x-kubuno-user-email")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_owned();
                let user = kubuno_modauth::ModuleUser { id, role, email };
                kubuno_modauth::sign(module_secret.as_bytes(), &user, &target)
            })
    };

    tracing::debug!(caller = %caller.0.label(), target = %target, rest = %rest,
        "IPC relay");

    let method = reqwest::Method::from_bytes(req.method().as_str().as_bytes())
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Méthode HTTP invalide: {e}")))?;

    let mut forwarded = req.headers().clone();
    // Hop-by-hop headers, plus a user Authorization (the relay is internal), and
    // any identity token the caller supplied - it must never present its own.
    for h in &["host", "connection", "transfer-encoding", "te", "upgrade",
               "keep-alive", "content-length", "authorization"] {
        forwarded.remove(*h);
    }
    forwarded.remove(kubuno_modauth::TOKEN_HEADER);
    if let Some(token) = signed_identity {
        if let Ok(v) = HeaderValue::from_str(&token) {
            forwarded.insert(HeaderName::from_static(kubuno_modauth::TOKEN_HEADER), v);
        }
    }
    if let Ok(v) = HeaderValue::from_str(&module_secret) {
        forwarded.insert(HeaderName::from_static("x-internal-secret"), v);
    }

    let body_bytes = axum::body::to_bytes(req.into_body(), usize::MAX)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Lecture body: {e}")))?;

    let client = reqwest::Client::new();
    let resp = client
        .request(method, &target_url)
        .headers(forwarded)
        .body(body_bytes)
        .send()
        .await
        .map_err(|e| {
            tracing::error!(error = %e, target = %target, "Relais IPC échoué");
            AppError::Internal(anyhow::anyhow!("Module cible injoignable: {e}"))
        })?;

    let status = StatusCode::from_u16(resp.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut builder = Response::builder().status(status);
    for (name, value) in resp.headers() {
        let n = name.as_str();
        if !matches!(n, "connection" | "transfer-encoding" | "keep-alive" | "te" | "upgrade") {
            builder = builder.header(name, value);
        }
    }
    let body = Body::from_stream(resp.bytes_stream());
    Ok(builder.body(body).unwrap())
}

/// Returns true if this request is a WebSocket upgrade.
pub fn is_websocket_upgrade(req: &Request<Body>) -> bool {
    req.headers()
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
}

/// Proxy a WebSocket upgrade request to the target module.
/// Bidirectionally forwards frames between the client and the module.
pub async fn proxy_ws_to_module(
    state: AppState,
    module_id: String,
    req: Request<Body>,
) -> axum::response::Response {
    let registry = state.modules.read().await;
    let instance = match registry.get(&module_id) {
        Some(i) => i.clone(),
        None => {
            drop(registry);
            return AppError::NotFound(format!("Module '{module_id}' non actif")).into_response();
        }
    };
    let base_url = instance.base_url.trim_end_matches('/').to_owned();
    drop(registry);

    let path_and_query = req.uri().path_and_query().map(|pq| pq.as_str()).unwrap_or("/").to_owned();
    let stripped = path_and_query
        .strip_prefix(&format!("/{module_id}"))
        .map(|s| if s.is_empty() { "/" } else { s })
        .unwrap_or(&path_and_query)
        .to_owned();

    // Same rule as the HTTP proxy, unconditional here: a WebSocket carries no
    // module→module authentication.
    if is_private_module_path(&stripped) {
        tracing::warn!(
            module = %module_id,
            "Accès refusé à une route interne de module depuis une WebSocket cliente"
        );
        return AppError::NotFound(format!("Route inconnue pour le module '{module_id}'"))
            .into_response();
    }

    // Convert http:// base_url → ws://
    let ws_base = base_url
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    // The ticket never reaches the module.
    let target_ws_url = format!("{ws_base}{}", tickets::strip_from_path_and_query(&stripped));

    // Resolve the user. Browsers cannot set headers on a WebSocket handshake, so
    // after the Authorization header (native clients) comes a signed ticket
    // (`?kt=`, bound to this module and path), then the deprecated cookie (only
    // while `auth.legacy_access_cookie` is on), then `?token=<access token>`,
    // still used by the native clients.
    let header_bearer = req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_owned());
    let ticket = if header_bearer.is_none() {
        tickets::from_query(req.uri().query()).map(str::to_owned)
    } else {
        None
    };
    let ticket_user = match ticket {
        Some(t) => {
            let full_path = format!("/api/v1{}", req.uri().path());
            match tickets::authenticate(&state, &t, &module_id, &full_path, "GET").await {
                Ok((user, _)) => Some(user),
                Err(e) => return e.into_response(),
            }
        }
        None => None,
    };
    let bearer = if ticket_user.is_some() {
        None
    } else {
        header_bearer
            .or_else(|| {
                let t = tickets::legacy_cookie_token(&state, req.headers())?;
                tickets::log_legacy_cookie_use(&module_id, req.uri().path());
                Some(t.to_owned())
            })
            .or_else(|| {
                req.uri().query()
                    .and_then(|q| url::form_urlencoded::parse(q.as_bytes())
                        .find(|(k, _)| k == "token")
                        .map(|(_, v)| v.into_owned()))
            })
    };

    // Per-module secret: authenticates the hop AND keys the identity token below.
    let module_secret = state.settings.server.module_secret(&module_id);

    let mut user_headers: Vec<(String, String)> = Vec::new();
    let resolved = match (ticket_user, bearer) {
        (Some(user), _) => Some((user, None, "ticket")),
        (None, Some(token)) => {
            let (resolved_user, grant) = resolve_caller(&state, &token).await;
            resolved_user.map(|u| {
                let origin = if grant.is_some() { "api_token" } else { "session" };
                (u, grant, origin)
            })
        }
        (None, None) => None,
    };
    if let Some((user, grant, origin)) = resolved {
        {
            let role = match grant.as_ref() {
                Some(g) => token_scope::module_role_for(g, &user.role),
                None => user.role.clone(),
            };
            user_headers.push(("x-kubuno-user-id".to_owned(), user.id.to_string()));
            user_headers.push(("x-kubuno-user-role".to_owned(), role.clone()));
            user_headers.push(("x-kubuno-user-email".to_owned(), user.email.clone()));
            // Signed, audience-bound identity - same trust boundary as the HTTP
            // path (see kubuno-modauth). A WebSocket forged directly against the
            // module's loopback port cannot produce this without the secret.
            let mu = kubuno_modauth::ModuleUser {
                id: user.id,
                role,
                email: user.email.clone(),
            };
            user_headers.push((
                kubuno_modauth::TOKEN_HEADER.to_owned(),
                kubuno_modauth::sign(module_secret.as_bytes(), &mu, &module_id),
            ));
            user_headers.push(("x-kubuno-auth-origin".to_owned(), origin.to_owned()));
            if let Some(g) = grant.as_ref().filter(|g| !g.is_legacy) {
                user_headers.push(("x-kubuno-token-scopes".to_owned(), g.scopes.join(",")));
            }
            // One count per socket opened, not per frame. Chat and media are
            // used almost entirely over this path; without it they would read as
            // deserted on the attendance panel.
            state.usage.record(&module_id, user.id);
        }
    }
    // Secret interne du module cible (celui qu'il détient), pas le secret maître.
    user_headers.push(("x-internal-secret".to_owned(), module_secret));

    // Extract WebSocketUpgrade from the request parts
    let (mut parts, _body) = req.into_parts();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        Ok(u) => u,
        Err(e) => return e.into_response(),
    };

    upgrade.on_upgrade(move |client_ws| async move {
        // Build tungstenite request with WebSocket handshake headers + user headers.
        // When passing http::Request<()> to connect_async, tungstenite does NOT auto-add
        // the mandatory WebSocket headers, so we must include them ourselves.
        let ws_key: [u8; 16] = rand::random();
        let ws_key_b64 = B64.encode(ws_key);

        // Extract host[:port] from the target URL for the required Host header
        let host_header = target_ws_url
            .trim_start_matches("wss://")
            .trim_start_matches("ws://")
            .split('/')
            .next()
            .unwrap_or("127.0.0.1");

        let mut req_builder = tungstenite::handshake::client::Request::builder()
            .uri(&target_ws_url)
            .header("Host", host_header)
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Key", &ws_key_b64);
        for (k, v) in &user_headers {
            req_builder = req_builder.header(k.as_str(), v.as_str());
        }
        let tung_req = match req_builder.body(()) {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(error = %e, "WS proxy: build request failed");
                return;
            }
        };

        let (module_ws, _) = match tokio_tungstenite::connect_async(tung_req).await {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, target = %target_ws_url, "WS proxy: connect to module failed");
                return;
            }
        };

        let (mut client_sink, mut client_stream) = client_ws.split();
        let (mut module_sink, mut module_stream) = module_ws.split();

        // Client → Module
        let c2m = tokio::spawn(async move {
            while let Some(Ok(msg)) = client_stream.next().await {
                let tung_msg = axum_to_tung(msg);
                if matches!(tung_msg, tungstenite::Message::Close(_)) {
                    let _ = module_sink.send(tung_msg).await;
                    break;
                }
                if module_sink.send(tung_msg).await.is_err() { break; }
            }
        });

        // Module → Client
        while let Some(Ok(msg)) = module_stream.next().await {
            let axum_msg = tung_to_axum(msg);
            if matches!(axum_msg, axum::extract::ws::Message::Close(_)) {
                let _ = client_sink.send(axum_msg).await;
                break;
            }
            if client_sink.send(axum_msg).await.is_err() { break; }
        }

        c2m.abort();
    }).into_response()
}

fn axum_to_tung(msg: axum::extract::ws::Message) -> tungstenite::Message {
    use axum::extract::ws::Message as A;
    use tungstenite::Message as T;
    match msg {
        A::Text(s)   => T::Text(s.to_string()),
        A::Binary(b) => T::Binary(b),
        A::Ping(p)   => T::Ping(p),
        A::Pong(p)   => T::Pong(p),
        A::Close(f)  => T::Close(f.map(|cf| tungstenite::protocol::CloseFrame {
            code:   tungstenite::protocol::frame::coding::CloseCode::from(cf.code),
            reason: cf.reason.to_string().into(),
        })),
    }
}

fn tung_to_axum(msg: tungstenite::Message) -> axum::extract::ws::Message {
    use axum::extract::ws::Message as A;
    use tungstenite::Message as T;
    match msg {
        T::Text(s)   => A::Text(s.to_string()),
        T::Binary(b) => A::Binary(b),
        T::Ping(p)   => A::Ping(p),
        T::Pong(p)   => A::Pong(p),
        T::Close(f)  => A::Close(f.map(|cf| axum::extract::ws::CloseFrame {
            code:   cf.code.into(),
            reason: cf.reason.to_string().into(),
        })),
        T::Frame(_)  => A::Binary(vec![]),
    }
}

/// Resolves a bearer into the account it names **and** the grant behind it.
///
/// Shared by the HTTP and the WebSocket path so the two cannot drift: a refusal
/// or a role rule added here applies to both. Returns `(None, None)` for anything
/// that does not resolve - the proxy then forwards no identity headers at all,
/// which is what an unauthenticated call should look like to a module.
///
/// The grant is `Some` only for an API token; a session yields `(user, None)` and
/// keeps the account's own role.
async fn resolve_caller(
    state: &AppState,
    token: &str,
) -> (Option<User>, Option<TokenGrant>) {
    let jwt = JwtService::new(
        state.settings.auth.jwt_secret.clone(),
        state.settings.auth.access_token_ttl,
    );

    if let Ok(claims) = jwt.validate_access_token(token) {
        let user = load_active_user(state, claims.sub).await;
        return (user, None);
    }

    // API token. Every refusal - revoked, expired, owner deactivated, legacy past
    // its grace window - is decided by `resolve_grant`, the one path all three
    // entry points share.
    match token_scope::resolve_grant(&state.db, token).await {
        Ok(grant) => {
            let user = load_active_user(state, grant.user_id).await;
            (user, Some(grant))
        }
        Err(_) => (None, None),
    }
}

async fn load_active_user(state: &AppState, id: uuid::Uuid) -> Option<User> {
    match state
        .db
        .fetch_optional_as::<User>(
            "SELECT * FROM core.users WHERE id = $1 AND is_active = TRUE",
            params![id],
        )
        .await
    {
        Ok(u) => u,
        Err(e) => {
            tracing::error!(error = %e, user_id = %id, "Proxy : chargement de l'utilisateur");
            None
        }
    }
}

/// Tells the module how the caller authenticated, and with what scopes.
///
/// Informational: the core has already narrowed the role above, so a module that
/// ignores these headers is not less safe than before. A module that reads them
/// can be stricter - refuse a programmatic call on a route meant for a person,
/// say - without the core having to know that route exists.
fn annotate_origin(headers: &mut axum::http::HeaderMap, grant: Option<&TokenGrant>) {
    let origin = if grant.is_some() { "api_token" } else { "session" };
    if let Ok(v) = HeaderValue::from_str(origin) {
        headers.insert(HeaderName::from_static("x-kubuno-auth-origin"), v);
    }
    // A legacy token has no scope list to publish; its header is omitted rather
    // than sent empty, which would read as "scoped to nothing".
    match grant.filter(|g| !g.is_legacy) {
        Some(g) => {
            if let Ok(v) = HeaderValue::from_str(&g.scopes.join(",")) {
                headers.insert(HeaderName::from_static("x-kubuno-token-scopes"), v);
            }
        }
        None => {
            headers.remove("x-kubuno-token-scopes");
        }
    }
}

/// `Cache-Control` for a response to a ticketed request: `public` and
/// `s-maxage` (shared-cache directives) are dropped and `private` is added, the
/// browser-side directives (`max-age`, `immutable`…) are kept so thumbnails stay
/// cacheable in the tab.
fn privatise_cache_control(value: &HeaderValue) -> HeaderValue {
    let Ok(raw) = value.to_str() else {
        return HeaderValue::from_static("private, no-cache");
    };
    let mut kept: Vec<&str> = raw
        .split(',')
        .map(str::trim)
        .filter(|d| {
            let lower = d.to_ascii_lowercase();
            !d.is_empty() && lower != "public" && !lower.starts_with("s-maxage") && lower != "private"
        })
        .collect();
    let has_no_store = kept.iter().any(|d| d.eq_ignore_ascii_case("no-store"));
    if !has_no_store {
        kept.insert(0, "private");
    }
    HeaderValue::from_str(&kept.join(", "))
        .unwrap_or_else(|_| HeaderValue::from_static("private, no-cache"))
}

/// True when a client-supplied module path targets the module's private surface
/// (`/internal/*` or `/ipc/*`). The path is normalised the way an HTTP router
/// might: query dropped, percent-decoding applied (repeatedly, against double
/// encoding), backslashes read as slashes, empty and `.` segments ignored. A `..`
/// segment is treated as private: no legitimate client path needs one.
fn is_private_module_path(path_and_query: &str) -> bool {
    let path = path_and_query.split(['?', '#']).next().unwrap_or_default();
    let mut decoded = path.to_owned();
    for _ in 0..3 {
        let next = percent_decode(&decoded);
        if next == decoded {
            break;
        }
        decoded = next;
    }
    let normalised = decoded.replace('\\', "/");
    if normalised.split('/').any(|s| s == "..") {
        return true;
    }
    match normalised.split('/').find(|s| !s.is_empty() && *s != ".") {
        None => false,
        Some(first) => {
            let first = first.to_ascii_lowercase();
            first == "internal" || first == "ipc"
        }
    }
}

/// Minimal percent-decoding; invalid escapes are kept as they are.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn private_module_paths_are_detected_after_normalisation() {
        use super::is_private_module_path as p;
        for path in [
            "/internal", "/internal/x", "/ipc", "/ipc/files/1", "//ipc/x", "/./ipc/x",
            "/%69pc/x", "/%2569pc/x", "/IPC/x", "/\\ipc/x", "/a/../ipc/x", "/ipc?x=1",
            "/%2Finternal/x",
        ] {
            assert!(p(path), "{path} must be private");
        }
        for path in ["/", "/files/1", "/files/ipc", "/internalize", "/files?q=/ipc/x", "/ipcs"] {
            assert!(!p(path), "{path} must be public");
        }
    }

    use super::privatise_cache_control;
    use axum::http::HeaderValue;

    #[test]
    fn ticketed_responses_never_go_to_shared_caches() {
        let cases = [
            ("public, max-age=3600", "private, max-age=3600"),
            ("public, s-maxage=600, max-age=60, immutable", "private, max-age=60, immutable"),
            ("private, max-age=60", "private, max-age=60"),
            ("no-store", "no-store"),
            ("max-age=86400", "private, max-age=86400"),
        ];
        for (input, expected) in cases {
            let got = privatise_cache_control(&HeaderValue::from_static(input));
            assert_eq!(got.to_str().expect("ascii"), expected, "{input}");
        }
    }
}
