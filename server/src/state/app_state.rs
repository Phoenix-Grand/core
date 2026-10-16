use crate::{
    config::Settings,
    events::EventBus,
    modules::registry::ModuleRegistry,
    modules::usage::UsageMeter,
    network::TlsRuntime,
    websocket::hub::WsHub,
};
use kubuno_db::DbPool;
use kubuno_storage::StorageBackend;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::storage::remote::RemoteMountService;

#[derive(Clone)]
pub struct AppState {
    pub db:       DbPool,
    pub settings: Arc<Settings>,
    pub events:   Arc<EventBus>,
    pub modules:  Arc<RwLock<ModuleRegistry>>,
    pub storage:  Arc<dyn StorageBackend>,
    pub ws_hub:   Arc<WsHub>,
    /// Centralised remote mounts (connectors + cache + encryption).
    pub remote_mounts: Arc<RemoteMountService>,
    /// Attendance counter fed by the module proxy - which account used which
    /// application, aggregated by day (see [`crate::modules::usage`]).
    pub usage: Arc<UsageMeter>,
    /// Live TLS state: the reloadable rustls config the HTTPS listener serves
    /// and the HSTS header the response layer emits (see [`crate::network`]).
    pub tls: Arc<TlsRuntime>,
}
