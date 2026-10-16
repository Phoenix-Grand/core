//! Tamper-evidence for the administrative trail: a per-row HMAC hash chain.
//!
//! # What this adds
//!
//! Each row carries `row_hash = HMAC(K, canonical(row) ‖ prev_hash)`, where
//! `prev_hash` is the previous row's `row_hash` (the genesis predecessor is 32
//! zero bytes). Any edit to a recorded row, any reordering, and any deletion of
//! a row in the middle of the chain breaks the link at that point and is caught
//! by [`verify_chain`]. Combined with the append-only trigger on the table
//! (migration `000127`), the trail can no longer be altered in place through the
//! application role without detection.
//!
//! # The key, and its limit
//!
//! `K` is derived from `server.internal_secret` with HKDF-SHA256 (RFC 5869) and
//! never stored in the database - so an actor with SQL access but not the secret
//! cannot forge a valid chain. This is the honest boundary of the scheme: an
//! attacker holding **both** the database and the internal secret could recompute
//! the whole chain. Defending against that requires anchoring the head hash
//! outside the database (an RFC 3161 timestamp, an external witness); that
//! anchoring is future work and is documented as such. What this delivers today
//! is detection of tampering by anyone who does not also hold the secret - which
//! covers the DBA-only and SQL-injection threat models that matter most.
//!
//! Design confirmed against RFC 2104 (HMAC), RFC 5869 (HKDF) and the
//! tamper-evident-log literature (hash chaining; RFC 9162 for the Merkle variant
//! we deliberately do not need here).

use std::sync::OnceLock;

use chrono::{DateTime, Utc};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use kubuno_db::{params, DbPool};
use sha2::Sha256;
use uuid::Uuid;

use super::model::{AuditContext, AuditEntry};

type HmacSha256 = Hmac<Sha256>;

/// The genesis predecessor: the `prev_hash` of the very first chained row.
pub const GENESIS: [u8; 32] = [0u8; 32];

/// Advisory-lock key serialising chain appends: two concurrent writers must not
/// read the same tip and both append to it. Any fixed value works.
pub const CHAIN_LOCK: i64 = 0x0000_4B42_4155_4441; // "KBAUDA"

const HKDF_INFO: &[u8] = b"kubuno:v1:core:audit-hmac";

static AUDIT_KEY: OnceLock<[u8; 32]> = OnceLock::new();

/// Derive and install the audit chain key from the internal secret. Called once
/// at bootstrap. Idempotent; a second call is ignored.
pub fn init_audit_key(internal_secret: &str) {
    let hk = Hkdf::<Sha256>::new(None, internal_secret.as_bytes());
    let mut key = [0u8; 32];
    if hk.expand(HKDF_INFO, &mut key).is_err() {
        key = [0u8; 32];
    }
    let _ = AUDIT_KEY.set(key);
}

/// The installed key, or `None` when [`init_audit_key`] has not run (unit tests,
/// tools). Writers then skip chaining and leave the hash columns NULL.
pub fn audit_key() -> Option<&'static [u8; 32]> {
    AUDIT_KEY.get()
}

/// The immutable, hashed content of a row. Deliberately excludes the two undo
/// back-links (`reverts_entry_id`, `reverted_by_entry_id`): they are written or
/// nulled after the fact (an undo, or a retention `ON DELETE SET NULL`), which
/// the append-only trigger allows precisely because they are not part of this.
pub struct CanonFields<'a> {
    pub occurred_at: DateTime<Utc>,
    pub actor_id: Option<Uuid>,
    pub actor_label: &'a str,
    pub actor_role: Option<&'a str>,
    pub actor_origin: &'a str,
    pub actor_token_id: Option<Uuid>,
    pub ip_address: Option<&'a str>,
    pub user_agent: Option<&'a str>,
    pub action: &'a str,
    pub module_id: Option<&'a str>,
    pub target_type: Option<&'a str>,
    pub target_id: Option<&'a str>,
    pub target_label: Option<&'a str>,
    pub before: Option<&'a serde_json::Value>,
    pub after: Option<&'a serde_json::Value>,
    pub outcome: &'a str,
    pub detail: Option<&'a str>,
    pub reversible: bool,
}

/// Append one optional field, length-prefixed and presence-tagged, so no two
/// distinct field sequences can produce the same byte string.
fn put(buf: &mut Vec<u8>, v: Option<&[u8]>) {
    match v {
        None => buf.push(0),
        Some(b) => {
            buf.push(1);
            buf.extend_from_slice(&(b.len() as u32).to_le_bytes());
            buf.extend_from_slice(b);
        }
    }
}

