//! Le manifeste signé du catalogue.
//!
//! Une empreinte authentifie un fichier **par rapport à une liste** ; rien
//! n'authentifie la liste. Qui prendrait le contrôle du site public réécrirait
//! l'empreinte et l'artefact d'un même geste : le core vérifierait, tout
//! concorderait, puisque c'est l'attaquant qui aurait calculé les deux.
//!
//! Le catalogue publie donc sa liste d'empreintes **signée en bloc** - une seule
//! signature Ed25519 pour tous les modules, toutes les plateformes. La clé privée
//! vit sur la machine d'administration, qui n'est jamais déployée ; le serveur
//! public ne détient que la signature. Une compromission du serveur public peut
//! donc altérer ce qui est servi, mais pas faire vérifier l'altération.
//!
//! C'est le modèle des dépôts Debian : une liste de sommes, et une signature
//! autour de la liste.

use serde::Deserialize;
use std::collections::HashMap;

use crate::errors::AppError;

/// Clé publique du catalogue officiel (Ed25519, base64).
///
/// Surchargée par `KUBUNO_MARKETPLACE_KEY` pour une instance qui suit un autre
/// catalogue que celui de kubuno.com.
const DEFAULT_PUBLIC_KEY: &str = "aYPR5XQemigRP5S0D4h86Ts923u9kbIlwUVILA0o91o=";

/// Une entrée du manifeste. Les champs de plateforme ne servent pas au core -
/// le catalogue a déjà choisi pour lui - mais ils sont conservés parce qu'ils
/// font partie des octets signés, et qu'un manifeste doit rester lisible pour un
/// humain qui l'inspecte.
#[derive(Debug, Clone, Deserialize)]
pub struct SignedArtifact {
    #[allow(dead_code)] pub os:       String,
    #[allow(dead_code)] pub arch:     String,
    #[allow(dead_code)] pub kind:     String,
    #[serde(default)]
    #[allow(dead_code)] pub filename: String,
    pub url:      String,
    #[serde(default)]
    pub sha256:   String,
}

#[derive(Debug, Deserialize)]
struct SignedModule {
    id: String,
    #[serde(default)]
    artifacts: Vec<SignedArtifact>,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    #[serde(default)]
    modules: Vec<SignedModule>,
}

/// Empreintes attestées par le catalogue, indexées par module puis par URL.
pub struct SignedDigests(HashMap<String, HashMap<String, String>>);

impl SignedDigests {
    /// L'empreinte signée pour cette URL, si le manifeste en porte une.
    pub fn digest_for(&self, module_id: &str, url: &str) -> Option<&str> {
        self.0.get(module_id)?.get(url).map(String::as_str)
    }
}

fn public_key() -> Vec<u8> {
    let b64 = std::env::var("KUBUNO_MARKETPLACE_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_PUBLIC_KEY.to_string());
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .unwrap_or_default()
}

/// Récupère le manifeste et **ne le rend que si la signature est valide**.
///
/// Un manifeste absent ou dont la signature ne vérifie pas ne vaut pas mieux
/// qu'aucun manifeste : dans les deux cas on rend `None`, et l'appelant applique
/// la politique (avertir, ou refuser si ce module était déjà signé).
pub async fn fetch_signed(http: &reqwest::Client, base: &str) -> Option<SignedDigests> {
    let url = format!("{base}/manifest");
    let resp = match http.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => {
            // État normal d'un catalogue qui n'a pas encore vérifié d'empreinte :
            // il n'y a rien à signer, donc rien à servir. Ce n'est pas une panne.
            tracing::info!("Marketplace : le catalogue ne publie pas encore de manifeste signé");
            return None;
        }
        Ok(r) => {
            tracing::warn!(status = %r.status(), "Marketplace : manifeste signé indisponible");
            return None;
        }
        Err(e) => {
            tracing::warn!(error = %e, "Marketplace : manifeste signé injoignable");
            return None;
        }
    };

    let sig_b64 = resp
        .headers()
        .get("x-kubuno-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(error = %e, "Marketplace : lecture du manifeste impossible");
            return None;
        }
    };

    if !verify(&body, &sig_b64) {
        // Volontairement sévère : un manifeste dont la signature ne vérifie pas
        // est plus inquiétant qu'un manifeste absent.
        tracing::error!("Marketplace : signature du manifeste INVALIDE - manifeste ignoré");
        return None;
    }

    let parsed: Manifest = match serde_json::from_slice(&body) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(error = %e, "Marketplace : manifeste illisible");
            return None;
        }
    };

    let mut map: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut n = 0usize;
    for m in parsed.modules {
        let entry = map.entry(m.id).or_default();
        for a in m.artifacts {
            if !a.sha256.is_empty() {
                entry.insert(a.url, a.sha256.to_ascii_lowercase());
                n += 1;
            }
        }
    }
    tracing::info!(empreintes = n, "Marketplace : manifeste signé vérifié");
    Some(SignedDigests(map))
}

