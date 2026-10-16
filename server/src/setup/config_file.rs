//! Writing the installer's answers into `config.toml` without losing the file.
//!
//! The shipped `config.toml.example` is dense with comments - it is the reference
//! an administrator reads months later - so answers are patched in line by line,
//! section aware, instead of re-serialising a parsed document (which would drop
//! every comment). The previous file is kept beside the new one as
//! `config.toml.bak`, and the new one is written to a temporary file in the same
//! directory then renamed, so an interrupted write can never leave a half-written
//! configuration behind.

use anyhow::{Context, Result};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// One `key = value` assignment to apply inside `[section]`.
#[derive(Debug, Clone)]
pub struct Assign {
    pub section: String,
    pub key: String,
    /// Already rendered as TOML (quoted for strings, bare for numbers/booleans).
    pub value: String,
}

impl Assign {
    /// Assignment of a string value (quoted and escaped).
    pub fn text(section: &str, key: &str, value: &str) -> Self {
        Self { section: section.into(), key: key.into(), value: quote(value) }
    }
    /// Assignment of an already-rendered value (number, boolean).
    pub fn raw(section: &str, key: &str, value: impl Into<String>) -> Self {
        Self { section: section.into(), key: key.into(), value: value.into() }
    }
}

/// A TOML basic string, escaping what the format requires. Database passwords
/// routinely carry quotes and backslashes.
pub fn quote(v: &str) -> String {
    let mut out = String::with_capacity(v.len() + 2);
    out.push('"');
    for c in v.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `key = …` on this line, whether it is live or commented out (`# key = …`).
fn is_assignment_of(line: &str, key: &str) -> bool {
    let t = line.trim_start();
    let t = t.strip_prefix('#').map(str::trim_start).unwrap_or(t);
    match t.strip_prefix(key) {
        Some(rest) => rest.trim_start().starts_with('='),
        None => false,
    }
}

/// Applies every assignment to `source`, preserving comments and layout.
pub fn patch(source: &str, assigns: &[Assign]) -> String {
    let mut lines: Vec<String> = source.lines().map(str::to_string).collect();

    // Body range of each `[section]`, so a missing key lands inside its own
    // section rather than being appended after an unrelated one.
    let mut sections: Vec<(String, usize, usize)> = Vec::new();
    let mut current: Option<(String, usize)> = None;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') && !t.starts_with("[[") {
            if let Some((name, start)) = current.take() {
                sections.push((name, start, i));
            }
            current = Some((t[1..t.len() - 1].trim().to_string(), i + 1));
        }
    }
    if let Some((name, start)) = current.take() {
        sections.push((name, start, lines.len()));
    }

    let mut inserts: Vec<(usize, String)> = Vec::new();
    let mut appended: Vec<String> = Vec::new();

    for a in assigns {
        let rendered = format!("{} = {}", a.key, a.value);
        match sections.iter().find(|(n, _, _)| *n == a.section) {
            Some((_, start, end)) => {
                match (*start..*end).find(|&i| is_assignment_of(&lines[i], &a.key)) {
                    // An existing assignment - live or commented out - is replaced in place.
                    Some(i) => lines[i] = rendered,
                    // Otherwise the key is added at the end of its section.
                    None => {
                        let mut at = *end;
                        while at > *start && lines[at - 1].trim().is_empty() {
                            at -= 1;
                        }
                        inserts.push((at, rendered));
                    }
                }
            }
            None => {
                appended.push(String::new());
                appended.push(format!("[{}]", a.section));
                appended.push(rendered);
            }
        }
    }

    // Highest index first, so the earlier ones stay valid as we insert.
    inserts.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    for (at, line) in inserts {
        lines.insert(at, line);
    }
    lines.extend(appended);

    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// Removes every live `key = …` line inside `[section]`, leaving commented-out
/// examples (`# key = …`) and everything else in place. Used when a value must
/// stop applying, e.g. a `[database] url`, which would otherwise outrank the
/// discrete fields an engine switch writes.
pub fn remove_key(source: &str, section: &str, key: &str) -> String {
    let mut current: Option<String> = None;
    let mut out: Vec<&str> = Vec::new();
    for line in source.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') && !t.starts_with("[[") {
            current = Some(t[1..t.len() - 1].trim().to_string());
        }
        let live = !t.starts_with('#') && is_assignment_of(line, key);
        if live && current.as_deref() == Some(section) {
            continue;
        }
        out.push(line);
    }
    let mut s = out.join("\n");
    s.push('\n');
    s
}

