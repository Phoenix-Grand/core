//! Content-Security-Policy header, kept in sync with the deployed frontend.
//!
//! The host's ESM import map is an inline `<script type="importmap">`. CSP only
//! allows an inline script whose sha256 is listed in `script-src`, so the build
//! emits that hash next to the bundle (`<frontend_dist>/importmap.sha256`) and
//! the server echoes it into the header.
//!
//! Reading the hash once at startup is a trap: a frontend-only deployment
//! (`cp dist/* /usr/share/kubuno/frontend/`) rewrites both `index.html` and the
//! hash file without restarting the server. The header then carries the hash of
//! the *previous* import map, the browser blocks the inline script, and every
//! bare specifier a module bundle imports (`@ui`, `react`, `@kubuno/sdk`…)
//! becomes unresolvable - silently emptying the app launcher and the sidebar
//! while the host shell itself keeps working (it references its chunks by URL).
//!
//! So the value is recomputed whenever the hash file's mtime or length changes.

use axum::http::HeaderValue;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::SystemTime;

/// Identity of the hash file as last read: mtime + length. `None` when the file
/// is absent, which is a legitimate state (dev host built without the plugin).
type FileStamp = Option<(SystemTime, u64)>;

pub struct CspHeaderCache {
    path: PathBuf,
    /// Last observed file stamp and the header value derived from it.
    cached: RwLock<(FileStamp, HeaderValue)>,
}

impl CspHeaderCache {
    pub fn new(frontend_dist: &str) -> Self {
        let path = Path::new(frontend_dist).join("importmap.sha256");
        let stamp = stamp_of(&path);
        let header = build_header(read_hash(&path).as_deref());
        Self { path, cached: RwLock::new((stamp, header)) }
    }

    /// Header for the current response, refreshed if the hash file changed.
    pub fn header(&self) -> HeaderValue {
        let stamp = stamp_of(&self.path);

        // Fast path: the file is unchanged since the last read. A poisoned lock
        // must not take the server down, so fall back to recomputing.
        if let Ok(cached) = self.cached.read() {
            if cached.0 == stamp {
                return cached.1.clone();
            }
        }

        let header = build_header(read_hash(&self.path).as_deref());
        if let Ok(mut cached) = self.cached.write() {
            *cached = (stamp, header.clone());
        }
        tracing::info!(
            path = %self.path.display(),
            "import map hash changed, Content-Security-Policy refreshed"
        );
        header
    }
}

fn stamp_of(path: &Path) -> FileStamp {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

fn read_hash(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| s.starts_with("sha256-"))
}

/// Builds the policy. Without a hash the inline import map is simply not
/// allowed - that is the correct behaviour for a build that emits none.
fn build_header(hash: Option<&str>) -> HeaderValue {
    let script_src = match hash {
        Some(h) => format!("script-src 'self' https://cdn.jsdelivr.net 'unsafe-eval' '{h}'"),
        None => "script-src 'self' https://cdn.jsdelivr.net 'unsafe-eval'".to_string(),
    };
    let csp = format!(
        "default-src 'self'; {script_src}; \
         style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; \
         img-src 'self' data: blob: https:; \
         media-src 'self' blob:; \
         connect-src 'self' ws: wss: blob: https: http:; \
         worker-src 'self' blob:; \
         font-src 'self' data: https://cdn.jsdelivr.net; \
         frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com; \
         object-src 'none'; base-uri 'self'; form-action 'self'"
    );
    // The hash file is validated above, so every byte here is header-safe; a
    // malformed one degrades to the hashless policy rather than panicking.
    HeaderValue::from_str(&csp).unwrap_or_else(|_| {
        tracing::error!("invalid import map hash, serving Content-Security-Policy without it");
        build_header(None)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_includes_the_hash_when_present() {
        let h = build_header(Some("sha256-AAAA"));
        let s = h.to_str().expect("header is ASCII");
        assert!(s.contains("'sha256-AAAA'"), "{s}");
    }

    #[test]
    fn header_omits_the_hash_when_absent() {
        let h = build_header(None);
        let s = h.to_str().expect("header is ASCII");
        assert!(!s.contains("sha256-"), "{s}");
    }

    #[test]
    fn a_rewritten_hash_file_is_picked_up_without_a_restart() {
        let dir = std::env::temp_dir().join(format!("kbcsp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("importmap.sha256");
        std::fs::write(&path, "sha256-FIRST").expect("write");

        let cache = CspHeaderCache::new(&dir.to_string_lossy());
        let first = cache.header();
        assert!(first.to_str().unwrap_or_default().contains("sha256-FIRST"));

        // Same length, so the mtime is what must catch the change; sleep past
        // the coarsest filesystem timestamp granularity in use.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&path, "sha256-SECOND").expect("rewrite");

        let second = cache.header();
        let s = second.to_str().unwrap_or_default();
        assert!(s.contains("sha256-SECOND"), "stale header served: {s}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
