//! A mock Kubuno core reproducing the native auth contract of the real server (`core/server`): `GET /health`,
//! `POST /api/v1/auth/{login,totp,refresh,logout}` and `GET /api/v1/me`, with refresh-token rotation and reuse
//! detection. Shared by the integration tests and `examples/mock_server.rs` (the on-device check).
//!
//! Accounts: `zoe@kubuno.test` / `secret` (no second factor), `totp@kubuno.test` / `secret` (TOTP code `123456`).

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

pub const PASSWORD: &str = "secret";
pub const TOTP_CODE: &str = "123456";

#[derive(Default)]
pub struct Inner {
    seq: u64,
    current_refresh: Option<String>,
    spent: HashSet<String>,
    /// Access tokens the server accepts, and whose they are.
    valid_access: HashMap<String, String>,
    pub refresh_calls: usize,
    pub logins: usize,
    /// Lifetime of the access token issued at sign-in / at refresh (seconds).
    pub login_ttl: i64,
    pub refresh_ttl: i64,
}

pub type Mock = Arc<Mutex<Inner>>;

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn b64url(b: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut o = String::new();
    for c in b.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        o.push(A[(n >> 18 & 63) as usize] as char);
        o.push(A[(n >> 12 & 63) as usize] as char);
        if c.len() > 1 {
            o.push(A[(n >> 6 & 63) as usize] as char);
        }
        if c.len() > 2 {
            o.push(A[(n & 63) as usize] as char);
        }
    }
    o
}

fn user(login: &str) -> Value {
    let (id, name) = if login.starts_with("totp") { ("u-totp", "Toto Totp") } else { ("u-zoe", "Zoé Test") };
    json!({ "id": id, "email": login, "display_name": name, "username": login.split('@').next().unwrap_or(login) })
}

/// Issue a new token pair (rotating the refresh token) and return the native token response.
fn issue(m: &mut Inner, login: &str, ttl: i64) -> Value {
    m.seq += 1;
    let iat = now();
    let payload = json!({ "sub": user(login)["id"], "iat": iat, "exp": iat + ttl, "n": m.seq });
    let access = format!("{}.{}.sig", b64url(br#"{"alg":"HS256"}"#), b64url(payload.to_string().as_bytes()));
    let refresh = format!("r-{}-{}", login, m.seq);
    m.valid_access.insert(access.clone(), login.to_string());
    m.current_refresh = Some(refresh.clone());
    json!({ "access_token": access, "refresh_token": refresh, "refresh_expires_at": "2099-01-01T00:00:00Z", "user": user(login) })
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": code, "message": message }))).into_response()
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "version": "mock", "uptime_s": 0 }))
}

async fn login(State(mock): State<Mock>, Json(body): Json<Value>) -> Response {
    let mut m = mock.lock().expect("mock");
    m.logins += 1;
    // A native client must ask for the body token flow; otherwise the real server sets a cookie instead.
    if body["client_type"] != "native" {
        return error(StatusCode::BAD_REQUEST, "NATIVE_ONLY", "this mock only serves native clients");
    }
    let login = body["login"].as_str().unwrap_or_default().to_string();
    if body["password"] != PASSWORD || !(login == "zoe@kubuno.test" || login == "totp@kubuno.test") {
        return error(StatusCode::UNAUTHORIZED, "INVALID_CREDENTIALS", "Identifiants invalides");
    }
    if login.starts_with("totp") {
        return Json(json!({ "requires_totp": true, "totp_session": "ts-totp" })).into_response();
    }
    let ttl = m.login_ttl;
    Json(issue(&mut m, &login, ttl)).into_response()
}

async fn totp(State(mock): State<Mock>, Json(body): Json<Value>) -> Response {
    let mut m = mock.lock().expect("mock");
    if body["totp_session"] != "ts-totp" || body["code"] != TOTP_CODE {
        return error(StatusCode::UNAUTHORIZED, "INVALID_TOTP", "Code invalide");
    }
    let ttl = m.login_ttl;
    Json(issue(&mut m, "totp@kubuno.test", ttl)).into_response()
}

async fn refresh(State(mock): State<Mock>, Json(body): Json<Value>) -> Response {
    let mut m = mock.lock().expect("mock");
    m.refresh_calls += 1;
    let token = body["refresh_token"].as_str().unwrap_or_default().to_string();
    if m.spent.contains(&token) {
        // Replaying a rotated token revokes the whole family (the real server's reuse detection).
        m.current_refresh = None;
        m.valid_access.clear();
        return error(StatusCode::UNAUTHORIZED, "reuse_detected", "Session révoquée");
    }
    if m.current_refresh.as_deref() != Some(token.as_str()) {
        return error(StatusCode::UNAUTHORIZED, "INVALID_REFRESH", "Session expirée");
    }
    m.spent.insert(token.clone());
    let login = token.trim_start_matches("r-").rsplit_once('-').map(|(l, _)| l.to_string()).unwrap_or_default();
    let ttl = m.refresh_ttl;
    Json(issue(&mut m, &login, ttl)).into_response()
}

async fn logout(State(mock): State<Mock>, Json(body): Json<Value>) -> StatusCode {
    let mut m = mock.lock().expect("mock");
    if body["refresh_token"].as_str() == m.current_refresh.as_deref() {
        m.current_refresh = None;
        m.valid_access.clear();
    }
    StatusCode::NO_CONTENT
}

async fn me(State(mock): State<Mock>, headers: HeaderMap) -> Response {
    let m = mock.lock().expect("mock");
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    let Some(login) = m.valid_access.get(token) else {
        return error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", "Non authentifié");
    };
    Json(json!({ "user": user(login), "privileges": {} })).into_response()
}

/// Test hook: the server stops accepting the access tokens it issued (as after a key rotation), so the next request
/// gets a 401 and must refresh.
async fn expire_access(State(mock): State<Mock>) -> StatusCode {
    mock.lock().expect("mock").valid_access.clear();
    StatusCode::NO_CONTENT
}

/// Start the mock on `addr` (port 0 = any free port). Returns the bound address and the shared state.
pub async fn serve(addr: &str, login_ttl: i64, refresh_ttl: i64) -> (SocketAddr, Mock) {
    let mock: Mock = Arc::new(Mutex::new(Inner { login_ttl, refresh_ttl, ..Default::default() }));
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/v1/auth/login", post(login))
        .route("/api/v1/auth/totp", post(totp))
        .route("/api/v1/auth/refresh", post(refresh))
        .route("/api/v1/auth/logout", post(logout))
        .route("/api/v1/me", get(me))
        .route("/test/expire-access", post(expire_access))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind the mock server");
    let bound = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (bound, mock)
}
