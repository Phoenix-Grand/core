//! `/admin/security/dashboard` - the security overview, as panels of counted facts.
//!
//! # What this endpoint is allowed to say
//!
//! Every number below is a `COUNT(*)` over a table the core itself writes. There
//! is no estimation, no extrapolation, no sampling and no placeholder: a panel
//! either has a real series or is not returned at all. That constraint is what
//! makes the page worth opening - a security chart that guesses is worse than no
//! chart, because it is read as a measurement.
//!
//! # What it deliberately does NOT say
//!
//! The console this page is modelled on also charts message authentication
//! (SPF/DKIM/DMARC), transport encryption, spam filtering and external file
//! shares. Kubuno's core cannot: a module owns its own PostgreSQL schema and the
//! core never reads it. Those facts live in `mail`, in `drive`, in `photos` -
//! and until a module *declares* them, the honest rendering is their absence.
//!
//! The shape such a declaration would take is already settled by precedent:
//! `POST /internal/storage/usage` (see [`crate::handlers::storage_usage`]) is how
//! a module hands the core a figure about itself, authenticated by
//! `X-Internal-Secret` and attributed to the calling module. A security-metrics
//! channel would be its sibling - same authentication, same "the caller names
//! itself" arbitration, a closed vocabulary of metric ids instead of a closed
//! vocabulary of storage categories, and counters bucketed by day rather than
//! absolute totals. It is not built here because building a channel with no
//! producer would ship panels whose empty state reads as "nothing bad happened"
//! when it means "nobody measured". The report accompanying this change states
//! the contract in full.
//!
//! # Serving a report as well as a page
//!
//! The console's report page (`/admin/reports/<panel>`) is a printable document
//! about ONE panel over ONE period, and it reads this same endpoint - narrowed
//! by `?panel=<id>` and widened by `?full=true`. Both are explicit parameters
//! rather than a change of default: a report must name every country a sign-in
//! came from, and a dashboard must not pay for forty arcs to draw eight.
//! Everything else - the window, the comparison, the privileges - is the same
//! reading, so a figure printed on paper and the figure on the card can never
//! disagree.
//!
//! # Scope
//!
//! Every panel is an INSTANCE-WIDE aggregate, so each one is gated on its
//! privilege **at instance scope** ([`AdminContext::has_at_instance`]). A
//! delegated administrator holding `core.alerts.read` over one organisational
//! unit is not shown an instance-wide alert count with their unit's name implied
//! on it; the panel is withheld and named in `withheld`, so the console can say
//! why the page is short rather than leave a hole.

use axum::{
    extract::{Query, State},
    Json,
};
use kubuno_db::{params, DbPool};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::audit::AdminAudit;
use crate::authz::{keys, AdminCtx};
use crate::errors::AppError;
use crate::state::AppState;

// The records behind a figure. Keyed on the source TABLE, so three panels
// counting three predicates over one table list the same columns.
use super::detail::{self, DetailTable};
// The window, its closed list of periods and the three readers below it are
// shared with the general dashboard: two pages whose "−12 %" meant two different
// things would be worse than one page.
use super::period::{self, Counted, Point, Provenance, Slice, PERIODS};

// ── Sources ──────────────────────────────────────────────────────────────────

/// Where a panel's number comes from.
///
/// Every SQL fragment here is a `&'static str` written in this file. None of them
/// is ever assembled from a request: the only caller-supplied values in the
/// generated statements are bound parameters (the window bounds and the time
/// zone name).
struct Source {
    /// Stable id - the console's translation key and its layout key.
    id: &'static str,
    /// Privilege required AT INSTANCE SCOPE for the panel to be served.
    privilege: &'static str,
    /// Table, aliased `t`.
    table: &'static str,
    /// Timestamp column of `t` the window applies to.
    time: &'static str,
    /// Predicate narrowing `t` to the fact being counted.
    filter: &'static str,
    /// Expression to group the breakdown on, when the panel has one.
    breakdown: Option<&'static str>,
    /// True when the panel is read as a ranking (top N) rather than as parts of
    /// a whole. Only changes how the console draws it.
    ranking: bool,
    /// A limit of the measurement itself, printed under the chart. `None` when
    /// the count means exactly what its title says.
    caveat: Option<&'static str>,
}

