use axum::{
    body::Body,
    http::{HeaderName, HeaderValue, Request, StatusCode},
    middleware::Next,
    response::Response,
};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::Instant,
};

struct Window {
    count:      u32,
    started_at: Instant,
}

static LIMITER: LazyLock<Mutex<HashMap<String, Window>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const WINDOW_SECS: u64 = 60;

fn limit_for_path(path: &str) -> u32 {
    if path.contains("forgot-password") || path.contains("reset-password") {
        // Brute-forceable and mail-sending - keep these tight.
        3
    } else if path.contains("/reauth") {
        // Step-up: the caller is already authenticated and each attempt is audited,
        // so the brute-force surface is small - but an office behind one NAT can
        // legitimately produce a burst of challenges, and locking a shared address
        // out of every sensitive action would be worse than the risk.
        30
    } else if path.ends_with("/refresh") {
        // One home/office IP legitimately carries many refresh callers (browser tabs,
        // desktop daemon + doc proxy, mobile). A refresh without a valid HttpOnly
        // cookie is not brute-forceable, so a generous per-IP budget is safe.
        60
    } else {
        10
    }
}

pub async fn rate_limit_auth(req: Request<Body>, next: Next) -> Response {
    let path  = req.uri().path().to_owned();
    // Trusted-proxy aware: a forged X-Forwarded-For can no longer mint a fresh
    // bucket on every request. See `crate::auth::client_ip`.
    let ip    = crate::auth::client_ip::client_ip_key(&req);

    let key   = format!("{ip}:{path}");
    let limit = limit_for_path(&path);

    let exceeded = {
        let mut map = LIMITER.lock().unwrap_or_else(|e| e.into_inner());
        let now     = Instant::now();
        let entry   = map.entry(key).or_insert(Window { count: 0, started_at: now });
        if now.duration_since(entry.started_at).as_secs() >= WINDOW_SECS {
            *entry = Window { count: 1, started_at: now };
            false
        } else {
            entry.count += 1;
            entry.count > limit
        }
    };

    if exceeded {
        let mut resp = axum::response::Response::new(axum::body::Body::from(
            json!({ "error": "RATE_LIMITED", "message": "Too many attempts. Try again in 60 seconds" }).to_string(),
        ));
        *resp.status_mut() = StatusCode::TOO_MANY_REQUESTS;
        resp.headers_mut().insert(
            HeaderName::from_static("content-type"),
            HeaderValue::from_static("application/json"),
        );
        resp.headers_mut().insert(
            HeaderName::from_static("retry-after"),
            HeaderValue::from_static("60"),
        );
        return resp;
    }

    next.run(req).await
}
