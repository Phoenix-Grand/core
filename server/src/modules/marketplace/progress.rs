//! Suivi de progression d'installation (en mémoire).
//!
//! L'installation tourne en tâche de fond ; le frontend interroge l'état via
//! `GET /admin/marketplace/:id/status`. Phases : resolving → downloading →
//! verifying → extracting → starting → done | error.

use std::sync::{Mutex, OnceLock};
use std::collections::BTreeMap;

use serde::Serialize;

use crate::errors::AppError;

use super::install::InstallReport;

#[derive(Debug, Clone, Serialize)]
pub struct InstallProgress {
    pub phase:   String,
    pub message: String,
    /// Interpolation values for the stable phase, not pretranslated sentences.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report:  Option<InstallReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error:   Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<&'static str>,
}

static PROGRESS: OnceLock<Mutex<std::collections::HashMap<String, InstallProgress>>> = OnceLock::new();
fn progress_map() -> &'static Mutex<std::collections::HashMap<String, InstallProgress>> {
    PROGRESS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

pub(super) fn set_phase(id: &str, phase: &str, message: &str) {
    set_phase_params(id, phase, message, BTreeMap::new());
}

pub(super) fn set_dependency(id: &str, dependency: &str) {
    set_phase_params(id, "dependencies", &format!("Installing dependency '{dependency}'…"),
        BTreeMap::from([("dependency".to_string(), dependency.to_string())]));
}

fn set_phase_params(id: &str, phase: &str, message: &str, params: BTreeMap<String, String>) {
    if let Ok(mut m) = progress_map().lock() {
        m.insert(id.to_string(), InstallProgress {
            phase: phase.to_string(), message: message.to_string(), params,
            report: None, error: None, error_code: None,
        });
    }
}

/// État courant d'une installation (None si aucune n'a été lancée pour cet id).
pub fn get_progress(id: &str) -> Option<InstallProgress> {
    progress_map().lock().ok().and_then(|m| m.get(id).cloned())
}

/// Marque une installation « en file d'attente » (avant de lancer la tâche de fond).
pub fn begin(id: &str) {
    set_phase(id, "queued", "Queued…");
}

/// Marque l'installation terminée (avec le rapport) ou échouée (avec l'erreur).
pub fn finish_progress(id: &str, result: &Result<InstallReport, AppError>) {
    if let Ok(mut m) = progress_map().lock() {
        let entry = match result {
            Ok(r)  => InstallProgress { phase: "done".into(),  message: "Installed".into(),
                                        params: BTreeMap::new(), report: Some(r.clone()), error: None, error_code: None },
            Err(e) => InstallProgress { phase: "error".into(), message: "Failed".into(),
                                        params: BTreeMap::new(), report: None, error: Some(e.detail()),
                                        error_code: Some(match e {
                                            AppError::Unauthorized => "UNAUTHORIZED",
                                            AppError::Forbidden => "FORBIDDEN",
                                            AppError::Conflict(_) => "CONFLICT",
                                            AppError::NotFound(_) => "NOT_FOUND",
                                            AppError::Validation(_) => "VALIDATION_ERROR",
                                            _ => "INSTALL_FAILED",
                                        }) },
        };
        m.insert(id.to_string(), entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_parameters_are_structured_and_do_not_leak_into_later_phases() {
        let id = "test-localized-progress";
        begin(id);
        assert_eq!(get_progress(id).unwrap().message, "Queued…");
        set_dependency(id, "drive");
        let json = serde_json::to_value(get_progress(id).unwrap()).unwrap();
        assert_eq!(json["phase"], "dependencies");
        assert_eq!(json["params"]["dependency"], "drive");
        set_phase(id, "starting", "Starting module…");
        assert!(get_progress(id).unwrap().params.is_empty());
        progress_map().lock().unwrap().remove(id);
    }

    #[test]
    fn failure_preserves_diagnostics_alongside_a_stable_code() {
        let id = "test-localized-failure";
        finish_progress(id, &Err(AppError::Validation("Package is incompatible".into())));
        let value = get_progress(id).unwrap();
        assert_eq!(value.error_code, Some("VALIDATION_ERROR"));
        assert!(value.error.unwrap().contains("Package is incompatible"));
        assert_eq!(value.phase, "error");
        progress_map().lock().unwrap().remove(id);
    }
}
