//! Client address resolution behind (optionally) trusted reverse proxies.
//!
//! `X-Forwarded-For` and `X-Real-IP` are request headers: any client can set
//! them to any value. Trusting them unconditionally lets a single host defeat
//! every per-IP control - rate limiting, DDoS shedding - simply by rotating the
//! header on each request, and poisons session records and access logs.
//!
//! This module implements the rule used by hardened reverse proxies: forwarding
//! headers are honoured ONLY when the TCP peer (the socket address, which cannot
//! be forged over an established connection) belongs to a configured trusted
//! range. Inside `X-Forwarded-For` the chain is then walked from the RIGHT - the
//! entry appended by the closest proxy, the only hop it actually observed - down
//! to the first address that is not itself a trusted proxy. Taking the leftmost
//! entry, the naive implementation, is exactly what is forgeable: the client
//! writes it.
//!
//! The trusted list is process-global and initialised once at startup from
//! `server.trusted_proxy_cidrs` (see [`init`]). When it has not been
//! initialised - CLI binaries, unit tests - the list is empty and forwarding
//! headers are never honoured, which fails closed.

use axum::extract::ConnectInfo;
use axum::http::request::Parts;
use axum::http::{HeaderMap, Request};
use ipnet::IpNet;
use std::net::{IpAddr, SocketAddr};
use std::sync::OnceLock;

/// Rate-limit bucket used when the client address cannot be determined at all
/// (no `ConnectInfo` layer on the router).
pub const UNKNOWN_CLIENT: &str = "unknown";

/// Default value of `server.trusted_proxy_cidrs`.
///
/// Rationale: the overwhelmingly common self-hosted deployment puts a reverse
/// proxy (nginx, Traefik, Caddy) either on the same host - the core then sees a
/// loopback peer - or on the same private LAN / container network. Shipping an
/// empty list would silently collapse every remote user onto the proxy's own
/// address and break per-user rate limiting, so these ranges are trusted out of
/// the box. They are all non-routable on the public Internet: a header forged by
/// a client connecting from a public address is still rejected, which is the
/// property that matters.
///
/// A proxy that reaches the core from a PUBLIC address (VPN/tunnel endpoint,
/// remote load balancer, cloud front-end) is deliberately not covered and must
/// be declared explicitly in the configuration.
pub const DEFAULT_TRUSTED_PROXY_CIDRS: &[&str] = &[
    "127.0.0.0/8",    // IPv4 loopback (proxy on the same host)
    "::1/128",        // IPv6 loopback
    "10.0.0.0/8",     // RFC 1918 private
    "172.16.0.0/12",  // RFC 1918 private (includes the default Docker bridge)
    "192.168.0.0/16", // RFC 1918 private
    "fc00::/7",       // RFC 4193 unique local IPv6
];

static TRUSTED_PROXIES: OnceLock<Vec<IpNet>> = OnceLock::new();

/// Installs the trusted-proxy ranges. Called once at startup; later calls are
/// ignored (with a warning) so the policy cannot be swapped at runtime.
pub fn init(cidrs: &[String]) {
    let nets = parse_cidrs(cidrs);
    let rendered: Vec<String> = nets.iter().map(ToString::to_string).collect();
    if TRUSTED_PROXIES.set(nets).is_err() {
        tracing::warn!("Liste des mandataires de confiance déjà initialisée - réinitialisation ignorée");
        return;
    }
    if rendered.is_empty() {
        tracing::warn!(
            "server.trusted_proxy_cidrs est vide : les en-têtes X-Forwarded-For / X-Real-IP \
             seront ignorés et l'adresse de la socket fera foi"
        );
    } else {
        tracing::info!("Mandataires de confiance : {}", rendered.join(", "));
    }
}

/// Parses the configured ranges, skipping (and reporting) invalid entries so a
/// typo cannot take the whole server down.
fn parse_cidrs(cidrs: &[String]) -> Vec<IpNet> {
    let mut out = Vec::with_capacity(cidrs.len());
    for raw in cidrs {
        let entry = raw.trim();
        if entry.is_empty() {
            continue;
        }
        match parse_cidr(entry) {
            Some(net) => out.push(net),
            None => tracing::warn!(
                "server.trusted_proxy_cidrs : entrée ignorée (CIDR invalide) : {entry}"
            ),
        }
    }
    out
}

