//! Free space of the volume that holds the instance data.
//!
//! The standard library has no such API, and the core had no dependency able to
//! answer the question, so this is a direct `statvfs(3)` call. It is a plain
//! read of filesystem metadata: nothing is spawned, so the seccomp filter
//! (which refuses `execve`/`execveat`) is unaffected.

#[cfg(unix)]
use std::ffi::CString;
use std::path::Path;

/// What `statvfs` reports about a mount point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskUsage {
    pub total_bytes: u64,
    /// Space available to an unprivileged process - `f_bavail`, not `f_bfree`.
    /// The difference is the reserved root quota (5 % by default on ext4), and
    /// reporting it as free is how a "10 % left" instance stops accepting
    /// uploads.
    pub available_bytes: u64,
}

impl DiskUsage {
    /// Fraction of the volume still writable, in `0.0..=1.0`.
    pub fn available_ratio(&self) -> f64 {
        if self.total_bytes == 0 {
            return 1.0;
        }
        (self.available_bytes as f64 / self.total_bytes as f64).clamp(0.0, 1.0)
    }

    pub fn used_bytes(&self) -> u64 {
        self.total_bytes.saturating_sub(self.available_bytes)
    }
}

/// Reads the volume hosting `path`.
///
/// Returns `None` when the path cannot be interrogated - a data directory that
/// does not exist yet, a path with an interior NUL, a refused `statvfs`. The
/// caller turns that into a check that says "unknown", never into a reassuring
/// "plenty of room".
pub fn usage_of(path: &Path) -> Option<DiskUsage> {
    // `statvfs` follows the path, so an existing ancestor answers for a data
    // directory that has not been created yet - which is exactly the volume the
    // operator cares about.
    let target = first_existing_ancestor(path)?;
    usage_of_existing(&target)
}

/// The POSIX answer.
#[cfg(unix)]
fn usage_of_existing(target: &Path) -> Option<DiskUsage> {
    let raw = CString::new(target.as_os_str().as_encoded_bytes()).ok()?;

    // SAFETY: `raw` is a valid NUL-terminated C string that outlives the call,
    // and `stat` is a fully initialised-on-success `statvfs` we only read from
    // after the call reports 0.
    let mut stat = unsafe { std::mem::zeroed::<libc::statvfs>() };
    let rc = unsafe { libc::statvfs(raw.as_ptr(), &mut stat) };
    if rc != 0 {
        tracing::warn!(
            path = %target.display(),
            error = %std::io::Error::last_os_error(),
            "health: statvfs sur le volume de données a échoué",
        );
        return None;
    }

    // `f_frsize` is the fragment size, the unit `f_blocks`/`f_bavail` are
    // counted in. Some filesystems report 0 there; fall back on `f_bsize`.
    let unit = if stat.f_frsize > 0 { stat.f_frsize } else { stat.f_bsize } as u64;
    if unit == 0 {
        return None;
    }

    Some(DiskUsage {
        total_bytes: (stat.f_blocks as u64).saturating_mul(unit),
        available_bytes: (stat.f_bavail as u64).saturating_mul(unit),
    })
}

/// The Windows answer.
///
/// `statvfs` does not exist there, and calling it unconditionally is what kept
/// the server from compiling for Windows at all. `GetDiskFreeSpaceExW` reports
/// the same two figures, with one difference worth knowing: it answers for the
/// calling user's quota when one is in force, which is the honest number for a
/// service that writes as itself.
#[cfg(windows)]
fn usage_of_existing(target: &Path) -> Option<DiskUsage> {
    use std::os::windows::ffi::OsStrExt;

    // A NUL-terminated wide string, as every Windows path API expects.
    let wide: Vec<u16> = target.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut available: u64 = 0;
    let mut total: u64 = 0;

    // SAFETY: `wide` is NUL-terminated and outlives the call; both outputs are
    // owned here and only read once the call reports success.
    let ok = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            &mut total,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        tracing::warn!(
            path = %target.display(),
            error = %std::io::Error::last_os_error(),
            "health: espace libre du volume de données indisponible",
        );
        return None;
    }
    Some(DiskUsage { total_bytes: total, available_bytes: available })
}

/// Walks up until something exists. A relative `./data/files` on a fresh
/// install resolves to the working directory rather than to nothing.
fn first_existing_ancestor(path: &Path) -> Option<std::path::PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    let mut candidate = absolute.as_path();
    loop {
        if candidate.exists() {
            return Some(candidate.to_path_buf());
        }
        candidate = candidate.parent()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_volume_is_readable() {
        let usage = usage_of(Path::new("/")).expect("statvfs sur /");
        assert!(usage.total_bytes > 0);
        assert!(usage.available_bytes <= usage.total_bytes);
    }

    #[test]
    fn a_missing_directory_falls_back_to_its_volume() {
        // The point of the ancestor walk: a data directory that does not exist
        // yet must still report the volume it will land on.
        let usage = usage_of(Path::new("/tmp/kubuno-health-does-not-exist/files"));
        assert!(usage.is_some());
    }

    #[test]
    fn ratio_is_bounded_and_degenerate_volumes_read_as_full_of_room() {
        let d = DiskUsage { total_bytes: 1000, available_bytes: 250 };
        assert!((d.available_ratio() - 0.25).abs() < f64::EPSILON);
        assert_eq!(d.used_bytes(), 750);

        let empty = DiskUsage { total_bytes: 0, available_bytes: 0 };
        assert_eq!(empty.available_ratio(), 1.0);
    }
}
