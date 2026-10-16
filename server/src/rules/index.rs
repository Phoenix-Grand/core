//! The memory index: which rules concern which event type.
//!
//! ## Why nothing is queried on the hot path
//!
//! Every event on the bus would otherwise cost at least one `SELECT` to ask
//! "does any rule care?", and the honest answer on almost every instance is
//! "no". An index rebuilt on change and read from memory turns that question
//! into a hash lookup, so an instance with no rules pays approximately nothing
//! for having the engine compiled in.
//!
//! ## How it stays fresh across processes
//!
//! A rule write ends with `pg_notify('kubuno_rules', …)`
//! ([`super::store::notify_reload`]). Every core process listens on that
//! channel and rebuilds. The listener also rebuilds on reconnect, because a
//! `NOTIFY` sent while the listener was reconnecting is lost - the same failure
//! mode the job runner handles by polling, answered here by the fact that a
//! rebuild is cheap and idempotent.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, RwLock};

use sqlx::postgres::PgListener;

use kubuno_db::{params, DbPool};

use crate::errors::AppError;

use super::model::Rule;
use super::store::{self, RULES_CHANNEL};

/// A compiled rule: the rule itself plus the event type its trigger listens to,
/// resolved once at load rather than per event.
#[derive(Debug, Clone)]
pub struct CompiledRule {
    pub rule: Rule,
    pub event_type: String,
}

/// The whole index, replaced atomically on every reload.
#[derive(Debug, Default)]
pub struct RuleIndex {
    by_event: HashMap<String, Vec<Arc<CompiledRule>>>,
    /// The same rules, keyed by trigger.
    ///
    /// The asynchronous path asks "which rules care about this *event*"; the
    /// synchronous gate asks "which rules care about this *trigger*", because a
    /// module naming an operation names the catalogue entry it declared, not a
    /// bus event type. Two maps over one list rather than a scan, for the same
    /// reason `by_event` exists: the question is asked on a path a user is
    /// waiting on.
    by_trigger: HashMap<String, Vec<Arc<CompiledRule>>>,
    /// Number of rules loaded, for the health surface and the logs.
    pub len: usize,
}

impl RuleIndex {
    /// Rules attached to `trigger_key`, already ordered by priority.
    pub fn for_trigger(&self, trigger_key: &str) -> &[Arc<CompiledRule>] {
        self.by_trigger
            .get(trigger_key)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
}

impl RuleIndex {
    /// Rules concerning `event_type`, already ordered by priority.
    ///
    /// Returns an empty slice for an event nobody wrote a rule about, which is
    /// the overwhelmingly common case and costs one hash lookup.
    pub fn for_event(&self, event_type: &str) -> &[Arc<CompiledRule>] {
        self.by_event
            .get(event_type)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// Does any rule at all watch this event type?
    pub fn watches(&self, event_type: &str) -> bool {
        self.by_event.contains_key(event_type)
    }

    pub fn is_empty(&self) -> bool {
        self.by_event.is_empty()
    }
}

static INDEX: LazyLock<RwLock<Arc<RuleIndex>>> =
    LazyLock::new(|| RwLock::new(Arc::new(RuleIndex::default())));

/// The current index. Cheap: one lock acquisition and an `Arc` clone.
pub fn snapshot() -> Arc<RuleIndex> {
    match INDEX.read() {
        Ok(guard) => Arc::clone(&guard),
        Err(poisoned) => {
            // A poisoned lock means a panic happened while holding it. Serving
            // the value anyway is strictly better than propagating the panic
            // into the event worker, which would stop the engine for good.
            tracing::error!("rules: verrou de l'index empoisonné, lecture forcée");
            Arc::clone(&poisoned.into_inner())
        }
    }
}

/// One `(trigger key, event type)` mapping row.
#[derive(sqlx::FromRow)]
struct TriggerEvent {
    key: String,
    event_type: String,
}

/// Rebuilds the index from the database.
pub async fn reload(db: &DbPool) -> Result<usize, AppError> {
    let rules = store::load_active(db).await?;

    // Trigger → event type, in one query rather than one per rule.
    let mappings = db
        .fetch_all_as::<TriggerEvent>(
            "SELECT \"key\", event_type FROM core.rule_triggers",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "rules: lecture des déclencheurs pour l'index");
            AppError::Database(e)
        })?;
    let event_of: HashMap<String, String> = mappings
        .into_iter()
        .map(|m| (m.key, m.event_type))
        .collect();

    let mut by_event: HashMap<String, Vec<Arc<CompiledRule>>> = HashMap::new();
    let mut by_trigger: HashMap<String, Vec<Arc<CompiledRule>>> = HashMap::new();
    let mut loaded = 0usize;
    for rule in rules {
        let Some(event_type) = event_of.get(&rule.trigger_key).cloned() else {
            // A rule whose trigger vanished. It cannot fire, and saying so once
            // per reload is better than saying nothing and letting an operator
            // believe it is armed.
            tracing::warn!(
                rule_id = %rule.id, trigger = %rule.trigger_key,
                "Règle ignorée : son déclencheur n'est plus au catalogue"
            );
            continue;
        };
        loaded += 1;
        let trigger_key = rule.trigger_key.clone();
        let compiled = Arc::new(CompiledRule { rule, event_type: event_type.clone() });
        by_event.entry(event_type).or_default().push(Arc::clone(&compiled));
        by_trigger.entry(trigger_key).or_default().push(compiled);
    }

