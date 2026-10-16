//! The key that protects data at rest - kept apart from the token-signing key.
//!
//! SMTP and directory passwords, OIDC client secrets, users' TOTP secrets and
//! migration credentials are all encrypted with a key derived from
//! `auth.jwt_secret`. That conflates two jobs with opposite lifetimes: a signing
//! key SHOULD be rotated (it only invalidates sessions), while a
//! data-encryption key must not be, or everything sealed with it becomes
//! unreadable. Rotating the JWT secret therefore silently destroyed every
//! stored secret and every enrolled second factor.
//!
//! So the root of the data keys now lives in its own file, next to the TLS
//! material, and rotating the JWT secret no longer touches it.
//!
//! **Upgrading an existing instance costs nothing**: the file is seeded with the
//! JWT secret currently in force, so every value already stored keeps decrypting
//! with exactly the same derivation. Nothing is re-encrypted, nothing can be
//! lost. An instance whose seed was a weak or public value should then run
//! `kubuno rotate-data-key`, which draws a fresh key and re-encrypts the stores.
//!
//! **Ownership.** Several instances can share a machine (the packaged service
//! and a development core, for instance). Each one only ever uses the key in
//! ITS state directory, and an ownership record `data.key.owner` sits next to
//! the key: the instance id, the directory the key belongs to, and a check
//! value derived from the key. A key whose record names another directory, or
//! whose check value does not match, is refused with an explicit error and
//! left untouched; a key is never taken from a directory whose record says it
//! belongs to an instance; and a key is never moved: an upgrade from an older
//! location copies it, verifies the copy and links it into place, leaving the
//! original exactly where it was.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use kubuno_paths::MigrationOutcome;

static ROOT: OnceLock<String> = OnceLock::new();

/// Variable naming the key file explicitly (absolute path).
const ENV_KEY_FILE: &str = "KUBUNO_DATA_KEY_FILE";

/// Suffix of the ownership record written next to the key.
const OWNER_SUFFIX: &str = ".owner";

/// The key file named explicitly by `KUBUNO_DATA_KEY_FILE`, if any.
fn explicit_key_file() -> Result<Option<PathBuf>> {
    match std::env::var(ENV_KEY_FILE) {
        Ok(p) if !p.trim().is_empty() => {
            let p = PathBuf::from(p.trim());
            if !p.is_absolute() {
                bail!(
                    "{ENV_KEY_FILE} = {} is relative: it would depend on the working directory; \
                     use an absolute path",
                    p.display()
                );
            }
            Ok(Some(p))
        }
        _ => Ok(None),
    }
}

/// Where the root key lives: `KUBUNO_DATA_KEY_FILE` when set, else `data.key`
/// in the instance's state directory (`kubuno-paths`), beside the TLS key, for
/// the same reason: it is instance identity, not application data - no
/// database dump carries it. Never inferred from whether a directory exists,
/// and never a guessed default: if the instance's directories cannot be
/// resolved, this fails instead of pointing at the system instance's key.
pub fn key_path() -> Result<PathBuf> {
    if let Some(p) = explicit_key_file()? {
        return Ok(p);
    }
    let paths = crate::config::paths::try_current()
        .map_err(|e| anyhow::anyhow!("cannot locate the data encryption key: {e}"))?;
    Ok(paths.data_key_file())
}

/// Loads the root key, seeding it from `jwt_secret` the first time.
///
/// Seeding rather than generating is what makes the change free for an existing
/// instance: the derivations stay identical, so nothing already encrypted has to
/// be touched.
///
/// Before seeding, and ONLY for the default system instance, the locations
/// older versions of that same service used (`C:\var\lib\kubuno`, its former
/// working directory, …) are searched, and a key found there is copied to
/// [`key_path`]: a new key is NEVER created while an old one exists, and the
/// old one is never moved. An instance with a state directory of its own, or
/// a key file named explicitly, looks nowhere else.
pub fn init(jwt_secret: &str) -> Result<()> {
    let explicit = explicit_key_file()?.is_some();
    let path = key_path()?;
    let paths = crate::config::paths::try_current()
        .map_err(|e| anyhow::anyhow!("cannot locate the data encryption key: {e}"))?;
    let legacy = if explicit {
        Vec::new()
    } else {
        crate::config::paths::legacy_state_files(paths, kubuno_paths::DATA_KEY)
    };
    if !path.exists() {
        harden_state_dir(paths, &path);
    }
    let root = load_or_seed(&path, &legacy, jwt_secret)?;
    let _ = ROOT.set(root);
    Ok(())
}