/// Vérifie la signature détachée (Ed25519) sur les octets exacts du manifeste.
fn verify(body: &[u8], sig_b64: &str) -> bool {
    use base64::Engine;
    let sig = match base64::engine::general_purpose::STANDARD.decode(sig_b64.trim()) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let key = public_key();
    if key.len() != 32 || sig.len() != 64 {
        return false;
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &key)
        .verify(body, &sig)
        .is_ok()
}

/// Erreur d'un module déjà signé dont l'artefact n'est plus couvert par le
/// manifeste - alors que ce manifeste, lui, est bien là et valide.
pub fn downgrade_error(id: &str) -> AppError {
    AppError::Validation(format!(
        "« {id} » a déjà été installé depuis un catalogue signé, et le manifeste signé actuel ne \
         couvre pas l'artefact proposé. Installation refusée : une signature qui disparaît est une \
         régression, pas une nouveauté."
    ))
}

/// Erreur d'un module déjà signé alors que le manifeste est, lui, indisponible.
///
/// Distinguer les deux cas est ce qui sépare « on vous refuse un artefact
/// dégradé » de « on ne peut pas vérifier en ce moment » : le second se résout
/// tout seul, et l'administrateur doit savoir qu'il n'a rien à corriger.
pub fn unavailable_error(id: &str) -> AppError {
    AppError::Validation(format!(
        "« {id} » a déjà été installé depuis un catalogue signé, mais le manifeste signé du \
         catalogue est momentanément indisponible : impossible de vérifier l'origine de l'artefact. \
         Installation reportée - réessayez plus tard."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &[u8] = include_bytes!("testdata/manifest.json");
    const SIG:  &str  = include_str!("testdata/manifest.sig");
    const PUB:  &str  = include_str!("testdata/manifest.pub");

    fn verify_with(body: &[u8], sig: &str, pub_b64: &str) -> bool {
        use base64::Engine;
        let key = base64::engine::general_purpose::STANDARD.decode(pub_b64.trim()).unwrap();
        let s   = match base64::engine::general_purpose::STANDARD.decode(sig.trim()) { Ok(v) => v, Err(_) => return false };
        if key.len() != 32 || s.len() != 64 { return false; }
        ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &key)
            .verify(body, &s).is_ok()
    }

    /// A real manifest, signed by the real catalogue, verifies.
    #[test]
    fn accepts_the_catalogue_signature() {
        assert!(verify_with(BODY, SIG, PUB));
    }

    /// One byte changed anywhere in the list - a URL, a digest, a file name -
    /// and the signature no longer holds. That is the whole point: the list is
    /// what an attacker would have to rewrite.
    #[test]
    fn rejects_a_tampered_list() {
        let tampered = String::from_utf8_lossy(BODY).replace("kubuno-drive", "kubuno-pirate");
        assert!(!verify_with(tampered.as_bytes(), SIG, PUB));
    }

    /// A signature made by another key is not a signature.
    #[test]
    fn rejects_another_key() {
        let other = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        assert!(!verify_with(BODY, SIG, other));
    }

    /// The manifest is read into the digests the installer consults.
    #[test]
    fn reads_the_digests() {
        let parsed: Manifest = serde_json::from_slice(BODY).expect("manifeste");
        assert!(!parsed.modules.is_empty());
        let drive = parsed.modules.iter().find(|m| m.id == "drive").expect("drive");
        assert!(drive.artifacts.iter().all(|a| a.sha256.len() == 64), "chaque entrée signée porte une empreinte complète");
    }
}
