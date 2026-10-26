//! The live TLS state the running server holds, and the one place a rustls
//! `ServerConfig` is built.
//!
//! rustls is the sole TLS engine. This module never touches key bytes beyond
//! handing them to rustls, and rustls categorically cannot negotiate SSLv3 /
//! TLS 1.0 / TLS 1.1 - so the "disable the old protocols" hardening an Apache
//! operator applies by hand is, here, structural.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use axum::http::HeaderValue;
use axum_server::tls_rustls::RustlsConfig;
use rustls::ServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};

use crate::{errors::AppError, state::AppState};

use super::cert;
use super::config::{NetworkConfig, TlsMinVersion};

/// Installs the process-wide crypto provider rustls 0.23 requires before any
/// `ServerConfig` is built. Idempotent - a second call is a no-op.
pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Builds a rustls `ServerConfig` from a PEM chain and key, honouring the
/// minimum protocol version. A build failure means the pair is unusable or
/// mismatched - which is exactly the validation the upload path relies on.
pub fn build_server_config(
    cert_pem: &[u8],
    key_pem: &[u8],
    min: TlsMinVersion,
) -> Result<Arc<ServerConfig>, AppError> {
    install_crypto_provider();

    let mut cr: &[u8] = cert_pem;
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cr)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::Validation(format!("Unreadable certificate chain: {e}")))?;
    if certs.is_empty() {
        return Err(AppError::Validation(
            "No certificate found in the supplied PEM".into(),
        ));
    }

    let mut kr: &[u8] = key_pem;
    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut kr)
        .map_err(|e| AppError::Validation(format!("Unreadable private key: {e}")))?
        .ok_or_else(|| AppError::Validation("No private key found in the supplied PEM".into()))?;

    let versions: &[&'static rustls::SupportedProtocolVersion] = match min {
        TlsMinVersion::V1_3 => &[&rustls::version::TLS13],
        TlsMinVersion::V1_2 => rustls::ALL_VERSIONS,
    };

    let cfg = ServerConfig::builder_with_protocol_versions(versions)
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| {
            AppError::Validation(format!("Certificate and key are incompatible or invalid: {e}"))
        })?;

    Ok(Arc::new(cfg))
}

/// The mutable TLS state shared between the accept loop and the admin handlers.
///
/// `reload` holds the axum-server config the HTTPS listener actually serves -
/// `Some` only when the process bound an HTTPS socket at boot. `hsts` holds the
/// **configured** `Strict-Transport-Security` value (`None` when the setting is
/// off); whether a given response actually carries it is decided per request by
/// [`response_is_over_tls`], because an instance can be reached over TLS without
/// terminating it itself.
#[derive(Default)]
pub struct TlsRuntime {
    reload: RwLock<Option<RustlsConfig>>,
    hsts: RwLock<Option<HeaderValue>>,
    /// Pending ACME HTTP-01 challenge responses: token → key authorization.
    /// The public `/.well-known/acme-challenge/:token` route reads it; the ACME
    /// client fills it for the duration of an order and clears it afterwards.
    acme_challenges: RwLock<HashMap<String, String>>,
}

impl TlsRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_reload(&self, config: RustlsConfig) {
        if let Ok(mut g) = self.reload.write() {
            *g = Some(config);
        }
    }

    pub fn reload_handle(&self) -> Option<RustlsConfig> {
        self.reload.read().ok().and_then(|g| g.clone())
    }

    pub fn is_https_live(&self) -> bool {
        self.reload.read().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn set_hsts(&self, value: Option<HeaderValue>) {
        if let Ok(mut g) = self.hsts.write() {
            *g = value;
        }
    }

    pub fn hsts(&self) -> Option<HeaderValue> {
        self.hsts.read().ok().and_then(|g| g.clone())
    }

    /// Registers the response for one ACME HTTP-01 challenge token.
    pub fn set_acme_challenge(&self, token: String, key_authorization: String) {
        if let Ok(mut g) = self.acme_challenges.write() {
            g.insert(token, key_authorization);
        }
    }

    /// The response for a challenge token, if one is pending.
    pub fn acme_challenge(&self, token: &str) -> Option<String> {
        self.acme_challenges
            .read()
            .ok()
            .and_then(|g| g.get(token).cloned())
    }

    /// Drops one challenge token once its order has moved on.
    pub fn clear_acme_challenge(&self, token: &str) {
        if let Ok(mut g) = self.acme_challenges.write() {
            g.remove(token);
        }
    }
}

