//! Signed download / stream tickets.
//!
//! ## Why
//!
//! A handful of requests are made by the browser itself and can never carry an
//! `Authorization` header: an `<img src>`, a `<video>` and its Range requests,
//! a download performed as a navigation, an `EventSource`, a `WebSocket`
//! handshake. They used to authenticate with an `access_token` cookie that the
//! web client wrote from JavaScript - readable by any script running in the
//! page, so one XSS was enough to lift a full API credential.
//!
//! A ticket replaces that cookie for exactly those requests. It is a short-lived
//! capability for **one** request shape, minted on demand by an authenticated
//! `POST /api/v1/auth/tickets` (bearer header) and carried in the URL as
//! `?kt=<ticket>`:
//!
//! | binding   | meaning                                                           |
//! |-----------|-------------------------------------------------------------------|
//! | `uid`     | the account it acts for                                           |
//! | `sid`     | the session it was minted from - signing out revokes it at once   |
//! | `aud`     | `core` or a module id - a drive ticket is refused by photos       |
//! | `path`    | the exact request path (query string not included)                |
//! | `mth`     | the HTTP method (`GET` also admits `HEAD`)                        |
//! | `exp`     | expiry, seconds since the epoch                                   |
//! | `once`    | optional nonce: the ticket is spent by its first use              |
//!
//! The core validates tickets in exactly two places - the module proxy and the
//! [`crate::auth::middleware::AuthUser`] extractor - and the proxy turns a valid
//! ticket into the same signed identity (`kubuno-modauth`) it forwards for a
//! bearer, so modules need no code of their own.
//!
//! ## Format
//!
//! `kt1.<base64url(json claims)>.<base64url(HMAC-SHA-256(key, "kt1." + payload))>`
//! where `key = HMAC-SHA-256(auth.jwt_secret, "kubuno/ticket/v1")`: a sub-key, so
//! a ticket can never be confused with a JWT signed by the same instance secret.
//!
//! Non-spent tickets are **deterministic** within a time bucket (half the TTL):
//! asking twice for the same resource yields the same URL, so the browser's HTTP
//! cache keeps working for thumbnails instead of re-downloading them each time a
//! fresh ticket is minted.

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64URL};
use hmac::{Hmac, Mac};
use kubuno_db::params;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

use crate::{errors::AppError, models::user::User, state::AppState};

type HmacSha256 = Hmac<Sha256>;

/// Query parameter carrying a ticket.
pub const QUERY_PARAM: &str = "kt";
const VERSION: &str = "kt1";
const KEY_LABEL: &[u8] = b"kubuno/ticket/v1";
/// Longest path a ticket may be bound to.
pub const MAX_PATH_LEN: usize = 2048;
/// How long a positive session-liveness answer is reused. Bounds how late a
/// sign-out takes effect on tickets already in flight.
const SESSION_CACHE_TTL: Duration = Duration::from_secs(5);

/// What the ticket is for. Decides its lifetime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Purpose {
    /// Image, preview, inline document (`<img>`, `<iframe>`).
    #[default]
    View,
    /// File download performed as a navigation.
    Download,
    /// Media playback (`<video>`/`<audio>` with Range requests) or `EventSource`.
    Stream,
    /// `WebSocket` handshake - checked once, at connect.
    Socket,
}

/// Signed claims of a ticket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketClaims {
    pub uid:  Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sid:  Option<Uuid>,
    pub aud:  String,
    pub path: String,
    pub mth:  String,
    pub pur:  Purpose,
    pub exp:  i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub once: Option<String>,
}

/// Why a ticket was refused. Never sent to the client verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketError {
    Malformed,
    BadSignature,
    Expired,
    WrongAudience,
    WrongPath,
    WrongMethod,
    Replayed,
}

impl TicketError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::BadSignature => "bad signature",
            Self::Expired => "expired",
            Self::WrongAudience => "wrong audience",
            Self::WrongPath => "wrong path",
            Self::WrongMethod => "wrong method",
            Self::Replayed => "already used",
        }
    }

    /// 401 for a ticket that proves nothing (forged, garbled, expired), 403 for
    /// a genuine ticket presented where it does not apply.
    pub fn into_app_error(self) -> AppError {
        match self {
            Self::Malformed | Self::BadSignature | Self::Expired => AppError::Unauthorized,
            Self::WrongAudience | Self::WrongPath | Self::WrongMethod | Self::Replayed => {
                AppError::Forbidden
            }
        }
    }
}

