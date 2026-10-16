//! Reading and writing the registry, and the four rules that make it a model
//! rather than a list of strings.
//!
//!   1. **Exactly one primary.** Held by a unique index, swapped in one
//!      transaction, never by two statements a crash could interleave.
//!   2. **A promotion, not a creation.** A domain becomes primary only if it is
//!      already declared *and* verified - the same order the reference imposes,
//!      and for the same reason: the instance's own name is the one thing that
//!      must never be a claim.
//!   3. **An alias hangs off a real domain.** Its parent is the primary or a
//!      secondary, never another alias: an alias of an alias is a chain nobody
//!      can read and every consumer would have to walk.
//!   4. **Nothing is removed out from under an account.** A domain carrying
//!      addresses refuses to go until they are moved, and says how many.

use chrono::{DateTime, Utc};
use kubuno_db::{new_id, params, DbPool, DbTx};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

use super::dns;
use super::model::{Domain, DomainKind};
use crate::errors::AppError;

/// Columns every read shares, account count included.
///
/// Built per engine because the account-count subquery splits an address on its
/// `@`, which has no single spelling across the three engines: the portable
/// [`kubuno_db::dialect::Backend::email_domain`] produces `SPLIT_PART` on
/// PostgreSQL, `SUBSTRING_INDEX` on MySQL and `substr`/`instr` on SQLite. The
/// `COUNT(*)` scalar subquery already decodes as `i64` on every engine, so the
/// old `::bigint` cast is dropped. Every other token is a fixed identifier, so
/// the assembled text still carries no request data.
fn select_domains(backend: kubuno_db::dialect::Backend, suffix: &str) -> String {
    let domain = backend.email_domain("u.email");
    format!(
        r#"
    SELECT d.id, d.name, d.kind, d.parent_id, p.name AS parent_name,
           d.verify_token, d.verified_at, d.last_checked_at, d.last_error,
           d.mx_hosts, d.has_spf, d.has_dmarc, d.mail_checked_at, d.created_at,
           (SELECT COUNT(*) FROM core.users u
             WHERE LOWER({domain}) = d.name) AS account_count
      FROM core.domains d
      LEFT JOIN core.domains p ON p.id = d.parent_id
{suffix}"#
    )
}

/// The raw columns of a [`select_domains`] read. `Domain` carries a parsed
/// `DomainKind`, so no `FromRow` builds it directly.
#[derive(Debug, FromRow)]
struct DomainRow {
    id: Uuid,
    name: String,
    kind: String,
    parent_id: Option<Uuid>,
    parent_name: Option<String>,
    verify_token: String,
    verified_at: Option<DateTime<Utc>>,
    last_checked_at: Option<DateTime<Utc>>,
    last_error: Option<String>,
    mx_hosts: Value,
    has_spf: Option<bool>,
    has_dmarc: Option<bool>,
    mail_checked_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    account_count: i64,
}

impl DomainRow {
    fn into_domain(self) -> Result<Domain, AppError> {
        Ok(Domain {
            id: self.id,
            name: self.name,
            kind: DomainKind::parse(&self.kind)?,
            parent_id: self.parent_id,
            parent_name: self.parent_name,
            verify_token: self.verify_token,
            verified_at: self.verified_at,
            last_checked_at: self.last_checked_at,
            last_error: self.last_error,
            mx_hosts: self.mx_hosts,
            has_spf: self.has_spf,
            has_dmarc: self.has_dmarc,
            mail_checked_at: self.mail_checked_at,
            created_at: self.created_at,
            account_count: self.account_count,
        })
    }
}

/// Every domain, the primary first, then aliases grouped under the domain they
/// serve - the order the console renders without having to sort.
pub async fn list(db: &DbPool) -> Result<Vec<Domain>, AppError> {
    let sql = select_domains(
        db.backend(),
        " ORDER BY (d.kind = 'primary') DESC, COALESCE(p.name, d.name), d.kind, d.name",
    );
    let rows = db
        .fetch_all_as::<DomainRow>(&sql, params![])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "domains: liste");
            AppError::Database(e)
        })?;
    rows.into_iter().map(DomainRow::into_domain).collect()
}

