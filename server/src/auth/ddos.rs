//! Protections anti-DDoS au niveau applicatif.
//!
//! Trois lignes de défense complémentaires, à brancher comme layers Axum :
//!   1. `concurrency_limit` - plafonne le nombre de requêtes traitées **en
//!      parallèle** ; au-delà on *load-shed* (503) immédiatement plutôt que de
//!      laisser la file enfler jusqu'à l'OOM. C'est la protection la plus
//!      efficace contre une saturation brutale (la mémoire/threads restent
//!      bornés quoi qu'il arrive).
//!   2. `global_rate_limit` - fenêtre fixe par IP sur **toutes** les routes,
//!      pour amortir un flood applicatif (beaucoup de requêtes valides depuis
//!      peu d'IP). La table est bornée en taille pour ne pas devenir elle-même
//!      un vecteur d'attaque (IP usurpées).
//!   3. `TimeoutLayer` (branché dans le router) - coupe les requêtes lentes
//!      (slowloris applicatif, clients qui n'envoient/lisent jamais le corps).
//!
//! La terminaison TLS et les limites de connexions/bande passante restent du
//! ressort du reverse-proxy (nginx) en amont ; ceci en est le complément côté
//! application, utile même si le proxy est contourné.

use axum::{
    body::Body,
    http::{HeaderName, HeaderValue, Request, StatusCode},
    middleware::Next,
    response::Response,
};
use kubuno_db::{params, DbPool};
use serde_json::json;
use std::{
    collections::HashMap,
    env,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
        LazyLock, Mutex,
    },
    time::Instant,
};

// ── Réglages mutables à chaud ────────────────────────────────────────────────
//
// La source de vérité est la table `core.settings` (clés `security.ddos_*`),
// pilotée depuis le panneau d'administration. Les variables d'environnement
// `KV_SERVER_MAX_CONCURRENT` / `KV_SERVER_RATE_LIMIT_PER_MIN` ne servent qu'à
// amorcer la valeur initiale au boot, avant le premier `reload_from_db`.

/// Interrupteur général : à false, les deux middlewares laissent tout passer.
static ENABLED: AtomicBool = AtomicBool::new(true);
/// Requêtes simultanées maximum traitées par le core. Au-delà → 503.
static MAX_CONCURRENT: AtomicUsize = AtomicUsize::new(1024);
/// Requêtes par IP et par fenêtre (60 s), toutes routes confondues.
static RATE_PER_WINDOW: AtomicU32 = AtomicU32::new(600);
/// Budget par UTILISATEUR authentifié (Bearer valide) quand la fenêtre IP est
/// dépassée. Une IP de foyer/bureau porte N onglets + daemon desktop + mobile :
/// le périmètre anti-DDoS reste l'anonyme par IP ; un porteur de JWT valide est
/// un problème de révocation de session, pas de flood.
static RATE_USER_PER_WINDOW: AtomicU32 = AtomicU32::new(3000);

const MIN_CONCURRENT: usize = 16;
const MIN_RATE: u32 = 60;

/// Secret JWT pour la vérification paresseuse (signature seule, pas de DB) dans
/// le chemin throttlé. Posé une fois au bootstrap.
static JWT_SECRET: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// À appeler une fois au démarrage pour activer le budget par utilisateur.
pub fn set_jwt_secret(secret: &str) {
    let _ = JWT_SECRET.set(secret.to_string());
}

const WINDOW_SECS: u64 = 60;
/// Plafond du nombre d'IP suivies. Empêche un flood d'IP usurpées de faire
/// gonfler la table indéfiniment.
const MAX_TRACKED_IPS: usize = 100_000;