// ── Key and signature ────────────────────────────────────────────────────────

/// The ticket signing key, derived from the instance secret.
pub fn derive_key(instance_secret: &str) -> [u8; 32] {
    // `new_from_slice` accepts keys of any length for HMAC; the error branch is
    // unreachable but handled without panicking.
    let mut mac = match HmacSha256::new_from_slice(instance_secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return [0u8; 32],
    };
    mac.update(KEY_LABEL);
    mac.finalize().into_bytes().into()
}

fn mac(key: &[u8; 32], data: &[u8]) -> Vec<u8> {
    match HmacSha256::new_from_slice(key) {
        Ok(mut m) => {
            m.update(data);
            m.finalize().into_bytes().to_vec()
        }
        Err(_) => Vec::new(),
    }
}

/// Serialises and signs `claims`.
pub fn encode(key: &[u8; 32], claims: &TicketClaims) -> String {
    // Serialising a struct of strings, numbers and UUIDs cannot fail.
    let json = serde_json::to_vec(claims).unwrap_or_default();
    let payload = B64URL.encode(json);
    let signing_input = format!("{VERSION}.{payload}");
    let sig = mac(key, signing_input.as_bytes());
    format!("{signing_input}.{}", B64URL.encode(sig))
}

/// Checks the signature and the expiry; returns the claims. Bindings (audience,
/// path, method) are checked separately by [`check_binding`].
pub fn decode(key: &[u8; 32], token: &str, now: i64) -> Result<TicketClaims, TicketError> {
    if token.len() > 8 * 1024 {
        return Err(TicketError::Malformed);
    }
    let mut parts = token.split('.');
    let (Some(ver), Some(payload), Some(sig), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(TicketError::Malformed);
    };
    if ver != VERSION {
        return Err(TicketError::Malformed);
    }
    let sig = B64URL.decode(sig).map_err(|_| TicketError::Malformed)?;
    let mut verifier =
        HmacSha256::new_from_slice(key).map_err(|_| TicketError::BadSignature)?;
    verifier.update(format!("{VERSION}.{payload}").as_bytes());
    // Constant-time comparison.
    verifier.verify_slice(&sig).map_err(|_| TicketError::BadSignature)?;

    let json = B64URL.decode(payload).map_err(|_| TicketError::Malformed)?;
    let claims: TicketClaims =
        serde_json::from_slice(&json).map_err(|_| TicketError::Malformed)?;
    if claims.exp <= now {
        return Err(TicketError::Expired);
    }
    Ok(claims)
}

/// Checks that the ticket applies to this exact request.
pub fn check_binding(
    claims: &TicketClaims,
    audience: &str,
    path: &str,
    method: &str,
) -> Result<(), TicketError> {
    if claims.aud != audience {
        return Err(TicketError::WrongAudience);
    }
    if claims.path != path {
        return Err(TicketError::WrongPath);
    }
    let method_ok = claims.mth.eq_ignore_ascii_case(method)
        || (claims.mth.eq_ignore_ascii_case("GET") && method.eq_ignore_ascii_case("HEAD"));
    if !method_ok {
        return Err(TicketError::WrongMethod);
    }
    Ok(())
}

/// Expiry of a new ticket. Reusable tickets end on a bucket boundary of half the
/// TTL (lifetime between `ttl/2` and `ttl`), which makes them deterministic -
/// and so cacheable - within the bucket. One-time tickets live exactly `ttl`.
pub fn expiry(now: i64, ttl_secs: u64, one_time: bool) -> i64 {
    let ttl = ttl_secs.max(2) as i64;
    if one_time {
        return now + ttl;
    }
    let bucket = ttl / 2;
    // now ∈ [k·b, (k+1)·b)  →  exp = (k+2)·b  →  lifetime ∈ (b, 2b] = (ttl/2, ttl].
    (now.div_euclid(bucket) + 2) * bucket
}

/// Lifetime for `purpose`, from the settings, clamped to sane bounds.
pub fn ttl_for(settings: &crate::config::settings::AuthSettings, purpose: Purpose) -> u64 {
    match purpose {
        Purpose::View | Purpose::Download => settings.ticket_ttl_secs.clamp(30, 900),
        Purpose::Stream => settings.ticket_stream_ttl_secs.clamp(60, 86_400),
        // Checked once, at connect: no reason to let it live long.
        Purpose::Socket => 60,
    }
}