pub async fn get(db: &DbPool, id: Uuid) -> Result<Domain, AppError> {
    let sql = select_domains(db.backend(), " WHERE d.id = $1");
    db.fetch_optional_as::<DomainRow>(&sql, params![id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "domains: lecture");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Domaine introuvable".into()))?
        .into_domain()
}

/// Is `name` a domain this instance has *proven* it controls?
///
/// The question every consumer asks, and the reason the registry exists. An
/// alias answers yes: an address at an alias is an address of this instance.
pub async fn is_verified(db: &DbPool, name: &str) -> bool {
    match db
        .fetch_scalar::<bool>(
            "SELECT EXISTS(SELECT 1 FROM core.domains WHERE name = $1 AND verified_at IS NOT NULL)",
            params![name.trim().to_ascii_lowercase()],
        )
        .await
    {
        Ok(found) => found,
        Err(e) => {
            // Never fatal, and never a silent "yes": a caller that cannot read
            // the registry must not be told the domain is fine.
            tracing::error!(error = %e, "domains: vérification d'appartenance");
            false
        }
    }
}

/// The verified names, for a picker.
pub async fn verified_names(db: &DbPool) -> Vec<String> {
    match db
        .fetch_all_as::<(String,)>(
            "SELECT name FROM core.domains WHERE verified_at IS NOT NULL \
          ORDER BY (kind = 'primary') DESC, name",
            params![],
        )
        .await
    {
        Ok(rows) => rows.into_iter().map(|(name,)| name).collect(),
        Err(e) => {
            tracing::error!(error = %e, "domains: liste des domaines vérifiés");
            Vec::new()
        }
    }
}

/// Declares a domain. Secondary or alias only - the primary is never created,
/// it is promoted (see [`promote`]).
pub async fn create(
    tx: &mut DbTx,
    name: &str,
    kind: DomainKind,
    parent_id: Option<Uuid>,
    actor: Uuid,
) -> Result<Uuid, AppError> {
    if kind == DomainKind::Primary {
        return Err(AppError::Validation(
            "Le domaine principal ne se crée pas : ajoutez le domaine, vérifiez-le, puis promouvez-le.".into(),
        ));
    }

    // An alias hangs off a real domain, and off one that is itself proven:
    // lending addresses from a name nobody has verified would launder the very
    // claim the registry exists to check.
    if kind == DomainKind::Alias {
        let parent_id = parent_id.ok_or_else(|| {
            AppError::Validation("Un alias doit désigner le domaine dont il reprend les adresses.".into())
        })?;
        let parent = tx
            .fetch_optional_row(
                "SELECT kind, verified_at FROM core.domains WHERE id = $1",
                params![parent_id],
            )
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::Validation("Le domaine désigné n'existe pas.".into()))?;
        let parent_kind: String = parent.try_get("kind").map_err(AppError::Database)?;
        if parent_kind == "alias" {
            return Err(AppError::Validation(
                "Un alias ne peut pas désigner un autre alias : rattachez-le au domaine d'origine.".into(),
            ));
        }
        let parent_verified: Option<DateTime<Utc>> =
            parent.try_get("verified_at").map_err(AppError::Database)?;
        if parent_verified.is_none() {
            return Err(AppError::Validation(
                "Vérifiez d'abord le domaine dont cet alias reprend les adresses.".into(),
            ));
        }
    } else if parent_id.is_some() {
        return Err(AppError::Validation(
            "Seul un alias désigne un domaine d'origine.".into(),
        ));
    }

    // The raw half of a CSPRNG token, kept alphanumeric: it is pasted by hand
    // into a registrar's form, and `-`/`_` are exactly the characters people
    // lose when they retype it. Thirty-two characters is far past guessing.
    let (raw, _hash) = crate::crypto::token::generate_token();
    let token: String = raw.chars().filter(|c| c.is_ascii_alphanumeric()).take(32).collect();

    // The id is generated in Rust (no `RETURNING` on MySQL) and returned directly.
    let id = new_id();
    tx.execute(
        "INSERT INTO core.domains (id, name, kind, parent_id, verify_token, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6)",
        params![id, name, kind.as_str(), parent_id, &token, actor],
    )
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(db) = &e {
            if db.is_unique_violation() {
                return AppError::Conflict(format!("Le domaine « {name} » est déjà déclaré ici."));
            }
        }
        tracing::error!(error = %e, domain = %name, "domains: création");
        AppError::Database(e)
    })?;
    Ok(id)
}

