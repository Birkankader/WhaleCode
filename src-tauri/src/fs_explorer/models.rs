use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Serialize, Type)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u32,
    pub extension: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct FileContent {
    pub content: String,
    pub truncated: bool,
    pub size: u32,
    pub language: String,
}