/// The root key at `path`, copied from `legacy` or seeded from `jwt_secret`,
/// after its ownership record has been checked.
fn load_or_seed(path: &Path, legacy: &[PathBuf], jwt_secret: &str) -> Result<String> {
    let refuse = |e: anyhow::Error| {
        tracing::error!(error = %e, file = %path.display(), "Data encryption key: refusing to start");
        e
    };

    // A record without its key means the key was deleted or moved away:
    // seeding a new one would silently make every stored secret unreadable.
    if !path.exists() && owner_path(path).exists() {
        return Err(refuse(anyhow::anyhow!(
            "the data encryption key {} is missing but its ownership record {} exists: the key \
             was deleted or moved. Restore it from a backup; a new key is not created, since it \
             could not decrypt the data already stored",
            path.display(),
            owner_path(path).display()
        )));
    }

    let outcome = kubuno_paths::migrate_secret_file(path, legacy, &source_is_unowned)
        .map_err(|e| refuse(anyhow::anyhow!("data encryption key ({}): {e}", path.display())))?;
    match outcome {
        MigrationOutcome::InPlace { stale, .. } => {
            for old in stale {
                tracing::warn!(
                    old = %old.display(),
                    current = %path.display(),
                    "An older copy of the data encryption key is still present (not used, not \
                     touched). Delete it once you have confirmed this instance works: it may sit \
                     in a directory other local users can read"
                );
            }
            let root = read_root(path)?;
            match verify_owner(path, &root).map_err(refuse)? {
                Ownership::Owned => {}
                Ownership::Unrecorded => {
                    // A key from before ownership records, in this instance's
                    // own directory: adopt it. Failing to write the record is
                    // not fatal (the key itself is fine), only less protected.
                    match write_owner(path, &root, None) {
                        Ok(()) => tracing::info!(
                            record = %owner_path(path).display(),
                            "Data encryption key: ownership record created"
                        ),
                        Err(e) => tracing::warn!(
                            record = %owner_path(path).display(),
                            error = %e,
                            "Data encryption key: the ownership record could not be written"
                        ),
                    }
                }
            }
            Ok(root)
        }
        MigrationOutcome::Copied { from, to } => {
            let root = read_root(path)?;
            write_owner(path, &root, None)
                .with_context(|| format!("Writing the ownership record of {}", path.display()))?;
            tracing::warn!(
                from = %from.display(),
                to = %to.display(),
                "Data encryption key copied from the location an earlier version used to the \
                 instance's state directory. The original was left untouched: delete it once \
                 the upgrade is confirmed"
            );
            Ok(root)
        }
        MigrationOutcome::NotFound => {
            write_root(path, jwt_secret)
                .with_context(|| format!("Writing the data encryption key to {}", path.display()))?;
            tracing::info!(
                file = %path.display(),
                "Data encryption key initialised from the JWT secret in force: data already \
                 encrypted stays readable, and the JWT secret can now be rotated without losing it"
            );
            Ok(jwt_secret.to_string())
        }
    }
}

/// Migration check: a key whose directory carries an ownership record
/// belongs to an instance, and is never taken from it.
fn source_is_unowned(from: &Path, _value: &str) -> Result<(), String> {
    let record = owner_path(from);
    if record.exists() {
        return Err(format!(
            "{} belongs to a Kubuno instance (ownership record {}); a key is never taken from \
             another instance's directory",
            from.display(),
            record.display()
        ));
    }
    Ok(())
}

fn read_root(path: &Path) -> Result<String> {
    let v = std::fs::read_to_string(path)
        .with_context(|| format!("Reading the data encryption key {}", path.display()))?;
    Ok(v.trim().to_string())
}

/// Off Linux the state directory holds nothing but secrets: close it, so that
/// what is created inside inherits private permissions too. On Linux it is
/// `/var/lib/kubuno`, which the package owns and shares with the data.
fn harden_state_dir(paths: &kubuno_paths::Paths, key: &Path) {
    if paths.os == kubuno_paths::Os::Linux || key.parent() != Some(paths.state_dir.as_path()) {
        return;
    }
    if let Err(e) = kubuno_paths::create_private_dir(&paths.state_dir) {
        tracing::warn!(dir = %paths.state_dir.display(), error = %e, "State directory could not be restricted");
    }
}

/// Replaces the root key on disk (used by seeding and by the re-keying
/// command): written aside and renamed, readable by the service only (`0600`,
/// or a protected DACL on Windows). The ownership record is updated to the
/// new key, keeping the instance id.
pub fn write_root(path: &Path, value: &str) -> Result<()> {
    let instance_id = read_owner(path).ok().flatten().map(|o| o.instance_id);
    kubuno_paths::write_private(path, format!("{value}\n").as_bytes())?;
    write_owner(path, value, instance_id)
        .with_context(|| format!("Writing the ownership record of {}", path.display()))?;
    Ok(())
}

