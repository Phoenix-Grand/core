//! Réglages de session lus à chaud depuis `core.settings`.
//!
//! Permet à l'administrateur de modifier les durées de session (et le nombre
//! max de sessions) depuis le panneau d'admin, sans redémarrage : les valeurs
//! sont relues à chaque émission de token. Repli sur la config statique si la
//! clé est absente ou invalide.

use std::time::Duration;

use kubuno_db::{params, DbPool};

use crate::config::Settings;

/// One `core.settings` row read for the security TTLs.
#[derive(sqlx::FromRow)]
struct SettingRow {
    key:   String,
    value: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct SecurityTtls {
    pub access_ttl:   Duration,
    pub refresh_ttl:  Duration,
    pub max_sessions: i64,
    /// Déconnexion après inactivité (None = désactivé).
    pub idle_timeout: Option<Duration>,
}

fn as_i64(v: &serde_json::Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

/// Lit les durées de session depuis `core.settings`, avec repli sur `settings`.
pub async fn security_ttls(db: &DbPool, settings: &Settings) -> SecurityTtls {
    let mut out = SecurityTtls {
        access_ttl:   settings.auth.access_token_ttl,
        refresh_ttl:  settings.auth.refresh_token_ttl,
        max_sessions: 10,
        idle_timeout: None,
    };

    let rows = db
        .fetch_all_as::<SettingRow>(
            "SELECT \"key\", value FROM core.settings \
             WHERE \"key\" IN ('security.jwt_access_ttl_s', \
                           'security.jwt_refresh_ttl_d', \
                           'security.max_sessions', \
                           'security.session_idle_timeout_min')",
            params![],
        )
        .await
        .unwrap_or_default();

    for SettingRow { key, value } in rows {
        match key.as_str() {
            "security.jwt_access_ttl_s" => {
                if let Some(n) = as_i64(&value) {
                    if n > 0 { out.access_ttl = Duration::from_secs(n as u64); }
                }
            }
            "security.jwt_refresh_ttl_d" => {
                if let Some(n) = as_i64(&value) {
                    if n > 0 { out.refresh_ttl = Duration::from_secs(n as u64 * 86_400); }
                }
            }
            "security.max_sessions" => {
                if let Some(n) = as_i64(&value) {
                    if n > 0 { out.max_sessions = n; }
                }
            }
            "security.session_idle_timeout_min" => {
                if let Some(n) = as_i64(&value) {
                    if n > 0 { out.idle_timeout = Some(Duration::from_secs(n as u64 * 60)); }
                }
            }
            _ => {}
        }
    }

    out
}

/// Révoque les sessions excédentaires d'un utilisateur (au-delà de `max_sessions`),
/// en conservant les plus RÉCEMMENT UTILISÉES (last_used_at). Trier par activité -
/// et non par date de création - évite de déconnecter une session ancienne mais
/// active au profit d'une nouvelle (= déconnexions « aléatoires »).
pub async fn enforce_max_sessions(db: &DbPool, user_id: uuid::Uuid, max_sessions: i64) {
    if max_sessions <= 0 { return; }
    let now = db.backend().now();
    // Placeholders strictly increasing and never reused: the revocation instant
    // is bound once ($1), `user_id` twice ($2 and $3), the keep count ($4).
    // The inner set is wrapped in a derived table `t` so MySQL accepts selecting
    // from the very table being updated.
    let sql = format!(
        "UPDATE core.refresh_tokens \
           SET revoked_at = $1, revoke_reason = 'max_sessions' \
           WHERE user_id = $2 AND revoked_at IS NULL AND expires_at > {now} \
             AND id NOT IN ( \
               SELECT id FROM ( \
                 SELECT id FROM core.refresh_tokens \
                 WHERE user_id = $3 AND revoked_at IS NULL AND expires_at > {now} \
                 ORDER BY last_used_at DESC, created_at DESC \
                 LIMIT $4 \
               ) t \
             )"
    );
    let _ = db
        .execute(&sql, params![chrono::Utc::now(), user_id, user_id, max_sessions])
        .await;
}