/// The canonical byte encoding hashed for a row. Order is fixed and every field
/// is unambiguously delimited; both the writer and [`verify_chain`] build it the
/// same way.
pub fn canonical(f: &CanonFields) -> Vec<u8> {
    let mut b = Vec::with_capacity(256);
    put(&mut b, Some(&f.occurred_at.timestamp_micros().to_le_bytes()));
    let actor_id = f.actor_id.map(|u| u.into_bytes());
    put(&mut b, actor_id.as_ref().map(|a| a.as_slice()));
    put(&mut b, Some(f.actor_label.as_bytes()));
    put(&mut b, f.actor_role.map(str::as_bytes));
    put(&mut b, Some(f.actor_origin.as_bytes()));
    let token_id = f.actor_token_id.map(|u| u.into_bytes());
    put(&mut b, token_id.as_ref().map(|a| a.as_slice()));
    put(&mut b, f.ip_address.map(str::as_bytes));
    put(&mut b, f.user_agent.map(str::as_bytes));
    put(&mut b, Some(f.action.as_bytes()));
    put(&mut b, f.module_id.map(str::as_bytes));
    put(&mut b, f.target_type.map(str::as_bytes));
    put(&mut b, f.target_id.map(str::as_bytes));
    put(&mut b, f.target_label.map(str::as_bytes));
    let before = f.before.map(|v| serde_json::to_vec(v).unwrap_or_default());
    put(&mut b, before.as_deref());
    let after = f.after.map(|v| serde_json::to_vec(v).unwrap_or_default());
    put(&mut b, after.as_deref());
    put(&mut b, Some(f.outcome.as_bytes()));
    put(&mut b, f.detail.map(str::as_bytes));
    b.push(if f.reversible { 1 } else { 0 });
    b
}

/// `HMAC-SHA256(key, canonical ‖ prev_hash)` - the row's chain hash.
pub fn row_hash(key: &[u8; 32], canonical: &[u8], prev_hash: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(canonical);
    mac.update(prev_hash);
    mac.finalize().into_bytes().to_vec()
}

/// Build the canonical fields from a live write (`ctx` + `entry`).
pub fn canonical_of_write<'a>(
    ctx: &'a AuditContext,
    entry: &'a AuditEntry,
    occurred_at: DateTime<Utc>,
    ip_owned: Option<&'a str>,
) -> CanonFields<'a> {
    CanonFields {
        occurred_at,
        actor_id: ctx.actor.id,
        actor_label: &ctx.actor.label,
        actor_role: ctx.actor.role.as_deref(),
        actor_origin: ctx.actor.origin.as_str(),
        actor_token_id: ctx.actor.token_id,
        ip_address: ip_owned,
        user_agent: ctx.user_agent.as_deref(),
        action: &entry.action,
        module_id: entry.module_id.as_deref(),
        target_type: entry.target.kind.as_deref(),
        target_id: entry.target.id.as_deref(),
        target_label: entry.target.label.as_deref(),
        before: entry.before.as_ref(),
        after: entry.after.as_ref(),
        outcome: entry.outcome.as_str(),
        detail: entry.detail.as_deref(),
        reversible: entry.reversible,
    }
}

/// One chained row as read back for verification. `ip_text` is the text form of
/// the stored address (`host(ip_address)` on PostgreSQL), matching what was
/// hashed at write time.
#[derive(sqlx::FromRow)]
struct RawChainRow {
    id: i64,
    occurred_at: DateTime<Utc>,
    actor_id: Option<Uuid>,
    actor_label: String,
    actor_role: Option<String>,
    actor_origin: String,
    actor_token_id: Option<Uuid>,
    ip_text: Option<String>,
    user_agent: Option<String>,
    action: String,
    module_id: Option<String>,
    target_type: Option<String>,
    target_id: Option<String>,
    target_label: Option<String>,
    before: Option<serde_json::Value>,
    after: Option<serde_json::Value>,
    outcome: String,
    detail: Option<String>,
    reversible: bool,
    prev_hash: Vec<u8>,
    row_hash: Vec<u8>,
}

/// Outcome of a full-chain verification.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ChainReport {
    /// Chained rows examined.
    pub checked: i64,
    /// True when every examined row verified and linked correctly.
    pub ok: bool,
    /// The id of the first row that failed, if any.
    pub first_broken_id: Option<i64>,
    /// A short machine reason for the break (`content`, `link`), if any.
    pub reason: Option<String>,
}

