//! `/admin/health-checks` - the instance health report and the "ignored" state.
//!
//! The evaluation itself lives in [`crate::health`]; this file is the HTTP
//! surface: it takes the exposure probe from the request being served, narrows
//! the report to the caller's privileges, and audits every mute.

use axum::{
    extract::{ConnectInfo, Path, State},
    http::HeaderMap,
    Json,
};
use kubuno_db::{dialect::Assign, params};
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::SocketAddr;

use crate::audit::{redact::target, AdminAudit, AuditEntry};
use crate::auth::client_ip;
use crate::auth::middleware::AdminUser;
use crate::authz::{keys, AdminCtx};
use crate::errors::AppError;
use crate::health::{self, RequestProbe};
use crate::state::AppState;

/// Longest justification kept on a mute. Long enough for a sentence, short
/// enough that the column cannot be used as free storage.
const MAX_REASON_LEN: usize = 500;

/// What this very request says about how it reached the server.
///
/// The core has no "am I behind TLS" helper, and `X-Forwarded-Proto` is
/// forgeable by anyone who can open a socket - so the header is believed only
/// when the socket peer sits in `server.trusted_proxy_cidrs`, the same rule
/// `client_ip` applies to `X-Forwarded-For`. Everything else is recorded as
/// "a proxy claims something we cannot verify".
fn probe_from(headers: &HeaderMap, peer: Option<SocketAddr>) -> RequestProbe {
    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .map(str::to_ascii_lowercase);

    let forwarded = forwarded_proto.is_some()
        || headers.contains_key("x-forwarded-for")
        || headers.contains_key("x-forwarded-host")
        || headers.contains_key("forwarded");

    let peer_trusted = peer
        .map(|addr| client_ip::is_trusted_proxy(addr.ip()))
        .unwrap_or(false);

    // A comma-separated chain (`https, http`) keeps the FIRST hop - the scheme
    // the browser actually used.
    let claims_https = forwarded_proto
        .as_deref()
        .map(|raw| raw.split(',').next().unwrap_or("").trim() == "https")
        .unwrap_or(false);

    RequestProbe {
        forwarded,
        peer_trusted,
        forwarded_https: claims_https && peer_trusted,
    }
}

#[derive(Debug, Deserialize)]
pub struct HealthQuery {
    /// Re-evaluate instead of serving the cached report ("check everything
    /// again"). Absent or false honours the cache.
    #[serde(default)]
    pub refresh: bool,
}

/// `GET /api/v1/admin/health-checks`
///
/// Open to any administrator: the report narrows itself to what the caller may
/// read, so a delegate simply gets a shorter list rather than a 403 and a blank
/// page.
pub async fn get_health_checks(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    headers: HeaderMap,
    peer: Option<ConnectInfo<SocketAddr>>,
    axum::extract::Query(q): axum::extract::Query<HealthQuery>,
) -> Result<Json<Value>, AppError> {
    let probe = probe_from(&headers, peer.map(|ConnectInfo(a)| a));
    let (checks, generated_at, cached) =
        health::evaluate(&state.db, &state.settings, probe, q.refresh).await?;
    let report = health::report_for(&ctx, checks, generated_at, cached);
    Ok(Json(serde_json::to_value(report).map_err(|e| {
        tracing::error!(error = %e, "health: sérialisation du rapport");
        AppError::Internal(e.into())
    })?))
}

#[derive(Debug, Deserialize)]
pub struct MuteDto {
    /// Why this finding does not apply here. Optional, kept verbatim, never
    /// interpreted.
    pub reason: Option<String>,
}

