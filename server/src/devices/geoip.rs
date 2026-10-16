//! Country resolution from a **local** database, or not at all.
//!
//! ## Why there is no HTTP client in this file
//!
//! Every mainstream "geolocate this address" answer is an API call to a third
//! party. Kubuno's users are self-hosting precisely so that a sign-in does not
//! become a request to somebody else's server carrying their users' addresses.
//! So the country column is filled from a file on disk or it stays empty, and
//! the console says "unknown" without apology. Nothing downloads anything, ever,
//! and there is no setting that would make it.
//!
//! ## Optional by construction
//!
//! `devices.country_db_path` is empty by default. With no database:
//!
//! * [`lookup`] returns `None`;
//! * the column stays `NULL`;
//! * the country filter offers nothing and the sheet says "unknown".
//!
//! Nothing else changes and nothing fails. That is the whole contract: the
//! feature must be a bonus, never a dependency.
//!
//! ## Accepted formats
//!
//! Two shapes of CSV, detected per line, so an operator can point at whichever
//! free database they already trust:
//!
//! ```text
//! 1.0.0.0,1.0.0.255,AU          range form  (db-ip lite, IP2Location LITE)
//! 1.0.0.0/24,AU                 CIDR form   (GeoLite2-style country blocks)
//! ```
//!
//! In CIDR form the country is the first field after the network that looks like
//! an ISO 3166-1 alpha-2 code, which tolerates the extra columns those exports
//! carry.

use std::net::{IpAddr, Ipv6Addr};
use std::sync::OnceLock;

use ipnet::IpNet;

/// One contiguous range, normalised to u128 so v4 and v6 share the search.
#[derive(Debug, Clone, Copy)]
struct Range {
    start: u128,
    end: u128,
    country: [u8; 2],
}

/// Ranges sorted by start, searched by binary search.
#[derive(Debug, Default)]
pub struct CountryDb {
    v4: Vec<Range>,
    v6: Vec<Range>,
}

static DB: OnceLock<Option<CountryDb>> = OnceLock::new();

/// Loads the database once, at startup. A missing, empty or unreadable path
/// disables the feature with a single informative log line - never an error:
/// a typo in an optional path must not keep the server from booting.
pub fn init(path: &str) {
    let trimmed = path.trim();
    let loaded = if trimmed.is_empty() {
        tracing::info!(
            "Base de pays hors-ligne non configurée : le pays des appareils restera inconnu"
        );
        None
    } else {
        match std::fs::read_to_string(trimmed) {
            Ok(text) => {
                let db = parse(&text);
                tracing::info!(
                    path = %trimmed,
                    ranges = db.v4.len() + db.v6.len(),
                    "Base de pays hors-ligne chargée"
                );
                Some(db)
            }
            Err(e) => {
                tracing::warn!(
                    path = %trimmed,
                    error = %e,
                    "Base de pays hors-ligne illisible - le pays restera inconnu"
                );
                None
            }
        }
    };
    if DB.set(loaded).is_err() {
        tracing::warn!("Base de pays déjà initialisée - rechargement ignoré");
    }
}

/// True when a database is loaded. The console uses it to explain an empty
/// country column instead of leaving the operator to guess.
pub fn is_available() -> bool {
    DB.get().map(Option::is_some).unwrap_or(false)
}

/// ISO 3166-1 alpha-2 code for an address, or `None`.
///
/// Addresses that cannot have a country - loopback, RFC 1918, link-local,
/// unique-local - return `None` before the search: reporting a country for
/// `192.168.1.20` would be a fabrication, and on a self-hosted LAN that is most
/// of the traffic.
pub fn lookup(ip: IpAddr) -> Option<String> {
    if !is_public(ip) {
        return None;
    }
    let db = DB.get()?.as_ref()?;
    let (table, key) = match ip {
        IpAddr::V4(v4) => (&db.v4, u32::from(v4) as u128),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => (&db.v4, u32::from(v4) as u128),
            None => (&db.v6, u128::from(v6)),
        },
    };
    search(table, key)
}

/// Same, from the textual form stored on a session row.
pub fn lookup_str(ip: Option<&str>) -> Option<String> {
    lookup(ip?.parse().ok()?)
}

fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]) // CGNAT
                || v4.octets()[0] == 0)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || is_unique_local(v6)
                || is_v6_link_local(v6))
        }
    }
}

// `Ipv6Addr::is_unique_local` / `is_unicast_link_local` are still unstable.
fn is_unique_local(v6: Ipv6Addr) -> bool {
    v6.octets()[0] & 0xfe == 0xfc
}

fn is_v6_link_local(v6: Ipv6Addr) -> bool {
    let o = v6.octets();
    o[0] == 0xfe && o[1] & 0xc0 == 0x80
}

