//! `job_type` → handler registry.
//!
//! The runner only knows the registry: a feature plugs its own job type in at
//! bootstrap and the runner picks it up, claiming *only* the types that are
//! registered. An unknown type therefore stays `pending` instead of being
//! burnt through its attempts by a process that cannot execute it (a module,
//! or a newer core, may be the one able to run it).

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use async_trait::async_trait;
use kubuno_db::DbPool;

use super::Job;

/// Everything a handler gets besides the job itself.
#[derive(Clone)]
pub struct JobContext {
    pub db: DbPool,
}

/// A unit of background work. Returning `Err` schedules a retry (see
/// [`super::queue::backoff_delay`]) until `max_attempts` is reached.
#[async_trait]
pub trait JobHandler: Send + Sync {
    async fn handle(&self, ctx: &JobContext, job: &Job) -> anyhow::Result<()>;
}

/// Adapter turning an async closure into a [`JobHandler`].
struct FnHandler<F>(F);

#[async_trait]
impl<F, Fut> JobHandler for FnHandler<F>
where
    F:   Fn(JobContext, Job) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = anyhow::Result<()>> + Send + 'static,
{
    async fn handle(&self, ctx: &JobContext, job: &Job) -> anyhow::Result<()> {
        (self.0)(ctx.clone(), job.clone()).await
    }
}

#[derive(Clone, Default)]
pub struct JobRegistry {
    handlers: HashMap<String, Arc<dyn JobHandler>>,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a handler. A second registration of the same type replaces the
    /// first one and is logged - silently ignoring it would hide a real bug.
    pub fn register<H: JobHandler + 'static>(&mut self, job_type: impl Into<String>, handler: H) {
        let job_type = job_type.into();
        if self.handlers.insert(job_type.clone(), Arc::new(handler)).is_some() {
            tracing::warn!(job_type = %job_type, "Type de tâche enregistré deux fois - le dernier gestionnaire l'emporte");
        }
    }

    /// Convenience form for handlers written as an async closure.
    pub fn register_fn<F, Fut>(&mut self, job_type: impl Into<String>, f: F)
    where
        F:   Fn(JobContext, Job) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = anyhow::Result<()>> + Send + 'static,
    {
        self.register(job_type, FnHandler(f));
    }

    pub fn get(&self, job_type: &str) -> Option<Arc<dyn JobHandler>> {
        self.handlers.get(job_type).cloned()
    }

    /// Types this runner is able to execute - the filter used when claiming.
    pub fn job_types(&self) -> Vec<String> {
        let mut types: Vec<String> = self.handlers.keys().cloned().collect();
        types.sort();
        types
    }

    pub fn len(&self) -> usize {
        self.handlers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registered_types_are_listed_and_resolvable() {
        let mut reg = JobRegistry::new();
        assert!(reg.is_empty());
        reg.register_fn("b.job", |_ctx, _job| async { Ok(()) });
        reg.register_fn("a.job", |_ctx, _job| async { Ok(()) });
        assert_eq!(reg.job_types(), vec!["a.job".to_string(), "b.job".to_string()]);
        assert!(reg.get("a.job").is_some());
        assert!(reg.get("inconnu").is_none());
        assert_eq!(reg.len(), 2);
    }
}
