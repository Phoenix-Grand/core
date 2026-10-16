//! What the **core** contributes to an archive: the account, and the instance
//! referentials.
//!
//! The modules answer for their own data through
//! [`super::contract`]; this file is the core answering for its own, and it is
//! the one part of the export that always exists - a service picker with every
//! module unticked still produces a complete account sheet, because "who this
//! person is" is the thing every other file in the archive refers to.
//!
//! ## The redaction rule, and why it is a column list
//!
//! Every query below names its columns **explicitly**. Not one uses `SELECT *`,
//! and that is the whole security design of this file rather than a style
//! preference: a `SELECT *` exports whatever the next migration adds, and the
//! next migration is exactly where the next secret arrives. With an explicit
//! list, adding a sensitive column is inert here until somebody deliberately
//! types its name - and typing it means walking past this paragraph.
//!
//! Never exported, and absent from every list below: `password_hash`,
//! `totp_secret`, `totp_pending_secret`, refresh- and verification-token hashes,
//! API token hashes, backup codes, OAuth client secrets, the SMTP password, and
//! the JWT and internal secrets (which are not in the database at all). An
//! archive is read by a human on a laptop; a credential that reaches one has
//! left the instance for good.
//!
//! ## Why JSON, and one CSV
//!
//! JSON for the structured records: it survives a round trip, it is what an
//! importer on the other side will read, and it does not lose a nested field the
//! way a flattened table would. CSV for the audit trail alone, because that one
//! is read by a person scrolling - and it is rendered by
//! [`crate::audit::query::csv_line`], the same writer the console's own export
//! button uses, so the two can never disagree about what a line looks like.

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, Utc};
use kubuno_db::{params, DbPool};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

use crate::errors::AppError;

// ── Portable JSON assembly ───────────────────────────────────────────────────
//
// PostgreSQL built each export sheet in SQL with `json_agg`/`row_to_json` (and,
// for a nested list, a correlated `json_agg`). Neither has a portable spelling
// across MySQL and SQLite that survives the `ORDER BY` inside the aggregate, so
// every sheet is now fetched as its explicit rows and serialised in Rust. The
// column list - the whole security design of this file - is unchanged; only the
// `COALESCE(json_agg(t …), '[]') FROM ( … ) t` wrapper is gone, replaced by
// `serde_json::to_value` over a typed row. `host(ip_address)` is spelled per
// engine (`Backend::inet_text`).

/// Serialises fetched rows into a JSON array. Serialising a `Vec` of these
/// plain structs cannot fail (no non-string map keys, no non-finite floats), so
/// the `Null` fallback is unreachable and only spares an `unwrap`.
fn to_json<T: Serialize>(rows: T) -> Value {
    serde_json::to_value(rows).unwrap_or(Value::Null)
}

#[derive(FromRow, Serialize)]
struct ProfileRow {
    id: Uuid,
    email: String,
    username: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
    role: String,
    quota_bytes: i64,
    used_bytes: i64,
    is_active: bool,
    email_verified: bool,
    oauth_provider: Option<String>,
    oauth_id: Option<String>,
    preferences: Value,
    name_pronunciation: Option<String>,
    pronouns: Option<String>,
    work_location: Option<String>,
    introduction: Option<String>,
    gender: Option<String>,
    birthday: Option<NaiveDate>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    last_login_at: Option<DateTime<Utc>>,
    password_changed_at: Option<DateTime<Utc>>,
    totp_enabled: bool,
    org_unit_id: Option<Uuid>,
    org_unit_name: Option<String>,
}

#[derive(FromRow, Serialize)]
struct GroupMemberRow {
    id: Uuid,
    name: String,
    description: Option<String>,
    added_at: DateTime<Utc>,
}