fn search(table: &[Range], key: u128) -> Option<String> {
    // `partition_point` gives the first range starting after `key`; the
    // candidate is therefore the one just before it.
    let index = table.partition_point(|r| r.start <= key);
    let candidate = table.get(index.checked_sub(1)?)?;
    if key <= candidate.end {
        std::str::from_utf8(&candidate.country)
            .ok()
            .map(str::to_string)
    } else {
        None
    }
}

fn parse(text: &str) -> CountryDb {
    let mut v4 = Vec::new();
    let mut v6 = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line
            .split(',')
            .map(|f| f.trim().trim_matches('"'))
            .collect();
        let Some(parsed) = parse_line(&fields) else {
            continue;
        };
        if parsed.end <= u128::from(u32::MAX) && fields[0].contains('.') {
            v4.push(parsed);
        } else {
            v6.push(parsed);
        }
    }

    v4.sort_unstable_by_key(|r| r.start);
    v6.sort_unstable_by_key(|r| r.start);
    CountryDb { v4, v6 }
}

fn parse_line(fields: &[&str]) -> Option<Range> {
    let first = fields.first()?;
    if first.contains('/') {
        // CIDR form: the country is the first later field shaped like a code.
        let net: IpNet = first.parse().ok()?;
        let country = fields[1..].iter().find_map(|f| country_code(f))?;
        return Some(Range {
            start: to_u128(net.network()),
            end: to_u128(net.broadcast()),
            country,
        });
    }
    // Range form: start, end, country.
    let start: IpAddr = first.parse().ok()?;
    let end: IpAddr = fields.get(1)?.parse().ok()?;
    let country = fields[2..].iter().find_map(|f| country_code(f))?;
    Some(Range {
        start: to_u128(start),
        end: to_u128(end),
        country,
    })
}

fn country_code(field: &str) -> Option<[u8; 2]> {
    let bytes = field.as_bytes();
    if bytes.len() == 2 && bytes.iter().all(|b| b.is_ascii_alphabetic()) {
        Some([bytes[0].to_ascii_uppercase(), bytes[1].to_ascii_uppercase()])
    } else {
        None
    }
}

fn to_u128(ip: IpAddr) -> u128 {
    match ip {
        IpAddr::V4(v4) => u128::from(u32::from(v4)),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => u128::from(u32::from(v4)),
            None => u128::from(v6),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# a comment
1.0.0.0,1.0.0.255,AU
2.0.0.0,2.255.255.255,FR
2001:db8::/32,DE
";

    fn db() -> CountryDb {
        parse(SAMPLE)
    }

    fn find(db: &CountryDb, raw: &str) -> Option<String> {
        let ip: IpAddr = raw.parse().ok()?;
        match ip {
            IpAddr::V4(v4) => search(&db.v4, u128::from(u32::from(v4))),
            IpAddr::V6(v6) => search(&db.v6, u128::from(v6)),
        }
    }

    #[test]
    fn reads_both_range_and_cidr_forms() {
        let db = db();
        assert_eq!(find(&db, "1.0.0.7").as_deref(), Some("AU"));
        assert_eq!(find(&db, "2.10.20.30").as_deref(), Some("FR"));
        assert_eq!(find(&db, "2001:db8::1").as_deref(), Some("DE"));
    }

    #[test]
    fn an_address_outside_every_range_is_unknown_not_guessed() {
        let db = db();
        assert_eq!(find(&db, "9.9.9.9"), None);
    }

    /// On a self-hosted LAN most traffic is private. Naming a country for it
    /// would be an invention, and inventions are what this feature must not do.
    #[test]
    fn private_and_loopback_addresses_have_no_country() {
        for raw in ["127.0.0.1", "192.168.1.20", "10.4.4.4", "172.16.9.9", "::1", "fd00::1"] {
            let ip: IpAddr = raw.parse().expect("adresse de test");
            assert!(!is_public(ip), "{raw} devrait être considérée non publique");
            assert_eq!(lookup(ip), None, "{raw} ne doit pas avoir de pays");
        }
    }

    /// The whole point of the option: without a file, nothing breaks.
    #[test]
    fn without_a_database_every_lookup_is_simply_unknown() {
        let empty = CountryDb::default();
        assert_eq!(find(&empty, "2.10.20.30"), None);
        assert_eq!(parse("").v4.len(), 0);
    }

    #[test]
    fn malformed_lines_are_skipped_rather_than_fatal() {
        let db = parse("garbage\n1.0.0.0,1.0.0.255,AU\n,,\n8.8.8.8,notanip,US\n");
        assert_eq!(db.v4.len(), 1);
        assert_eq!(find(&db, "1.0.0.1").as_deref(), Some("AU"));
    }

    #[test]
    fn ipv4_mapped_ipv6_is_searched_in_the_v4_table() {
        let db = db();
        let mapped: Ipv6Addr = "::ffff:2.10.20.30".parse().expect("adresse de test");
        let key = to_u128(IpAddr::V6(mapped));
        assert_eq!(search(&db.v4, key).as_deref(), Some("FR"));
    }
}