/// Administrative actions that grant power, weaken authentication or open the
/// instance up. Written out rather than pattern-matched on a prefix: "sensitive"
/// is a judgement, and a judgement belongs in a list somebody can read.
const SENSITIVE_ACTIONS: &str = "t.action IN (\
    'core.roles.create', 'core.roles.update', 'core.roles.delete', \
    'core.role_assignments.create', 'core.role_assignments.delete', \
    'core.api_tokens.create', 'core.api_tokens.revoke', \
    'core.auth.two_factor.disable', 'core.auth.backup_codes.regenerate', \
    'core.auth.recovery.cli', \
    'core.users.delete', 'core.users.purge', 'core.users.password_reset', \
    'core.users.require_password_change', \
    'core.sessions.revoke_all', \
    'core.devices.approval', \
    'core.settings.change', \
    'core.auth_providers.create', 'core.auth_providers.update', \
    'core.auth_providers.delete', \
    'core.rules.set_mode', 'core.detectors.set_enabled', \
    'core.audit.export', 'core.audit.purge', \
    'core.reports.detail', \
    'core.themes.trust')";

/// The catalogue, in the order the console lays panels out by default.
const SOURCES: &[Source] = &[
    // ── Sign-in activity ─────────────────────────────────────────────────────
    Source {
        id: "signins",
        privilege: keys::SESSIONS_READ,
        table: "core.device_events",
        time: "occurred_at",
        filter: "t.kind = 'session_opened'",
        breakdown: None,
        ranking: false,
        caveat: None,
    },
    Source {
        id: "signin_methods",
        privilege: keys::SESSIONS_READ,
        table: "core.device_events",
        time: "occurred_at",
        filter: "t.kind = 'session_opened'",
        // `detail` carries the authentication strength for this event kind - see
        // `handlers::auth::tokens`, which writes it there at sign-in.
        breakdown: Some("t.detail"),
        ranking: false,
        caveat: None,
    },
    Source {
        id: "signin_countries",
        privilege: keys::SESSIONS_READ,
        table: "core.device_events",
        time: "occurred_at",
        filter: "t.kind = 'session_opened'",
        breakdown: Some("t.country"),
        ranking: true,
        // The country comes from an OPTIONAL local database; without it every
        // sign-in is "unknown" and the panel says so instead of reading as
        // "everybody signed in from nowhere".
        caveat: Some("country_db"),
    },
    Source {
        id: "login_failures",
        privilege: keys::AUDIT_READ,
        table: "core.admin_audit",
        time: "occurred_at",
        filter: "t.action = 'core.auth.login_failed'",
        breakdown: None,
        ranking: false,
        // Failed sign-ins are recorded for ADMINISTRATOR accounts only, on
        // purpose: auditing every miss on every unknown login would let a
        // stranger fill the trail at will (see `handlers::auth::login`).
        caveat: Some("admin_accounts_only"),
    },
    Source {
        id: "admin_denied",
        privilege: keys::AUDIT_READ,
        table: "core.admin_audit",
        time: "occurred_at",
        filter: "t.outcome <> 'success'",
        breakdown: Some("t.outcome"),
        ranking: false,
        caveat: None,
    },
    Source {
        id: "sensitive_actions",
        privilege: keys::AUDIT_READ,
        table: "core.admin_audit",
        time: "occurred_at",
        filter: SENSITIVE_ACTIONS,
        breakdown: Some("t.action"),
        ranking: true,
        caveat: None,
    },
    // ── Devices ──────────────────────────────────────────────────────────────
    Source {
        id: "new_devices",
        privilege: keys::SESSIONS_READ,
        table: "core.device_events",
        time: "occurred_at",
        filter: "t.kind = 'first_seen'",
        breakdown: None,
        ranking: false,
        caveat: None,
    },
    Source {
        id: "device_incidents",
        privilege: keys::SESSIONS_READ,
        table: "core.device_events",
        time: "occurred_at",
        // `disowned` is the account owner saying "that was not me" - the
        // strongest signal the product has. `blocked` is an operator's decision.
        filter: "t.kind IN ('blocked', 'disowned')",
        breakdown: Some("t.kind"),
        ranking: false,
        caveat: None,
    },
    // ── Alerts ───────────────────────────────────────────────────────────────
    Source {
        id: "alerts_opened",
        privilege: keys::ALERTS_READ,
        table: "core.alerts",
        time: "created_at",
        filter: "t.is_simulation = FALSE",
        breakdown: None,
        ranking: false,
        caveat: None,
    },
    Source {
        id: "alerts_severity",
        privilege: keys::ALERTS_READ,
        table: "core.alerts",
        time: "created_at",
        filter: "t.is_simulation = FALSE",
        breakdown: Some("t.severity"),
        ranking: false,
        caveat: None,
    },
    Source {
        id: "alerts_kinds",
        privilege: keys::ALERTS_READ,
        table: "core.alerts",
        time: "created_at",
        filter: "t.is_simulation = FALSE",
        breakdown: Some("t.kind"),
        ranking: true,
        caveat: None,
    },
    // ── Rules and content detectors ──────────────────────────────────────────
    Source {
        id: "rule_matches",
        privilege: keys::RULES_READ,
        table: "core.rule_executions",
        time: "occurred_at",
        filter: "t.outcome IN ('matched', 'acted') AND t.mode <> 'backtest'",
        breakdown: None,
        ranking: false,
        caveat: None,
    },
    Source {
        id: "top_rules",
        privilege: keys::RULES_READ,
        table: "core.rule_executions",
        time: "occurred_at",
        filter: "t.outcome IN ('matched', 'acted') AND t.mode <> 'backtest'",
        breakdown: Some("(SELECT r.name FROM core.rules r WHERE r.id = t.rule_id)"),
        ranking: true,
        caveat: None,
    },
    Source {
        id: "gate_blocks",
        privilege: keys::RULES_READ,
        table: "core.rule_executions",
        // A reference is minted only when a detector actually withheld
        // something: its presence IS the block (see migration 000070).
        time: "occurred_at",
        filter: "t.gate_reference IS NOT NULL",
        breakdown: None,
        ranking: false,
        caveat: None,
    },
];

