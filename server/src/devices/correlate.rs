//! Deciding *which* device a request comes from, and keeping the inventory row
//! in step with it.
//!
//! ## Three sources, in decreasing order of honesty
//!
//! 1. **A native client's device key** (`X-Kubuno-Device-Key`) - the application
//!    generates it once, stores it in the OS keychain, and sends it on every
//!    authentication. Strong.
//! 2. **A first-party opaque cookie** (`kb_device`) - minted by the server on
//!    the first browser sign-in that has none. HttpOnly, so no script can read
//!    or forge it, and it carries nothing but a random value. Strong.
//! 3. **A fingerprint derived from the normalised user agent** - the fallback,
//!    and the only thing available for sessions opened before this table
//!    existed. Honestly weaker: two identical laptops of the same account
//!    collapse into one row. The console shows which of the two kinds a device
//!    was correlated by, rather than presenting the guess as a fact.
//!
//! ## The correlation identifier is a secret
//!
//! Whatever the source, the material is hashed (SHA-256) and only the hash is
//! stored, in `core.devices.correlation_hash`. It is never serialised, never
//! logged, and never accepted as an input: a caller who knew it could claim
//! somebody else's inventory row. The API speaks exclusively in
//! `core.devices.id`, a public UUID that grants nothing on its own.

use chrono::{DateTime, Utc};
use kubuno_db::dialect::Assign;
use kubuno_db::{new_id, params, Backend, DbPool, DbTx};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use uuid::Uuid;

use super::model::{event_kind, AuthStrength};
use super::user_agent::{self, Normalised};
use crate::errors::AppError;

/// Name of the first-party correlation cookie.
pub const DEVICE_COOKIE: &str = "kb_device";
/// Header a native application uses instead of the cookie.
pub const DEVICE_HEADER: &str = "x-kubuno-device-key";
/// Two years: long enough that a laptop keeps its identity across a holiday,
/// short enough that an abandoned machine eventually falls out of the inventory
/// by itself.
const COOKIE_MAX_AGE: i64 = 60 * 60 * 24 * 730;

/// How a request was tied to an inventory row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceKey {
    /// Correlation material. **Never** logged, never serialised.
    raw: String,
    /// `"key"` or `"fingerprint"`, mirrored into `correlation_kind`.
    pub kind: &'static str,
    /// Present when the server had to mint a cookie: the caller must send it
    /// back on the response, otherwise the next sign-in falls back to the
    /// fingerprint and the inventory splits.
    pub mint: Option<String>,
}

impl DeviceKey {
    /// SHA-256 of the material, hex. The only form that ever reaches the
    /// database.
    pub fn hash(&self) -> String {
        hex::encode(Sha256::digest(self.raw.as_bytes()))
    }
}

// `Debug` on the struct would print `raw`. Deriving it and then remembering not
// to log the value is the kind of discipline that lasts until the first
// `tracing::debug!(?key)`, so the field is private and this is the manual impl.
impl std::fmt::Display for DeviceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DeviceKey({})", self.kind)
    }
}

/// Reads the correlation cookie out of a `Cookie` header value.
fn cookie_value(cookies: &str) -> Option<String> {
    cookies.split(';').find_map(|part| {
        part.trim()
            .strip_prefix(&format!("{DEVICE_COOKIE}="))
            .map(str::to_string)
            .filter(|v| !v.is_empty())
    })
}

/// Builds the `Set-Cookie` value for a freshly minted key.
pub fn mint_cookie(value: &str, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    // `Path=/` and not `/api/v1/auth`: the cookie has to reach `/me/devices` so
    // the personal screen can mark "this device" without the client having to
    // hold anything itself. HttpOnly keeps it out of reach of scripts, and it
    // carries no information beyond a random value.
    format!("{DEVICE_COOKIE}={value}; HttpOnly{secure}; Path=/; SameSite=Lax; Max-Age={COOKIE_MAX_AGE}")
}

/// Resolves the correlation key of an authenticating request.
///
/// `header` / `cookies` are the raw header values; `normalised` is the reading
/// of the user agent, used only by the fingerprint fallback.
pub fn resolve(
    header: Option<&str>,
    cookies: Option<&str>,
    user_id: Uuid,
    client_type: &str,
    normalised: &Normalised,
    accepts_cookie: bool,
) -> DeviceKey {
    if let Some(key) = header.map(str::trim).filter(|k| !k.is_empty()) {
        return DeviceKey {
            raw: format!("k:{key}"),
            kind: "key",
            mint: None,
        };
    }
    if let Some(existing) = cookies.and_then(cookie_value) {
        return DeviceKey {
            raw: format!("k:{existing}"),
            kind: "key",
            mint: None,
        };
    }
    if accepts_cookie {
        let (fresh, _) = crate::crypto::token::generate_token();
        return DeviceKey {
            raw: format!("k:{fresh}"),
            kind: "key",
            mint: Some(fresh),
        };
    }
    DeviceKey {
        raw: format!(
            "f:{user_id}:{client_type}:{}",
            normalised.fingerprint_material()
        ),
        kind: "fingerprint",
        mint: None,
    }
}

