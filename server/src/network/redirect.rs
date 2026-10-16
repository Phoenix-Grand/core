//! Sending plain-HTTP traffic to HTTPS, when the instance is configured to.
//!
//! Applied as a layer over the ordinary application router, so a request that
//! must NOT be redirected is simply served as usual. Three things this has to get
//! right, and each one has broken a real deployment:
//!
//!   * **A request that already arrived over TLS is not redirected.** Behind a
//!     TLS-terminating reverse proxy the core is reached in plain HTTP on the
//!     loopback: redirecting there answers a visitor who IS on HTTPS with "go to
//!     HTTPS", which at best is a wasted round trip and at worst a loop. The
//!     proxy's `X-Forwarded-Proto` decides, and only from a trusted peer
//!     ([`super::runtime::response_is_over_tls`]).
//!
//!   * **The ACME challenge is never redirected.** Proving domain control
//!     happens over plain HTTP, and answering a renewal check with a 308 to the
//!     very certificate being renewed is how automatic renewal quietly stops
//!     working.
//!
//!   * **The destination is not taken from the client.** A redirect built from
//!     the request's `Host` header sends whatever the client asked for - a
//!     request carrying `Host: elsewhere.example` gets
//!     `Location: https://elsewhere.example/…`, turning the instance into an
//!     open redirector for phishing and scanners. When the instance knows which
//!     names it answers for (the active certificate's SANs, the configured ACME
//!     domains), an unknown `Host` goes to the canonical name instead.

use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect},
};

/// Path prefix that must keep answering in plain HTTP for ACME to work.
const ACME_PREFIX: &str = "/.well-known/acme-challenge/";

/// Characters allowed in a hostname taken from a request. Anything else (a
/// slash, an `@`, a CR/LF, a space) could break out of the authority part of the
/// `Location` URL, so such a `Host` is never echoed back.
fn is_plausible_hostname(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// The host to redirect to: the requested one when the instance recognises it,
/// the canonical one otherwise.
fn target_host(requested: Option<&str>, canonical: &[String]) -> Option<String> {
    let requested = requested
        .map(|h| h.split(':').next().unwrap_or("").trim().to_ascii_lowercase())
        .filter(|h| is_plausible_hostname(h));

    if canonical.is_empty() {
        // Nothing to compare against (no certificate yet, no ACME domains): the
        // sanitised request host is all there is. It cannot break the URL open,
        // and this is the state an instance is in before it has any identity.
        return requested;
    }
    match requested {
        Some(h) if canonical.iter().any(|c| c.eq_ignore_ascii_case(&h)) => Some(h),
        // Known names exist and this is not one of them: send the visitor to the
        // instance's own first name rather than wherever the header pointed.
        _ => canonical.first().cloned(),
    }
}

/// Wraps `app` so that plain-HTTP requests are answered with a permanent
/// redirect to HTTPS. Used only on the plain-HTTP listeners.
pub fn wrap(app: Router, https_port: u16, canonical_hosts: Vec<String>) -> Router {
    app.layer(middleware::from_fn(
        move |req: Request<Body>, next: Next| {
            let canonical = canonical_hosts.clone();
            async move {
                let path = req.uri().path().to_owned();
                let peer = req
                    .extensions()
                    .get::<ConnectInfo<std::net::SocketAddr>>()
                    .map(|ci| ci.0.ip());
                // `tls_live` is false on purpose: this layer only ever runs on a
                // plain-HTTP socket, so the sole way of already being on TLS is a
                // trusted proxy having terminated it.
                let already_tls = super::runtime::response_is_over_tls(req.headers(), peer, false);

                if already_tls || path.starts_with(ACME_PREFIX) {
                    return next.run(req).await;
                }

                let requested = req
                    .headers()
                    .get(header::HOST)
                    .and_then(|v| v.to_str().ok());
                let Some(host) = target_host(requested, &canonical) else {
                    // No usable destination: better a plain error than a redirect
                    // to a host we made up.
                    return StatusCode::BAD_REQUEST.into_response();
                };
                let authority = if https_port == 443 {
                    host
                } else {
                    format!("{host}:{https_port}")
                };
                let path_and_query = req
                    .uri()
                    .path_and_query()
                    .map(|p| p.as_str().to_owned())
                    .unwrap_or_else(|| "/".into());
                Redirect::permanent(&format!("https://{authority}{path_and_query}")).into_response()
            }
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_known_host_is_kept() {
        let canonical = vec!["cloud.example".to_string(), "www.example".to_string()];
        assert_eq!(
            target_host(Some("cloud.example"), &canonical).as_deref(),
            Some("cloud.example")
        );
        // Port and case are irrelevant to the comparison.
        assert_eq!(
            target_host(Some("WWW.Example:8080"), &canonical).as_deref(),
            Some("www.example")
        );
    }

    /// The open-redirect case: a forged `Host` must not become the destination.
    #[test]
    fn an_unknown_host_falls_back_to_the_canonical_name() {
        let canonical = vec!["cloud.example".to_string()];
        assert_eq!(
            target_host(Some("attacker.test"), &canonical).as_deref(),
            Some("cloud.example")
        );
        assert_eq!(target_host(None, &canonical).as_deref(), Some("cloud.example"));
    }

    /// Anything that could break out of the authority part is refused outright,
    /// including when the instance has no names to compare against.
    #[test]
    fn a_host_that_could_break_the_url_is_refused() {
        for bad in [
            "evil.test/path",
            "evil.test@real.test",
            "evil.test\r\nX-Injected: 1",
            "evil test",
            "",
        ] {
            assert_eq!(target_host(Some(bad), &[]), None, "doit refuser {bad:?}");
        }
    }

    #[test]
    fn without_canonical_names_a_sane_host_is_used() {
        assert_eq!(
            target_host(Some("cloud.example:8080"), &[]).as_deref(),
            Some("cloud.example")
        );
    }
}
