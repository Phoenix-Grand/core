use std::path::PathBuf;
use uuid::Uuid;

// ── User file storage path layout ─────────────────────────────────────────────

/// Physical path of a user file.
/// Format (relative to the storage root): {owner_id}/files{folder_virt_path}/{filename}
///
/// `folder_virt_path` comes from `files.folders.path`: empty string for the root,
/// "/Documents" for a top-level folder, "/Documents/Subfolder" for a nested folder.
/// The original name is preserved → the on-disk tree mirrors the virtual tree.
pub fn user_file_path(owner_id: Uuid, folder_virt_path: &str, filename: &str) -> PathBuf {
    let mut p = PathBuf::from(owner_id.to_string()).join("files");
    let rel = folder_virt_path.trim_start_matches('/');
    if !rel.is_empty() {
        p = p.join(rel);
    }
    p.join(filename)
}

/// Physical directory matching a virtual folder.
/// Format: {owner_id}/files{folder_virt_path}
pub fn user_folder_dir(owner_id: Uuid, folder_virt_path: &str) -> PathBuf {
    let mut p = PathBuf::from(owner_id.to_string()).join("files");
    let rel = folder_virt_path.trim_start_matches('/');
    if !rel.is_empty() {
        p = p.join(rel);
    }
    p
}

/// Path of a file version.
/// Format: {owner_id}/versions/{file_id}/{version_number}/{filename}
pub fn user_version_path(owner_id: Uuid, file_id: Uuid, version_number: i32, filename: &str) -> PathBuf {
    PathBuf::from(owner_id.to_string())
        .join("versions")
        .join(file_id.to_string())
        .join(version_number.to_string())
        .join(filename)
}

/// Thumbnail path.
/// Format: {owner_id}/thumbnails/{file_id}.jpg
pub fn user_thumbnail_path(owner_id: Uuid, file_id: Uuid) -> PathBuf {
    PathBuf::from(owner_id.to_string())
        .join("thumbnails")
        .join(format!("{file_id}.jpg"))
}

/// Répertoire temporaire d'upload (commun à tous les utilisateurs).
/// Format: .uploads/{session_id}
pub fn upload_temp_dir_v2(session_id: Uuid) -> PathBuf {
    PathBuf::from(".uploads").join(session_id.to_string())
}

/// Chemin d'un chunk temporaire.
/// Format: .uploads/{session_id}/{chunk_index:08}.part
pub fn chunk_path_v2(session_id: Uuid, chunk_index: u32) -> PathBuf {
    PathBuf::from(".uploads")
        .join(session_id.to_string())
        .join(format!("{chunk_index:08}.part"))
}

// ── Anciens helpers (conservés pour rétrocompatibilité interne) ───────────────

/// @deprecated - Utiliser `user_file_path` à la place.
pub fn file_path(
    base: &str,
    module_id: &str,
    owner_id: Uuid,
    file_id: Uuid,
    created_at: chrono::DateTime<chrono::Utc>,
) -> PathBuf {
    PathBuf::from(base)
        .join(sanitize_component(module_id))
        .join(owner_id.to_string())
        .join(created_at.format("%Y").to_string())
        .join(created_at.format("%m").to_string())
        .join(file_id.to_string())
}

/// @deprecated - Utiliser `user_thumbnail_path` à la place.
pub fn thumbnail_path(base: &str, module_id: &str, file_id: Uuid) -> PathBuf {
    PathBuf::from(base)
        .join("thumbs")
        .join(sanitize_component(module_id))
        .join(format!("{file_id}.jpg"))
}

/// @deprecated - Utiliser `upload_temp_dir_v2` à la place.
pub fn upload_temp_dir(temp: &str, session_id: Uuid) -> PathBuf {
    PathBuf::from(temp).join(session_id.to_string())
}

/// @deprecated - Utiliser `chunk_path_v2` à la place.
pub fn chunk_path(temp: &str, session_id: Uuid, chunk_index: u32) -> PathBuf {
    PathBuf::from(temp)
        .join(session_id.to_string())
        .join(format!("{chunk_index:08}.part"))
}

fn sanitize_component(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>()
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// The components of a path as strings, so the assertions check the layout
    /// (which segments, in which order) and not the host's separator.
    fn parts(p: &Path) -> Vec<String> {
        p.components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn test_user_file_path_root() {
        let uid = Uuid::nil();
        let p = user_file_path(uid, "", "rapport.pdf");
        assert_eq!(parts(&p), [uid.to_string().as_str(), "files", "rapport.pdf"]);
    }

    #[test]
    fn test_user_file_path_nested() {
        let uid = Uuid::nil();
        let p = user_file_path(uid, "/Documents/Archives", "old.pdf");
        assert_eq!(
            parts(&p),
            [uid.to_string().as_str(), "files", "Documents", "Archives", "old.pdf"]
        );
    }

    #[test]
    fn test_user_folder_dir() {
        let uid = Uuid::nil();
        let p = user_folder_dir(uid, "/Photos/Vacances");
        assert_eq!(
            parts(&p),
            [uid.to_string().as_str(), "files", "Photos", "Vacances"]
        );
    }

    #[test]
    fn test_user_thumbnail_path() {
        let uid = Uuid::nil();
        let fid = Uuid::nil();
        let p = user_thumbnail_path(uid, fid);
        assert_eq!(
            parts(&p),
            [uid.to_string().as_str(), "thumbnails", format!("{fid}.jpg").as_str()]
        );
    }

    #[test]
    fn test_upload_temp_paths() {
        let sid = Uuid::nil();
        let dir = upload_temp_dir_v2(sid);
        assert_eq!(parts(&dir), [".uploads", sid.to_string().as_str()]);
        let chunk = chunk_path_v2(sid, 3);
        assert_eq!(parts(&chunk), [".uploads", sid.to_string().as_str(), "00000003.part"]);
    }
}