// ── URL helpers ──────────────────────────────────────────────────────────────

/// The ticket carried in a query string, if any.
pub fn from_query(query: Option<&str>) -> Option<&str> {
    query?
        .split('&')
        .find_map(|pair| pair.strip_prefix("kt="))
        .filter(|v| !v.is_empty())
}

/// `path_and_query` without its `kt` parameter (the module must never see it).
pub fn strip_from_path_and_query(path_and_query: &str) -> String {
    let Some((path, query)) = path_and_query.split_once('?') else {
        return path_and_query.to_owned();
    };
    let kept: Vec<&str> = query
        .split('&')
        .filter(|pair| !pair.is_empty() && *pair != "kt" && !pair.starts_with("kt="))
        .collect();
    if kept.is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{}", kept.join("&"))
    }
}

/// Appends `kt=<ticket>` to a relative URL, replacing an existing one.
pub fn append_to_url(url: &str, ticket: &str) -> String {
    let base = strip_from_path_and_query(url);
    let sep = if base.contains('?') { '&' } else { '?' };
    format!("{base}{sep}{QUERY_PARAM}={ticket}")
}

/// Validates a URL a client asks a ticket for and returns its path.
///
/// Accepted: a same-origin, absolute path under `/api/v1/`, or one of the core
/// sockets (`/ws`, `/collab/<room>/sync`). Refused: anything with a scheme or an
/// authority, dot segments, backslashes, control characters, an empty segment.
pub fn validate_target(url: &str) -> Result<String, &'static str> {
    if url.len() > MAX_PATH_LEN {
        return Err("URL too long");
    }
    if !url.starts_with('/') || url.starts_with("//") {
        return Err("URL must be a same-origin absolute path");
    }
    if url.chars().any(|c| c.is_control() || c == '\\' || c == '#' || c == ' ') {
        return Err("URL contains forbidden characters");
    }
    let uri: axum::http::Uri = url.parse().map_err(|_| "URL is not valid")?;
    if uri.scheme().is_some() || uri.authority().is_some() {
        return Err("URL must be a same-origin absolute path");
    }
    let path = uri.path();
    let lowered = path.to_ascii_lowercase();
    if path
        .split('/')
        .skip(1)
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
        || lowered.contains("%2e%2e")
        || lowered.contains("%2f")
        || lowered.contains("%5c")
    {
        return Err("URL path is not canonical");
    }
    let allowed = path.starts_with("/api/v1/")
        || path == "/ws"
        || (path.starts_with("/collab/") && path.ends_with("/sync"));
    if !allowed {
        return Err("URL is outside the API");
    }
    Ok(path.to_owned())
}

/// The audience of a path: the module id for `/api/v1/<module>/…` when that
/// module is active, `core` otherwise.
pub async fn audience_for(state: &AppState, path: &str) -> String {
    if let Some(rest) = path.strip_prefix("/api/v1/") {
        let first = rest.split('/').next().unwrap_or("");
        if !first.is_empty() && state.modules.read().await.get(first).is_some() {
            return first.to_owned();
        }
    }
    "core".to_owned()
}

// ── Replay guard (one-time tickets) and session liveness ────────────────────

fn spent() -> &'static Mutex<HashMap<String, i64>> {
    static SPENT: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    SPENT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Marks a one-time nonce as used. `false` when it already was.
pub fn consume_once(nonce: &str, exp: i64, now: i64) -> bool {
    let mut map = spent().lock().unwrap_or_else(|e| e.into_inner());
    if map.len() > 4096 {
        map.retain(|_, e| *e > now);
    }
    if map.contains_key(nonce) {
        return false;
    }
    map.insert(nonce.to_owned(), exp);
    true
}

fn session_cache() -> &'static Mutex<HashMap<Uuid, Instant>> {
    static CACHE: OnceLock<Mutex<HashMap<Uuid, Instant>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// True while the session (refresh-token family or row) still has a live,
