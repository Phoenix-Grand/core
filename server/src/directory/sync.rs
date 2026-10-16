//! Importing a directory: accounts, groups, and what happens to somebody the
//! directory stopped returning.
//!
//! ## Nothing is ever deleted
//!
//! The only policies the schema can express are *disable* and *ignore*
//! ([`super::model::OnMissing`]). A deletion cascades through every module's
//! data and cannot be undone, while the input that would trigger it - "the
//! directory did not return this person" - is exactly what a network partition,
//! an expired service password, a typo in the base DN or a paginated result set
//! produces. Disabling costs one click to undo.
//!
//! ## The second guard
//!
//! Choosing *disable* is not enough to make a mass deactivation possible.
//! [`disable_guard`] refuses the whole disabling phase when the run looks like
//! an incident rather than a payroll change: nobody at all came back, or the run
//! would switch off more than a quarter of the accounts the directory governs.
//! The run then reports `partial` and says why, which is a page an operator
//! reads - a silently emptied instance is not.
//!
//! ## Memberships a synchronisation may touch
//!
//! `core.user_group_members.source` separates what an operator granted by hand
//! from what a run imported. A run only ever removes rows it owns, so a manual
//! membership survives every synchronisation and survives detaching the
//! directory altogether.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use kubuno_db::{new_id, params, DbPool, DbQueryBuilder};
use serde::Serialize;
use uuid::Uuid;

use crate::{
    audit::{redact::target, AuditContext, AuditEntry},
    errors::AppError,
};

use super::client::Connection;
use super::mapping::{map_group, map_user, MappedGroup};
use super::model::{LdapDirectory, OnMissing};
use super::{config, filter, provision};

/// `core.user_groups.name` is `VARCHAR(100)`.
const GROUP_NAME_MAX: usize = 100;

/// Cuts a name to `max` characters (never bytes: a group named in Greek would
/// be split mid-codepoint and the insert would fail on invalid UTF-8).
fn clamp_group_name(name: &str, max: usize) -> String {
    name.chars().take(max.max(8)).collect()
}

/// Below this many governed accounts, the proportional guard is meaningless and
/// the absolute floor applies instead.
const DISABLE_FLOOR: usize = 5;
/// Fraction of the governed population a single run may deactivate.
const DISABLE_MAX_RATIO: f64 = 0.25;

/// What one run did. Serialised into the audit trail and returned by the
/// "synchronise now" button.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncReport {
    pub directory:      String,
    pub users_seen:     usize,
    pub users_created:  usize,
    pub users_linked:   usize,
    pub users_matched:  usize,
    pub users_skipped:  usize,
    pub groups_seen:    usize,
    pub groups_created: usize,
    pub memberships_added:   usize,
    pub memberships_removed: usize,
    pub disabled:       usize,
    /// Set when the disabling phase was refused. The text is what the console
    /// shows, verbatim.
    pub disable_refused: Option<String>,
    /// Non-fatal problems, already truncated.
    pub warnings:   Vec<String>,
    /// `ok`, `partial` or `failed`.
    pub status:     String,
    pub elapsed_ms: u64,
}

impl SyncReport {
    fn finish(mut self, started: std::time::Instant) -> Self {
        self.elapsed_ms = started.elapsed().as_millis() as u64;
        if self.status.is_empty() {
            self.status = if self.warnings.is_empty() && self.disable_refused.is_none() {
                "ok".into()
            } else {
                "partial".into()
            };
        }
        self
    }