/// Did THIS request reach the instance over TLS?
///
/// Two ways are legitimate and both must count, or HSTS would be dropped on the
/// most common production layout:
///   * the core terminated the TLS itself (`tls_live`);
///   * a reverse proxy terminated it and says so with `X-Forwarded-Proto`.
///
/// That header is forgeable by anyone who can open a socket, so it is believed
/// only when the socket peer sits in `server.trusted_proxy_cidrs` - the same
/// rule [`crate::auth::client_ip`] applies to `X-Forwarded-For`, and the one
/// `handlers::admin::health` already uses. A comma-separated chain keeps the
/// FIRST hop: the scheme the browser actually used.
pub fn response_is_over_tls(
    headers: &axum::http::HeaderMap,
    peer: Option<std::net::IpAddr>,
    tls_live: bool,
) -> bool {
    if tls_live {
        return true;
    }
    let Some(peer) = peer else { return false };
    if !crate::auth::client_ip::is_trusted_proxy(peer) {
        return false;
    }
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| raw.split(',').next())
        .map(|first| first.trim().eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

/// Should HSTS be announced for this `Host`?
///
/// Never for a loopback name. HSTS is remembered by the browser per host, and
/// `localhost` is shared by every project on the machine: one instance that
/// serves it once pins `http://localhost:<any port>` to HTTPS for every other
/// local server the developer runs, with an unhelpful certificate error and a
/// purge through `chrome://net-internals/#hsts` as the only way back. Browsers
/// ignore HSTS on bare IP addresses anyway, so nothing is lost by not sending
/// it there either.
pub fn hsts_applies_to_host(host: Option<&str>) -> bool {
    let Some(host) = host else { return true };
    let host = host.trim();
    // An IPv6 literal is bracketed and full of colons, so the port cannot be
    // found by splitting on the last one: take what is inside the brackets.
    let name = match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => host.rsplit_once(':').map_or(host, |(head, _)| head),
    }
    .to_ascii_lowercase();

    !(name == "localhost"
        || name.ends_with(".localhost")
        || name == "::1"
        || name.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback()))
}


/// Recomputes the HSTS header and applies a minimum-version change to the live
/// listener. Called after any `network.*` setting changes. Cheap and safe to
/// call when no HTTPS listener is running (it just clears HSTS).
pub async fn refresh_runtime(state: &AppState) {
    let cfg = NetworkConfig::load(&state.db).await;
    let live = state.tls.is_https_live();

    // The CONFIGURED value; whether a given response carries it is decided per
    // request by `response_is_over_tls` - an instance behind a TLS-terminating
    // reverse proxy serves plain HTTP here and must still send HSTS.
    state.tls.set_hsts(
        cfg.hsts
            .header_value()
            .and_then(|s| HeaderValue::from_str(&s).ok()),
    );

    // A minimum-version change reaches the live listener without a restart.
    if live {
        reload_active_certificate(state, cfg.tls_min_version).await;
    }
}

/// Rebuilds the served `ServerConfig` from the active certificate and swaps it
/// into the live listener, with no dropped connections. Returns whether a swap
/// actually happened (false when no HTTPS listener is running).
pub async fn reload_certificate(state: &AppState) -> bool {
    if !state.tls.is_https_live() {
        return false;
    }
    let min = NetworkConfig::load(&state.db).await.tls_min_version;
    reload_active_certificate(state, min).await
}

async fn reload_active_certificate(state: &AppState, min: TlsMinVersion) -> bool {
    let Some(handle) = state.tls.reload_handle() else {
        return false;
    };
    let Some((cert_pem, key_pem)) =
        cert::active_material(&super::store::Paths::from_settings(&state.settings.server.tls))
    else {
        tracing::warn!("réseau : rechargement TLS demandé mais aucun certificat actif exploitable");
        return false;
    };
    match build_server_config(cert_pem.as_bytes(), key_pem.as_bytes(), min) {
        Ok(sc) => {
            handle.reload_from_config(sc);
            tracing::info!("réseau : certificat TLS rechargé à chaud");
            true
        }
        Err(e) => {
            tracing::error!(error = %e, "réseau : rechargement du certificat TLS échoué");
            false
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;
    use std::net::IpAddr;

    #[test]
    fn hsts_is_never_announced_for_a_loopback_name() {
        for local in [
            "localhost",
            "localhost:8080",
            "LOCALHOST:8443",
            "app.localhost",
            "127.0.0.1",
            "127.0.0.1:8080",
            "127.1.2.3",
            "[::1]",
            "[::1]:8080",
        ] {
            assert!(
                !hsts_applies_to_host(Some(local)),
                "ne doit pas épingler {local}"
            );
        }
    }

    #[test]
    fn hsts_is_announced_for_a_real_domain() {
        for real in ["cloud.example", "cloud.example:8443", "dev.kubuno.com"] {
            assert!(hsts_applies_to_host(Some(real)), "doit s'appliquer à {real}");
        }
        // No Host header at all: nothing says it is local, so keep the header.
        assert!(hsts_applies_to_host(None));
    }

    fn headers(proto: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(p) = proto {
            h.insert("x-forwarded-proto", HeaderValue::from_str(p).unwrap());
        }
        h
    }

    #[test]
    fn local_tls_is_enough() {
        assert!(response_is_over_tls(&headers(None), None, true));
    }

    #[test]
    fn plain_http_without_a_proxy_is_not_tls() {
        assert!(!response_is_over_tls(&headers(None), None, false));
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        assert!(!response_is_over_tls(&headers(Some("http")), Some(loopback), false));
    }

    /// The header alone must never be enough: an untrusted peer can forge it.
    #[test]
    fn an_untrusted_peer_claiming_https_is_not_believed() {
        crate::auth::client_ip::init(&["127.0.0.0/8".to_string()]);
        let public: IpAddr = "203.0.113.7".parse().unwrap();
        assert!(!response_is_over_tls(&headers(Some("https")), Some(public), false));
    }

    #[test]
    fn a_trusted_proxy_claiming_https_is_believed() {
        // `init` is process-global and idempotent after the first call; the
        // default list already contains loopback, which is what this asserts.
        crate::auth::client_ip::init(&["127.0.0.0/8".to_string()]);
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        assert!(response_is_over_tls(&headers(Some("https")), Some(loopback), false));
        // A chain keeps the first hop.
        assert!(response_is_over_tls(&headers(Some("https, http")), Some(loopback), false));
        assert!(!response_is_over_tls(&headers(Some("http, https")), Some(loopback), false));
    }
}