/// unrevoked token. Positive answers are cached for [`SESSION_CACHE_TTL`].
async fn session_alive(state: &AppState, user_id: Uuid, sid: Uuid) -> bool {
    {
        let cache = session_cache().lock().unwrap_or_else(|e| e.into_inner());
        if cache.get(&sid).is_some_and(|t| t.elapsed() < SESSION_CACHE_TTL) {
            return true;
        }
    }
    let row = state
        .db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM core.refresh_tokens
              WHERE (family_id = $1 OR id = $2) AND user_id = $3
                AND revoked_at IS NULL AND expires_at > $4
              LIMIT 1",
            params![sid, sid, user_id, chrono::Utc::now()],
        )
        .await;
    match row {
        Ok(Some(_)) => {
            let mut cache = session_cache().lock().unwrap_or_else(|e| e.into_inner());
            if cache.len() > 4096 {
                cache.retain(|_, t| t.elapsed() < SESSION_CACHE_TTL);
            }
            cache.insert(sid, Instant::now());
            true
        }
        Ok(None) => false,
        Err(e) => {
            tracing::error!(error = %e, "ticket: session liveness lookup failed");
            false
        }
    }
}

/// Full validation of a ticket presented on a request: signature, expiry,
/// bindings, session, account, one-time use. Returns the account.
pub async fn authenticate(
    state: &AppState,
    token: &str,
    audience: &str,
    path: &str,
    method: &str,
) -> Result<(User, TicketClaims), AppError> {
    let key = derive_key(&state.settings.auth.jwt_secret);
    let now = chrono::Utc::now().timestamp();
    let claims = decode(&key, token, now)
        .and_then(|c| check_binding(&c, audience, path, method).map(|_| c))
        .map_err(|e| {
            tracing::warn!(audience = %audience, reason = e.as_str(), "ticket refused");
            e.into_app_error()
        })?;

    if let Some(sid) = claims.sid {
        if !session_alive(state, claims.uid, sid).await {
            tracing::warn!(audience = %audience, "ticket refused: session ended");
            return Err(AppError::Unauthorized);
        }
    }

    let user = state
        .db
        .fetch_optional_as::<User>(
            "SELECT * FROM core.users WHERE id = $1 AND is_active = TRUE",
            params![claims.uid],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "ticket: loading the account failed");
            AppError::Database(e)
        })?
        .ok_or(AppError::Unauthorized)?;

    // Spent last, so a refused request (wrong path…) does not burn the ticket.
    if let Some(nonce) = claims.once.as_deref() {
        if !consume_once(nonce, claims.exp, now) {
            tracing::warn!(audience = %audience, "ticket refused: one-time ticket replayed");
            return Err(TicketError::Replayed.into_app_error());
        }
    }
    Ok((user, claims))
}

/// Account behind a core WebSocket handshake (`/ws`, `/collab/<room>/sync`):
/// a socket ticket (`?kt=`, preferred, what the web client sends) or an access
/// token (`?token=`, still what the native clients send).
pub async fn socket_user(
    state: &AppState,
    ticket: Option<&str>,
    access_token: Option<&str>,
    path: &str,
) -> Result<Uuid, AppError> {
    if let Some(t) = ticket.filter(|t| !t.is_empty()) {
        let (user, _) = authenticate(state, t, "core", path, "GET").await?;
        return Ok(user.id);
    }
    let token = access_token.filter(|t| !t.is_empty()).ok_or(AppError::Unauthorized)?;
    let jwt = crate::auth::jwt::JwtService::new(
        state.settings.auth.jwt_secret.clone(),
        state.settings.auth.access_token_ttl,
    );
    Ok(jwt.validate_access_token(token)?.sub)
}

// ── Legacy cookie (compatibility, one release) ──────────────────────────────

/// Name of the deprecated access cookie.
pub const LEGACY_COOKIE: &str = "access_token";

/// `Set-Cookie` value carrying `access_token` for pre-ticket module frontends,
/// when `auth.legacy_access_cookie` is on. HttpOnly: scripts can no longer read
/// it, which is the point of the change.
pub fn legacy_cookie(state: &AppState, access_token: &str, max_age_secs: u64) -> Option<String> {
    if !state.settings.auth.legacy_access_cookie {
        return None;
    }
    let secure = if state.settings.server.secure_cookies { "; Secure" } else { "" };
    Some(format!(
        "{LEGACY_COOKIE}={access_token}; HttpOnly{secure}; Path=/api/v1; SameSite=Strict; Max-Age={max_age_secs}"
    ))
}