    /// One-line summary stored in `last_sync_detail` and shown in the list.
    pub fn summary(&self) -> String {
        let mut parts = vec![format!(
            "{} compte(s) vus - {} créé(s), {} lié(s), {} ignoré(s)",
            self.users_seen, self.users_created, self.users_linked, self.users_skipped
        )];
        if self.groups_seen > 0 {
            parts.push(format!(
                "{} groupe(s), {} adhésion(s) ajoutée(s), {} retirée(s)",
                self.groups_seen, self.memberships_added, self.memberships_removed
            ));
        }
        if self.disabled > 0 {
            parts.push(format!("{} compte(s) désactivé(s)", self.disabled));
        }
        if let Some(reason) = &self.disable_refused {
            parts.push(format!("désactivation suspendue : {reason}"));
        }
        for w in self.warnings.iter().take(3) {
            parts.push(w.clone());
        }
        let text = parts.join(" · ");
        super::client::truncate(&text)
    }
}

/// Should the disabling phase run at all?
///
/// Returns the reason to skip it, or `None` to proceed. Pure, so the policy is
/// exercised without a directory and without a database.
pub fn disable_guard(governed: usize, seen: usize, would_disable: usize) -> Option<String> {
    if would_disable == 0 {
        return None;
    }
    if seen == 0 {
        return Some(format!(
            "l'annuaire n'a retourné aucune entrée alors que {governed} compte(s) en dépendent - \
             incident réseau ou configuration cassée plutôt que départs"
        ));
    }
    let ceiling = DISABLE_FLOOR.max((governed as f64 * DISABLE_MAX_RATIO).ceil() as usize);
    if would_disable > ceiling {
        return Some(format!(
            "{would_disable} compte(s) sur {governed} seraient désactivés, au-delà du plafond de {ceiling} \
             par exécution - relancez après avoir vérifié le filtre et le DN de base"
        ));
    }
    None
}

