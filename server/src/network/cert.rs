//! Certificate material: parsing its metadata, validating a chain+key pair, and
//! persisting it.
//!
//! No cryptography lives here. Validation is delegated to rustls (building a
//! `ServerConfig` fails unless the chain and key are usable and match), and
//! metadata extraction to `x509-parser`. This module only moves bytes between
//! the console and the database.

use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;
use x509_parser::prelude::*;

use kubuno_db::{new_id, params, DbPool, DbTx};

use crate::errors::AppError;

use super::config;

/// A certificate row as the console sees it - never the private key.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct StoredCert {
    pub id: Uuid,
    pub source: String,
    pub subject: Option<String>,
    pub issuer: Option<String>,
    // The SAN list is stored as a JSON array so it reads the same on every
    // engine (Postgres `TEXT[]` is not portable).
    #[sqlx(json)]
    pub san: Vec<String>,
    pub not_before: Option<DateTime<Utc>>,
    pub not_after: Option<DateTime<Utc>>,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
}

/// The column list shared by every read of `core.tls_certificates`.
const CERT_COLS: &str =
    "id, source, subject, issuer, san, not_before, not_after, is_active, created_at";

/// Metadata parsed from the leaf certificate of a chain.
struct CertMeta {
    subject: Option<String>,
    issuer: Option<String>,
    san: Vec<String>,
    not_before: Option<DateTime<Utc>>,
    not_after: Option<DateTime<Utc>>,
}

/// Parses the leaf certificate (first PEM block) for its human-facing metadata.
fn parse_metadata(cert_pem: &[u8]) -> Result<CertMeta, AppError> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(cert_pem).map_err(|_| {
        AppError::Validation("Unreadable certificate: the PEM does not contain a valid CERTIFICATE block".into())
    })?;
    let cert = pem
        .parse_x509()
        .map_err(|_| AppError::Validation("Certificat X.509 illisible".into()))?;

    let cn_of = |name: &X509Name| -> Option<String> {
        name.iter_common_name()
            .next()
            .and_then(|a| a.as_str().ok())
            .map(str::to_string)
    };

    let subject = cn_of(cert.subject()).or_else(|| Some(cert.subject().to_string()));
    let issuer = cn_of(cert.issuer()).or_else(|| Some(cert.issuer().to_string()));

    let mut san = Vec::new();
    if let Ok(Some(ext)) = cert.subject_alternative_name() {
        for gn in &ext.value.general_names {
            if let GeneralName::DNSName(d) = gn {
                san.push(d.to_string());
            }
        }
    }

    let to_dt = |ts: i64| DateTime::<Utc>::from_timestamp(ts, 0);
    let not_before = to_dt(cert.validity().not_before.timestamp());
    let not_after = to_dt(cert.validity().not_after.timestamp());

    Ok(CertMeta {
        subject,
        issuer,
        san,
        not_before,
        not_after,
    })
}

