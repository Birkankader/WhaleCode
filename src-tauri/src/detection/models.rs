use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum AuthStatus {
    Authenticated,
    NeedsAuth,
    NotInstalled,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DetectedAgent {
    pub tool_name: String,
    pub installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub auth_status: AuthStatus,
    pub display_name: String,
}
