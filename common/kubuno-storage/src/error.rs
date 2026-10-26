#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("File not found: {0}")]
    NotFound(String),

    #[error("Invalid path: {0}")]
    InvalidPath(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("S3 error: {0}")]
    S3(String),

    #[error("Multipart upload not found: {0}")]
    MultipartNotFound(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

pub type StorageResult<T> = Result<T, StorageError>;