// ── Ownership record ────────────────────────────────────────────────────────

/// `data.key.owner`: which instance and which directory the key belongs to.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Owner {
    version: u32,
    instance_id: String,
    /// The directory the key was created or adopted in (canonical).
    state_dir: String,
    /// Derived from the key and the instance id: proves the key next to the
    /// record is the one the record was written for, without revealing it.
    check: String,
}

enum Ownership {
    Owned,
    /// No record yet (a key written by an earlier version).
    Unrecorded,
}

fn owner_path(key: &Path) -> PathBuf {
    let name = key.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    key.with_file_name(format!("{name}{OWNER_SUFFIX}"))
}

/// The directory holding `key`, canonical when it exists.
fn key_dir(key: &Path) -> PathBuf {
    let dir = match key.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => PathBuf::from("."),
    };
    std::fs::canonicalize(&dir).unwrap_or(dir)
}

fn same_dir(recorded: &Path, actual: &Path) -> bool {
    let recorded = std::fs::canonicalize(recorded).unwrap_or_else(|_| recorded.to_path_buf());
    kubuno_paths::same_lexical(&recorded, actual, kubuno_paths::Os::current())
}

fn check_of(instance_id: &str, root: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"kubuno-data-key-owner-check-v1\0");
    h.update(instance_id.as_bytes());
    h.update(b"\0");
    h.update(root.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The record next to `key`: `None` when absent; an error when present but
/// unreadable or malformed (never guessed around).
fn read_owner(key: &Path) -> Result<Option<Owner>> {
    let record = owner_path(key);
    let text = match std::fs::read_to_string(&record) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("Reading the ownership record {}", record.display())),
    };
    let owner: Owner = serde_json::from_str(&text)
        .with_context(|| format!("The ownership record {} is malformed", record.display()))?;
    Ok(Some(owner))
}

fn write_owner(key: &Path, root: &str, instance_id: Option<String>) -> Result<()> {
    let instance_id = instance_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let owner = Owner {
        version: 1,
        check: check_of(&instance_id, root),
        instance_id,
        state_dir: key_dir(key).to_string_lossy().into_owned(),
    };
    let json = serde_json::to_string_pretty(&owner).context("Serialising the ownership record")?;
    kubuno_paths::write_private(&owner_path(key), format!("{json}\n").as_bytes())?;
    Ok(())
}

/// Checks that the key at `key` (value `root`) belongs to the instance using
/// this directory. Refuses, without touching anything, a key recorded for
/// another directory or one that does not match its record.
fn verify_owner(key: &Path, root: &str) -> Result<Ownership> {
    let Some(owner) = read_owner(key)? else {
        return Ok(Ownership::Unrecorded);
    };
    let record = owner_path(key);
    let here = key_dir(key);
    if !same_dir(Path::new(&owner.state_dir), &here) {
        bail!(
            "the data encryption key {} belongs to the Kubuno instance whose state directory is \
             {} (ownership record {}), not to this one ({}). Refusing to use, copy or modify it. \
             Give this instance a state directory of its own; if this directory was moved or \
             restored on purpose, delete {} so that this instance adopts the key",
            key.display(),
            owner.state_dir,
            record.display(),
            here.display(),
            record.display()
        );
    }
    if owner.check != check_of(&owner.instance_id, root) {
        bail!(
            "the data encryption key {} does not match its ownership record {}: the key was \
             replaced or altered. Refusing to start, since data encrypted with the original key \
             would be unreadable. Restore the original key; if it was replaced on purpose, delete \
             {} so that this instance adopts the new one",
            key.display(),
            record.display(),
            record.display()
        );
    }
    Ok(Ownership::Owned)
}

