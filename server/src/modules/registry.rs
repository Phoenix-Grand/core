use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleRoute {
    pub method: String,
    pub path:   String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarItem {
    pub id:               String,
    pub label:            String,
    pub icon:             String,
    pub path:             String,
    pub position:         i32,
    pub badge:            Option<String>,
    pub section:          Option<String>,
    pub protected_folder: Option<String>,
    /// Whether this entry is a launchable app (`true`) or an internal view/filter of
    /// another app (`false`, e.g. Drive's "Shared with me" / "Trash"). Defaults to
    /// `true` for backward compatibility - modules mark their views explicitly.
    /// Consumed by the desktop launcher to list only real apps (the web sidebar
    /// keeps showing every item as navigation).
    #[serde(default = "default_launchable")]
    pub launchable:       bool,
}

fn default_launchable() -> bool {
    true
}

#[derive(Debug, Clone)]
pub struct ActiveInstance {
    pub module_id:         String,
    pub base_url:          String,
    pub routes:            Vec<ModuleRoute>,
    pub sidebar_items:     Vec<SidebarItem>,
    pub subscribed_events: Vec<String>,
    pub registered_at:     DateTime<Utc>,
    pub last_heartbeat:    DateTime<Utc>,
}

#[derive(Debug, Default)]
pub struct ModuleRegistry {
    instances: HashMap<String, ActiveInstance>,
}

impl ModuleRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, instance: ActiveInstance) {
        tracing::info!(module_id = %instance.module_id, base_url = %instance.base_url, "Module enregistré");
        self.instances.insert(instance.module_id.clone(), instance);
    }

    pub fn unregister(&mut self, module_id: &str) {
        self.instances.remove(module_id);
        tracing::info!(module_id = %module_id, "Module désenregistré");
    }

    pub fn get(&self, module_id: &str) -> Option<&ActiveInstance> {
        self.instances.get(module_id)
    }

    pub fn all(&self) -> Vec<&ActiveInstance> {
        self.instances.values().collect()
    }

    pub fn update_heartbeat(&mut self, module_id: &str) -> bool {
        if let Some(inst) = self.instances.get_mut(module_id) {
            inst.last_heartbeat = Utc::now();
            true
        } else {
            false
        }
    }

    pub fn sidebar_items(&self) -> Vec<SidebarItem> {
        let mut items: Vec<SidebarItem> = self
            .instances
            .values()
            .flat_map(|i| i.sidebar_items.clone())
            .collect();
        items.sort_by_key(|i| i.position);
        items
    }
}