/// Amorce les valeurs depuis l'environnement (rétro-compatibilité). À appeler
/// une fois au démarrage, avant `reload_from_db`.
pub fn seed_from_env() {
    if let Some(n) = env::var("KV_SERVER_MAX_CONCURRENT").ok().and_then(|v| v.parse::<usize>().ok()) {
        MAX_CONCURRENT.store(n.max(MIN_CONCURRENT), Ordering::Relaxed);
    }
    if let Some(n) = env::var("KV_SERVER_RATE_LIMIT_PER_MIN").ok().and_then(|v| v.parse::<u32>().ok()) {
        RATE_PER_WINDOW.store(n.max(MIN_RATE), Ordering::Relaxed);
    }
}

/// One `(key, value)` settings row.
#[derive(sqlx::FromRow)]
struct SettingKv {
    key: String,
    value: serde_json::Value,
}

/// (Re)charge les réglages anti-DDoS depuis `core.settings`. Idempotent : en cas
/// d'erreur de lecture, les valeurs courantes sont conservées. À appeler au
/// démarrage puis après chaque mise à jour des réglages `security.ddos_*`.
pub async fn reload_from_db(db: &DbPool) {
    let rows = db
        .fetch_all_as::<SettingKv>(
            "SELECT \"key\", value FROM core.settings \
         WHERE \"key\" IN ('security.ddos_enabled', 'security.ddos_rate_per_min', 'security.ddos_max_concurrent', \
                       'security.rate_user_per_min')",
            params![],
        )
        .await;

    let rows = match rows {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "anti-DDoS : lecture des réglages échouée, valeurs courantes conservées");
            return;
        }
    };

    for r in rows {
        let key = r.key;
        let val = r.value;
        match key.as_str() {
            "security.ddos_enabled" => {
                if let Some(b) = val.as_bool() {
                    ENABLED.store(b, Ordering::Relaxed);
                }
            }
            "security.ddos_rate_per_min" => {
                if let Some(n) = val.as_u64() {
                    RATE_PER_WINDOW.store((n as u32).max(MIN_RATE), Ordering::Relaxed);
                }
            }
            "security.ddos_max_concurrent" => {
                if let Some(n) = val.as_u64() {
                    MAX_CONCURRENT.store((n as usize).max(MIN_CONCURRENT), Ordering::Relaxed);
                }
            }
            "security.rate_user_per_min" => {
                if let Some(n) = val.as_u64() {
                    RATE_USER_PER_WINDOW.store((n as u32).max(MIN_RATE), Ordering::Relaxed);
                }
            }
            _ => {}
        }
    }

    tracing::info!(
        enabled = ENABLED.load(Ordering::Relaxed),
        rate_per_min = RATE_PER_WINDOW.load(Ordering::Relaxed),
        rate_user_per_min = RATE_USER_PER_WINDOW.load(Ordering::Relaxed),
        max_concurrent = MAX_CONCURRENT.load(Ordering::Relaxed),
        "réglages anti-DDoS appliqués",
    );
}

// ── 1. Limite de concurrence (load-shedding) ─────────────────────────────────

