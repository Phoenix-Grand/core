use crate::crypto::datakey;
use sha2::{Digest, Sha256};
use anyhow::Context;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::Rng;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

// ── Secret encryption key ───────────────────────────────────────────────────
// Client secrets are stored AES-256-GCM encrypted; the key is derived from the
// JWT secret with domain separation (same pattern as TOTP secrets).
pub fn secret_key(jwt_secret: &str) -> [u8; 32] {
    // The key comes from the data-encryption root, not from the token-signing
    // secret, so rotating the latter leaves what is stored readable. The root is
    // seeded with the JWT secret on first boot, so existing values keep the same
    // derivation; `jwt_secret` is only the fallback when the root was never loaded.
    datakey::key(b"kubuno:oidc:", jwt_secret)
}

// ── PKCE + state ──────────────────────────────────────────────────────────────

pub struct OAuthPkce {
    pub nonce:         String,
    pub code_verifier: String,
}

impl OAuthPkce {
    pub fn generate() -> Self {
        let nonce_bytes: Vec<u8> = rand::thread_rng()
            .sample_iter(rand::distributions::Standard)
            .take(24)
            .collect();
        let verifier_bytes: Vec<u8> = rand::thread_rng()
            .sample_iter(rand::distributions::Standard)
            .take(32)
            .collect();
        Self {
            nonce:         URL_SAFE_NO_PAD.encode(&nonce_bytes),
            code_verifier: URL_SAFE_NO_PAD.encode(&verifier_bytes),
        }
    }

    pub fn code_challenge(&self) -> String {
        URL_SAFE_NO_PAD.encode(Sha256::digest(self.code_verifier.as_bytes()))
    }

    /// Sérialisé dans le cookie HttpOnly `oauth_pkce`.
    pub fn to_cookie_value(&self) -> String {
        format!("{}:{}", self.nonce, self.code_verifier)
    }

    pub fn from_cookie_value(s: &str) -> Option<Self> {
        let (nonce, verifier) = s.split_once(':')?;
        Some(Self {
            nonce:         nonce.to_string(),
            code_verifier: verifier.to_string(),
        })
    }
}

// ── OIDC discovery (.well-known/openid-configuration) ───────────────────────────
// Provider-agnostic: works for Keycloak, GitLab, Authentik, Okta, Zitadel, etc.
// Results are cached per issuer for an hour to avoid hammering the IdP.

#[derive(Debug, Clone, Deserialize)]
pub struct OidcDiscovery {
    pub authorization_endpoint: String,
    pub token_endpoint:         String,
    pub userinfo_endpoint:      String,
    #[serde(default)]
    pub end_session_endpoint:   Option<String>,
}

fn discovery_cache() -> &'static RwLock<HashMap<String, (OidcDiscovery, Instant)>> {
    static CACHE: OnceLock<RwLock<HashMap<String, (OidcDiscovery, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

const DISCOVERY_TTL: Duration = Duration::from_secs(3600);

pub async fn discover(client: &reqwest::Client, issuer_url: &str) -> anyhow::Result<OidcDiscovery> {
    let issuer = issuer_url.trim_end_matches('/').to_string();

    if let Some((disc, fetched_at)) = discovery_cache()
        .read()
        .ok()
        .and_then(|m| m.get(&issuer).cloned())
    {
        if fetched_at.elapsed() < DISCOVERY_TTL {
            return Ok(disc);
        }
    }

    let url = format!("{issuer}/.well-known/openid-configuration");
    let resp = client
        .get(&url)
        .send()
        .await
        .context("Appel discovery OIDC échoué")?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("Discovery OIDC ({issuer}): {body}"));
    }
    let disc: OidcDiscovery = resp.json().await.context("Document discovery OIDC invalide")?;

    if let Ok(mut m) = discovery_cache().write() {
        m.insert(issuer, (disc.clone(), Instant::now()));
    }
    Ok(disc)
}

// ── Authorization URL ───────────────────────────────────────────────────────────

pub fn oidc_auth_url(
    disc:         &OidcDiscovery,
    client_id:    &str,
    scopes:       &str,
    redirect_uri: &str,
    pkce:         &OAuthPkce,
) -> anyhow::Result<String> {
    let mut url = url::Url::parse(&disc.authorization_endpoint)
        .context("authorization_endpoint invalide")?;
    url.query_pairs_mut()
        .append_pair("client_id",             client_id)
        .append_pair("redirect_uri",          redirect_uri)
        .append_pair("response_type",         "code")
        .append_pair("scope",                 scopes)
        .append_pair("state",                 &pkce.nonce)
        .append_pair("code_challenge",        &pkce.code_challenge())
        .append_pair("code_challenge_method", "S256");
    Ok(url.to_string())
}

// ── Token exchange ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct OidcTokenResponse {
    pub access_token: String,
}

#[allow(clippy::too_many_arguments)]
pub async fn oidc_exchange_code(
    client:        &reqwest::Client,
    disc:          &OidcDiscovery,
    client_id:     &str,
    client_secret: &str,
    code:          &str,
    redirect_uri:  &str,
    code_verifier: &str,
) -> anyhow::Result<OidcTokenResponse> {
    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type",    "authorization_code"),
        ("client_id",     client_id),
        ("code",          code),
        ("redirect_uri",  redirect_uri),
        ("code_verifier", code_verifier),
    ];
    // Public clients (no secret) omit client_secret and rely on PKCE.
    if !client_secret.is_empty() {
        form.push(("client_secret", client_secret));
    }

    let resp = client
        .post(&disc.token_endpoint)
        .form(&form)
        .send()
        .await
        .context("Appel token OIDC échoué")?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("OIDC token endpoint: {body}"));
    }

    resp.json::<OidcTokenResponse>()
        .await
        .context("Réponse token OIDC invalide")
}