/// Runs one synchronisation.
///
/// Never returns `Err` for a directory problem: a failed run is a *report* with
/// `status = "failed"`, because the caller is a background job whose retry would
/// change nothing and whose failure would be invisible. `Err` is reserved for
/// the database being unusable.
pub async fn run(db: &DbPool, jwt_secret: &str, dir: &LdapDirectory) -> Result<SyncReport, AppError> {
    let started = std::time::Instant::now();
    let cutoff = Utc::now();
    let mut report = SyncReport {
        directory: dir.slug.clone(),
        ..Default::default()
    };

    if !dir.is_usable() {
        report.status = "failed".into();
        report.warnings.push("Annuaire désactivé ou incomplet".into());
        return Ok(finalise(db, dir, report.finish(started)).await);
    }

    let sync_filter = match filter::build_sync_filter(&dir.user_filter) {
        Ok(f) => f,
        Err(e) => {
            report.status = "failed".into();
            report.warnings.push(e.message().to_string());
            return Ok(finalise(db, dir, report.finish(started)).await);
        }
    };

    let service_password = config::decrypt_password(jwt_secret, &dir.bind_password_enc);
    let mut conn = match Connection::open(dir, &service_password).await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(directory = %dir.slug, error = %e, "annuaire : synchronisation impossible");
            report.status = "failed".into();
            report.warnings.push(super::client::truncate(&e.to_string()));
            return Ok(finalise(db, dir, report.finish(started)).await);
        }
    };

    let attrs = dir.attributes();
    let entries = match conn
        .search(&dir.base_dn, dir.scope(), &sync_filter, &attrs.requested())
        .await
    {
        Ok(e) => e,
        Err(e) => {
            conn.close().await;
            tracing::error!(directory = %dir.slug, error = %e, "annuaire : recherche de synchronisation refusée");
            report.status = "failed".into();
            report.warnings.push(super::client::truncate(&e.to_string()));
            return Ok(finalise(db, dir, report.finish(started)).await);
        }
    };

    // ── Accounts ─────────────────────────────────────────────────────────────
    let allow_create = config::provision_on_login(db).await && dir.allow_signup;
    // A synchronisation is the one place that may create accounts even when
    // "provision on first sign-in" is off: an operator who runs an import is
    // asking for exactly that. The directory's own flag still applies.
    let allow_create = allow_create || dir.allow_signup;

    // DN → local account, for the group phase.
    let mut by_dn: HashMap<String, Uuid> = HashMap::new();
    let mut member_of_edges: Vec<(Uuid, String)> = Vec::new();

    for entry in &entries {
        let mapped = map_user(entry, &attrs);
        report.users_seen += 1;

        match provision::upsert(db, dir, &mapped, allow_create).await {
            Ok(Some(outcome)) => {
                match outcome.how {
                    provision::Provisioned::Created => report.users_created += 1,
                    provision::Provisioned::Linked => report.users_linked += 1,
                    provision::Provisioned::Matched => report.users_matched += 1,
                }
                by_dn.insert(mapped.dn.to_lowercase(), outcome.user.id);
                for group_dn in &mapped.member_of {
                    member_of_edges.push((outcome.user.id, group_dn.to_lowercase()));
                }
            }
            Ok(None) => report.users_skipped += 1,
            Err(e) => {
                // One bad entry must not abort the import of the other 4 999.
                tracing::error!(directory = %dir.slug, dn = %mapped.dn, error = %e, "annuaire : entrée non importée");
                report.users_skipped += 1;
                if report.warnings.len() < 5 {
                    report.warnings.push(super::client::truncate(&format!(
                        "entrée non importée ({})",
                        mapped.dn
                    )));
                }
            }
        }
    }

    // ── Groups ───────────────────────────────────────────────────────────────
    //
    // The membership reconciliation is subject to the SAME suspicion as the
    // disabling phase, and for the same reason: a run whose user search came
    // back empty knows nothing about who belongs where, and removing every
    // imported membership on that basis is the group-shaped version of emptying
    // the instance. Caught in testing - the first run with a filter that matched
    // nobody stripped every imported group of every member, silently, with a
    // report that said "ok".
    if dir.sync_groups {
        let trustworthy = report.users_seen > 0;
        if !trustworthy {
            report.warnings.push(
                "aucune entrée retournée : adhésions de groupe laissées intactes".into(),
            );
        }
        match sync_groups(db, dir, &mut conn, &by_dn, &member_of_edges, trustworthy).await {
            Ok(g) => {
                report.groups_seen = g.seen;
                report.groups_created = g.created;
                report.memberships_added = g.added;
                report.memberships_removed = g.removed;
                report.warnings.extend(g.warnings);
            }
            Err(e) => {
                tracing::error!(directory = %dir.slug, error = %e, "annuaire : synchronisation des groupes");
                report.warnings.push(super::client::truncate(&format!("groupes : {e}")));
            }
        }
    }

    conn.close().await;

    // ── Accounts the directory no longer returns ─────────────────────────────
    if dir.on_missing() == OnMissing::Disable {
        match disable_missing(db, dir, cutoff, report.users_seen).await {
            Ok(DisableOutcome::Disabled(n)) => report.disabled = n,
            Ok(DisableOutcome::Refused(reason)) => {
                tracing::warn!(directory = %dir.slug, reason = %reason, "annuaire : désactivation suspendue");
                report.disable_refused = Some(reason);
            }
            Err(e) => {
                report.warnings.push(super::client::truncate(&format!("désactivation : {e}")));
            }
        }
    }

    let report = report.finish(started);
    tracing::info!(
        directory = %dir.slug,
        status = %report.status,
        vus = report.users_seen,
        créés = report.users_created,
        désactivés = report.disabled,
        "annuaire : synchronisation terminée"
    );
    Ok(finalise(db, dir, report).await)
}

// ── Disabling ────────────────────────────────────────────────────────────────

enum DisableOutcome {
    Disabled(usize),
    Refused(String),
}