/// Slices kept in a breakdown. Beyond this the tail is folded by the console
/// rather than given a colour of its own.
const MAX_SLICES: i64 = 8;

// ── Reading one panel ────────────────────────────────────────────────────────

impl Source {
    /// What this source counts, in the vocabulary the shared reader speaks.
    fn counted(&self) -> Counted {
        Counted::rows(self.table, self.time, self.filter)
    }

    /// The columns of the records behind the count.
    ///
    /// Read from the TABLE rather than declared per panel: `login_failures`,
    /// `admin_denied` and `sensitive_actions` are three predicates over one
    /// trail, and their records are the same records. Every source of this page
    /// counts rows of an event table, so every panel has a detail - a property
    /// the tests below hold in place rather than a coincidence.
    fn detail_columns(&self) -> Option<&'static [detail::DetailColumn]> {
        detail::for_table(self.table)
    }
}

#[derive(Debug, Serialize)]
struct Panel {
    id: &'static str,
    total: i64,
    previous_total: i64,
    ranking: bool,
    series: Vec<Point>,
    breakdown: Vec<Slice>,
    /// The breakdown stopped at the ceiling rather than at its own end. Printed
    /// by a report, which would otherwise present a cut list as a complete one.
    breakdown_truncated: bool,
    caveat: Option<&'static str>,
    /// Where the figure comes from - the table, the predicate, the unit. Read by
    /// the report page, which states the method under the tables.
    source: Provenance,
    /// The records behind the figure. Served only to a caller that asked for
    /// them (`?detail=true`), because a dashboard card has no use for two
    /// thousand rows and reading them is not free.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<DetailTable>,
    /// Why there are none, when there are none. A closed vocabulary
    /// ([`detail::absent`]) the console turns into one sentence - a heading with
    /// nothing under it reads as a rendering fault.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail_absent: Option<&'static str>,
}

// ── Retention ────────────────────────────────────────────────────────────────