/// Fingerprint key without minting anything - used by the backfill, which
/// reconciles rows that were written before any cookie existed.
pub fn fingerprint_key(user_id: Uuid, client_type: &str, normalised: &Normalised) -> DeviceKey {
    DeviceKey {
        raw: format!(
            "f:{user_id}:{client_type}:{}",
            normalised.fingerprint_material()
        ),
        kind: "fingerprint",
        mint: None,
    }
}

/// Outcome of an upsert.
pub struct Touched {
    pub device_id: Uuid,
    pub approval: String,
    pub created: bool,
}

/// The reselected identity of a just-upserted device row.
#[derive(FromRow)]
struct TouchedRow {
    id: Uuid,
    approval: String,
    first_seen_at: DateTime<Utc>,
    last_seen_at: DateTime<Utc>,
}

/// Creates or refreshes the inventory row for a device that just authenticated.
///
/// Observed fields are always refreshed (a laptop that moved country must say
/// so). Declared fields are never touched here - only the declaration route
/// writes them, and only when the operator switched declarations on.
///
/// The old `RETURNING` is replaced by an insert-then-reselect: the row is keyed
/// by `(user_id, correlation_hash)`, so after the upsert the same key reads back
/// the durable `id` (which, on a conflict, is the pre-existing one rather than
/// the id we generated). `created` still follows the invariant that a freshly
/// inserted row has `first_seen_at == last_seen_at` because both are bound from
/// the same instant, while a conflicting row keeps its older `first_seen_at`.
#[allow(clippy::too_many_arguments)]
pub async fn upsert(
    db: &DbPool,
    user_id: Uuid,
    key: &DeviceKey,
    normalised: &Normalised,
    raw_ua: &str,
    client_type: &str,
    ip: Option<&str>,
    country: Option<&str>,
) -> Result<Touched, AppError> {
    let backend = db.backend();
    let id = new_id();
    let now = Utc::now();
    let hash = key.hash();

    // NOTE (multi-DBMS): `$12::inet` is PostgreSQL-only; the cast is applied only
    // on PostgreSQL (where `last_ip` is an `inet`) and dropped elsewhere. Flagged
    // in the port report - the column needs a portable (TEXT) form on MySQL/SQLite.
    let ip_placeholder = match backend {
        Backend::Postgres => "$12::inet",
        _ => "$12",
    };
    let conflict = backend.upsert(
        "core.devices",
        &["user_id", "correlation_hash"],
        &[
            Assign::Incoming("device_type"),
            Assign::Incoming("client_kind"),
            Assign::Incoming("platform"),
            Assign::Incoming("platform_version"),
            Assign::Incoming("browser"),
            Assign::Incoming("browser_version"),
            Assign::Incoming("user_agent"),
            Assign::Incoming("last_ip"),
            Assign::Expr {
                col: "last_country",
                expr: "COALESCE({new}, {cur})",
            },
            Assign::Incoming("last_seen_at"),
        ],
    );
    let insert_sql = format!(
        r#"INSERT INTO core.devices
               (id, user_id, correlation_hash, correlation_kind, device_type, client_kind,
                platform, platform_version, browser, browser_version, user_agent,
                last_ip, last_country, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, {ip_placeholder}, $13, $14, $15){conflict}"#
    );

    db.execute(
        &insert_sql,
        params![
            id,
            user_id,
            hash.clone(),
            key.kind,
            &normalised.device_type,
            client_type,
            normalised.platform.as_deref(),
            normalised.platform_version.as_deref(),
            normalised.browser.as_deref(),
            normalised.browser_version.as_deref(),
            raw_ua,
            ip,
            country,
            now,
            now
        ],
    )
    .await
    .map_err(|e| {
        // The key is not in this log line, and must never be added to it.
        tracing::error!(error = %e, user_id = %user_id, "devices: device upsert");
        AppError::Database(e)
    })?;

    let row = db
        .fetch_one_as::<TouchedRow>(
            "SELECT id, approval, first_seen_at, last_seen_at
               FROM core.devices
              WHERE user_id = $1 AND correlation_hash = $2",
            params![user_id, hash],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "devices: device upsert reselect");
            AppError::Database(e)
        })?;

    let device_id = row.id;
    let approval = row.approval;
    let created = row.first_seen_at == row.last_seen_at;
    if created {
        record_event(
            db,
            device_id,
            event_kind::FIRST_SEEN,
            ip,
            country,
            None,
            None,
            Some(&normalised.describe()),
        )
        .await;
    }

    Ok(Touched {
        device_id,
        approval,
        created,
    })
}