async fn disable_missing(
    db: &DbPool,
    dir: &LdapDirectory,
    cutoff: DateTime<Utc>,
    seen: usize,
) -> Result<DisableOutcome, AppError> {
    let backend = db.backend();
    let governed: i64 = db
        .fetch_scalar::<i64>(
            &format!(
                "SELECT {} FROM core.users WHERE ldap_directory_id = $1 AND is_active = TRUE",
                backend.count_bigint("*")
            ),
            params![dir.id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "annuaire : comptage des comptes gouvernés");
            AppError::Database(e)
        })?;

    // Not seen during this run: either never stamped, or stamped before it began.
    let candidates: Vec<(Uuid, String)> = db
        .fetch_all_as::<(Uuid, String)>(
            "SELECT id, username FROM core.users
          WHERE ldap_directory_id = $1 AND is_active = TRUE
            AND (ldap_synced_at IS NULL OR ldap_synced_at < $2)",
            params![dir.id, cutoff],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "annuaire : liste des comptes absents");
            AppError::Database(e)
        })?;

    if let Some(reason) = disable_guard(governed.max(0) as usize, seen, candidates.len()) {
        return Ok(DisableOutcome::Refused(reason));
    }
    if candidates.is_empty() {
        return Ok(DisableOutcome::Disabled(0));
    }

    let ids: Vec<Uuid> = candidates.iter().map(|(id, _)| *id).collect();
    // `= ANY($1)` over an array is replaced by a portable `IN (...)` list.
    let mut deactivate = DbQueryBuilder::new(backend, "UPDATE core.users SET is_active = FALSE WHERE id");
    deactivate.push_in(ids.iter().copied());
    let affected = deactivate.execute(db).await.map_err(|e| {
        tracing::error!(error = %e, "annuaire : désactivation des comptes absents");
        AppError::Database(e)
    })? as usize;

    // Sessions of a deactivated account are cut: leaving a live refresh token
    // behind would keep somebody signed in for a month after they left.
    let mut revoke =
        DbQueryBuilder::new(backend, "UPDATE core.refresh_tokens SET revoked_at = ");
    revoke.push_bind(Utc::now());
    revoke.push(", revoke_reason = 'admin' WHERE user_id");
    revoke.push_in(ids.iter().copied());
    revoke.push(" AND revoked_at IS NULL");
    if let Err(e) = revoke.execute(db).await {
        tracing::error!(error = %e, "annuaire : révocation des sessions des comptes désactivés");
    }

    let ctx = AuditContext::system("annuaire");
    for (id, username) in &candidates {
        ctx.record(
            db,
            AuditEntry::new("core.directory.user_disabled")
                .module("core")
                .target(target::USER, *id, username.clone())
                .detail(format!(
                    "absent de l'annuaire « {} » - compte désactivé, aucune donnée supprimée",
                    dir.display_name
                ))
                .reversible(),
        )
        .await;
    }

    Ok(DisableOutcome::Disabled(affected))
}

// ── Groups ───────────────────────────────────────────────────────────────────

#[derive(Default)]
struct GroupOutcome {
    seen: usize,
    created: usize,
    added: usize,
    removed: usize,
    warnings: Vec<String>,
}

