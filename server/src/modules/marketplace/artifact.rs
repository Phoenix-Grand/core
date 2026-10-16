//! Résolution de l'artefact installable dans les **Releases GitHub** du dépôt du
//! module, pour l'OS/arch sur lequel tourne le core.
//!
//! **Un seul format : `.kbpkg`.** Un module n'est pas un logiciel système ; il
//! n'enregistre aucun service et la marketplace n'a jamais appelé `dpkg`. Le
//! `.kbpkg` (archive ZIP dont la racine est le dossier du module) est le seul
//! format que le core installe - le seul aussi qu'il déballe sans outil externe,
//! donc le seul qui marche à l'identique sur Linux, Windows et macOS. Les paquets
//! système (`.deb`, `.rpm`, `.exe`, `.pkg`) ne sont plus ni produits ni acceptés
//! pour un module ; un module qui n'aurait publié que ceux-là pour la plateforme
//! du core est refusé franchement plutôt que téléchargé pour rien.

use serde::Deserialize;

use crate::errors::AppError;

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    /// Empreinte fournie par GitHub, format `sha256:<hex>` (peut être absente sur
    /// d'anciennes releases).
    #[serde(default)]
    digest: Option<String>,
}
#[derive(Deserialize)]
struct GhRelease {
    #[serde(default)]
    assets: Vec<GhAsset>,
}

/// Extrait `owner/repo` d'une URL `https://github.com/owner/repo`.
fn parse_owner_repo(repo_url: &str) -> Option<(String, String)> {
    let rest = repo_url.strip_prefix("https://github.com/")?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let mut it = rest.split('/');
    let owner = it.next()?.to_string();
    let name = it.next()?.to_string();
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    Some((owner, name))
}

/// `true` si `name` désigne un paquet Kubuno - le seul format d'un module.
pub(super) fn is_kbpkg(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".kbpkg")
}

/// Artefact résolu : URL + empreinte SHA-256 (si publiée). Le format est
/// implicite - c'est toujours un `.kbpkg` (archive ZIP).
pub(super) struct Artifact {
    pub url:    String,
    pub sha256: Option<String>,
}

/// Une URL d'artefact est-elle acceptable ?
///
/// HTTPS exigé : le catalogue est authentifié par sa signature, mais l'artefact
/// se télécharge ailleurs - en clair, n'importe qui sur le chemin le remplace.
/// L'empreinte le rattraperait, sauf qu'on ne veut pas dépendre d'un seul
/// rempart. Exception faite de la boucle locale, qui n'a pas de chemin réseau à
/// détourner et sans laquelle on ne peut pas éprouver le dispositif.
fn acceptable_url(url: &str) -> bool {
    if url.starts_with("https://") {
        return true;
    }
    url.starts_with("http://127.0.0.1")
        || url.starts_with("http://localhost")
        || url.starts_with("http://[::1]")
}

/// Traduit la recommandation du catalogue en artefact téléchargeable.
///
/// Le catalogue a déjà fait le tri pour la plateforme annoncée ; il reste à
/// vérifier que c'est bien un `.kbpkg` - refuser franchement vaut mieux que
/// télécharger cinquante mégaoctets pour buter dessus.
pub(super) fn from_recommendation(a: &crate::modules::marketplace::catalog::CatalogArtifact)
    -> Option<Artifact>
{
    if !acceptable_url(&a.url) {
        tracing::error!(url = %a.url, "Marketplace : artefact proposé hors HTTPS - ignoré");
        return None;
    }
    if !a.kind.eq_ignore_ascii_case("kbpkg") && !is_kbpkg(&a.filename) {
        tracing::warn!(kind = %a.kind, asset = %a.filename,
            "Marketplace : le catalogue recommande un format qui n'est pas .kbpkg - ignoré");
        return None;
    }
    tracing::info!(asset = %a.filename, "Marketplace : artefact .kbpkg recommandé par le catalogue");
    Some(Artifact { url: a.url.clone(), sha256: a.sha256.as_ref().map(|h| h.to_ascii_lowercase()) })
}