/// Ties a freshly issued session to its device and records what the request
/// revealed about it.
pub async fn attach_session(
    db: &DbPool,
    session_id: Uuid,
    device_id: Uuid,
    country: Option<&str>,
    strength: AuthStrength,
) -> Result<(), AppError> {
    // Placeholders must appear once each in ascending order (portable rewrite),
    // so the WHERE key is numbered after the SET assignments.
    db.execute(
        "UPDATE core.refresh_tokens
            SET device_id = $1, country = $2, auth_strength = $3
          WHERE id = $4",
        params![device_id, country, strength.as_str(), session_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, session_id = %session_id, "devices: attaching the session");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Appends a line to a device timeline.
///
/// Best-effort: a timeline that could not be written must never turn a
/// successful sign-in into a 500. The failure is logged loudly instead - the
/// administrative audit trail, which *is* transactional, remains the authority
/// on every operator action.
#[allow(clippy::too_many_arguments)]
pub async fn record_event(
    db: &DbPool,
    device_id: Uuid,
    kind: &str,
    ip: Option<&str>,
    country: Option<&str>,
    actor_id: Option<Uuid>,
    actor_label: Option<&str>,
    detail: Option<&str>,
) {
    // NOTE (multi-DBMS): the `$3::inet` cast is PostgreSQL-only and applied only
    // there; flagged in the port report (the `ip_address` column needs a portable
    // form on MySQL/SQLite).
    let ip_placeholder = match db.backend() {
        Backend::Postgres => "$3::inet",
        _ => "$3",
    };
    let sql = format!(
        "INSERT INTO core.device_events
             (device_id, kind, ip_address, country, actor_id, actor_label, detail)
         VALUES ($1, $2, {ip_placeholder}, $4, $5, $6, $7)"
    );
    let result = db
        .execute(
            &sql,
            params![device_id, kind, ip, country, actor_id, actor_label, detail],
        )
        .await;

    if let Err(e) = result {
        tracing::error!(error = %e, device_id = %device_id, kind = %kind, "devices: writing a device event");
    }
}

/// Same, inside a caller-supplied transaction, so an administrative act and its
/// timeline line commit together.
#[allow(clippy::too_many_arguments)]
pub async fn record_event_tx(
    tx: &mut DbTx,
    device_id: Uuid,
    kind: &str,
    actor_id: Option<Uuid>,
    actor_label: Option<&str>,
    detail: Option<&str>,
) -> Result<(), AppError> {
    tx.execute(
        "INSERT INTO core.device_events (device_id, kind, actor_id, actor_label, detail)
         VALUES ($1, $2, $3, $4, $5)",
        params![device_id, kind, actor_id, actor_label, detail],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, device_id = %device_id, kind = %kind, "devices: device event (transaction)");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Attaches every session that predates the inventory to a device, by
/// fingerprint.
///
/// Runs once at startup and is cheap afterwards: it only ever looks at rows
/// where `device_id IS NULL`, and there are none after the first pass. Doing it
/// in Rust rather than in the migration is what lets it use the very same
/// normaliser as the live path - an SQL approximation of the parser would file
/// the same laptop under two different devices depending on which code touched
/// it first.
/// One row of the backfill scan: `(session, account, user agent, client, address)`.
type LegacySession = (Uuid, Uuid, Option<String>, Option<String>, Option<String>);

pub async fn backfill(db: &DbPool) -> Result<u64, AppError> {
    // `host(ip_address)` is spelled per engine (`Backend::inet_text`); `NOW()` is
    // replaced by a bound instant.
    let rows: Vec<LegacySession> = db
        .fetch_all_as::<LegacySession>(
            &format!(
                r#"SELECT id, user_id, user_agent, client_type, {ip}
             FROM core.refresh_tokens
            WHERE device_id IS NULL
              AND revoked_at IS NULL
              AND expires_at > $1
            ORDER BY created_at
            LIMIT 5000"#,
                ip = db.backend().inet_text("ip_address")
            ),
            params![Utc::now()],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "devices: reading sessions to attach");
            AppError::Database(e)
        })?;

    if rows.is_empty() {
        return Ok(0);
    }

    let mut attached = 0u64;
    for (session_id, user_id, ua, client_type, ip) in rows {
        let raw_ua = ua.unwrap_or_default();
        let normalised = user_agent::normalise(&raw_ua);
        let client = client_type.unwrap_or_else(|| "web".into());
        let key = fingerprint_key(user_id, &client, &normalised);
        let country = super::geoip::lookup_str(ip.as_deref());

        let touched = upsert(
            db,
            user_id,
            &key,
            &normalised,
            &raw_ua,
            &client,
            ip.as_deref(),
            country.as_deref(),
        )
        .await?;

        attach_session(
            db,
            session_id,
            touched.device_id,
            country.as_deref(),
            AuthStrength::Unknown,
        )
        .await?;
        attached += 1;
    }

    tracing::info!(sessions = attached, "Sessions existantes rattachées à un appareil");
    Ok(attached)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(ua: &str) -> Normalised {
        user_agent::normalise(ua)
    }

    const CHROME: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    const SAFARI: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15";

    #[test]
    fn a_native_device_key_wins_over_everything_else() {
        let user = Uuid::from_u128(1);
        let key = resolve(
            Some("abc123"),
            Some("kb_device=zzz"),
            user,
            "native",
            &norm(CHROME),
            true,
        );
        assert_eq!(key.kind, "key");
        assert_eq!(key.mint, None);
        // Same header ⇒ same row, whatever the cookie says.
        let again = resolve(Some("abc123"), None, user, "native", &norm(SAFARI), false);
        assert_eq!(key.hash(), again.hash());
    }

    #[test]
    fn an_existing_cookie_is_reused_and_nothing_is_minted() {
        let user = Uuid::from_u128(2);
        let key = resolve(None, Some("a=1; kb_device=opaque; b=2"), user, "web", &norm(CHROME), true);
        assert_eq!(key.kind, "key");
        assert_eq!(key.mint, None);
    }

    #[test]
    fn a_browser_without_a_cookie_gets_one_minted() {
        let user = Uuid::from_u128(3);
        let key = resolve(None, None, user, "web", &norm(CHROME), true);
        assert_eq!(key.kind, "key");
        let minted = key.mint.clone().expect("un cookie doit être émis");
        assert!(!minted.is_empty());
        // The cookie the browser will send back resolves to the same row.
        let next = resolve(
            None,
            Some(&format!("kb_device={minted}")),
            user,
            "web",
            &norm(CHROME),
            true,
        );
        assert_eq!(key.hash(), next.hash());
    }

    #[test]
    fn without_a_cookie_channel_the_fingerprint_is_the_fallback() {
        let user = Uuid::from_u128(4);
        let key = resolve(None, None, user, "api", &norm(CHROME), false);
        assert_eq!(key.kind, "fingerprint");
        assert_eq!(key.mint, None);
    }

    /// Two different machines of the same account must not be one row…
    #[test]
    fn the_fingerprint_separates_two_machines() {
        let user = Uuid::from_u128(5);
        let laptop = fingerprint_key(user, "web", &norm(SAFARI));
        let desktop = fingerprint_key(user, "web", &norm(CHROME));
        assert_ne!(laptop.hash(), desktop.hash());
    }

    /// …and the same machine used by two accounts must not be one row either:
    /// the inventory is a view of one account's exposure.
    #[test]
    fn the_fingerprint_separates_two_accounts() {
        let a = fingerprint_key(Uuid::from_u128(6), "web", &norm(CHROME));
        let b = fingerprint_key(Uuid::from_u128(7), "web", &norm(CHROME));
        assert_ne!(a.hash(), b.hash());
    }

    /// A browser update must not mint a new device.
    #[test]
    fn a_browser_update_keeps_the_same_fingerprint() {
        let user = Uuid::from_u128(8);
        let before = fingerprint_key(user, "web", &norm(CHROME));
        let after = fingerprint_key(
            user,
            "web",
            &norm("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
        );
        assert_eq!(before.hash(), after.hash());
    }

    /// The stored identifier is a hash: 64 hex characters, and none of the
    /// material is recoverable from it.
    #[test]
    fn only_a_hash_is_ever_stored() {
        let key = resolve(Some("secret-material"), None, Uuid::from_u128(9), "native", &norm(CHROME), false);
        let hash = key.hash();
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!hash.contains("secret-material"));
        // Nor does the only textual rendering the type offers.
        assert_eq!(key.to_string(), "DeviceKey(key)");
    }

    #[test]
    fn the_minted_cookie_is_http_only_and_scoped_to_the_whole_site() {
        let value = mint_cookie("abc", true);
        assert!(value.contains("HttpOnly"));
        assert!(value.contains("Secure"));
        assert!(value.contains("Path=/"));
        assert!(value.contains("SameSite=Lax"));
        assert!(!mint_cookie("abc", false).contains("Secure"));
    }
}