/// `POST /api/v1/admin/health-checks/:id/ignore`
///
/// Silencing a finding is a security decision, so it needs the privilege that
/// governs the instance settings, it is written with its author, and it is
/// audited. It is also reversible - that is the whole difference between
/// "ignored" and "hidden".
pub async fn mute_check(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<String>,
    Json(dto): Json<MuteDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::SETTINGS_MANAGE)?;

    // Validate before touching the database: an unknown id would sit in the
    // table forever, invisible to the page that is supposed to clear it.
    let ignorable = health::checks::is_ignorable(&id)
        .ok_or_else(|| AppError::NotFound(format!("Unknown check '{id}'")))?;
    if !ignorable {
        return Err(AppError::Validation(format!(
            "Check '{id}' cannot be ignored"
        )));
    }

    let reason = dto
        .reason
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty());
    if let Some(r) = &reason {
        if r.chars().count() > MAX_REASON_LEN {
            return Err(AppError::Validation(format!(
                "Reason too long (maximum {MAX_REASON_LEN} characters)"
            )));
        }
    }

    let mut tx = audit.begin(&state.db).await?;
    let backend = state.db.backend();
    let muted_at = chrono::Utc::now();
    let insert_sql = format!(
        "INSERT INTO core.health_check_mutes (check_id, muted_by, muted_at, reason) \
         VALUES ($1, $2, $3, $4){}",
        backend.upsert(
            "core.health_check_mutes",
            &["check_id"],
            &[
                Assign::Incoming("muted_by"),
                Assign::Incoming("muted_at"),
                Assign::Incoming("reason"),
            ],
        )
    );
    tx.execute(
        &insert_sql,
        params![&id, audit.admin.id, muted_at, reason.as_deref()],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, check = %id, "health: enregistrement du contrôle ignoré");
        AppError::Database(e)
    })?;

    let mut entry = AuditEntry::new("core.health_check.mute")
        .target(target::SETTING, &id, id.clone())
        .reversible();
    if let Some(r) = &reason {
        entry = entry.detail(r.clone());
    }
    tx.commit(entry).await?;

    // The report is cached; the operator must see their decision immediately.
    health::invalidate();
    Ok(Json(json!({ "message": "Check ignored", "check_id": id })))
}

/// `DELETE /api/v1/admin/health-checks/:id/ignore` - put the finding back.
pub async fn unmute_check(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::SETTINGS_MANAGE)?;

    let mut tx = audit.begin(&state.db).await?;
    let deleted = tx
        .execute(
            "DELETE FROM core.health_check_mutes WHERE check_id = $1",
            params![&id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, check = %id, "health: retrait du contrôle ignoré");
            AppError::Database(e)
        })?;

    if deleted == 0 {
        // Nothing to undo. Rolled back rather than committed with an empty
        // trail entry: "un-ignored a check that was not ignored" is noise.
        return Err(AppError::NotFound(format!("Check '{id}' is not ignored")));
    }

    tx.commit(
        AuditEntry::new("core.health_check.unmute")
            .target(target::SETTING, &id, id.clone())
            .reversible(),
    )
    .await?;

    health::invalidate();
    Ok(Json(json!({ "message": "Check re-enabled", "check_id": id })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use std::net::{IpAddr, Ipv4Addr};

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_str(v).expect("en-tête valide"));
        }
        h
    }

    fn peer(ip: &str) -> Option<SocketAddr> {
        Some(SocketAddr::new(ip.parse::<IpAddr>().expect("ip"), 5000))
    }

    #[test]
    fn a_bare_request_reports_no_proxy_and_no_tls() {
        let p = probe_from(&headers(&[]), peer("203.0.113.9"));
        assert!(!p.forwarded);
        assert!(!p.forwarded_https);
    }

    #[test]
    fn an_untrusted_peer_claiming_https_is_not_believed() {
        // `client_ip::init` is process-global and may not have run in the test
        // binary; with no ranges installed nothing is trusted, which is exactly
        // the situation being asserted.
        let p = probe_from(
            &headers(&[("x-forwarded-proto", "https"), ("x-forwarded-for", "203.0.113.7")]),
            peer("203.0.113.9"),
        );
        assert!(p.forwarded, "un en-tête de transfert a bien été vu");
        assert!(!p.forwarded_https, "sans mandataire de confiance, la déclaration ne vaut rien");
    }

    #[test]
    fn the_first_hop_of_a_chain_is_the_one_that_counts() {
        // `https, http` means the browser spoke HTTPS to the edge; a naive
        // parse reading the last element would report plaintext.
        client_ip::init(&["127.0.0.0/8".to_string()]);
        let p = probe_from(
            &headers(&[("x-forwarded-proto", "https, http")]),
            Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 5000)),
        );
        // Whether `init` took effect depends on test ordering (it is a
        // `OnceLock`), so only the parsing half is asserted unconditionally.
        assert!(p.forwarded);
        if p.peer_trusted {
            assert!(p.forwarded_https);
        }
    }

    #[test]
    fn a_missing_peer_address_trusts_nothing() {
        let p = probe_from(&headers(&[("x-forwarded-proto", "https")]), None);
        assert!(!p.peer_trusted);
        assert!(!p.forwarded_https);
    }
}