/// Runs the ownership probe and records what it saw.
///
/// Idempotent and re-runnable: an administrator who publishes the record ten
/// minutes later presses the same button, and a domain that was verified stays
/// verified even if a later probe fails - a registrar hiccup must not silently
/// un-own a domain that accounts already depend on.
pub async fn verify(db: &DbPool, id: Uuid) -> Result<Domain, AppError> {
    let domain = get(db, id).await?;
    let probe = dns::check_verification(&domain.name, &domain.verify_token).await;

    match probe {
        Ok(result) if result.found => {
            // `NOW()` bound from Rust; placeholders ascending (SET then WHERE).
            let now = Utc::now();
            db.execute(
                "UPDATE core.domains \
                    SET verified_at = COALESCE(verified_at, $1), last_checked_at = $2, last_error = NULL \
                  WHERE id = $3",
                params![now, now, id],
            )
            .await
            .map_err(AppError::Database)?;
        }
        Ok(result) => {
            let mut message = "L'enregistrement TXT attendu n'a pas été trouvé sur ce domaine.".to_string();
            if !result.others.is_empty() {
                // The near-miss worth naming: a token from another instance, or
                // one published on the wrong name.
                message.push_str(&format!(
                    " D'autres jetons de vérification sont publiés : {}.",
                    result.others.join(", ")
                ));
            }
            record_failure(db, id, &message).await?;
        }
        Err(e) => record_failure(db, id, &e.message()).await?,
    }

    get(db, id).await
}

async fn record_failure(db: &DbPool, id: Uuid, message: &str) -> Result<(), AppError> {
    // `NOW()` bound from Rust; placeholders ascending (SET then WHERE).
    db.execute(
        "UPDATE core.domains SET last_checked_at = $1, last_error = $2 WHERE id = $3",
        params![Utc::now(), message, id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "domains: enregistrement de l'échec de vérification");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Refreshes the mail diagnosis of one domain.
pub async fn refresh_mail(db: &DbPool, id: Uuid) -> Result<Domain, AppError> {
    let domain = get(db, id).await?;
    let probe = dns::probe_mail(&domain.name).await;

    // A probe that could not run leaves the previous answer in place rather than
    // overwriting a real diagnosis with three falses.
    if probe.error.is_none() {
        // `NOW()` bound from Rust; placeholders ascending (SET then WHERE).
        db.execute(
            "UPDATE core.domains SET mx_hosts = $1, has_spf = $2, has_dmarc = $3, mail_checked_at = $4 \
              WHERE id = $5",
            params![json!(probe.mx), probe.spf, probe.dmarc, Utc::now(), id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "domains: enregistrement du diagnostic de messagerie");
            AppError::Database(e)
        })?;
    }
    get(db, id).await
}

/// Promotes a verified secondary domain to primary, demoting the current one.
///
/// One transaction, because the unique index means the intermediate state - two
/// primaries, or none - cannot be allowed to exist even for a statement.
pub async fn promote(tx: &mut DbTx, id: Uuid) -> Result<(String, Option<String>), AppError> {
    // The row lock is spelled per engine via `Backend::for_update` (empty on
    // SQLite, whose writes are already serialized).
    let for_update = tx.backend().for_update();
    let row = tx
        .fetch_optional_row(
            &format!(
                "SELECT name, kind, verified_at FROM core.domains WHERE id = $1{}",
                for_update
            ),
            params![id],
        )
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound("Domaine introuvable".into()))?;

    let name: String = row.try_get("name").map_err(AppError::Database)?;
    let kind: String = row.try_get("kind").map_err(AppError::Database)?;
    match kind.as_str() {
        "primary" => {
            return Err(AppError::Validation(format!(
                "« {name} » est déjà le domaine principal."
            )))
        }
        "alias" => {
            return Err(AppError::Validation(
                "Un alias ne peut pas devenir le domaine principal : il ne porte aucun compte.".into(),
            ))
        }
        _ => {}
    }
    let verified_at: Option<DateTime<Utc>> =
        row.try_get("verified_at").map_err(AppError::Database)?;
    if verified_at.is_none() {
        return Err(AppError::Validation(format!(
            "Vérifiez « {name} » avant d'en faire le domaine principal."
        )));
    }

    // The outgoing primary becomes a secondary rather than disappearing: its
    // accounts keep their addresses, and the instance keeps answering for it.
    // The old `UPDATE … RETURNING name` (which MySQL lacks) is split into a read
    // then a write; both run on the same transaction, so nothing slips between.
    let previous: Option<String> = tx
        .fetch_optional_scalar::<String>(
            "SELECT name FROM core.domains WHERE kind = 'primary'",
            params![],
        )
        .await
        .map_err(AppError::Database)?;
    tx.execute(
        "UPDATE core.domains SET kind = 'secondary' WHERE kind = 'primary'",
        params![],
    )
    .await
    .map_err(AppError::Database)?;

    tx.execute(
        "UPDATE core.domains SET kind = 'primary' WHERE id = $1",
        params![id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "domains: promotion");
        AppError::Database(e)
    })?;

    Ok((name, previous))
}