/// The configuration file the running instance actually reads, and that the
/// installer therefore has to write. It follows the same plan as the loader
/// (`kubuno_paths::plan_config_files`): `KV_CONFIG_FILE` when set; the system
/// file only for the system instance; otherwise the instance's own file (its
/// configuration directory, or `config.toml` in its working directory). An
/// instance that is not the system one never writes the system file.
pub fn target_path() -> PathBuf {
    let explicit = std::env::var("KV_CONFIG_FILE").ok().filter(|p| !p.trim().is_empty());
    let system_file = kubuno_paths::default_system_layout(&kubuno_paths::PathEnv::from_process())
        .map(|p| p.config_file())
        .unwrap_or_else(|_| crate::config::paths::current().config_file());
    let cwd = std::env::current_dir().ok();
    match crate::config::paths::config_plan(explicit.as_deref()) {
        Ok(plan) => plan.write_target(cwd.as_deref(), &system_file),
        // The layout does not resolve: the loader refused it too; write
        // nowhere near the system instance.
        Err(_) => cwd.map(|d| d.join("config.toml")).unwrap_or_else(|| PathBuf::from("config.toml")),
    }
}

/// Text to patch: the current configuration, else the shipped example (so a
/// fresh install inherits its documentation), else a minimal skeleton.
pub fn source_text(target: &Path) -> String {
    if let Ok(s) = fs::read_to_string(target) {
        return s;
    }
    let examples = [
        crate::config::paths::current().config_example_file(),
        PathBuf::from("config.toml.example"),
    ];
    for example in examples {
        if let Ok(s) = fs::read_to_string(example) {
            return s;
        }
    }
    "[server]\n\n[database]\n\n[auth]\n".to_string()
}

/// Can the service replace this file? Answered before the wizard collects
/// anything, so an installation cannot fail at its last step.
pub fn is_writable(target: &Path) -> bool {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let probe = dir.join(".kubuno-write-probe");
    match fs::File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            // The directory takes it; the file itself must be replaceable too.
            !target.exists() || fs::OpenOptions::new().append(true).open(target).is_ok()
        }
        Err(_) => false,
    }
}

/// Writes `content` over `path`: previous version kept as `.bak`, new one
/// written aside then renamed, never world-readable.
pub fn write_atomic(path: &Path, content: &str) -> Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();
    if path.exists() {
        // A first run that got the database wrong stays recoverable.
        let bak = path.with_extension("toml.bak");
        if fs::copy(path, &bak).is_ok() {
            // A copy does not carry the original's DACL on Windows.
            #[cfg(windows)]
            let _ = kubuno_paths::restrict_to_owner(&bak);
        }
    }
    let tmp = dir.join(".config.toml.new");
    {
        let mut f = fs::File::create(&tmp)
            .with_context(|| format!("Écriture de {}", tmp.display()))?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    // 0640 - it carries the database password and the JWT secret. On Windows,
    // a protected DACL (SYSTEM, Administrators, the service account): under
    // %ProgramData% the inherited one lets every local user read it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o640))?;
    }
    #[cfg(windows)]
    kubuno_paths::restrict_to_owner(&tmp)
        .with_context(|| format!("Restricting access to {}", tmp.display()))?;
    fs::rename(&tmp, path)
        .with_context(|| format!("Remplacement de {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_key_drops_only_the_live_line_of_that_section() {
        let src = "[server]\nurl = \"keep\"\n\n[database]\n# url = \"example\"\nurl = \"postgres://u:p@h/db\"\nhost = \"h\"\n";
        let out = remove_key(src, "database", "url");
        assert_eq!(out, "[server]\nurl = \"keep\"\n\n[database]\n# url = \"example\"\nhost = \"h\"\n");
        // Nothing to remove: unchanged.
        assert_eq!(remove_key(&out, "database", "url"), out);
    }

    #[test]
    fn replaces_in_the_right_section_and_keeps_comments() {
        let src = "# doc\n[server]\n# a comment\ninternal_secret = \"CHANGEZ_MOI\"\n\n[database]\n# url = \"postgres://…\"\nhost = \"localhost\"\n";
        let out = patch(src, &[
            Assign::text("server", "internal_secret", "s3cret"),
            Assign::text("database", "host", "db.internal"),
            Assign::raw("database", "port", "5432"),
        ]);
        assert!(out.contains("# doc"), "les commentaires sont conservés");
        assert!(out.contains("internal_secret = \"s3cret\""));
        assert!(out.contains("host = \"db.internal\""));
        assert!(out.contains("port = 5432"), "clé absente ajoutée dans sa section");
        assert!(out.contains("# url = \"postgres://…\""), "la ligne d'exemple reste");
    }

    #[test]
    fn creates_a_missing_section() {
        let out = patch("[server]\nport = 8080\n", &[Assign::text("auth", "jwt_secret", "k")]);
        assert!(out.contains("[auth]\njwt_secret = \"k\""));
    }

    #[test]
    fn escapes_quotes_and_backslashes() {
        assert_eq!(quote(r#"a"b\c"#), r#""a\"b\\c""#);
    }
}