/// `Set-Cookie` values clearing every variant of the access cookie: the
/// server-set one (`Path=/api/v1`) and the one older web clients wrote from
/// JavaScript (`Path=/`).
pub fn clear_legacy_cookies() -> [&'static str; 2] {
    [
        "access_token=; HttpOnly; Path=/api/v1; SameSite=Strict; Max-Age=0",
        "access_token=; Path=/; SameSite=Strict; Max-Age=0",
    ]
}

/// The access token carried by the deprecated cookie, when the compatibility
/// switch is on.
pub fn legacy_cookie_token<'a>(
    state: &AppState,
    headers: &'a axum::http::HeaderMap,
) -> Option<&'a str> {
    if !state.settings.auth.legacy_access_cookie {
        return None;
    }
    headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())?
        .split(';')
        .find_map(|part| part.trim().strip_prefix("access_token=").filter(|v| !v.is_empty()))
}

/// Logs (at most once an hour per audience) that a request still relied on the
/// deprecated cookie, so an operator can tell which module needs updating.
pub fn log_legacy_cookie_use(audience: &str, path: &str) {
    static LAST: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    let map = LAST.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = map.lock().unwrap_or_else(|e| e.into_inner());
    let due = map
        .get(audience)
        .is_none_or(|t| t.elapsed() > Duration::from_secs(3600));
    if due {
        map.insert(audience.to_owned(), Instant::now());
        tracing::warn!(
            audience = %audience,
            path = %path,
            "DEPRECATED: request authenticated by the legacy access_token cookie; \
             update this module to signed tickets (auth.legacy_access_cookie will be removed)"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; 32] {
        derive_key("test-instance-secret-0123456789abcdef0123456789abcdef")
    }

    fn claims(exp: i64) -> TicketClaims {
        TicketClaims {
            uid: Uuid::from_u128(1),
            sid: Some(Uuid::from_u128(2)),
            aud: "drive".into(),
            path: "/api/v1/drive/abc/download".into(),
            mth: "GET".into(),
            pur: Purpose::View,
            exp,
            once: None,
        }
    }

    #[test]
    fn round_trip() {
        let t = encode(&key(), &claims(2_000));
        assert!(t.starts_with("kt1."));
        assert_eq!(decode(&key(), &t, 1_000).expect("valid"), claims(2_000));
    }

    #[test]
    fn url_safe() {
        let t = encode(&key(), &claims(2_000));
        assert!(t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')));
    }

    #[test]
    fn expired_is_refused() {
        let t = encode(&key(), &claims(1_000));
        assert_eq!(decode(&key(), &t, 1_000), Err(TicketError::Expired));
        assert_eq!(decode(&key(), &t, 5_000), Err(TicketError::Expired));
        assert_eq!(TicketError::Expired.into_app_error().to_string(), AppError::Unauthorized.to_string());
    }

    #[test]
    fn other_secret_is_refused() {
        let t = encode(&key(), &claims(2_000));
        let other = derive_key("another-instance-secret-0123456789abcdef0123456789");
        assert_eq!(decode(&other, &t, 1_000), Err(TicketError::BadSignature));
    }

    #[test]
    fn tampered_payload_is_refused() {
        // Re-sign nothing: swap the payload for another user's claims.
        let t = encode(&key(), &claims(2_000));
        let mut forged = claims(2_000);
        forged.uid = Uuid::from_u128(99);
        let forged_payload =
            B64URL.encode(serde_json::to_vec(&forged).expect("json"));
        let parts: Vec<&str> = t.split('.').collect();
        let tampered = format!("{}.{}.{}", parts[0], forged_payload, parts[2]);
        assert_eq!(decode(&key(), &tampered, 1_000), Err(TicketError::BadSignature));
    }

    #[test]
    fn garbage_is_malformed() {
        for t in ["", "kt1", "kt1.a", "kt2.a.b", "kt1.a.b.c", "kt1.!!.??"] {
            assert!(matches!(
                decode(&key(), t, 0),
                Err(TicketError::Malformed | TicketError::BadSignature)
            ), "{t}");
        }
    }

    #[test]
    fn binding_audience() {
        let c = claims(2_000);
        assert_eq!(check_binding(&c, "drive", &c.path, "GET"), Ok(()));
        // A drive ticket presented to photos.
        assert_eq!(
            check_binding(&c, "photos", &c.path, "GET"),
            Err(TicketError::WrongAudience)
        );
        assert_eq!(TicketError::WrongAudience.into_app_error().to_string(), AppError::Forbidden.to_string());
    }

    #[test]
    fn binding_path_is_exact() {
        let c = claims(2_000);
        for p in [
            "/api/v1/drive/abc/download/",
            "/api/v1/drive/abd/download",
            "/api/v1/drive/abc",
            "/api/v1/drive/abc/download/../../other",
        ] {
            assert_eq!(check_binding(&c, "drive", p, "GET"), Err(TicketError::WrongPath), "{p}");
        }
    }

    #[test]
    fn binding_method() {
        let c = claims(2_000);
        assert_eq!(check_binding(&c, "drive", &c.path, "HEAD"), Ok(()));
        for m in ["POST", "PUT", "DELETE", "PATCH"] {
            assert_eq!(check_binding(&c, "drive", &c.path, m), Err(TicketError::WrongMethod), "{m}");
        }
    }

    #[test]
    fn one_time_replay() {
        let nonce = Uuid::new_v4().to_string();
        assert!(consume_once(&nonce, 2_000, 1_000));
        assert!(!consume_once(&nonce, 2_000, 1_001));
        assert!(consume_once(&Uuid::new_v4().to_string(), 2_000, 1_000));
    }

    #[test]
    fn expiry_buckets_are_deterministic_and_bounded() {
        let ttl = 300;
        for now in [1_000_000i64, 1_000_001, 1_000_149, 1_000_150, 1_000_299] {
            let exp = expiry(now, ttl, false);
            assert!(exp - now > 150 && exp - now <= 300, "now={now} exp={exp}");
        }
        // Same bucket → same expiry → same ticket. (1_000_050 = 6667·150.)
        assert_eq!(expiry(1_000_050, ttl, false), expiry(1_000_199, ttl, false));
        let a = encode(&key(), &claims(expiry(1_000_050, ttl, false)));
        let b = encode(&key(), &claims(expiry(1_000_199, ttl, false)));
        assert_eq!(a, b);
        // One-time tickets are not bucketed.
        assert_eq!(expiry(1_000_000, ttl, true), 1_000_300);
    }

    #[test]
    fn query_helpers() {
        assert_eq!(from_query(Some("a=1&kt=kt1.x.y&b=2")), Some("kt1.x.y"));
        assert_eq!(from_query(Some("akt=1")), None);
        assert_eq!(from_query(Some("kt=")), None);
        assert_eq!(from_query(None), None);
        assert_eq!(strip_from_path_and_query("/a/b?kt=x"), "/a/b");
        assert_eq!(strip_from_path_and_query("/a/b?x=1&kt=y&z=2"), "/a/b?x=1&z=2");
        assert_eq!(strip_from_path_and_query("/a/b?kts=1"), "/a/b?kts=1");
        assert_eq!(append_to_url("/a?inline=1", "T"), "/a?inline=1&kt=T");
        assert_eq!(append_to_url("/a?kt=old", "T"), "/a?kt=T");
        assert_eq!(append_to_url("/a", "T"), "/a?kt=T");
    }

    #[test]
    fn target_validation() {
        assert_eq!(
            validate_target("/api/v1/drive/abc/download?inline=1").as_deref(),
            Ok("/api/v1/drive/abc/download")
        );
        assert!(validate_target("/ws").is_ok());
        assert!(validate_target("/collab/doc:1/sync").is_ok());
        for bad in [
            "https://evil.example/api/v1/x",
            "//evil.example/api/v1/x",
            "api/v1/x",
            "/api/v1/../admin",
            "/api/v1/drive//x",
            "/api/v1/drive/%2e%2e/x",
            "/api/v1/drive/a%2Fb",
            "/api/v1/drive\\x",
            "/assets/app.js",
            "/api/v1/x#frag",
        ] {
            assert!(validate_target(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn range_requests_reuse_a_stream_ticket() {
        // A media element issues many GETs (Range) - and possibly HEAD - against
        // the same path with the same ticket: all of them must pass.
        let mut c = claims(10_000);
        c.pur = Purpose::Stream;
        let t = encode(&key(), &c);
        for _ in 0..5 {
            let got = decode(&key(), &t, 1_000).expect("valid");
            assert_eq!(check_binding(&got, "drive", &c.path, "GET"), Ok(()));
        }
        assert_eq!(check_binding(&c, "drive", &c.path, "HEAD"), Ok(()));
    }
}