/// Accepts either a CIDR block (`10.0.0.0/8`) or a bare address, which is then
/// treated as a single host (`/32` or `/128`).
fn parse_cidr(entry: &str) -> Option<IpNet> {
    if let Ok(net) = entry.parse::<IpNet>() {
        // `trunc` clears any host bits so `10.1.2.3/8` behaves like `10.0.0.0/8`.
        return Some(net.trunc());
    }
    entry.parse::<IpAddr>().ok().map(IpNet::from)
}

fn trusted() -> &'static [IpNet] {
    TRUSTED_PROXIES.get().map(Vec::as_slice).unwrap_or(&[])
}

fn is_trusted(nets: &[IpNet], ip: IpAddr) -> bool {
    nets.iter().any(|net| net.contains(&ip))
}

/// True when `ip` is a configured trusted proxy.
pub fn is_trusted_proxy(ip: IpAddr) -> bool {
    is_trusted(trusted(), ip)
}

/// Core resolution, parameterised by the trusted list so it can be unit-tested
/// without touching the process-global state.
fn resolve(headers: &HeaderMap, peer: Option<IpAddr>, nets: &[IpNet]) -> Option<IpAddr> {
    // No socket address means no anchor of trust: nothing in the request can be
    // believed, so report "unknown" rather than a forgeable header value.
    let peer = peer?;

    if !is_trusted(nets, peer) {
        return Some(peer);
    }

    let chain = forwarded_chain(headers);
    if !chain.is_empty() {
        // Rightmost entry that is not itself a trusted hop.
        if let Some(ip) = chain.iter().rev().find(|ip| !is_trusted(nets, **ip)) {
            return Some(*ip);
        }
        // Every hop is a trusted proxy: the leftmost entry is the closest thing
        // to a real client the chain can attest to.
        return chain.first().copied();
    }

    // Single-hop proxies that only emit X-Real-IP.
    if let Some(ip) = headers
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_forwarded_entry)
    {
        return Some(ip);
    }

    Some(peer)
}

/// Flattens every `X-Forwarded-For` header (a request may legitimately carry
/// several) into a left-to-right list of parsable addresses.
fn forwarded_chain(headers: &HeaderMap) -> Vec<IpAddr> {
    headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(parse_forwarded_entry)
        .collect()
}

/// Parses one chain element. Tolerates the shapes proxies emit in practice:
/// bare address, quoted address, `[v6]:port` and `v4:port`.
fn parse_forwarded_entry(raw: &str) -> Option<IpAddr> {
    let entry = raw.trim().trim_matches('"');
    if entry.is_empty() {
        return None;
    }
    // Bare address first - this is also the only form that parses a
    // bracket-less IPv6 address correctly.
    if let Ok(ip) = entry.parse::<IpAddr>() {
        return Some(ip);
    }
    // "[2001:db8::1]" or "[2001:db8::1]:443"
    if let Some(rest) = entry.strip_prefix('[') {
        if let Some((inner, _)) = rest.split_once(']') {
            return inner.parse::<IpAddr>().ok();
        }
    }
    // "192.0.2.1:443"
    if let Some((host, _port)) = entry.rsplit_once(':') {
        if let Ok(ip) = host.parse::<IpAddr>() {
            return Some(ip);
        }
    }
    None
}

/// Resolves the client address of a request being processed by a middleware.
/// `None` when the router was mounted without `ConnectInfo`.
pub fn client_ip<B>(req: &Request<B>) -> Option<IpAddr> {
    let peer = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip());
    resolve(req.headers(), peer, trusted())
}

/// Rate-limiting key: the resolved address, or [`UNKNOWN_CLIENT`] when it cannot
/// be determined. Sharing a single bucket in that case is deliberate - it fails
/// closed instead of handing out an unlimited budget.
pub fn client_ip_key<B>(req: &Request<B>) -> String {
    client_ip(req).map_or_else(|| UNKNOWN_CLIENT.to_string(), |ip| ip.to_string())
}

