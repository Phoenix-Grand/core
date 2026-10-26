use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio_util::io::ReaderStream;

use super::{ByteStream, MultipartPart, StorageBackend, StorageObject};
use crate::error::{StorageError, StorageResult};

pub struct LocalStorage {
    base: PathBuf,
}

impl LocalStorage {
    pub async fn new(base_path: &str) -> StorageResult<Self> {
        let base = PathBuf::from(base_path);
        tokio::fs::create_dir_all(&base).await?;
        Ok(Self { base })
    }

    fn resolve(&self, path: &str) -> StorageResult<PathBuf> {
        // Build the candidate on the canonical base, so both sides of the
        // `starts_with` check share one spelling. On Windows `canonicalize()`
        // returns a verbatim `\\?\C:\...` path; comparing it with a candidate
        // built on the raw base (`C:\...`) rejected every path. The same applies
        // on Unix when the base itself sits behind a symlink.
        let canonical_base = self
            .base
            .canonicalize()
            .unwrap_or_else(|_| self.base.clone());
        let full = canonical_base.join(path.trim_start_matches('/'));
        let normalized = normalize_path(&full);

        if !normalized.starts_with(&canonical_base) {
            return Err(StorageError::InvalidPath(format!(
                "Path '{path}' is outside the allowed storage area"
            )));
        }
        Ok(normalized)
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut components: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                components.pop();
            }
            Component::CurDir => {}
            c => components.push(c),
        }
    }
    components.iter().collect()
}