/// Stores `cert_pem` + `key_pem` as the new active certificate, deactivating any
/// previous one. Atomicity is the caller's transaction (`tx`): the console
/// upload runs it inside the audited transaction, so a crash between the two
/// writes never leaves two active - or zero - certificates behind.
///
/// The pair is validated first (rustls refuses a mismatched or unusable pair)
/// and its metadata parsed for display. **The key material is written to disk**
/// (`super::store`), never to the database: the row holds subject, SAN and
/// validity, none of which is a secret.
pub async fn store_active(
    tx: &mut DbTx,
    paths: &super::store::Paths,
    source: &str,
    cert_pem: &str,
    key_pem: &str,
    uploaded_by: Option<Uuid>,
) -> Result<StoredCert, AppError> {
    // Validation: if rustls can build a server config from the pair, it is a
    // usable, matching chain+key. This is the same code path that will serve it.
    super::runtime::build_server_config(
        cert_pem.as_bytes(),
        key_pem.as_bytes(),
        config::TlsMinVersion::V1_2,
    )?;

    let meta = parse_metadata(cert_pem.as_bytes())?;

    // Disk first: if the material cannot be written there is nothing to record,
    // and the transaction the caller opened is simply dropped. The reverse order
    // would leave a row claiming a certificate the server cannot serve.
    super::store::write_material(paths, cert_pem, key_pem)?;

    // The previous certificate is retired. Only its metadata survives - the key
    // material it referred to has just been overwritten on disk, and there is no
    // rollback path that would want an old key back.
    tx.execute(
        "UPDATE core.tls_certificates SET is_active = FALSE WHERE is_active = TRUE",
        params![],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "network: deactivating the previous certificates");
        AppError::Database(e)
    })?;

    // Bounded history. An ACME renewal lands here every ~60 days for the life of
    // the instance; without a ceiling the table grows without end. The kept set
    // is a derived table (`kept`): MySQL/MariaDB reject `LIMIT` directly inside
    // `IN (...)` and a subquery on the table being deleted from.
    tx.execute(
        "DELETE FROM core.tls_certificates WHERE is_active = FALSE AND id NOT IN ( \
             SELECT id FROM ( \
                 SELECT id FROM core.tls_certificates WHERE is_active = FALSE \
                 ORDER BY created_at DESC LIMIT 20 \
             ) kept )",
        params![],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "network: pruning the certificate history");
        AppError::Database(e)
    })?;

    // The key is generated by the process (no RETURNING / DB-side default) and
    // the timestamp is bound from Rust, so the whole row is known without a
    // read-back inside the transaction.
    let id = new_id();
    let created_at = Utc::now();
    tx.execute(
        "INSERT INTO core.tls_certificates \
             (id, source, subject, issuer, san, not_before, not_after, is_active, uploaded_by, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9)",
        params![
            id,
            source,
            meta.subject.clone(),
            meta.issuer.clone(),
            meta.san.clone(),
            meta.not_before,
            meta.not_after,
            uploaded_by,
            created_at
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "network: inserting the certificate");
        AppError::Database(e)
    })?;

    Ok(StoredCert {
        id,
        source: source.to_string(),
        subject: meta.subject,
        issuer: meta.issuer,
        san: meta.san,
        not_before: meta.not_before,
        not_after: meta.not_after,
        is_active: true,
        created_at,
    })
}

/// Every stored certificate, newest first - the active one and the retired ones
/// whose metadata is kept for the history (their keys are already destroyed).
pub async fn list(db: &DbPool) -> Result<Vec<StoredCert>, AppError> {
    db.fetch_all_as::<StoredCert>(
        &format!(
            "SELECT {CERT_COLS} \
             FROM core.tls_certificates ORDER BY is_active DESC, created_at DESC"
        ),
        params![],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "network: listing the certificates");
        AppError::Database(e)
    })
}

/// Deletes one certificate, key material included.
///
/// Refuses to delete the ACTIVE certificate while HTTPS is switched on: that
/// would leave the instance configured to serve TLS with nothing to serve it
/// with, and the failure would only appear at the next restart - as an instance
/// that silently fell back to plain HTTP. Turning HTTPS off first is an explicit
/// act; this keeps it from happening by accident.
pub async fn delete(
    db: &DbPool,
    paths: &super::store::Paths,
    id: Uuid,
    https_enabled: bool,
) -> Result<StoredCert, AppError> {
    let cert = db
        .fetch_optional_as::<StoredCert>(
            &format!("SELECT {CERT_COLS} FROM core.tls_certificates WHERE id = $1"),
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "network: reading the certificate to delete");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Certificate not found".into()))?;

    if cert.is_active && https_enabled {
        return Err(AppError::Validation(
            "HTTPS is serving this certificate. Disable HTTPS first or install another certificate in its place"
                .into(),
        ));
    }

    db.execute(
        "DELETE FROM core.tls_certificates WHERE id = $1",
        params![id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "network: deleting the certificate");
        AppError::Database(e)
    })?;

    // Only the ACTIVE row owns the files on disk; a retired row is metadata for
    // a certificate whose material was overwritten when it was replaced.
    if cert.is_active {
        super::store::delete_material(paths)?;
    }

    Ok(cert)
}

/// The active certificate's metadata, or `None` when the instance holds none.
pub async fn active(db: &DbPool) -> Result<Option<StoredCert>, AppError> {
    db.fetch_optional_as::<StoredCert>(
        &format!("SELECT {CERT_COLS} FROM core.tls_certificates WHERE is_active = TRUE"),
        params![],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "network: reading the active certificate");
        AppError::Database(e)
    })
}

/// The usable material (chain PEM + private key PEM) the server binds or
/// reloads, read from disk. `None` when the instance holds none.
///
/// Deliberately does not consult the database: the files are the material, and a
/// row that disagreed with them would be a second source of truth for the one
/// thing that must have only one.
pub fn active_material(paths: &super::store::Paths) -> Option<(String, String)> {
    super::store::read_material(paths)
}
