//! Optional publisher-owned text. Runtime manifests remain unchanged: metadata
//! is parsed separately, so an invalid optional section cannot stop a module.
use std::{collections::BTreeMap, path::Path};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use super::catalog::{validate_id, MarketModule};

pub const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct PublisherText {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Default, Deserialize)]
struct Section {
    summary: Option<String>,
    description: Option<String>,
    #[serde(default)]
    localizations: BTreeMap<String, PublisherText>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PublisherMetadata {
    pub id: String,
    pub version: String,
    #[serde(flatten)]
    pub text: PublisherText,
    pub localizations: BTreeMap<String, PublisherText>,
}

fn locale_key(locale: &str) -> Result<String> {
    let key = locale.replace('_', "-").to_ascii_lowercase();
    if key.len() > 64 || key.split('-').any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_alphanumeric())) {
        bail!("Invalid metadata locale: {locale}");
    }
    Ok(key)
}

impl PublisherMetadata {
    /// Absence of [marketplace] means no opt-in and no change to catalog text.
    pub fn parse(content: &str) -> Result<Option<Self>> {
        if content.len() as u64 > MAX_MANIFEST_BYTES { bail!("Metadata manifest exceeds 256 KiB"); }
        let document: toml::Value = toml::from_str(content).context("Invalid metadata TOML")?;
        let Some(section) = document.get("marketplace") else { return Ok(None) };
        let section: Section = section.clone().try_into().context("Invalid [marketplace] metadata")?;
        let module = document.get("module").context("Missing [module]")?;
        let required = |name: &str| -> Result<String> {
            Ok(module.get(name).and_then(toml::Value::as_str).filter(|s| !s.is_empty())
                .with_context(|| format!("Missing module.{name}"))?.to_owned())
        };
        let id = required("id")?;
        validate_id(&id).map_err(|_| anyhow::anyhow!("Invalid metadata module ID"))?;
        let version = required("version")?;
        let description = section.description.or_else(|| module.get("description").and_then(toml::Value::as_str).map(str::to_owned));
        let text = PublisherText { summary: section.summary.or_else(|| description.clone()), description };
        let mut localizations: BTreeMap<String, PublisherText> = BTreeMap::new();
        // Reuse existing module description translations without requiring a
        // second copy. Unknown legacy translation data is not a runtime schema.
        if let Some(translations) = module.get("translations").and_then(toml::Value::as_table) {
            for (locale, value) in translations {
                if let Some(description) = value.get("description").and_then(toml::Value::as_str) {
                    localizations.entry(locale_key(locale)?).or_default().description = Some(description.to_owned());
                }
            }
        }
        let mut seen = std::collections::BTreeSet::new();
        for (locale, translated) in section.localizations {
            let key = locale_key(&locale)?;
            if !seen.insert(key.clone()) { bail!("Duplicate metadata locale: {locale}"); }
            let target = localizations.entry(key).or_default();
            if translated.summary.is_some() { target.summary = translated.summary; }
            if translated.description.is_some() { target.description = translated.description; }
        }
        // New metadata uses English as its baseline. Keeping it in the map
        // prevents a stale catalog translation from overriding the new text.
        let english = localizations.entry("en".into()).or_default();
        if english.summary.is_none() { english.summary = text.summary.clone(); }
        if english.description.is_none() { english.description = text.description.clone(); }
        let text = english.clone();
        Ok(Some(Self { id, version, text, localizations }))
    }

    /// Merge only text, keeping unknown catalog fields and installation data.
    /// Exact version matching prevents unreleased content describing old builds.
    pub fn merge_entry(&self, entry: &mut Value) -> bool {
        if entry.get("id").and_then(Value::as_str) != Some(self.id.as_str())
            || entry.get("version").and_then(Value::as_str) != Some(self.version.as_str()) { return false; }
        let Some(object) = entry.as_object_mut() else { return false };
        for (field, value) in [("summary", &self.text.summary), ("description", &self.text.description)] {
            if let Some(value) = value { object.insert(field.into(), json!(value)); }
        }
        let locales = object.entry("localizations").or_insert_with(|| json!({}));
        if !locales.is_object() { *locales = json!({}); }
        let locales = locales.as_object_mut().unwrap();
        for (locale, value) in std::mem::take(locales) {
            let key = locale_key(&locale).unwrap_or(locale);
            let target = locales.entry(key).or_insert_with(|| json!({}));
            if let (Some(target), Some(value)) = (target.as_object_mut(), value.as_object()) {
                target.extend(value.clone());
            }
        }
        // The opted-in fields belong to the publisher. Retain category/name
        // translations, but discard stale translations of the owned text.
        for value in locales.values_mut().filter_map(Value::as_object_mut) {
            if self.text.summary.is_some() { value.remove("summary"); }
            if self.text.description.is_some() { value.remove("description"); }
        }
        for (locale, text) in &self.localizations {
            let value = locales.entry(locale.clone()).or_insert_with(|| json!({}));
            if !value.is_object() { *value = json!({}); }
            let value = value.as_object_mut().unwrap();
            if let Some(summary) = &text.summary { value.insert("summary".into(), json!(summary)); }
            if let Some(description) = &text.description { value.insert("description".into(), json!(description)); }
        }
        true
    }