    // `load_active` already ordered by (priority, created_at); the grouping
    // preserves it, and this makes the total ordering explicit rather than
    // dependent on a query in another file.
    let order = |a: &Arc<CompiledRule>, b: &Arc<CompiledRule>| {
        a.rule
            .priority
            .cmp(&b.rule.priority)
            .then_with(|| a.rule.created_at.cmp(&b.rule.created_at))
    };
    for rules in by_event.values_mut() {
        rules.sort_by(order);
    }
    for rules in by_trigger.values_mut() {
        rules.sort_by(order);
    }

    let index = Arc::new(RuleIndex {
        by_event,
        by_trigger,
        len: loaded,
    });
    match INDEX.write() {
        Ok(mut guard) => *guard = index,
        Err(poisoned) => {
            *poisoned.into_inner() = index;
            tracing::error!("rules: verrou de l'index empoisonné, écriture forcée");
        }
    }

    // The compiled detector set rides the same reload rather than owning a
    // second channel and a second listener. Two refresh mechanisms on one
    // instance are two mechanisms that can disagree about which is stale, and
    // the one that ends up stale is always the one nobody watches. Rebuilding a
    // dozen regular expressions on a rule write is not a cost worth a second
    // apparatus.
    match super::detect::store::reload(db).await {
        Ok(n) => tracing::debug!(détecteurs = n, "Détecteurs de contenu compilés"),
        Err(e) => tracing::error!(error = %e, "rules: rechargement des détecteurs de contenu"),
    }

    tracing::info!(règles = loaded, "Index des règles rechargé");
    Ok(loaded)
}

/// Listens for rule changes and rebuilds the index.
///
/// Rebuilds once on connection too, which covers both the startup case and a
/// reconnection during which a notification was lost.
pub async fn start_listener(db: DbPool) {
    // FLAG: PostgreSQL-only. Live reload rides `LISTEN/NOTIFY`; on MySQL and
    // SQLite there is no such channel, so the index is built once here and then
    // refreshed only on process restart (or through the event outbox).
    let pg = match db.as_pg() {
        Some(pg) => pg.clone(),
        None => {
            if let Err(e) = reload(&db).await {
                tracing::error!(error = %e, "rules: rechargement initial de l'index");
            }
            tracing::warn!(
                "rules: écoute LISTEN/NOTIFY indisponible hors PostgreSQL, index figé jusqu'au redémarrage"
            );
            return;
        }
    };
    tokio::spawn(async move {
        loop {
            let mut listener = match PgListener::connect_with(&pg).await {
                Ok(l) => l,
                Err(e) => {
                    tracing::error!(error = %e, "rules: connexion de l'écouteur impossible, nouvelle tentative");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
            if let Err(e) = listener.listen(RULES_CHANNEL).await {
                tracing::error!(error = %e, "rules: écoute du canal impossible, nouvelle tentative");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }

            // A notification sent while this task was reconnecting is gone, so
            // the reconnection itself is treated as a reason to rebuild.
            if let Err(e) = reload(&db).await {
                tracing::error!(error = %e, "rules: rechargement de l'index après connexion");
            }

            loop {
                match listener.recv().await {
                    Ok(_) => {
                        if let Err(e) = reload(&db).await {
                            tracing::error!(error = %e, "rules: rechargement de l'index");
                        }
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "rules: écouteur interrompu, reconnexion");
                        break;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::model::{Mode, Scope};
    use chrono::Utc;
    use uuid::Uuid;

    fn rule(priority: i32, name: &str) -> Rule {
        Rule {
            id: Uuid::new_v4(),
            name: name.into(),
            description: None,
            trigger_key: "core.account_created".into(),
            conditions: Default::default(),
            actions: vec![],
            mode: Mode::Monitor,
            scope: Scope::default(),
            threshold_count: None,
            threshold_window_s: None,
            rollout_percent: 100,
            severity: "warning".into(),
            priority,
            version: 1,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn an_event_nobody_watches_costs_one_lookup_and_returns_nothing() {
        let index = RuleIndex::default();
        assert!(index.is_empty());
        assert!(!index.watches("UserCreated"));
        assert!(index.for_event("UserCreated").is_empty());
    }

    #[test]
    fn rules_come_back_in_priority_order() {
        let mut by_event: HashMap<String, Vec<Arc<CompiledRule>>> = HashMap::new();
        let entries = vec![
            Arc::new(CompiledRule {
                rule: rule(50, "seconde"),
                event_type: "UserCreated".into(),
            }),
            Arc::new(CompiledRule {
                rule: rule(10, "première"),
                event_type: "UserCreated".into(),
            }),
        ];
        by_event.insert("UserCreated".into(), entries.clone());
        let mut by_trigger: HashMap<String, Vec<Arc<CompiledRule>>> = HashMap::new();
        by_trigger.insert("core.account_created".into(), entries);
        let mut index = RuleIndex {
            by_event,
            by_trigger,
            len: 2,
        };
        for rules in index.by_event.values_mut() {
            rules.sort_by_key(|r| r.rule.priority);
        }
        for rules in index.by_trigger.values_mut() {
            rules.sort_by_key(|r| r.rule.priority);
        }

        let found = index.for_event("UserCreated");
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].rule.name, "première");
        assert_eq!(found[1].rule.name, "seconde");
        assert!(index.watches("UserCreated"));

        // The gate asks by trigger, and gets the same rules in the same order.
        let by_key = index.for_trigger("core.account_created");
        assert_eq!(by_key.len(), 2);
        assert_eq!(by_key[0].rule.name, "première");
        assert!(index.for_trigger("core.unknown").is_empty());
    }
}
