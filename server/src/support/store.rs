//! Reading and writing the instance's identity and its support contract.
//!
//! Both tables hold exactly one row, guarded by a constant primary key
//! (migration `000120`), so every function here reads or writes *the* row and
//! none of them has to decide which one.

use chrono::{DateTime, Utc};
use kubuno_db::dialect::Assign;
use kubuno_db::{params, DbPool, DbTx};
use uuid::Uuid;

use super::{SupportKey, Trust};
use crate::errors::AppError;

/// What this installation is, independently of what it is called.
#[derive(Debug, Clone)]
pub struct InstanceIdentity {
    /// Minted locally at migration time. Opaque, and never transmitted anywhere
    /// by the product itself - see the module preamble.
    pub instance_id: Uuid,
    pub installed_at: DateTime<Utc>,
}

/// The registered contract, as the console shows it.
///
/// The pasted key itself is deliberately **absent** from this struct: nothing
/// outside [`recheck`] has any use for it, and a field that exists is a field
/// somebody eventually serialises.
#[derive(Debug, Clone)]
pub struct StoredContract {
    pub subject: String,
    pub plan: Option<String>,
    pub perimeter: Option<String>,
    pub contact: Option<String>,
    pub issued_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub registered_at: DateTime<Utc>,
    /// The verdict recorded when the key was registered. The console shows the
    /// verdict recomputed at read time instead (see [`recheck`]), so that a
    /// contract registered before the publisher's signing key shipped becomes
    /// verified on its own; this field is what the audit trail refers to.
    pub verified_at_registration: bool,
    pub key_id: Option<String>,
}

pub async fn identity(db: &DbPool) -> Result<InstanceIdentity, AppError> {
    let row = db
        .fetch_optional_row(
            "SELECT instance_id, installed_at FROM core.instance_identity WHERE only_row = TRUE",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "support: lecture de l'identité de l'instance");
            AppError::Database(e)
        })?;

    // The row is seeded by the migration that creates the table, so its absence
    // means a schema that was tampered with rather than a first run. Reported as
    // "not found" and not repaired here: a read path that silently re-mints an
    // identity would hand out a new one every time somebody looked at the page.
    let row = row.ok_or_else(|| {
        tracing::error!("support: aucune ligne d'identité d'instance");
        AppError::NotFound("Identité de l'instance".into())
    })?;

    Ok(InstanceIdentity {
        instance_id: row.try_get("instance_id").map_err(AppError::Database)?,
        installed_at: row.try_get("installed_at").map_err(AppError::Database)?,
    })
}

/// The registered contract, or `None` - the normal state of an instance.
pub async fn contract(db: &DbPool) -> Result<Option<StoredContract>, AppError> {
    let row = db
        .fetch_optional_row(
            "SELECT verified, key_id, subject, plan, perimeter, contact,
                    issued_at, expires_at, registered_at
               FROM core.support_contract WHERE only_row = TRUE",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "support: lecture du contrat");
            AppError::Database(e)
        })?;

    let Some(row) = row else { return Ok(None) };
    Ok(Some(StoredContract {
        subject: row.try_get("subject").map_err(AppError::Database)?,
        plan: row.try_get("plan").map_err(AppError::Database)?,
        perimeter: row.try_get("perimeter").map_err(AppError::Database)?,
        contact: row.try_get("contact").map_err(AppError::Database)?,
        issued_at: row.try_get("issued_at").map_err(AppError::Database)?,
        expires_at: row.try_get("expires_at").map_err(AppError::Database)?,
        registered_at: row.try_get("registered_at").map_err(AppError::Database)?,
        verified_at_registration: row.try_get("verified").map_err(AppError::Database)?,
        key_id: row.try_get("key_id").map_err(AppError::Database)?,
    }))
}

/// Re-reads the stored key and reports today's verdict on its signature.
///
/// This is what makes the trusted-key list retroactive: a contract registered
/// while [`super::trusted_signing_keys`] returned nothing starts verifying the day a
/// key is added, without asking the operator for anything.
///
/// Returns `Ok(None)` when there is no contract. A key that no longer parses at
/// all is reported as declarative rather than as an error: the page must keep
/// working, and the stored claims are still what the operator registered.
pub async fn recheck(db: &DbPool, instance_id: &Uuid) -> Result<Option<Trust>, AppError> {
    let stored: Option<String> = db
        .fetch_optional_scalar::<String>(
            "SELECT key_text FROM core.support_contract WHERE only_row = TRUE",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "support: relecture de la clé");
            AppError::Database(e)
        })?;

    let Some(key_text) = stored else { return Ok(None) };
    // Never logged, never returned: only its verdict leaves this function.
    match super::read_key(&key_text, &instance_id.to_string()) {
        Ok(SupportKey { trust, .. }) => Ok(Some(trust)),
        Err(_) => Ok(Some(Trust::Declarative)),
    }
}

/// Writes the contract, replacing any previous one.
///
/// Takes a connection rather than the pool so the caller can run it inside the
/// audited transaction: the contract and the trail entry land in the same
/// `COMMIT`, or neither does.
pub async fn register(
    conn: &mut DbTx,
    key_text: &str,
    key: &SupportKey,
    actor: Uuid,
) -> Result<(), AppError> {
    // `NOW()` becomes a bound timestamp; the `ON CONFLICT` clause is spelled per
    // engine by `dialect::upsert` (`registered_at` folds to the incoming value,
    // which is the same `now`).
    let backend = conn.backend();
    let now = Utc::now();
    let clause = backend.upsert(
        "core.support_contract",
        &["only_row"],
        &[
            Assign::Incoming("key_text"),
            Assign::Incoming("verified"),
            Assign::Incoming("key_id"),
            Assign::Incoming("subject"),
            Assign::Incoming("plan"),
            Assign::Incoming("perimeter"),
            Assign::Incoming("contact"),
            Assign::Incoming("issued_at"),
            Assign::Incoming("expires_at"),
            Assign::Incoming("registered_at"),
            Assign::Incoming("registered_by"),
        ],
    );
    let sql = format!(
        "INSERT INTO core.support_contract \
             (only_row, key_text, verified, key_id, subject, plan, perimeter, contact, \
              issued_at, expires_at, registered_at, registered_by) \
         VALUES (TRUE, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11){clause}"
    );
    conn.execute(
        &sql,
        params![
            key_text,
            key.is_verified(),
            key.key_id(),
            key.claims.sub.trim(),
            key.claims.plan.as_deref().map(str::trim),
            key.claims.perimeter.as_deref().map(str::trim),
            key.claims.contact.as_deref().map(str::trim),
            key.issued_at(),
            key.expires_at(),
            now,
            actor
        ],
    )
    .await
    .map_err(|e| {
        // The key never appears in the message: an error that echoed the input
        // would put the contract proof in the log.
        tracing::error!(error = %e, "support: enregistrement du contrat");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Removes the contract. `false` when there was none - the caller turns that
/// into a 404 rather than an audited no-op.
pub async fn remove(conn: &mut DbTx) -> Result<bool, AppError> {
    let affected = conn
        .execute("DELETE FROM core.support_contract WHERE only_row = TRUE", params![])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "support: retrait du contrat");
            AppError::Database(e)
        })?;
    Ok(affected > 0)
}