    pub fn merge_catalog(&self, catalog: &mut Value) -> usize {
        let data = if catalog.get("data").is_some() { &mut catalog["data"] } else { catalog };
        match data {
            Value::Array(entries) => entries.iter_mut().map(|entry| usize::from(self.merge_entry(entry))).sum(),
            entry => usize::from(self.merge_entry(entry)),
        }
    }
}

pub async fn read_manifest(path: &Path) -> Result<String> {
    let file = tokio::fs::File::open(path).await?;
    let mut content = String::new();
    file.take(MAX_MANIFEST_BYTES + 1).read_to_string(&mut content).await?;
    if content.len() as u64 > MAX_MANIFEST_BYTES { bail!("Metadata manifest exceeds 256 KiB"); }
    Ok(content)
}

/// Explicit administrator-controlled metadata source. No GitHub fetches, no
/// automatic reads of installed modules, no changes to the default catalog.
pub(super) async fn apply_directory(directory: &Path, module: &mut MarketModule) -> Result<()> {
    validate_id(&module.id).map_err(|_| anyhow::anyhow!("Invalid catalog module ID"))?;
    let path = directory.join(&module.id).join("module.toml");
    let content = match read_manifest(&path).await {
        Ok(content) => content,
        Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) => return Ok(()),
        Err(error) => return Err(error),
    };
    let Some(metadata) = PublisherMetadata::parse(&content)? else { return Ok(()) };
    let mut value = serde_json::to_value(&*module)?;
    if !metadata.merge_entry(&mut value) { bail!("Metadata ID/version does not match the catalog entry"); }
    *module = serde_json::from_value(value)?;
    Ok(())
}