/// What stands between a domain and its removal, named rather than counted.
///
/// Returned as a list so the console can show a checklist instead of a single
/// refusal: the reference does exactly this, and it is the difference between
/// "impossible" and "voilà ce qu'il reste à faire".
pub async fn removal_blockers(db: &DbPool, domain: &Domain) -> Result<Vec<String>, AppError> {
    let mut blockers = Vec::new();

    if domain.kind == DomainKind::Primary {
        blockers.push(
            "C'est le domaine principal de l'instance. Promouvez d'abord un autre domaine.".to_string(),
        );
    }
    if domain.account_count > 0 {
        blockers.push(format!(
            "{} compte(s) portent une adresse à ce domaine. Changez leur adresse avant de le retirer.",
            domain.account_count
        ));
    }

    let aliases: i64 = db
        .fetch_scalar::<i64>(
            &format!(
                "SELECT {} FROM core.domains WHERE parent_id = $1",
                db.backend().count_bigint("*")
            ),
            params![domain.id],
        )
        .await
        .map_err(AppError::Database)?;
    if aliases > 0 {
        blockers.push(format!(
            "{aliases} alias reprennent les adresses de ce domaine. Retirez-les d'abord."
        ));
    }

    Ok(blockers)
}

/// Removes a domain once nothing stands in the way.
pub async fn delete(tx: &mut DbTx, id: Uuid) -> Result<(), AppError> {
    tx.execute("DELETE FROM core.domains WHERE id = $1", params![id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "domains: suppression");
            AppError::Database(e)
        })?;
    Ok(())
}

/// One row of the registry summary.
#[derive(Debug, FromRow)]
struct OverviewRow {
    total: i64,
    verified: i64,
    pending: i64,
    aliases: i64,
    primary_name: Option<String>,
}

/// The registry, summarised for the page header.
pub async fn overview(db: &DbPool) -> Result<Value, AppError> {
    // `COUNT(*) FILTER (WHERE …)` is PostgreSQL/SQLite only, so it is expressed
    // as the portable `COUNT(CASE WHEN … THEN 1 END)`; the redundant `::bigint`
    // casts are dropped.
    let row = db
        .fetch_one_as::<OverviewRow>(
            r#"SELECT COUNT(*)                                              AS total,
                  COUNT(CASE WHEN verified_at IS NOT NULL THEN 1 END)   AS verified,
                  COUNT(CASE WHEN verified_at IS NULL THEN 1 END)       AS pending,
                  COUNT(CASE WHEN kind = 'alias' THEN 1 END)            AS aliases,
                  (SELECT name FROM core.domains WHERE kind = 'primary') AS primary_name
             FROM core.domains"#,
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "domains: état du registre");
            AppError::Database(e)
        })?;

    Ok(json!({
        "total":        row.total,
        "verified":     row.verified,
        "pending":      row.pending,
        "aliases":      row.aliases,
        "primary_name": row.primary_name,
    }))
}