/// How far back each source can actually answer.
///
/// Served with the page so the console can say, on a 180-day window, that the
/// rule log only keeps 90 - instead of drawing a flat start that reads as a quiet
/// quarter when it is a purged one.
async fn retention(db: &DbPool) -> Value {
    let rows: Vec<(String, Value)> = db
        .fetch_all_as::<(String, Value)>(
            "SELECT \"key\", value FROM core.settings \
              WHERE \"key\" IN ('security.audit_retention_days', 'alerts.retention_days', \
                            'rules.execution_retention_days')",
            params![],
        )
        .await
        .unwrap_or_else(|e| {
        // Best-effort: a missing retention note must not cost the operator the
        // whole page.
        tracing::error!(error = %e, "security_dashboard: rétentions");
        Vec::new()
    });

    let read = |key: &str, fallback: i64| -> i64 {
        rows.iter()
            .find(|(k, _)| k.as_str() == key)
            .and_then(|(_, v)| v.as_i64())
            .unwrap_or(fallback)
    };

    json!({
        "audit_days":           read("security.audit_retention_days", 400),
        "alerts_days":          read("alerts.retention_days", 180),
        "rule_executions_days": read("rules.execution_retention_days", 90),
        // Fixed in `core.cleanup_event_log()`, not a setting.
        "event_log_days":       30,
    })
}

// ── Handler ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DashboardQuery {
    /// One of [`PERIODS`]. Absent means [`period::DEFAULT_PERIOD`].
    #[serde(default)]
    pub period: Option<String>,
    /// Restricts the reading to ONE panel, named by its id.
    ///
    /// For the report page, which is a document about a single panel: computing
    /// the other twelve to throw them away is thirteen times the database work
    /// for a page that shows one of them.
    #[serde(default)]
    pub panel: Option<String>,
    /// Read the breakdowns in FULL rather than as the card's top-N.
    ///
    /// An explicit request rather than a raised ceiling: a dashboard drawing
    /// forty arcs would be a texture, and every caller paying a report's query
    /// cost to render eight rows would be a regression nobody asked for.
    #[serde(default)]
    pub full: Option<bool>,
    /// List the RECORDS behind each panel, not only their count.
    ///
    /// Explicit, and audited when it is honoured: these rows name people, and
    /// consulting them is an act of its own - the count says forty-seven failed
    /// sign-ins, the detail says whose. A dashboard never asks; a report always
    /// does.
    #[serde(default)]
    pub detail: Option<bool>,
}

