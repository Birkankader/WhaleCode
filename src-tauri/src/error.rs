use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize, specta::Type)]
#[serde(tag = "code", content = "detail")]
pub enum WhaleError {
    #[error("Process timeout: {0}")]
    Timeout(String),

    #[error("Rate limited: {0}")]
    RateLimited(String),

    #[error("Agent error: {0}")]
    AgentError(String),

    #[error("Decomposition failed: {0}")]
    DecompositionFailed(String),

    #[error("Merge conflict: {0}")]
    MergeConflict(String),

    #[error("Config error: {0}")]
    ConfigError(String),

    #[error("Process not found: {0}")]
    ProcessNotFound(String),

    #[error("Lock poisoned")]
    LockPoisoned,

    #[error("IO error: {0}")]
    IoError(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

impl From<std::io::Error> for WhaleError {
    fn from(e: std::io::Error) -> Self {
        WhaleError::IoError(e.to_string())
    }
}

// For Tauri command return types
impl From<WhaleError> for String {
    fn from(e: WhaleError) -> String {
        serde_json::to_string(&e).unwrap_or_else(|_| e.to_string())
    }
}