#[derive(FromRow, Serialize)]
struct RoleRow {
    role_slug: String,
    role_name: String,
    scope: String,
    scope_org_unit: Option<String>,
    expires_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

#[derive(FromRow, Serialize)]
struct ExportDeviceRow {
    id: Uuid,
    device_name: Option<String>,
    device_type: Option<String>,
    ip_address: Option<String>,
    user_agent: Option<String>,
    created_at: DateTime<Utc>,
    last_used_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
    revoke_reason: Option<String>,
}

#[derive(FromRow, Serialize)]
struct InstanceAccountRow {
    id: Uuid,
    email: String,
    username: String,
    display_name: Option<String>,
    role: String,
    quota_bytes: i64,
    used_bytes: i64,
    is_active: bool,
    email_verified: bool,
    oauth_provider: Option<String>,
    totp_enabled: bool,
    org_unit_id: Option<Uuid>,
    org_unit_name: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    last_login_at: Option<DateTime<Utc>>,
    deleted_at: Option<DateTime<Utc>>,
}

#[derive(FromRow, Serialize)]
struct InstanceGroupRow {
    id: Uuid,
    name: String,
    description: Option<String>,
    permissions: Value,
    is_default: bool,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(FromRow, Serialize)]
struct OrgUnitRow {
    id: Uuid,
    name: String,
    parent_id: Option<Uuid>,
    parent_name: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    comptes: i64,
}

#[derive(FromRow)]
struct SettingRow {
    key: String,
    category: String,
    label: Option<String>,
    description: Option<String>,
    value_type: Option<String>,
    default_value: Option<Value>,
    updated_at: Option<DateTime<Utc>>,
    instance_value: Option<Value>,
}

/// A setting whose name suggests a credential is redacted rather than exported
/// (the same positive, err-on-the-safe-side filter the SQL `~*` did).
fn setting_is_secret(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["secret", "password", "token", "api_key", "private_key", "passphrase"]
        .iter()
        .any(|needle| k.contains(needle))
}

/// Audit lines carried per account. Generous for a person's own history,
/// bounded so one very active administrator cannot turn their folder into the
/// bulk of the archive. The manifest says when the cap was hit.
const ACCOUNT_AUDIT_LIMIT: i64 = 5_000;

/// Audit lines carried in the instance folder.
const INSTANCE_AUDIT_LIMIT: i64 = 100_000;

/// Fetches rows and serialises them to a JSON array, with the file's uniform
/// error handling (a failing extract must never end up silently empty).
async fn json_list<T: kubuno_db::exec::FromAnyRow + Serialize>(
    db: &DbPool,
    sql: &str,
    bind: Option<Uuid>,
) -> Result<Value, AppError> {
    let params = match bind {
        Some(id) => params![id],
        None => params![],
    };
    let rows = db.fetch_all_as::<T>(sql, params).await.map_err(|e| {
        tracing::error!(error = %e, "export: extraction des données du core impossible");
        AppError::Database(e)
    })?;
    Ok(to_json(rows))
}

// ── One account ──────────────────────────────────────────────────────────────

/// The account sheet: who this person is, where they sit, what they belong to.
///
/// `oauth_id` is included and `oauth_provider` with it: they say *how* somebody
/// signs in, which is part of an honest answer to "what do you hold about me",
/// and neither is a credential - the identifier is issued by the provider and
/// grants nothing on its own.
pub async fn account_profile(db: &DbPool, user_id: Uuid) -> Result<Value, AppError> {
    let profile = db
        .fetch_optional_as::<ProfileRow>(
            "SELECT u.id, u.email, u.username, u.display_name, u.avatar_url, u.role, \
                   u.quota_bytes, u.used_bytes, u.is_active, u.email_verified, \
                   u.oauth_provider, u.oauth_id, u.preferences, \
                   u.name_pronunciation, u.pronouns, u.work_location, u.introduction, \
                   u.gender, u.birthday, \
                   u.created_at, u.updated_at, u.last_login_at, u.password_changed_at, \
                   u.totp_enabled, \
                   o.id AS org_unit_id, o.name AS org_unit_name \
              FROM core.users u \
              LEFT JOIN core.org_units o ON o.id = u.org_unit_id \
             WHERE u.id = $1",
            params![user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "export: profil du compte");
            AppError::Database(e)
        })?
        .map(to_json)
        .unwrap_or(Value::Null);

    let groups = json_list::<GroupMemberRow>(
        db,
        "SELECT g.id, g.name, g.description, m.added_at \
              FROM core.user_group_members m \
              JOIN core.user_groups g ON g.id = m.group_id \
             WHERE m.user_id = $1 \
             ORDER BY g.name",
        Some(user_id),
    )
    .await?;

