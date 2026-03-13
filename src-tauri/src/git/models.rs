use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Serialize, Type)]
pub struct GitFileEntry {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct GitStatusReport {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<GitFileEntry>,
    pub unstaged: Vec<GitFileEntry>,
    pub untracked: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct GitLogEntry {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub time_ago: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct GitPullResult {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct GitPushResult {
    pub success: bool,
    pub message: String,
}