/// Choisit, parmi ce que le catalogue annonce, le `.kbpkg` installable ici.
///
/// Le catalogue dit ce que chaque module publie réellement ; il n'y a donc plus à
/// deviner d'après un nom de fichier. Deux refus explicites valent mieux qu'un
/// choix approximatif :
///   - un artefact d'une autre plateforme n'est jamais retenu ;
///   - tout format qui n'est pas `.kbpkg` (`.deb`, `.rpm`, `.exe`, `.pkg`, `.tar.gz`)
///     est ignoré : un module s'installe uniquement par son paquet Kubuno.
pub(super) fn from_catalogue(arts: &[crate::modules::marketplace::catalog::CatalogArtifact])
    -> Option<Artifact>
{
    let os   = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    let hit = arts.iter().find(|a| {
        acceptable_url(&a.url)
            && (a.kind.eq_ignore_ascii_case("kbpkg") || is_kbpkg(&a.filename))
            && a.os.eq_ignore_ascii_case(os)
            && (a.arch.eq_ignore_ascii_case(arch) || a.arch.eq_ignore_ascii_case("universal"))
    })?;
    tracing::info!(
        asset = %hit.filename,
        "Marketplace : paquet .kbpkg désigné par le catalogue pour {os}/{arch}"
    );
    Some(Artifact {
        url: hit.url.clone(),
        sha256: hit.sha256.as_ref().map(|h| h.to_ascii_lowercase()),
    })
}

/// Suffixe de nom d'asset du `.kbpkg` pour l'OS/arch **du core**. Le nom porte la
/// cible - `<id>-<version>-<os>-<arch>.kbpkg` - avec les noms de Rust
/// (`std::env::consts`), identiques à ceux que `build_kbpkg.sh` grave.
fn kbpkg_suffix() -> String {
    format!("-{}-{}.kbpkg", std::env::consts::OS, std::env::consts::ARCH)
}