    // Administrative roles, resolved to their labels. What a person is allowed
    // to do is part of what the instance holds about them, and it is the first
    // thing an auditor asks after "who are they".
    let roles = json_list::<RoleRow>(
        db,
        "SELECT r.slug AS role_slug, r.name AS role_name, a.scope, \
                   o.name AS scope_org_unit, a.expires_at, a.created_at \
              FROM core.role_assignments a \
              JOIN core.roles r ON r.id = a.role_id \
              LEFT JOIN core.org_units o ON o.id = a.scope_org_unit_id \
             WHERE a.subject_user_id = $1 \
             ORDER BY r.slug",
        Some(user_id),
    )
    .await?;

    Ok(json!({
        "profil":  profile,
        "groupes": groups,
        "roles_administratifs": roles,
    }))
}

/// The devices and sessions the instance has seen.
///
/// **No token, and no hash of one.** `token_hash` is the credential - exporting
/// it would hand over a working session - and it is simply not in the column
/// list. What is here is what a person can act on: which device, from where,
/// when, and whether it is still open.
pub async fn account_devices(db: &DbPool, user_id: Uuid) -> Result<Value, AppError> {
    json_list::<ExportDeviceRow>(
        db,
        &format!(
            "SELECT id, device_name, device_type, {ip} AS ip_address, \
                   user_agent, created_at, last_used_at, expires_at, revoked_at, revoke_reason \
              FROM core.refresh_tokens \
             WHERE user_id = $1 \
             ORDER BY created_at DESC",
            ip = db.backend().inet_text("ip_address")
        ),
        Some(user_id),
    )
    .await
}

/// The administrative audit trail **of what this account did**, as CSV.
///
/// Deliberately not "what was done to them": an entry naming this person as a
/// target usually also names the administrator who acted, and handing one
/// account a file about another account's actions would make the portability
/// answer a disclosure. Entries where they are the target are covered by the
/// instance-level trail, which only an operator receives.
pub async fn account_audit_csv(db: &DbPool, user_id: Uuid) -> Result<String, AppError> {
    let page = crate::audit::query::list(
        db,
        &crate::audit::query::AuditQuery {
            actor_id: Some(user_id),
            limit: Some(ACCOUNT_AUDIT_LIMIT),
            ..Default::default()
        },
    )
    .await?;

    let mut out = String::from(crate::audit::query::CSV_HEADER);
    for row in &page.rows {
        out.push_str(&crate::audit::query::csv_line(row));
    }
    Ok(out)
}

// ── The instance ─────────────────────────────────────────────────────────────

/// Every account, as the directory knows them.
///
/// `deleted_at` is carried rather than filtered on: an account pending erasure
/// is still an account the instance holds data about, and an export that
/// silently omitted it would answer the wrong question.
pub async fn instance_accounts(db: &DbPool) -> Result<Value, AppError> {
    json_list::<InstanceAccountRow>(
        db,
        "SELECT u.id, u.email, u.username, u.display_name, u.role, \
                   u.quota_bytes, u.used_bytes, u.is_active, u.email_verified, \
                   u.oauth_provider, u.totp_enabled, u.org_unit_id, \
                   o.name AS org_unit_name, \
                   u.created_at, u.updated_at, u.last_login_at, u.deleted_at \
              FROM core.users u \
              LEFT JOIN core.org_units o ON o.id = u.org_unit_id \
             ORDER BY u.username",
        None,
    )
    .await
}

/// Groups and their membership.
pub async fn instance_groups(db: &DbPool) -> Result<Value, AppError> {
    let groups = db
        .fetch_all_as::<InstanceGroupRow>(
            "SELECT g.id, g.name, g.description, g.permissions, g.is_default, \
                   g.created_at, g.updated_at \
              FROM core.user_groups g \
             ORDER BY g.name",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "export: groupes de l'instance");
            AppError::Database(e)
        })?;

    // Membership is fetched once and folded by group in Rust - the former
    // correlated `json_agg` per group. Ordered by (group, username) so each
    // group's members come out already sorted.
    let members = db
        .fetch_all_as::<(Uuid, String)>(
            "SELECT m.group_id, u.username \
               FROM core.user_group_members m \
               JOIN core.users u ON u.id = m.user_id \
              ORDER BY m.group_id, u.username",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "export: membres des groupes de l'instance");
            AppError::Database(e)
        })?;
    let mut by_group: HashMap<Uuid, Vec<String>> = HashMap::new();
    for (group_id, username) in members {
        by_group.entry(group_id).or_default().push(username);
    }

    let assembled: Vec<Value> = groups
        .into_iter()
        .map(|g| {
            let membres = by_group.remove(&g.id).unwrap_or_default();
            let mut obj = to_json(&g);
            if let Value::Object(map) = &mut obj {
                map.insert("membres".into(), json!(membres));
            }
            obj
        })
        .collect();
    Ok(Value::Array(assembled))
}