pub(super) async fn apply_configured(module: &mut MarketModule) {
    let Some(directory) = std::env::var_os("KUBUNO_MARKETPLACE_METADATA_DIR").filter(|p| !p.is_empty()) else { return };
    if let Err(error) = apply_directory(Path::new(&directory), module).await {
        tracing::warn!(module_id = %module.id, %error, "Ignoring unavailable or invalid optional Marketplace metadata");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const LEGACY: &str = "[module]\nid='mail'\nversion='0.1.8'\ndisplay_name='Mail'\ndescription='Email accounts'\nruntime='rust'\n[process]\nentrypoint='kubuno-mail'\n[server]\nhost='127.0.0.1'\nport=3111\n";
    fn opted_in() -> String {
        format!("{LEGACY}\n[marketplace]\nsummary='Email with multiple accounts'\n[marketplace.localizations.fr]\nsummary='Messagerie multi-comptes'\n")
    }
    fn catalog() -> Value {
        json!({"id":"mail","version":"0.1.8","name":"Mail","summary":"Old text","description":"Old details",
            "official":true,"category":"Communication","category_id":"communication","rating":4.5,
            "artifacts":[{"os":"linux","arch":"x86_64","kind":"kbpkg","filename":"mail.kbpkg","url":"https://publisher.example/mail.kbpkg","sha256":"abc"}],"future_field":{"keep":true},
            "localizations":{"EN":{"summary":"Stale English","name":"Mail"},"FR":{"summary":"Ancien texte","category":"Communication"},"de":{"summary":"Stale German","category":"Kommunikation"}}})
    }
    #[test]
    fn legacy_manifests_and_runtime_loading_remain_unchanged() {
        assert!(PublisherMetadata::parse(LEGACY).unwrap().is_none());
        for source in [LEGACY.to_owned(), opted_in(), format!("{LEGACY}\n[marketplace]\nsummary=123\n")] {
            let manifest = crate::modules::manifest::ModuleManifest::from_toml(&source).unwrap();
            assert_eq!(manifest.module.id, "mail");
            assert_eq!(manifest.module.description.as_deref(), Some("Email accounts"));
        }
    }
    #[test]
    fn minimal_metadata_inherits_description_and_existing_translations() {
        let source = format!("{LEGACY}\n[module.translations.fr]\ndescription='Comptes de messagerie'\n[marketplace]\nsummary='Email'\n[marketplace.localizations.fr]\nsummary='Messagerie'\n");
        let metadata = PublisherMetadata::parse(&source).unwrap().unwrap();
        assert_eq!(metadata.text.description.as_deref(), Some("Email accounts"));
        assert_eq!(metadata.localizations["fr"].description.as_deref(), Some("Comptes de messagerie"));
        assert_eq!(metadata.localizations["fr"].summary.as_deref(), Some("Messagerie"));
    }
    #[test]
    fn merges_text_without_changing_installation_or_editorial_data() {
        let metadata = PublisherMetadata::parse(&opted_in()).unwrap().unwrap();
        let before = catalog();
        let mut after = before.clone();
        assert!(metadata.merge_entry(&mut after));
        for (field, value) in before.as_object().unwrap() {
            if !["summary", "description", "localizations"].contains(&field.as_str()) { assert_eq!(&after[field], value, "{field}"); }
        }
        assert_eq!(after["summary"], "Email with multiple accounts");
        assert_eq!(after["description"], "Email accounts");
        assert_eq!(after["localizations"]["en"]["name"], "Mail");
        assert_eq!(after["localizations"]["fr"]["summary"], "Messagerie multi-comptes");
        assert_eq!(after["localizations"]["fr"]["category"], "Communication");
        assert!(after["localizations"].get("FR").is_none());
        assert!(after["localizations"]["de"].get("summary").is_none());
        assert_eq!(after["localizations"]["de"]["category"], "Kommunikation");
    }
    #[test]
    fn handles_list_detail_envelopes_and_preserves_unrelated_entries() {
        let metadata = PublisherMetadata::parse(&opted_in()).unwrap().unwrap();
        let legacy = json!({"id":"legacy","version":"1","summary":"Keep"});
        for mut value in [catalog(), json!({"data":catalog()}), json!([catalog(),legacy.clone()]), json!({"data":[catalog(),legacy.clone()],"meta":{"total":2}})] {
            assert_eq!(metadata.merge_catalog(&mut value), 1);
            let data = value.get("data").unwrap_or(&value);
            if data.is_array() { assert_eq!(data[1], legacy); }
            if value.get("meta").is_some() { assert_eq!(value["meta"]["total"], 2); }
        }
    }
    #[test]
    fn refuses_cross_module_and_cross_version_updates() {
        let metadata = PublisherMetadata::parse(&opted_in()).unwrap().unwrap();
        for (field, value) in [("id","other"),("version","0.1.9")] {
            let mut entry = catalog(); entry[field] = json!(value);
            let before = entry.clone();
            assert!(!metadata.merge_entry(&mut entry)); assert_eq!(entry, before);
        }
    }
    #[test]
    fn preserves_empty_text_and_normalizes_locale_keys() {
        let content = format!("{LEGACY}\n[marketplace]\nsummary=''\ndescription=''\n[marketplace.localizations.PT_BR]\nsummary='Correio'\n");
        let metadata = PublisherMetadata::parse(&content).unwrap().unwrap();
        assert_eq!(metadata.text.summary.as_deref(), Some(""));
        assert_eq!(metadata.localizations["pt-br"].summary.as_deref(), Some("Correio"));
        assert!(PublisherMetadata::parse(&format!("{content}\n[marketplace.localizations.pt-br]\nsummary='Duplicate'\n")).is_err());
        assert!(PublisherMetadata::parse(&format!("{LEGACY}\n[marketplace]\nsummary=123\n")).is_err());
    }
    #[tokio::test]
    async fn old_and_opted_in_packages_use_the_same_archive_and_runtime_reader() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("metadata-packages-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        for (index, content) in [LEGACY.to_owned(), opted_in()].iter().enumerate() {
            let path = root.join(format!("mail-{index}.kbpkg"));
            let mut archive = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            let options = zip::write::SimpleFileOptions::default();
            archive.start_file("module.toml", options).unwrap();
            archive.write_all(content.as_bytes()).unwrap();
            archive.start_file("kubuno-mail", options).unwrap();
            archive.write_all(b"test package entrypoint").unwrap();
            archive.finish().unwrap();
            let dest = root.join(index.to_string());
            super::super::extract::extract_kbpkg(&path, &dest).await.unwrap();
            let module = super::super::extract::find_module_root(&dest, "mail").unwrap();
            let loaded = read_manifest(&module.join("module.toml")).await.unwrap();
            let manifest = crate::modules::manifest::ModuleManifest::from_toml(&loaded).unwrap();
            assert_eq!(manifest.module.id, "mail");
            assert!(manifest.entrypoint_path(&module).is_file());
            assert_eq!(PublisherMetadata::parse(&loaded).unwrap().is_some(), index == 1);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn directory_refresh_is_optional_bounded_and_version_checked() {
        let dir = std::env::temp_dir().join(format!("metadata-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(dir.join("mail")).await.unwrap();
        let mut module: MarketModule = serde_json::from_value(catalog()).unwrap();
        let before = serde_json::to_value(&module).unwrap();
        apply_directory(&dir, &mut module).await.unwrap();
        assert_eq!(serde_json::to_value(&module).unwrap(), before);
        let path = dir.join("mail/module.toml");
        tokio::fs::write(&path, opted_in()).await.unwrap();
        apply_directory(&dir, &mut module).await.unwrap();
        assert_eq!(module.summary.as_deref(), Some("Email with multiple accounts"));
        tokio::fs::write(&path, opted_in().replace("Email with multiple accounts", "Updated wording")).await.unwrap();
        apply_directory(&dir, &mut module).await.unwrap();
        assert_eq!(module.summary.as_deref(), Some("Updated wording"));
        let last = serde_json::to_value(&module).unwrap();
        for source in [opted_in().replace("0.1.8", "0.1.9"), "x".repeat(MAX_MANIFEST_BYTES as usize + 1)] {
            tokio::fs::write(&path, source).await.unwrap();
            assert!(apply_directory(&dir, &mut module).await.is_err());
            assert_eq!(serde_json::to_value(&module).unwrap(), last);
        }
        module.id = "../outside".into();
        assert!(apply_directory(&dir, &mut module).await.is_err());
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