/// A fresh root key: 32 random bytes, hex.
pub fn generate_root() -> String {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The per-domain key. `domain` keeps one store's key useless against another -
/// the same separation the previous derivations used, so a seeded instance
/// reproduces them byte for byte.
pub fn derive(domain: &[u8], root: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    h.update(root.as_bytes());
    h.finalize().into()
}

/// The key in force for `domain`.
///
/// Falls back to the passed JWT secret when `init` was never called - a unit
/// test, a command that does not boot the server - so nothing has to know
/// whether the process went through the bootstrap.
pub fn key(domain: &[u8], jwt_secret_fallback: &str) -> [u8; 32] {
    match ROOT.get() {
        Some(root) => derive(domain, root),
        None => derive(domain, jwt_secret_fallback),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kubuno_paths::{Os, Overrides, PathEnv, Paths};

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let d = std::env::temp_dir().join(format!("kubuno-datakey-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            Scratch(d)
        }
        fn path(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }
        fn put(&self, rel: &str, v: &str) -> PathBuf {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, v).unwrap();
            p
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn read(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap()
    }

    /// The legacy list `init` would compute for a given environment.
    fn legacy_for(env: &PathEnv) -> Vec<PathBuf> {
        let paths = Paths::resolve(env, &Overrides::default()).unwrap();
        kubuno_paths::legacy_state_dirs_for(env, &paths)
    }

    // ── Explicit data dir ──────────────────────────────────────────────────

    /// The reported bug: a development core with a state directory of its own
    /// on a machine running the packaged service. It must not look at the
    /// system directory at all, on any OS.
    #[test]
    fn explicit_state_dir_never_looks_at_the_system_one() {
        for (os, own) in [
            (Os::Linux, "/home/dev/kubuno/state"),
            (Os::MacOs, "/Users/dev/kubuno/state"),
            (Os::Windows, r"C:\Users\dev\kubuno\state"),
        ] {
            let env = PathEnv::new(os)
                .with_var("KUBUNO_PATHS_STATE_DIR", own)
                .with_var("KUBUNO_PATHS_CONFIG_DIR", own)
                .with_var("KUBUNO_PATHS_DATA_DIR", own)
                .with_program_data(r"C:\ProgramData")
                .with_cwd(own);
            assert!(legacy_for(&env).is_empty(), "{os:?}");
        }

        // And with that empty list, a fake "system" key elsewhere is never
        // read, copied or renamed: the instance seeds its own.
        let s = Scratch::new("explicit");
        let system = s.put("var/lib/kubuno/data.key", "production-key\n");
        let own = s.path("dev/state/data.key");
        let root = load_or_seed(&own, &[], "dev-jwt").unwrap();
        assert_eq!(root, "dev-jwt");
        assert_eq!(read(&own), "dev-jwt\n");
        assert_eq!(read(&system), "production-key\n");
        assert!(!s.path("var/lib/kubuno/data.key.migrated").exists());
        assert!(!s.path("var/lib/kubuno/data.key.owner").exists());
    }

    // ── Default system dir ─────────────────────────────────────────────────

    #[test]
    fn default_linux_system_instance_uses_its_key_in_place_and_adopts_it() {
        // Linux: the default state dir IS the legacy dir, so no candidate.
        assert!(legacy_for(&PathEnv::new(Os::Linux).with_cwd("/var/lib/kubuno")).is_empty());

        // The production upgrade path: a key without a record, in place.
        let s = Scratch::new("adopt");
        let key = s.put("var/lib/kubuno/data.key", "prod-root\n");
        assert_eq!(load_or_seed(&key, &[], "jwt").unwrap(), "prod-root");
        assert_eq!(read(&key), "prod-root\n", "the key itself is never rewritten");
        let owner = read_owner(&key).unwrap().expect("record written");
        assert!(same_dir(Path::new(&owner.state_dir), &key_dir(&key)));
        // Next start: the record matches.
        assert_eq!(load_or_seed(&key, &[], "jwt").unwrap(), "prod-root");
        assert_eq!(read_owner(&key).unwrap().unwrap().instance_id, owner.instance_id);
    }

    #[test]
    fn default_windows_system_instance_has_its_old_locations() {
        let env = PathEnv::new(Os::Windows).with_program_data(r"C:\ProgramData").with_cwd(r"C:\ProgramData\Kubuno");
        assert_eq!(
            legacy_for(&env),
            vec![PathBuf::from(r"C:\var\lib\kubuno"), PathBuf::from(r"C:\ProgramData").join("Kubuno")]
        );
    }

    // ── Relocation: copy, verify, link; source intact ──────────────────────

    #[test]
    fn old_location_is_copied_never_moved() {
        let s = Scratch::new("copy");
        let target = s.path("state/data.key");
        let old = s.put("legacy/data.key", "rotated-root\n");
        let root = load_or_seed(&target, std::slice::from_ref(&old), "jwt").unwrap();
        assert_eq!(root, "rotated-root", "the old key wins over the JWT secret");
        assert_eq!(read(&target), "rotated-root\n");
        assert_eq!(read(&old), "rotated-root\n", "the source is left exactly as it was");
        assert!(!s.path("legacy/data.key.migrated").exists());
        assert!(!s.path("legacy/data.key.owner").exists(), "nothing is written beside the source");
        assert!(matches!(verify_owner(&target, "rotated-root").unwrap(), Ownership::Owned));

        // Next start: the key in place wins; the old copy is neither read nor touched.
        std::fs::write(&old, "something-else\n").unwrap();
        assert_eq!(load_or_seed(&target, std::slice::from_ref(&old), "jwt").unwrap(), "rotated-root");
        assert_eq!(read(&old), "something-else\n");
    }

    #[test]
    fn different_old_copies_refuse_to_start() {
        let s = Scratch::new("diff");
        let target = s.path("state/data.key");
        let a = s.put("a/data.key", "k1\n");
        let b = s.put("b/data.key", "k2\n");
        let err = load_or_seed(&target, &[a.clone(), b.clone()], "jwt").unwrap_err();
        assert!(err.to_string().contains("Refusing to choose"), "{err}");
        assert!(!target.exists());
        assert_eq!(read(&a), "k1\n");
        assert_eq!(read(&b), "k2\n");
    }

    #[test]
    fn nothing_anywhere_seeds_from_the_jwt_secret() {
        let s = Scratch::new("none");
        let target = s.path("state/data.key");
        assert_eq!(load_or_seed(&target, &[s.path("legacy/data.key")], "jwt-secret").unwrap(), "jwt-secret");
        assert_eq!(read(&target), "jwt-secret\n");
        assert!(matches!(verify_owner(&target, "jwt-secret").unwrap(), Ownership::Owned));
    }

    // ── Foreign keys are refused and left untouched ────────────────────────

    #[test]
    fn a_key_recorded_for_another_directory_is_refused_untouched() {
        let s = Scratch::new("foreign");
        // The system instance's directory, with its record.
        let prod = s.put("prod/data.key", "prod-root\n");
        write_owner(&prod, "prod-root", None).unwrap();
        let prod_record = read(&owner_path(&prod));
        // Someone copies the whole directory into a dev instance's state dir.
        let dev = s.put("dev/data.key", "prod-root\n");
        std::fs::write(owner_path(&dev), &prod_record).unwrap();

        let err = load_or_seed(&dev, &[], "jwt").unwrap_err();
        assert!(err.to_string().contains("belongs to the Kubuno instance"), "{err}");
        assert_eq!(read(&dev), "prod-root\n");
        assert_eq!(read(&owner_path(&dev)), prod_record, "the record is not rewritten");
        assert_eq!(read(&prod), "prod-root\n");
    }

    #[test]
    fn a_key_is_never_taken_from_an_owned_directory() {
        let s = Scratch::new("owned-source");
        let prod = s.put("prod/data.key", "prod-root\n");
        write_owner(&prod, "prod-root", None).unwrap();
        let record = read(&owner_path(&prod));
        let target = s.path("dev/data.key");
        let err = load_or_seed(&target, std::slice::from_ref(&prod), "jwt").unwrap_err();
        assert!(err.to_string().contains("never taken from another instance"), "{err}");
        assert!(!target.exists(), "no key copied, none seeded");
        assert_eq!(read(&prod), "prod-root\n");
        assert_eq!(read(&owner_path(&prod)), record);
    }

    #[test]
    fn a_replaced_key_is_refused() {
        let s = Scratch::new("replaced");
        let key = s.path("state/data.key");
        load_or_seed(&key, &[], "original").unwrap();
        std::fs::write(&key, "another\n").unwrap();
        let err = load_or_seed(&key, &[], "jwt").unwrap_err();
        assert!(err.to_string().contains("does not match its ownership record"), "{err}");
        assert_eq!(read(&key), "another\n");
    }

    #[test]
    fn a_deleted_key_is_not_reseeded() {
        let s = Scratch::new("deleted");
        let key = s.path("state/data.key");
        load_or_seed(&key, &[], "original").unwrap();
        std::fs::remove_file(&key).unwrap();
        let err = load_or_seed(&key, &[], "jwt").unwrap_err();
        assert!(err.to_string().contains("missing but its ownership record"), "{err}");
        assert!(!key.exists());
    }

    #[test]
    fn rekeying_keeps_the_instance_and_updates_the_check() {
        let s = Scratch::new("rekey");
        let key = s.path("state/data.key");
        load_or_seed(&key, &[], "old-root").unwrap();
        let id = read_owner(&key).unwrap().unwrap().instance_id;
        write_root(&key, "new-root").unwrap();
        assert_eq!(read_owner(&key).unwrap().unwrap().instance_id, id);
        assert_eq!(load_or_seed(&key, &[], "jwt").unwrap(), "new-root");
    }
}
