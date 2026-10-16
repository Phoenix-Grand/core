//! The process-wide pieces the shell installs and the apps use: the platform secret store and the background runtime.
//!
//! The shell creates the OS keystore wrapper (Android Keystore, iOS Keychain) and installs it with
//! [`set_platform_store`] before the app's `setup` runs; the app (and the sign-in flow) then reach it with
//! [`platform_store`]. Network calls run on a small shared Tokio runtime ([`spawn`]), off the UI thread; they post their
//! results back with the renderer's `post_ui`.

use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};

use crate::secret::{MemorySecretStore, SecretStore};

static PLATFORM: Mutex<Option<Arc<dyn SecretStore>>> = Mutex::new(None);

/// Install the OS secret store (the shell does it once, before the app's `setup`).
pub fn set_platform_store(store: Arc<dyn SecretStore>) {
    if let Ok(mut slot) = PLATFORM.lock() {
        *slot = Some(store);
    }
}

/// The OS secret store the shell installed. Without one (host tools, tests) a process-wide in-memory store stands in,
/// so nothing survives a restart - logged once.
pub fn platform_store() -> Arc<dyn SecretStore> {
    if let Some(store) = PLATFORM.lock().ok().and_then(|s| s.clone()) {
        return store;
    }
    static FALLBACK: OnceLock<Arc<dyn SecretStore>> = OnceLock::new();
    FALLBACK
        .get_or_init(|| {
            tracing::warn!("no platform secret store installed: using an in-memory store (nothing is persisted)");
            Arc::new(MemorySecretStore::new())
        })
        .clone()
}

/// Run `fut` on the shared background runtime (two worker threads, started on first use). The future must hand its
/// result to the UI thread itself (the renderer's `post_ui`).
pub fn spawn<F>(fut: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    static RUNTIME: OnceLock<Option<tokio::runtime::Runtime>> = OnceLock::new();
    let rt = RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("kubuno-net")
            .enable_all()
            .build()
            .map_err(|e| tracing::error!("cannot start the background runtime: {e}"))
            .ok()
    });
    match rt {
        Some(rt) => {
            rt.spawn(fut);
        }
        None => tracing::error!("no background runtime: the task is dropped"),
    }
}