// ── User info ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct OidcUserInfo {
    pub sub:                String,
    pub email:              Option<String>,
    pub preferred_username: Option<String>,
    // GitLab exposes the handle as `nickname`; used as a fallback.
    #[serde(default)]
    pub nickname:           Option<String>,
    pub name:               Option<String>,
    /// Everything the provider actually returned, kept so the configurable
    /// claim mapping below can reach names this struct does not know about.
    /// Skipped by serde and filled in by [`oidc_userinfo`].
    #[serde(skip)]
    pub raw:                serde_json::Value,
}

pub async fn oidc_userinfo(
    client:       &reqwest::Client,
    disc:         &OidcDiscovery,
    access_token: &str,
) -> anyhow::Result<OidcUserInfo> {
    let resp = client
        .get(&disc.userinfo_endpoint)
        .bearer_auth(access_token)
        .send()
        .await
        .context("Appel userinfo OIDC échoué")?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("OIDC userinfo endpoint: {body}"));
    }

    // Parsed once as a generic document, then narrowed. The document is kept:
    // the standard fields cover the common case, the configurable mapping needs
    // whatever else the provider chose to send.
    let raw: serde_json::Value = resp
        .json()
        .await
        .context("Réponse userinfo OIDC invalide")?;
    let mut info: OidcUserInfo =
        serde_json::from_value(raw.clone()).context("Profil OIDC sans `sub` exploitable")?;
    info.raw = raw;
    Ok(info)
}

// ── Claim mapping ─────────────────────────────────────────────────────────────
//
// The four names below used to be compiled in, which meant they were right for
// whoever wrote them and wrong for Okta (`login`), for an Azure tenant (`upn`)
// and for every provider whose author picked their own. They are configuration
// now, with the OpenID Connect standard names as the defaults.

/// Which claim feeds which of our fields. Names may be **dotted paths**:
/// `resource_access.kubuno.roles` is what a Keycloak client-role list actually
/// looks like, and a mapping that could not express it would be a mapping in
/// name only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimMap {
    pub username:     String,
    pub email:        String,
    pub display_name: String,
    pub groups:       String,
}

impl Default for ClaimMap {
    fn default() -> Self {
        Self {
            username:     "preferred_username".into(),
            email:        "email".into(),
            display_name: "name".into(),
            groups:       "groups".into(),
        }
    }
}

/// Walks a dotted path through a JSON document.
fn claim_at<'a>(doc: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    if path.trim().is_empty() {
        return None;
    }
    let mut cursor = doc;
    for segment in path.split('.') {
        cursor = cursor.get(segment)?;
    }
    Some(cursor)
}

/// A single string claim. Numbers and booleans are rendered rather than
/// refused: a provider that sends an employee number as an integer is not
/// wrong, and "the claim is missing" would be the wrong diagnosis.
pub fn claim_string(doc: &serde_json::Value, path: &str) -> Option<String> {
    match claim_at(doc, path)? {
        serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// A list-valued claim. Accepts an array of strings, and a single string -
/// several providers send one group as a bare string rather than a one-element
/// array, and treating that as "no groups" loses exactly the people who belong
/// to one.
pub fn claim_list(doc: &serde_json::Value, path: &str) -> Vec<String> {
    match claim_at(doc, path) {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => vec![s.trim().to_string()],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_dotted_path_reaches_a_nested_claim() {
        // What a Keycloak client-role list really looks like.
        let doc = json!({
            "sub": "1",
            "resource_access": { "kubuno": { "roles": ["ventes", "support"] } }
        });
        assert_eq!(
            claim_list(&doc, "resource_access.kubuno.roles"),
            vec!["ventes".to_string(), "support".to_string()]
        );
        assert!(claim_list(&doc, "resource_access.autre.roles").is_empty());
    }

    #[test]
    fn a_single_group_sent_as_a_bare_string_is_not_lost() {
        let doc = json!({ "groups": "ventes" });
        assert_eq!(claim_list(&doc, "groups"), vec!["ventes".to_string()]);
    }

    #[test]
    fn a_claim_that_is_not_text_is_rendered_rather_than_dropped() {
        let doc = json!({ "employee_number": 4213, "active": true, "nothing": null });
        assert_eq!(claim_string(&doc, "employee_number").as_deref(), Some("4213"));
        assert_eq!(claim_string(&doc, "active").as_deref(), Some("true"));
        assert_eq!(claim_string(&doc, "nothing"), None);
        assert_eq!(claim_string(&doc, "absent"), None);
    }

    #[test]
    fn an_empty_mapping_matches_nothing() {
        let doc = json!({ "": "surprise", "groups": ["a"] });
        assert_eq!(claim_string(&doc, ""), None);
        assert!(claim_list(&doc, "").is_empty());
    }

    #[test]
    fn the_defaults_are_the_standard_names() {
        let m = ClaimMap::default();
        assert_eq!(m.username, "preferred_username");
        assert_eq!(m.email, "email");
        assert_eq!(m.display_name, "name");
    }
}
