//! Suivi de progression d'installation (en mémoire).
//!
//! L'installation tourne en tâche de fond ; le frontend interroge l'état via
//! `GET /admin/marketplace/:id/status`. Phases : resolving → downloading →
//! verifying → extracting → starting → done | error.

use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::errors::AppError;

use super::install::InstallReport;

#[derive(Debug, Clone, Serialize)]
pub struct InstallProgress {
    pub phase:   String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report:  Option<InstallReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error:   Option<String>,
}

static PROGRESS: OnceLock<Mutex<std::collections::HashMap<String, InstallProgress>>> = OnceLock::new();
fn progress_map() -> &'static Mutex<std::collections::HashMap<String, InstallProgress>> {
    PROGRESS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

pub(super) fn set_phase(id: &str, phase: &str, message: &str) {
    if let Ok(mut m) = progress_map().lock() {
        m.insert(id.to_string(), InstallProgress {
            phase: phase.to_string(), message: message.to_string(), report: None, error: None,
        });
    }
}

/// État courant d'une installation (None si aucune n'a été lancée pour cet id).
pub fn get_progress(id: &str) -> Option<InstallProgress> {
    progress_map().lock().ok().and_then(|m| m.get(id).cloned())
}

/// Marque une installation « en file d'attente » (avant de lancer la tâche de fond).
pub fn begin(id: &str) {
    set_phase(id, "queued", "En file d'attente…");
}

/// Marque l'installation terminée (avec le rapport) ou échouée (avec l'erreur).
pub fn finish_progress(id: &str, result: &Result<InstallReport, AppError>) {
    if let Ok(mut m) = progress_map().lock() {
        let entry = match result {
            Ok(r)  => InstallProgress { phase: "done".into(),  message: "Installed".into(),
                                        report: Some(r.clone()), error: None },
            Err(e) => InstallProgress { phase: "error".into(), message: "Failed".into(),
                                        report: None, error: Some(e.detail()) },
        };
        m.insert(id.to_string(), entry);
    }
}