/// Résout le `.kbpkg` adapté à l'OS/arch du core pour `repo` à la `version` donnée.
/// Tente d'abord la release taguée `v<version>`, puis se rabat sur la dernière release.
pub(super) async fn resolve_artifact(
    http: &reqwest::Client,
    repo_url: &str,
    version: &str,
) -> Result<Artifact, AppError> {
    let (owner, name) = parse_owner_repo(repo_url)
        .ok_or_else(|| AppError::Validation(format!("dépôt invalide : {repo_url}")))?;
    let suffix = kbpkg_suffix();

    let candidates = [
        format!("https://api.github.com/repos/{owner}/{name}/releases/tags/v{version}"),
        format!("https://api.github.com/repos/{owner}/{name}/releases/latest"),
    ];

    for url in candidates {
        let resp = match http.get(&url).send().await {
            Ok(r) if r.status().is_success() => r,
            _ => continue,
        };
        let rel: GhRelease = match resp.json().await {
            Ok(r) => r,
            Err(_) => continue,
        };
        // Cherche le .kbpkg de cet OS/arch.
        if let Some(a) = rel.assets.iter().find(|a| a.name.to_ascii_lowercase().ends_with(suffix.as_str())) {
            let sha256 = a.digest.as_deref()
                .and_then(|d| d.strip_prefix("sha256:"))
                .map(|h| h.to_ascii_lowercase());
            tracing::info!(module = %name, asset = %a.name, "Marketplace : paquet .kbpkg choisi pour {}/{}", std::env::consts::OS, std::env::consts::ARCH);
            return Ok(Artifact { url: a.browser_download_url.clone(), sha256 });
        }
    }
    Err(AppError::NotFound(format!(
        "aucun paquet .kbpkg {}/{} dans les releases de {owner}/{name}",
        std::env::consts::OS, std::env::consts::ARCH
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::marketplace::catalog::{CatalogArtifact, MarketModule};

    fn art(os: &str, arch: &str, kind: &str) -> CatalogArtifact {
        CatalogArtifact {
            os: os.into(), arch: arch.into(), kind: kind.into(),
            filename: format!("kubuno-drive.{kind}"),
            url: format!("https://example.test/kubuno-drive.{kind}"),
            size: 1, sha256: Some("ABCDEF".into()),
        }
    }

    /// The catalogue's own payload must deserialize, artefacts included -
    /// otherwise the server silently falls back to guessing.
    #[test]
    fn reads_a_real_catalogue_payload() {
        let json = include_str!("testdata/catalogue_drive.json");
        let m: MarketModule = serde_json::from_str(json).expect("payload du catalogue");
        assert_eq!(m.id, "drive");
        assert!(!m.artifacts.is_empty(), "les artefacts doivent être lus");
    }

    #[test]
    fn ignores_other_platforms() {
        let other = if std::env::consts::OS == "linux" { "windows" } else { "linux" };
        assert!(from_catalogue(&[art(other, std::env::consts::ARCH, "kbpkg")]).is_none());
    }

    /// A module that ships anything but a `.kbpkg` cannot be installed: the server
    /// installs modules from their Kubuno package only.
    #[test]
    fn refuses_every_non_kbpkg_format() {
        let os = std::env::consts::OS;
        let arch = std::env::consts::ARCH;
        assert!(from_catalogue(&[
            art(os, arch, "deb"), art(os, arch, "rpm"),
            art(os, arch, "exe"), art(os, arch, "pkg"), art(os, arch, "tar.gz"),
        ]).is_none());
    }

    #[test]
    fn picks_the_kbpkg_for_this_platform() {
        let os = std::env::consts::OS;
        let arch = std::env::consts::ARCH;
        // Le .kbpkg est retenu même quand un .deb l'accompagne encore.
        let chosen = from_catalogue(&[art(os, arch, "deb"), art(os, arch, "kbpkg")]).expect("un .kbpkg");
        assert!(chosen.url.ends_with(".kbpkg"));
        // L'empreinte est normalisée en minuscules pour la comparaison.
        assert_eq!(chosen.sha256.as_deref(), Some("abcdef"));
        // Sans .kbpkg, rien n'est installable - même si un .deb existe.
        assert!(from_catalogue(&[art(os, arch, "deb")]).is_none());
    }

    #[test]
    fn accepts_a_universal_build() {
        let os = std::env::consts::OS;
        assert!(from_catalogue(&[art(os, "universal", "kbpkg")]).is_some());
    }
}

#[cfg(test)]
mod recommendation_tests {
    use super::*;
    use crate::modules::marketplace::catalog::CatalogArtifact;

    fn rec(kind: &str) -> CatalogArtifact {
        CatalogArtifact {
            os: std::env::consts::OS.into(), arch: std::env::consts::ARCH.into(),
            kind: kind.into(), filename: format!("kubuno-drive.{kind}"),
            url: format!("https://example.test/kubuno-drive.{kind}"),
            size: 1, sha256: Some("ABCDEF".into()),
        }
    }

    /// A `.kbpkg` recommendation is followed, with its digest.
    #[test]
    fn follows_a_kbpkg_recommendation() {
        let chosen = from_recommendation(&rec("kbpkg")).expect("format connu du core");
        assert!(chosen.url.ends_with(".kbpkg"));
        assert!(chosen.sha256.is_some(), "l'empreinte accompagne la recommandation");
    }

    /// Any non-`.kbpkg` recommendation is declined: a module installs from its
    /// Kubuno package only.
    #[test]
    fn declines_a_non_kbpkg_recommendation() {
        for kind in ["deb", "rpm", "exe", "pkg", "tar.gz"] {
            assert!(from_recommendation(&rec(kind)).is_none(), "{kind} doit être refusé");
        }
    }
}