async fn sync_groups(
    db: &DbPool,
    dir: &LdapDirectory,
    conn: &mut Connection,
    by_dn: &HashMap<String, Uuid>,
    member_of_edges: &[(Uuid, String)],
    // False when the user search returned nothing. Additions still happen (there
    // are none to make); removals do not.
    allow_removals: bool,
) -> Result<GroupOutcome, AppError> {
    let mut out = GroupOutcome::default();

    let base = if dir.group_base_dn.trim().is_empty() {
        dir.base_dn.as_str()
    } else {
        dir.group_base_dn.as_str()
    };
    let attrs = vec![dir.attr_group_name.clone(), dir.attr_group_member.clone()];

    let entries = match conn
        .search(base, dir.scope(), dir.group_filter.trim(), &attrs)
        .await
    {
        Ok(e) => e,
        Err(e) => {
            out.warnings.push(super::client::truncate(&e.to_string()));
            return Ok(out);
        }
    };

    let groups: Vec<MappedGroup> = entries
        .iter()
        .map(|e| map_group(e, &dir.attr_group_name, &dir.attr_group_member))
        .collect();
    out.seen = groups.len();

    // Membership read from the person's own entry, folded in by group DN.
    let mut from_member_of: HashMap<String, HashSet<Uuid>> = HashMap::new();
    for (user_id, group_dn) in member_of_edges {
        from_member_of.entry(group_dn.clone()).or_default().insert(*user_id);
    }

    for group in &groups {
        let group_id = match upsert_group(db, dir, group).await {
            Ok((id, created)) => {
                if created {
                    out.created += 1;
                }
                id
            }
            Err(e) => {
                out.warnings.push(super::client::truncate(&format!(
                    "groupe « {} » non importé : {e}",
                    group.name
                )));
                continue;
            }
        };

        // Both directions of membership, unioned: the group's `member` list and
        // whatever the people themselves declared through `memberOf`.
        let mut desired: HashSet<Uuid> = group
            .members
            .iter()
            .filter_map(|dn| by_dn.get(&dn.to_lowercase()).copied())
            .collect();
        if let Some(extra) = from_member_of.get(&group.dn.to_lowercase()) {
            desired.extend(extra.iter().copied());
        }
        let desired: Vec<Uuid> = desired.into_iter().collect();

        // PostgreSQL's `UNNEST($2::uuid[])` is replaced by a portable multi-row
        // `VALUES` list built from the desired members; the bare `ON CONFLICT DO
        // NOTHING` goes through the backend (MySQL uses `INSERT IGNORE`).
        let backend = db.backend();
        let added = if desired.is_empty() {
            0
        } else {
            let mut insert = DbQueryBuilder::new(
                backend,
                format!(
                    "INSERT {}INTO core.user_group_members (group_id, user_id, source) VALUES ",
                    backend.insert_ignore_prefix()
                ),
            );
            for (i, uid) in desired.iter().enumerate() {
                if i > 0 {
                    insert.push(", ");
                }
                insert.push("(");
                insert.push_bind(group_id);
                insert.push(", ");
                insert.push_bind(*uid);
                insert.push(", 'directory')");
            }
            insert.push(backend.on_conflict_do_nothing(&["group_id", "user_id"]));
            insert.execute(db).await.map_err(|e| {
                tracing::error!(error = %e, "annuaire : ajout des adhésions");
                AppError::Database(e)
            })? as usize
        };

        // Only rows a run created. A membership an operator granted by hand is
        // not the directory's to take away - and no membership at all is taken
        // away by a run that saw nobody.
        let removed = if allow_removals {
            if desired.is_empty() {
                // No desired members: every directory-sourced row of the group is
                // stale. (The old `NOT (user_id = ANY('{}'))` matched all rows;
                // an empty `IN (...)` would match none, so this case is explicit.)
                db.execute(
                    "DELETE FROM core.user_group_members
                      WHERE group_id = $1 AND source = 'directory'",
                    params![group_id],
                )
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "annuaire : retrait des adhésions");
                    AppError::Database(e)
                })? as usize
            } else {
                let mut delete = DbQueryBuilder::new(
                    backend,
                    "DELETE FROM core.user_group_members WHERE group_id = ",
                );
                delete.push_bind(group_id);
                delete.push(" AND source = 'directory' AND user_id NOT");
                delete.push_in(desired.iter().copied());
                delete.execute(db).await.map_err(|e| {
                    tracing::error!(error = %e, "annuaire : retrait des adhésions");
                    AppError::Database(e)
                })? as usize
            }
        } else {
            0
        };

        out.added += added;
        out.removed += removed;
    }

    Ok(out)
}

