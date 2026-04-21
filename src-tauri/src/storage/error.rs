//! Storage error surface. Wraps `sqlx::Error` so callers don't need to depend
//! on sqlx directly — keeps the database driver as an implementation detail.

#![allow(dead_code)]

use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("migration error: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid state: {0}")]
    Invalid(String),
}

pub type StorageResult<T> = Result<T, StorageError>;