/// The resolved client address, usable as an Axum extractor in handlers.
///
/// Never rejects: `None` simply means the address could not be established.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientIp(pub Option<IpAddr>);

impl ClientIp {
    /// Rendering suitable for a PostgreSQL `INET` bind (`NULL` when unknown).
    pub fn to_inet_string(self) -> Option<String> {
        self.0.map(|ip| ip.to_string())
    }

    /// Same resolution from already-extracted request parts, for code that holds
    /// `Parts` rather than an extractor slot (the audit context, for one). Keeps
    /// every caller on this module's trusted-proxy rule.
    pub fn from_parts(parts: &Parts) -> Self {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ci| ci.0.ip());
        ClientIp(resolve(&parts.headers, peer, trusted()))
    }
}

#[async_trait::async_trait]
impl<S> axum::extract::FromRequestParts<S> for ClientIp
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(ClientIp::from_parts(parts))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nets(list: &[&str]) -> Vec<IpNet> {
        parse_cidrs(&list.iter().map(|s| (*s).to_string()).collect::<Vec<_>>())
    }

    fn default_nets() -> Vec<IpNet> {
        nets(DEFAULT_TRUSTED_PROXY_CIDRS)
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (name, value) in pairs {
            h.append(
                axum::http::HeaderName::from_bytes(name.as_bytes()).expect("nom d'en-tête valide"),
                axum::http::HeaderValue::from_str(value).expect("valeur d'en-tête valide"),
            );
        }
        h
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("adresse IP de test valide")
    }

    #[test]
    fn untrusted_peer_ignores_forged_header() {
        // The whole point of the fix: a client connecting straight from the
        // Internet cannot claim to be someone else.
        let h = headers(&[("x-forwarded-for", "1.2.3.4"), ("x-real-ip", "5.6.7.8")]);
        let got = resolve(&h, Some(ip("203.0.113.9")), &default_nets());
        assert_eq!(got, Some(ip("203.0.113.9")));
    }

    #[test]
    fn untrusted_peer_ignores_rotating_header() {
        // Two requests with different forged headers must resolve to the same
        // rate-limit key.
        let nets = default_nets();
        let a = resolve(
            &headers(&[("x-forwarded-for", "10.0.0.1")]),
            Some(ip("198.51.100.7")),
            &nets,
        );
        let b = resolve(
            &headers(&[("x-forwarded-for", "10.0.0.2")]),
            Some(ip("198.51.100.7")),
            &nets,
        );
        assert_eq!(a, b);
        assert_eq!(a, Some(ip("198.51.100.7")));
    }

    #[test]
    fn trusted_peer_takes_rightmost_untrusted_hop() {
        // Client forged "1.1.1.1"; the real client is 203.0.113.5, appended by
        // the outer proxy. Walking from the right ignores the forged prefix.
        let h = headers(&[(
            "x-forwarded-for",
            "1.1.1.1, 203.0.113.5, 10.0.0.8, 192.168.1.2",
        )]);
        let got = resolve(&h, Some(ip("127.0.0.1")), &default_nets());
        assert_eq!(got, Some(ip("203.0.113.5")));
    }

    #[test]
    fn trusted_peer_single_hop() {
        let h = headers(&[("x-forwarded-for", "203.0.113.42")]);
        let got = resolve(&h, Some(ip("127.0.0.1")), &default_nets());
        assert_eq!(got, Some(ip("203.0.113.42")));
    }

    #[test]
    fn trusted_peer_chain_entirely_trusted_falls_back_to_leftmost() {
        let h = headers(&[("x-forwarded-for", "10.1.2.3, 192.168.0.5")]);
        let got = resolve(&h, Some(ip("127.0.0.1")), &default_nets());
        assert_eq!(got, Some(ip("10.1.2.3")));
    }

    #[test]
    fn trusted_peer_multiple_headers_are_concatenated() {
        let h = headers(&[
            ("x-forwarded-for", "203.0.113.5"),
            ("x-forwarded-for", "10.0.0.8"),
        ]);
        let got = resolve(&h, Some(ip("127.0.0.1")), &default_nets());
        assert_eq!(got, Some(ip("203.0.113.5")));
    }

    #[test]
    fn ipv6_client_through_trusted_ipv6_proxy() {
        let h = headers(&[("x-forwarded-for", "2001:db8::42, fc00::1")]);
        let got = resolve(&h, Some(ip("::1")), &default_nets());
        assert_eq!(got, Some(ip("2001:db8::42")));
    }

    #[test]
    fn ipv6_with_brackets_and_port() {
        let h = headers(&[("x-forwarded-for", "[2001:db8::7]:51234")]);
        let got = resolve(&h, Some(ip("127.0.0.1")), &default_nets());
        assert_eq!(got, Some(ip("2001:db8::7")));
    }

    #[test]
    fn ipv4_with_port() {
        let h = headers(&[("x-forwarded-for", "203.0.113.11:44321")]);
        let got = resolve(&h, Some(ip("127.0.0.1")), &default_nets());
        assert_eq!(got, Some(ip("203.0.113.11")));
    }

    #[test]
    fn ipv6_peer_not_trusted_when_public() {
        let h = headers(&[("x-forwarded-for", "10.0.0.1")]);
        let got = resolve(&h, Some(ip("2001:db8::1")), &default_nets());
        assert_eq!(got, Some(ip("2001:db8::1")));
    }

    #[test]
    fn missing_header_falls_back_to_peer() {
        let got = resolve(&HeaderMap::new(), Some(ip("127.0.0.1")), &default_nets());
        assert_eq!(got, Some(ip("127.0.0.1")));
    }

    #[test]
    fn malformed_header_is_skipped() {
        let h = headers(&[("x-forwarded-for", "not-an-ip, , 999.999.999.999")]);
        let got = resolve(&h, Some(ip("127.0.0.1")), &default_nets());
        assert_eq!(got, Some(ip("127.0.0.1")));
    }

    #[test]
    fn malformed_prefix_still_yields_valid_tail() {
        let h = headers(&[("x-forwarded-for", "junk, 203.0.113.77")]);
        let got = resolve(&h, Some(ip("127.0.0.1")), &default_nets());
        assert_eq!(got, Some(ip("203.0.113.77")));
    }

    #[test]
    fn x_real_ip_used_only_without_forwarded_for() {
        let h = headers(&[("x-real-ip", "203.0.113.99")]);
        assert_eq!(
            resolve(&h, Some(ip("127.0.0.1")), &default_nets()),
            Some(ip("203.0.113.99"))
        );
        // Untrusted peer: ignored.
        assert_eq!(
            resolve(&h, Some(ip("198.51.100.1")), &default_nets()),
            Some(ip("198.51.100.1"))
        );
    }

    #[test]
    fn no_socket_address_means_unknown() {
        let h = headers(&[("x-forwarded-for", "1.2.3.4")]);
        assert_eq!(resolve(&h, None, &default_nets()), None);
    }

    #[test]
    fn empty_trusted_list_never_honours_headers() {
        let h = headers(&[("x-forwarded-for", "1.2.3.4")]);
        assert_eq!(resolve(&h, Some(ip("127.0.0.1")), &[]), Some(ip("127.0.0.1")));
    }

    #[test]
    fn explicit_public_proxy_range_is_honoured() {
        // Deployment where the reverse proxy reaches the core over a tunnel with
        // publicly-routable addressing: the range must be declared explicitly.
        let custom = nets(&["15.100.1.0/24"]);
        let h = headers(&[("x-forwarded-for", "203.0.113.30")]);
        assert_eq!(
            resolve(&h, Some(ip("15.100.1.1")), &custom),
            Some(ip("203.0.113.30"))
        );
    }

    #[test]
    fn invalid_cidr_entries_are_dropped_not_fatal() {
        let parsed = nets(&["10.0.0.0/8", "pas-un-cidr", "", "192.168.1.7"]);
        assert_eq!(parsed.len(), 2);
        assert!(is_trusted(&parsed, ip("10.9.9.9")));
        assert!(is_trusted(&parsed, ip("192.168.1.7")));
        assert!(!is_trusted(&parsed, ip("192.168.1.8")));
    }

    #[test]
    fn host_bits_in_cidr_are_truncated() {
        let parsed = nets(&["10.1.2.3/8"]);
        assert!(is_trusted(&parsed, ip("10.255.0.1")));
    }
}
