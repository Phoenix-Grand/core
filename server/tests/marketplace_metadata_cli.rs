use serde_json::{json, Value};
use std::{path::PathBuf, process::Command};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("metadata-cli-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap(); Self(path)
    }
    fn run(&self, manifest: &str, catalog: Option<&Value>) -> std::process::Output {
        let path = self.0.join("module.toml");
        std::fs::write(&path, manifest).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_kubuno"));
        command.current_dir(&self.0).args(["marketplace:metadata"]).arg(path)
            .env("KV_CONFIG_FILE", self.0.join("does-not-exist.toml"));
        if let Some(catalog) = catalog {
            let path = self.0.join("catalog.json");
            std::fs::write(&path, serde_json::to_vec(catalog).unwrap()).unwrap();
            command.arg("--catalog").arg(path);
        }
        command.output().unwrap()
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
const MANIFEST: &str = "[module]\nid='mail'\nversion='1.0'\ndescription='Email accounts'\n";

#[test]
fn exports_clean_json_without_instance_configuration() {
    let fixture = Fixture::new();
    let output = fixture.run(&format!("{MANIFEST}\n[marketplace]\nsummary='Email'\n"), None);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["summary"], "Email");
    assert_eq!(value["description"], "Email accounts");
    assert_eq!(value["localizations"]["en"]["summary"], "Email");
}

#[test]
fn legacy_opt_out_preserves_the_existing_catalog() {
    let fixture = Fixture::new();
    let catalog = json!({"data":[{"id":"mail","version":"1.0","summary":"Curated text","unknown":42}],"meta":{"total":1}});
    let output = fixture.run(MANIFEST, Some(&catalog));
    assert!(output.status.success());
    assert_eq!(serde_json::from_slice::<Value>(&output.stdout).unwrap(), catalog);
    let output = fixture.run(MANIFEST, None);
    assert!(output.status.success());
    assert_eq!(serde_json::from_slice::<Value>(&output.stdout).unwrap(), Value::Null);
}

#[test]
fn mismatched_version_and_invalid_metadata_fail_without_partial_json() {
    let fixture = Fixture::new();
    let catalog = json!({"data":{"id":"mail","version":"2.0","summary":"Keep"}});
    for manifest in [format!("{MANIFEST}\n[marketplace]\nsummary='Email'\n"), format!("{MANIFEST}\n[marketplace]\nsummary=123\n")] {
        let output = fixture.run(&manifest, Some(&catalog));
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}