#[async_trait]
impl StorageBackend for LocalStorage {
    async fn put(&self, path: &str, data: Bytes) -> StorageResult<()> {
        let full = self.resolve(path)?;
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&full, data).await?;
        Ok(())
    }

    async fn put_stream(
        &self,
        path: &str,
        mut stream: ByteStream,
        _size_hint: Option<u64>,
    ) -> StorageResult<()> {
        let full = self.resolve(path)?;
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut file = tokio::fs::File::create(&full).await?;
        while let Some(chunk) = stream.next().await {
            file.write_all(&chunk?).await?;
        }
        file.flush().await?;
        Ok(())
    }

    async fn get(&self, path: &str) -> StorageResult<Bytes> {
        let full = self.resolve(path)?;
        tokio::fs::read(&full).await.map(Bytes::from).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                StorageError::NotFound(path.to_string())
            } else {
                StorageError::Io(e)
            }
        })
    }

    async fn get_stream(&self, path: &str) -> StorageResult<ByteStream> {
        let full = self.resolve(path)?;
        let file = tokio::fs::File::open(&full).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                StorageError::NotFound(path.to_string())
            } else {
                StorageError::Io(e)
            }
        })?;
        let stream = ReaderStream::new(file).map(|r| r.map_err(StorageError::Io));
        Ok(Box::pin(stream))
    }

    async fn get_range(&self, path: &str, start: u64, end: u64) -> StorageResult<ByteStream> {
        let full = self.resolve(path)?;
        let mut file = tokio::fs::File::open(&full).await?;
        file.seek(SeekFrom::Start(start)).await?;
        let limited = file.take(end - start + 1);
        let stream = ReaderStream::new(limited).map(|r| r.map_err(StorageError::Io));
        Ok(Box::pin(stream))
    }

    async fn delete(&self, path: &str) -> StorageResult<()> {
        let full = self.resolve(path)?;
        match tokio::fs::remove_file(&full).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(StorageError::Io(e)),
        }
    }

    async fn delete_dir(&self, path: &str) -> StorageResult<()> {
        let full = self.resolve(path)?;
        match tokio::fs::remove_dir_all(&full).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(StorageError::Io(e)),
        }
    }

    async fn exists(&self, path: &str) -> StorageResult<bool> {
        let full = self.resolve(path)?;
        Ok(tokio::fs::try_exists(&full).await?)
    }

    async fn size(&self, path: &str) -> StorageResult<u64> {
        let full = self.resolve(path)?;
        let meta = tokio::fs::metadata(&full).await?;
        Ok(meta.len())
    }

    async fn list(&self, prefix: &str) -> StorageResult<Vec<StorageObject>> {
        let full = self.resolve(prefix)?;
        let mut entries = Vec::new();
        let mut read_dir = tokio::fs::read_dir(&full)
            .await
            .map_err(|_| StorageError::NotFound(prefix.to_string()))?;
        while let Some(entry) = read_dir.next_entry().await? {
            let meta = entry.metadata().await?;
            if meta.is_file() {
                entries.push(StorageObject {
                    path: entry
                        .path()
                        .strip_prefix(&self.base)
                        .unwrap_or(entry.path().as_path())
                        .to_string_lossy()
                        .to_string(),
                    size: meta.len(),
                    content_type: None,
                });
            }
        }
        Ok(entries)
    }

    async fn copy(&self, from: &str, to: &str) -> StorageResult<()> {
        let src = self.resolve(from)?;
        let dest = self.resolve(to)?;
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::copy(&src, &dest).await?;
        Ok(())
    }

    async fn create_dir(&self, path: &str) -> StorageResult<()> {
        let full = self.resolve(path)?;
        tokio::fs::create_dir_all(&full).await?;
        Ok(())
    }

    async fn mv_dir(&self, from: &str, to: &str) -> StorageResult<()> {
        let src  = self.resolve(from)?;
        let dest = self.resolve(to)?;
        if !src.exists() {
            // Répertoire source absent → rien à faire (dossier peut-être vide)
            return Ok(());
        }
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::rename(&src, &dest).await?;
        Ok(())
    }

    async fn init_multipart(&self, _path: &str) -> StorageResult<String> {
        let upload_id = uuid::Uuid::new_v4().to_string();
        let temp_dir = self.base.join(".multipart").join(&upload_id);
        tokio::fs::create_dir_all(&temp_dir).await?;
        Ok(upload_id)
    }

    async fn put_part(
        &self,
        _path: &str,
        upload_id: &str,
        part_number: u32,
        data: Bytes,
    ) -> StorageResult<String> {
        let part_path = self
            .base
            .join(".multipart")
            .join(upload_id)
            .join(format!("{part_number:08}.part"));
        tokio::fs::write(&part_path, &data).await?;
        let etag = hex::encode(Sha256::digest(&data));
        Ok(etag)
    }

    async fn complete_multipart(
        &self,
        path: &str,
        upload_id: &str,
        mut parts: Vec<MultipartPart>,
    ) -> StorageResult<()> {
        parts.sort_by_key(|p| p.part_number);
        let dest = self.resolve(path)?;
        let temp_dir = self.base.join(".multipart").join(upload_id);

        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let mut out = tokio::fs::File::create(&dest).await?;
        for part in &parts {
            let part_path = temp_dir.join(format!("{:08}.part", part.part_number));
            let data = tokio::fs::read(&part_path).await?;
            out.write_all(&data).await?;
        }
        out.flush().await?;
        tokio::fs::remove_dir_all(&temp_dir).await.ok();
        Ok(())
    }

    async fn abort_multipart(&self, _path: &str, upload_id: &str) -> StorageResult<()> {
        let temp_dir = self.base.join(".multipart").join(upload_id);
        tokio::fs::remove_dir_all(&temp_dir).await.ok();
        Ok(())
    }

    async fn presign_get(&self, path: &str, _ttl_seconds: u64) -> StorageResult<String> {
        Ok(path.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn make_storage() -> (LocalStorage, TempDir) {
        let dir = TempDir::new().unwrap();
        let storage = LocalStorage::new(dir.path().to_str().unwrap()).await.unwrap();
        (storage, dir)
    }

    #[tokio::test]
    async fn test_put_and_get() {
        let (storage, _dir) = make_storage().await;
        storage.put("test.txt", Bytes::from("hello")).await.unwrap();
        let data = storage.get("test.txt").await.unwrap();
        assert_eq!(data, Bytes::from("hello"));
    }

    #[tokio::test]
    async fn test_get_nonexistent_returns_not_found() {
        let (storage, _dir) = make_storage().await;
        let result = storage.get("nope.txt").await;
        assert!(matches!(result, Err(StorageError::NotFound(_))));
    }

    #[tokio::test]
    async fn test_delete_idempotent() {
        let (storage, _dir) = make_storage().await;
        storage.put("del.txt", Bytes::from("x")).await.unwrap();
        storage.delete("del.txt").await.unwrap();
        storage.delete("del.txt").await.unwrap(); // doit réussir
    }

    #[tokio::test]
    async fn test_path_traversal_rejected() {
        let (storage, _dir) = make_storage().await;
        let result = storage.get("../../etc/passwd").await;
        assert!(matches!(result, Err(StorageError::InvalidPath(_))));
    }

    #[tokio::test]
    async fn test_exists() {
        let (storage, _dir) = make_storage().await;
        assert!(!storage.exists("x.txt").await.unwrap());
        storage.put("x.txt", Bytes::from("data")).await.unwrap();
        assert!(storage.exists("x.txt").await.unwrap());
    }

    #[tokio::test]
    async fn test_multipart_assemble() {
        let (storage, _dir) = make_storage().await;
        let upload_id = storage.init_multipart("assembled.bin").await.unwrap();
        let etag0 = storage.put_part("assembled.bin", &upload_id, 0, Bytes::from("hello")).await.unwrap();
        let etag1 = storage.put_part("assembled.bin", &upload_id, 1, Bytes::from(" world")).await.unwrap();
        let parts = vec![
            MultipartPart { part_number: 0, etag: etag0 },
            MultipartPart { part_number: 1, etag: etag1 },
        ];
        storage.complete_multipart("assembled.bin", &upload_id, parts).await.unwrap();
        let data = storage.get("assembled.bin").await.unwrap();
        assert_eq!(data, Bytes::from("hello world"));
    }

    #[tokio::test]
    async fn test_copy() {
        let (storage, _dir) = make_storage().await;
        storage.put("src.txt", Bytes::from("copy me")).await.unwrap();
        storage.copy("src.txt", "dst.txt").await.unwrap();
        assert_eq!(storage.get("dst.txt").await.unwrap(), Bytes::from("copy me"));
        assert!(storage.exists("src.txt").await.unwrap());
    }
}