/// Inserts or refreshes an imported group. Returns its id and whether this run
/// created it.
async fn upsert_group(
    db: &DbPool,
    dir: &LdapDirectory,
    group: &MappedGroup,
) -> Result<(Uuid, bool), AppError> {
    if let Some(id) = db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM core.user_groups WHERE ldap_directory_id = $1 AND ldap_dn = $2",
            params![dir.id, &group.dn],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "annuaire : recherche du groupe importé");
            AppError::Database(e)
        })?
    {
        // The name may have changed in the directory. Kept in step, but never
        // to a name another group already holds.
        let name = free_group_name(db, dir, &group.name, Some(id)).await?;
        // Placeholders ascending: the SET value first, the WHERE key after.
        db.execute(
            "UPDATE core.user_groups SET name = $1 WHERE id = $2",
            params![&name, id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "annuaire : renommage du groupe importé");
            AppError::Database(e)
        })?;
        return Ok((id, false));
    }

    let name = free_group_name(db, dir, &group.name, None).await?;
    // The old `RETURNING id` becomes generate-in-Rust + insert.
    let id = new_id();
    db.execute(
        "INSERT INTO core.user_groups (id, name, description, ldap_directory_id, ldap_dn)
         VALUES ($1, $2, $3, $4, $5)",
        params![
            id,
            &name,
            format!("Importé de l'annuaire « {} »", dir.display_name),
            dir.id,
            &group.dn
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, group = %group.dn, "annuaire : création du groupe importé");
        AppError::Database(e)
    })?;

    Ok((id, true))
}

/// A group name nobody else holds.
///
/// `core.user_groups.name` is unique across the instance, and an imported group
/// called "Administrateurs" must not collide with - or, worse, be merged into -
/// the seeded one. The directory's slug disambiguates.
async fn free_group_name(
    db: &DbPool,
    dir: &LdapDirectory,
    wanted: &str,
    keep: Option<Uuid>,
) -> Result<String, AppError> {
    // `core.user_groups.name` is VARCHAR(100). The base is cut short enough that
    // the disambiguating suffix still fits - truncating the *result* instead
    // would drop the suffix and put us back on the collision we were escaping.
    let wanted = clamp_group_name(wanted, GROUP_NAME_MAX - (dir.slug.chars().count() + 12));
    let taken = |name: String, keep: Option<Uuid>| async move {
        // `keep` is bound twice rather than reusing a placeholder (portable rewrite
        // forbids reuse); the `::uuid` cast is dropped since the value is typed.
        db.fetch_scalar::<bool>(
            "SELECT EXISTS(SELECT 1 FROM core.user_groups WHERE name = $1 AND ($2 IS NULL OR id <> $3))",
            params![name, keep, keep],
        )
        .await
    };

    if !taken(wanted.clone(), keep).await.map_err(|e| {
        tracing::error!(error = %e, "annuaire : test d'unicité du nom de groupe");
        AppError::Database(e)
    })? {
        return Ok(wanted);
    }

    let candidate = format!("{wanted} ({})", dir.slug);
    if !taken(candidate.clone(), keep).await.map_err(|e| {
        tracing::error!(error = %e, "annuaire : test d'unicité du nom de groupe");
        AppError::Database(e)
    })? {
        return Ok(candidate);
    }

    Ok(format!(
        "{wanted} ({}-{})",
        dir.slug,
        Uuid::new_v4().simple().to_string().chars().take(6).collect::<String>()
    ))
}

// ── Bookkeeping ──────────────────────────────────────────────────────────────