/// `GET /api/v1/admin/security/dashboard` - every panel the caller may see.
pub async fn security_dashboard(
    State(state): State<AppState>,
    // `AdminAudit` performs the exact same authorisation `AdminUser` did - it is
    // built on it - and additionally carries the context needed to record the
    // consultation of the detail below.
    audit: AdminAudit,
    ctx: AdminCtx,
    Query(q): Query<DashboardQuery>,
) -> Result<Json<Value>, AppError> {
    // Opening the page at all. Each panel is narrowed again below, at instance
    // scope, because each one is an instance-wide aggregate.
    ctx.require(keys::AUDIT_READ)?;

    // Input validated before anything reaches the database: an unknown period
    // is refused rather than silently defaulted, so a mistyped address is not
    // read as a month of history.
    let period = period::validate(q.period.as_deref())?;
    // Same discipline for the panel: an id nobody serves is refused, never
    // answered with an empty page that reads as "this panel has no data".
    let only = match q.panel.as_deref() {
        None | Some("") => None,
        Some(asked) => Some(
            SOURCES
                .iter()
                .find(|s| s.id == asked)
                .map(|s| s.id)
                .ok_or_else(|| AppError::Validation(format!("panneau inconnu : « {asked} »")))?,
        ),
    };
    let full = q.full.unwrap_or(false);
    let wants_detail = q.detail.unwrap_or(false);
    let slices = period::slice_limit(full, MAX_SLICES);

    let tz = crate::settings::intl::instance_timezone(&state.db).await;
    let win = period::resolve_window(period, tz);

    let mut panels: Vec<Panel> = Vec::with_capacity(SOURCES.len());
    let mut withheld: Vec<&'static str> = Vec::new();

    for src in SOURCES {
        if only.is_some_and(|id| id != src.id) {
            continue;
        }
        if !ctx.has_at_instance(src.privilege) {
            withheld.push(src.id);
            continue;
        }

        let counted = src.counted();
        let (total, previous_total) = period::totals(&state.db, &counted, &win, src.id).await?;
        // A ranking has no time axis: "which rules fired most" is not a
        // question about a curve, and drawing one would be ink without a fact.
        let series = if src.ranking {
            Vec::new()
        } else {
            period::series(&state.db, &counted, &win, src.id).await?
        };
        let breakdown = match src.breakdown {
            Some(expr) => period::breakdown(&state.db, &counted, &win, expr, slices, src.id).await?,
            None => Vec::new(),
        };

        // The privilege that opened the panel is the one that opens its records:
        // the rows are the very facts the count is made of, read over the same
        // window, at the same instance scope. Nothing here widens what the
        // caller may already read - it only stops summarising it.
        let (records, records_absent) = match (wants_detail, src.detail_columns()) {
            (false, _) => (None, None),
            (true, Some(columns)) => (
                Some(detail::read(&state.db, &counted, &win, columns, src.id).await?),
                None,
            ),
            // Unreachable while every source counts rows of a described table -
            // held by `every_source_can_list_its_records` below. Stated anyway,
            // because a heading with nothing under it is worse than a sentence.
            (true, None) => (None, Some(detail::absent::AGGREGATED)),
        };

        panels.push(Panel {
            id: src.id,
            total,
            previous_total,
            ranking: src.ranking,
            breakdown_truncated: src.breakdown.is_some() && breakdown.len() as i64 >= slices,
            series,
            breakdown,
            caveat: src.caveat,
            source: counted.provenance(),
            detail: records,
            detail_absent: records_absent,
        });
    }

    // Reading the records is audited; reading the counts is not. See
    // `detail::record_consultation`.
    let served: Vec<(&'static str, usize, bool)> = panels
        .iter()
        .filter_map(|p| p.detail.as_ref().map(|d| (p.id, d.rows.len(), d.truncated)))
        .collect();
    detail::record_consultation(&state, &audit, period, &served).await;

    Ok(Json(json!({
        "period": {
            "id":            &win.id,
            "from":          win.from,
            "to":            win.to,
            "previous_from": win.previous_from,
            "previous_to":   win.from,
            "bucket":        win.bucket.id(),
            "timezone":      win.tz.name(),
        },
        "periods":   PERIODS,
        "panels":    panels,
        "withheld":  withheld,
        "retention": retention(&state.db).await,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Panel ids are the console's translation keys AND its layout keys. Two
    /// panels sharing one would make a hidden panel hide its twin.
    #[test]
    fn panel_ids_are_unique() {
        let mut ids: Vec<&str> = SOURCES.iter().map(|s| s.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "deux panneaux portent le même identifiant");
    }

    /// A ranking is drawn from its breakdown; one without would render empty.
    #[test]
    fn every_ranking_has_a_breakdown() {
        for src in SOURCES {
            assert!(
                !src.ranking || src.breakdown.is_some(),
                "{} est un classement sans répartition",
                src.id
            );
        }
    }

    /// Every panel of this page counts rows of an event table, so every one of
    /// them can list those rows. A source whose table had no catalogue would
    /// print "no records to list" under a figure made of nothing but records -
    /// the exact contradiction the detail was added to remove.
    #[test]
    fn every_source_can_list_its_records() {
        for src in SOURCES {
            assert!(
                src.detail_columns().is_some(),
                "{} ne sait pas lister ses enregistrements",
                src.id
            );
        }
    }

    /// The detail is a NARROWING of the count, never a second reading: it reads
    /// the table the provenance names, under the predicate the provenance
    /// states. Two sources disagreeing here would print rows a figure did not
    /// count.
    #[test]
    fn the_records_come_from_the_table_the_figure_names() {
        for src in SOURCES {
            let counted = src.counted();
            assert_eq!(counted.table, src.table);
            assert_eq!(counted.filter, src.filter);
            assert_eq!(counted.provenance().table, src.table);
        }
    }

    /// Every source names a table and a time column the shared reader can use.
    /// A source whose fragments were empty would generate a statement that does
    /// not parse, and it would only be found at run time.
    #[test]
    fn every_source_describes_something_countable() {
        for src in SOURCES {
            let counted = src.counted();
            assert!(!counted.table.is_empty(), "{} n'a pas de table", src.id);
            assert!(!counted.time.is_empty(), "{} n'a pas de colonne temporelle", src.id);
            assert!(!counted.filter.is_empty(), "{} n'a pas de filtre", src.id);
        }
    }
}