/// Recompute the chain and report the first break. Reads the chained rows
/// (`row_hash IS NOT NULL`) oldest-first; rows written before the feature existed
/// (NULL hash) are outside the chain and skipped.
pub async fn verify_chain(db: &DbPool) -> Result<ChainReport, sqlx::Error> {
    let Some(key) = audit_key() else {
        return Ok(ChainReport {
            checked: 0,
            ok: false,
            first_broken_id: None,
            reason: Some("audit key not initialised".into()),
        });
    };

    // The chain reproduces the exact text hashed at write time. `host(ip_address)`
    // is spelled per engine (`Backend::inet_text`); `"before"`/`"after"` are
    // reserved words quoted for MySQL (harmless identifiers on the others).
    let rows = db
        .fetch_all_as::<RawChainRow>(
            &format!(
                r#"SELECT id, occurred_at, actor_id, actor_label, actor_role, actor_origin,
                      actor_token_id, {ip} AS ip_text, user_agent,
                      action, module_id, target_type, target_id, target_label,
                      "before", "after", outcome, detail, reversible, prev_hash, row_hash
                 FROM core.admin_audit
                WHERE row_hash IS NOT NULL
                ORDER BY id ASC"#,
                ip = db.backend().inet_text("ip_address")
            ),
            params![],
        )
        .await?;

    let mut prev: Vec<u8> = GENESIS.to_vec();
    let mut checked = 0i64;
    for r in &rows {
        let id = r.id;
        let stored_prev = &r.prev_hash;
        let stored_hash = &r.row_hash;

        let fields = CanonFields {
            occurred_at: r.occurred_at,
            actor_id: r.actor_id,
            actor_label: &r.actor_label,
            actor_role: r.actor_role.as_deref(),
            actor_origin: &r.actor_origin,
            actor_token_id: r.actor_token_id,
            ip_address: r.ip_text.as_deref(),
            user_agent: r.user_agent.as_deref(),
            action: &r.action,
            module_id: r.module_id.as_deref(),
            target_type: r.target_type.as_deref(),
            target_id: r.target_id.as_deref(),
            target_label: r.target_label.as_deref(),
            before: r.before.as_ref(),
            after: r.after.as_ref(),
            outcome: &r.outcome,
            detail: r.detail.as_deref(),
            reversible: r.reversible,
        };

        if *stored_prev != prev {
            return Ok(ChainReport {
                checked,
                ok: false,
                first_broken_id: Some(id),
                reason: Some("link".into()),
            });
        }
        let expected = row_hash(key, &canonical(&fields), &prev);
        if &expected != stored_hash {
            return Ok(ChainReport {
                checked,
                ok: false,
                first_broken_id: Some(id),
                reason: Some("content".into()),
            });
        }
        prev = stored_hash.clone();
        checked += 1;
    }

    Ok(ChainReport {
        checked,
        ok: true,
        first_broken_id: None,
        reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields<'a>(action: &'a str, label: &'a str) -> CanonFields<'a> {
        CanonFields {
            occurred_at: DateTime::from_timestamp(1_700_000_000, 0).expect("ts"),
            actor_id: None,
            actor_label: label,
            actor_role: Some("admin"),
            actor_origin: "session",
            actor_token_id: None,
            ip_address: Some("127.0.0.1"),
            user_agent: None,
            action,
            module_id: Some("core"),
            target_type: Some("user"),
            target_id: Some("42"),
            target_label: None,
            before: None,
            after: None,
            outcome: "success",
            detail: None,
            reversible: false,
        }
    }

    #[test]
    fn canonical_is_deterministic() {
        let f = fields("core.users.update", "alice");
        assert_eq!(canonical(&f), canonical(&f));
    }

    #[test]
    fn distinct_content_distinct_hash() {
        let key = [7u8; 32];
        let a = row_hash(&key, &canonical(&fields("a", "x")), &GENESIS);
        let b = row_hash(&key, &canonical(&fields("b", "x")), &GENESIS);
        assert_ne!(a, b);
    }

    #[test]
    fn same_content_different_prev_differs() {
        let key = [7u8; 32];
        let c = canonical(&fields("a", "x"));
        let h1 = row_hash(&key, &c, &GENESIS);
        let h2 = row_hash(&key, &c, &h1);
        assert_ne!(h1, h2);
    }
}