/// The organisational tree, flat, each unit carrying its parent.
pub async fn instance_org_units(db: &DbPool) -> Result<Value, AppError> {
    json_list::<OrgUnitRow>(
        db,
        "SELECT o.id, o.name, o.parent_id, p.name AS parent_name, \
                   o.created_at, o.updated_at, \
                   (SELECT COUNT(*) FROM core.users u WHERE u.org_unit_id = o.id) AS comptes \
              FROM core.org_units o \
              LEFT JOIN core.org_units p ON p.id = o.parent_id \
             ORDER BY o.name",
        None,
    )
    .await
}

/// The settings of the instance, **with the secret ones redacted**.
///
/// The filter is on the KEY, positively: anything whose name suggests a
/// credential is exported as `"(masqué)"` rather than as its value. Two things
/// make that acceptable rather than a guess:
///
///   * it errs in the safe direction - a harmless setting whose name contains
///     `secret` is redacted, which costs a line of an archive, whereas the
///     opposite error costs the instance;
///   * the settings that genuinely hold a credential (the SMTP password, the
///     OAuth client secrets) are stored **encrypted**, so what this would
///     otherwise export is ciphertext - and ciphertext in an archive is a
///     credential waiting for the day the key leaks.
pub async fn instance_settings(db: &DbPool) -> Result<Value, AppError> {
    let rows = db
        .fetch_all_as::<SettingRow>(
            "SELECT s.\"key\", s.category, s.label, s.description, s.value_type, \
                   s.default_value, s.updated_at, \
                   (SELECT v.value FROM core.setting_values v \
                     WHERE v.\"key\" = s.\"key\" AND v.scope_type = 'instance') AS instance_value \
              FROM core.settings s \
             ORDER BY s.\"key\"",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "export: paramètres de l'instance");
            AppError::Database(e)
        })?;

    // The `~*` redaction and the `COALESCE(instance override, default)` are done
    // here: a credential-looking key becomes `"(masqué)"`, everything else keeps
    // the instance value if one is set, else the default.
    let assembled: Vec<Value> = rows
        .into_iter()
        .map(|s| {
            let value = if setting_is_secret(&s.key) {
                json!("(masqué)")
            } else {
                s.instance_value.or(s.default_value.clone()).unwrap_or(Value::Null)
            };
            json!({
                "key": s.key,
                "category": s.category,
                "label": s.label,
                "description": s.description,
                "value_type": s.value_type,
                "default_value": s.default_value,
                "updated_at": s.updated_at,
                "value": value,
            })
        })
        .collect();
    Ok(Value::Array(assembled))
}

/// The whole administrative audit trail, as CSV.
pub async fn instance_audit_csv(db: &DbPool) -> Result<String, AppError> {
    let mut out = String::from(crate::audit::query::CSV_HEADER);
    let mut cursor: Option<String> = None;
    let mut written: i64 = 0;

    // Paged rather than fetched in one statement: the trail of a long-lived
    // instance is millions of rows, and a single `fetch_all` would hold all of
    // them in memory at once, inside a background job that is also holding an
    // archive open.
    loop {
        let page = crate::audit::query::list(
            db,
            &crate::audit::query::AuditQuery {
                limit: Some(1_000),
                cursor: cursor.clone(),
                ..Default::default()
            },
        )
        .await?;

        for row in &page.rows {
            out.push_str(&crate::audit::query::csv_line(row));
        }
        written += page.rows.len() as i64;

        match page.next_cursor {
            Some(next) if written < INSTANCE_AUDIT_LIMIT => cursor = Some(next),
            _ => break,
        }
    }
    Ok(out)
}
