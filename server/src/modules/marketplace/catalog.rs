//! Catalogue distant : client HTTP partagé, modèles et lectures du registre
//! servi par kubuno.com (`GET /api/v1/modules[/:id]`).

use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};

use crate::errors::AppError;

/// Base du catalogue public.
///
/// Le catalogue a quitté `www.kubuno.com/api/v1` pour son propre service, sur
/// `api.kubuno.com/v1` : l'ancienne adresse répond désormais 404. Elle est
/// surchargeable par `KUBUNO_MARKETPLACE_URL`, ce qui sert à deux choses -
/// éprouver un core contre un catalogue local, et permettre à une instance de
/// suivre un catalogue qui n'est pas celui de kubuno.com.
const CATALOG_DEFAULT: &str = "https://api.kubuno.com/v1/modules";

pub(super) fn catalog_base() -> String {
    std::env::var("KUBUNO_MARKETPLACE_URL")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| CATALOG_DEFAULT.to_string())
}
const USER_AGENT: &str = "Kubuno-Core/marketplace";

// ── Modèles du catalogue ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MarketLinks {
    #[serde(rename = "self", default)]
    pub self_url: Option<String>,
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
}

/// Un artefact publié par un module, tel que le catalogue le décrit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogArtifact {
    /// `linux` | `windows` | `macos`
    pub os:   String,
    /// `x86_64` | `aarch64` | `universal`
    pub arch: String,
    /// `kbpkg` | `deb` | `rpm` | `exe` | `pkg`
    pub kind: String,
    #[serde(default)]
    pub filename: String,
    pub url:  String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub sha256: Option<String>,
}

/// Optional, locale-keyed display metadata. IDs and install data are never localized.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MarketText {
    pub name: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketModule {
    pub id:      String,
    pub name:    String,
    pub version: String,
    #[serde(default)]
    pub author:      Option<String>,
    #[serde(default)]
    pub official:    bool,
    #[serde(default)]
    pub category:    Option<String>,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub localizations: Option<BTreeMap<String, MarketText>>,
    #[serde(default)]
    pub accent:      Option<String>,
    #[serde(default)]
    pub summary:     Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub license:     Option<String>,
    #[serde(default)]
    pub tags:        Vec<String>,
    #[serde(default)]
    pub rating:      Option<f64>,
    #[serde(default)]
    pub updated:     Option<String>,
    #[serde(default)]
    pub links:       MarketLinks,
    /// URL directe de l'artefact `.deb` servi par la marketplace. ABSENTE aujourd'hui
    /// (le catalogue ne fournit que des métadonnées → on résout la Release GitHub) ;
    /// quand kubuno.com servira les artefacts, il suffira que le détail expose ce champ
    /// (+ `sha256`) pour que le core télécharge directement, SANS modification.
    #[serde(default, alias = "artifact_url", alias = "download")]
    pub download_url: Option<String>,
    /// Ce que le module publie réellement, par plateforme. Renseigné par le
    /// catalogue à partir des releases du module : sans lui, le core doit
    /// DEVINER l'artefact d'après un suffixe de nom de fichier, une devinette qui
    /// n'a jamais correspondu à ce que produisent Windows et macOS.
    #[serde(default)]
    pub artifacts: Vec<CatalogArtifact>,
    /// Ce que le catalogue recommande d'installer **pour la plateforme annoncée
    /// dans la requête**. Le choix appartient au catalogue : il peut ainsi
    /// changer de règle - préférer le format unique à un paquet système - sans
    /// qu'aucune instance déjà déployée n'ait à être mise à jour.
    #[serde(default)]
    pub artifact: Option<CatalogArtifact>,
    /// Empreinte SHA-256 hex de l'artefact `download_url` (vérification d'intégrité).
    #[serde(default, alias = "sha256sum", alias = "checksum")]
    pub sha256:       Option<String>,
}

// ── Client HTTP ──────────────────────────────────────────────────────────────

pub(super) fn client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("client HTTP marketplace: {e}")))
}

/// Plateforme du core, telle qu'annoncée au catalogue.
///
/// Sans elle, le catalogue renverrait les artefacts de tous les systèmes et il
/// reviendrait à chaque core de trier - ce qu'il faisait, mal, en devinant
/// d'après un suffixe de nom de fichier.
fn platform_query() -> String {
    // Les noms de la bibliothèque standard sont déjà ceux qu'attend le catalogue.
    format!("os={}&arch={}", std::env::consts::OS, std::env::consts::ARCH)
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}

/// Récupère le catalogue complet des modules disponibles.
pub async fn fetch_catalog() -> Result<Vec<MarketModule>, AppError> {
    let resp = client()?
        .get(format!("{}?{}", catalog_base(), platform_query()))
        .send()
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("appel catalogue marketplace: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Internal(anyhow::anyhow!(
            "catalogue marketplace: statut {}",
            resp.status()
        )));
    }
    let env: Envelope<Vec<MarketModule>> = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("parse catalogue marketplace: {e}")))?;
    Ok(env.data)
}

/// Récupère le détail d'un module du catalogue.
pub async fn fetch_detail(id: &str) -> Result<MarketModule, AppError> {
    validate_id(id)?;
    let url = format!("{}/{id}?{}", catalog_base(), platform_query());
    let resp = client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("appel détail marketplace: {e}")))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::NotFound(format!("module marketplace « {id} »")));
    }
    if !resp.status().is_success() {
        return Err(AppError::Internal(anyhow::anyhow!(
            "détail marketplace: statut {}",
            resp.status()
        )));
    }
    let env: Envelope<MarketModule> = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("parse détail marketplace: {e}")))?;
    Ok(env.data)
}

/// Valide un id de module (anti-traversée) : alphanumériques, `-`, `_`.
pub fn validate_id(id: &str) -> Result<(), AppError> {
    if id.is_empty()
        || id.len() > 50
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::Validation(format!("Invalid module ID: '{id}'")));
    }
    Ok(())
}

#[cfg(test)]
mod localization_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retains_localizations_and_stable_ids_without_changing_legacy_metadata() {
        let value = json!({
            "id": "calendar", "name": "Calendar", "version": "1.0",
            "category": "Bureautique", "category_id": "office", "summary": "Agendas",
            "localizations": {
                "en": { "summary": "Calendars", "description": "" },
                "fr": { "summary": "Agendas" },
                "pt-BR": { "name": "Calendário" }
            }
        });
        let module: MarketModule = serde_json::from_value(value.clone()).unwrap();
        let encoded = serde_json::to_value(module).unwrap();
        for field in ["id", "name", "version", "category", "category_id", "summary"] {
            assert_eq!(encoded[field], value[field]);
        }
        assert_eq!(encoded["localizations"]["en"]["summary"], "Calendars");
        assert_eq!(encoded["localizations"]["en"]["description"], "");
        assert_eq!(encoded["localizations"]["pt-BR"]["name"], "Calendário");
    }

    #[test]
    fn accepts_catalogs_without_localizations_and_explicit_nulls() {
        for extra in [json!({}), json!({"localizations": null, "category_id": null})] {
            let mut value = json!({"id": "custom", "name": "Custom", "version": "1.0"});
            value.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            let module: MarketModule = serde_json::from_value(value).unwrap();
            assert!(module.localizations.is_none());
            assert!(module.category_id.is_none());
        }
    }
}