/// Requêtes actuellement en vol (comparées à `MAX_CONCURRENT`). Un simple
/// compteur atomique remplace un `Semaphore` pour rester reconfigurable à chaud.
static INFLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Décrémente le compteur en vol quoi qu'il arrive (fin normale, panic, abort).
struct InflightGuard;
impl Drop for InflightGuard {
    fn drop(&mut self) {
        INFLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Détecte un upgrade WebSocket (connexion longue durée) qu'il ne faut pas
/// compter dans la limite de concurrence - sinon chaque socket ouvert
/// retiendrait un permit pour toute sa durée de vie et épuiserait le pool.
fn is_long_lived(req: &Request<Body>) -> bool {
    if req.uri().path() == "/ws" {
        return true;
    }
    req.headers()
        .get(axum::http::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
}

pub async fn concurrency_limit(req: Request<Body>, next: Next) -> Response {
    if !ENABLED.load(Ordering::Relaxed) || is_long_lived(&req) {
        return next.run(req).await;
    }
    let max = MAX_CONCURRENT.load(Ordering::Relaxed);
    // Réservation optimiste : on incrémente puis on vérifie. Si on dépasse, on
    // libère aussitôt et on rejette (503) au lieu d'empiler la requête.
    let current = INFLIGHT.fetch_add(1, Ordering::Relaxed) + 1;
    if current > max {
        INFLIGHT.fetch_sub(1, Ordering::Relaxed);
        tracing::warn!("concurrency limit reached ({max} max) - shedding request");
        return too_busy("SERVER_BUSY", "The service is temporarily overloaded. Please try again");
    }
    let _guard = InflightGuard; // décrémente en fin de scope
    next.run(req).await
}

// ── 2. Rate-limit global par IP ──────────────────────────────────────────────

struct Window {
    count:      u32,
    started_at: Instant,
}

static GLOBAL_LIMITER: LazyLock<Mutex<HashMap<String, Window>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Incrémente la fenêtre `key` et dit si `limit` est dépassée.
fn window_exceeded(key: String, limit: u32) -> bool {
    let mut map = GLOBAL_LIMITER.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();

    // Nettoyage opportuniste : si la table devient trop grosse, on purge les
    // fenêtres expirées (et on garde le service fonctionnel même sous flood).
    if map.len() > MAX_TRACKED_IPS {
        map.retain(|_, w| now.duration_since(w.started_at).as_secs() < WINDOW_SECS);
    }

    let entry = map.entry(key).or_insert(Window { count: 0, started_at: now });
    if now.duration_since(entry.started_at).as_secs() >= WINDOW_SECS {
        *entry = Window { count: 1, started_at: now };
        false
    } else {
        entry.count += 1;
        entry.count > limit
    }
}

/// Vérification PARESSEUSE du Bearer (signature HMAC + exp, aucune DB) - appelée
/// seulement quand la fenêtre IP est dépassée, donc le chemin nominal ne paie rien.
fn bearer_sub(req: &Request<Body>) -> Option<String> {
    let secret = JWT_SECRET.get()?;
    let token = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())?
        .strip_prefix("Bearer ")?;
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.validate_exp = true;
    jsonwebtoken::decode::<crate::auth::jwt::AccessClaims>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .ok()
    .map(|d| d.claims.sub.to_string())
}

pub async fn global_rate_limit(req: Request<Body>, next: Next) -> Response {
    if !ENABLED.load(Ordering::Relaxed) {
        return next.run(req).await;
    }
    let path = req.uri().path();
    // Les sondes de santé du load-balancer ne doivent jamais être limitées.
    if path == "/health" || path == "/ready" {
        return next.run(req).await;
    }

    // Trusted-proxy aware: forwarding headers are honoured only when the socket
    // peer is a declared proxy. See `crate::auth::client_ip`.
    let ip = super::client_ip::client_ip_key(&req);
    let limit = RATE_PER_WINDOW.load(Ordering::Relaxed);

    if window_exceeded(ip, limit) {
        // Fenêtre IP saturée : un utilisateur AUTHENTIFIÉ bascule sur son budget
        // propre (clé `user:<uuid>`) - une IP de foyer ne s'auto-étrangle plus,
        // et un flood anonyme reste bloqué au périmètre IP.
        if let Some(sub) = bearer_sub(&req) {
            let user_limit = RATE_USER_PER_WINDOW.load(Ordering::Relaxed);
            if !window_exceeded(format!("user:{sub}"), user_limit) {
                return next.run(req).await;
            }
        }
        return too_busy("RATE_LIMITED", "Too many requests. Please slow down");
    }
    next.run(req).await
}

// ── Réponses 429/503 normalisées ─────────────────────────────────────────────

fn too_busy(code: &str, message: &str) -> Response {
    let status = if code == "RATE_LIMITED" {
        StatusCode::TOO_MANY_REQUESTS
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    let mut resp = Response::new(Body::from(
        json!({ "error": code, "message": message }).to_string(),
    ));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static("application/json"),
    );
    resp.headers_mut().insert(
        HeaderName::from_static("retry-after"),
        HeaderValue::from_static("5"),
    );
    resp
}