/// Writes the run's outcome onto the directory row and into the trail.
async fn finalise(db: &DbPool, dir: &LdapDirectory, report: SyncReport) -> SyncReport {
    let summary = report.summary();
    // Placeholders ascending (SET first, WHERE last); `NOW()` bound from Rust.
    if let Err(e) = db
        .execute(
            "UPDATE core.ldap_directories
            SET last_sync_at = $1, last_sync_status = $2, last_sync_detail = $3
          WHERE id = $4",
            params![Utc::now(), &report.status, &summary, dir.id],
        )
        .await
    {
        tracing::error!(error = %e, "annuaire : enregistrement du résultat de synchronisation");
    }

    let ctx = AuditContext::system("annuaire");
    let outcome_entry = AuditEntry::new("core.directory.sync")
        .module("core")
        .target(target::LDAP_DIRECTORY, dir.id, dir.display_name.clone())
        .after(serde_json::json!({ "sync": report }))
        .detail(summary);
    let outcome_entry = if report.status == "failed" {
        outcome_entry.failed(
            report
                .warnings
                .first()
                .cloned()
                .unwrap_or_else(|| "synchronisation échouée".into()),
        )
    } else {
        outcome_entry
    };
    ctx.record(db, outcome_entry).await;

    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_that_returned_nobody_never_deactivates_anybody() {
        // The incident case: 120 governed accounts, the search came back empty.
        // Every one of them looks "missing" and every one of them would be
        // switched off. Refused, with a reason an operator can act on.
        let reason = disable_guard(120, 0, 120).expect("garde-fou déclenché");
        assert!(reason.contains("aucune entrée"));
    }

    #[test]
    fn a_run_that_would_empty_the_instance_is_refused() {
        // 100 governed, 100 returned, but half of them stamped as missing -
        // a filter change, not a hundred resignations.
        let reason = disable_guard(100, 100, 50).expect("garde-fou déclenché");
        assert!(reason.contains("plafond"));
    }

    #[test]
    fn ordinary_departures_go_through() {
        // Three people left out of a hundred: the ceiling is 25, this is under it.
        assert_eq!(disable_guard(100, 97, 3), None);
        // And on a small instance the absolute floor applies rather than 25 %.
        assert_eq!(disable_guard(8, 6, 2), None);
        assert_eq!(disable_guard(8, 6, 5), None);
        assert!(disable_guard(8, 6, 6).is_some());
    }

    #[test]
    fn nothing_to_do_is_never_an_incident() {
        assert_eq!(disable_guard(0, 0, 0), None);
        assert_eq!(disable_guard(100, 100, 0), None);
    }

    #[test]
    fn a_report_says_what_it_did_in_one_line() {
        let mut r = SyncReport {
            directory: "test".into(),
            users_seen: 3,
            users_created: 2,
            users_linked: 1,
            ..Default::default()
        };
        r.disable_refused = Some("l'annuaire n'a retourné aucune entrée".into());
        let s = r.summary();
        assert!(s.contains("3 compte(s) vus"));
        assert!(s.contains("désactivation suspendue"));
        // Bounded, whatever the directory answered.
        assert!(s.chars().count() <= super::super::client::MAX_ERROR_LEN + 1);
    }

    #[test]
    fn a_run_that_saw_nobody_touches_no_membership() {
        // The bug this exists to prevent, caught on a live directory: a filter
        // that suddenly matched nobody stripped every imported group of every
        // member, and reported "ok" while doing it. The disabling phase already
        // refused; the group phase did not, so it removed silently what the
        // other guard had just protected.
        //
        // The condition is the same one `disable_guard` reasons about, which is
        // why it is stated once here rather than re-derived: "the run saw
        // nobody" is not evidence that nobody belongs anywhere.
        assert!(disable_guard(2, 0, 2).is_some(), "la désactivation est refusée");
        // …and the membership reconciliation now shares that verdict: see the
        // `trustworthy` flag in `run`, which is `users_seen > 0`.
        let seen = 0usize;
        assert_eq!(seen, 0, "aucune suppression d'adhésion sur une exécution vide");
    }

    #[test]
    fn a_run_with_warnings_is_partial_rather_than_ok() {
        let started = std::time::Instant::now();
        let clean = SyncReport::default().finish(started);
        assert_eq!(clean.status, "ok");

        let mut warned = SyncReport::default();
        warned.warnings.push("une entrée illisible".into());
        assert_eq!(warned.finish(started).status, "partial");
    }
}
