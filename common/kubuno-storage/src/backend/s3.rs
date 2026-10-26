use async_trait::async_trait;
use bytes::Bytes;

use super::{ByteStream, MultipartPart, StorageBackend, StorageObject};
use crate::error::{StorageError, StorageResult};

pub struct S3Storage;

#[async_trait]
impl StorageBackend for S3Storage {
    async fn put(&self, _path: &str, _data: Bytes) -> StorageResult<()> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn put_stream(&self, _path: &str, _stream: ByteStream, _size_hint: Option<u64>) -> StorageResult<()> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn get(&self, _path: &str) -> StorageResult<Bytes> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn get_stream(&self, _path: &str) -> StorageResult<ByteStream> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn get_range(&self, _path: &str, _start: u64, _end: u64) -> StorageResult<ByteStream> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn delete(&self, _path: &str) -> StorageResult<()> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn delete_dir(&self, _path: &str) -> StorageResult<()> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn exists(&self, _path: &str) -> StorageResult<bool> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn size(&self, _path: &str) -> StorageResult<u64> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn list(&self, _prefix: &str) -> StorageResult<Vec<StorageObject>> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn copy(&self, _from: &str, _to: &str) -> StorageResult<()> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn init_multipart(&self, _path: &str) -> StorageResult<String> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn put_part(&self, _path: &str, _upload_id: &str, _part_number: u32, _data: Bytes) -> StorageResult<String> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn complete_multipart(&self, _path: &str, _upload_id: &str, _parts: Vec<MultipartPart>) -> StorageResult<()> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn abort_multipart(&self, _path: &str, _upload_id: &str) -> StorageResult<()> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
    async fn create_dir(&self, _path: &str) -> StorageResult<()> {
        // S3 n'a pas de répertoires - no-op
        Ok(())
    }
    async fn mv_dir(&self, _from: &str, _to: &str) -> StorageResult<()> {
        Err(StorageError::Internal("mv_dir is not implemented for S3".into()))
    }
    async fn presign_get(&self, _path: &str, _ttl_seconds: u64) -> StorageResult<String> {
        Err(StorageError::Internal("S3 backend is not configured".into()))
    }
}
