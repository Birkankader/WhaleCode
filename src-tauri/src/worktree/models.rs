use serde::Serialize;
use specta::Type;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Type)]
pub struct WorktreeEntry {
    pub task_id: String,
    pub worktree_name: String,
    pub branch_name: String,
    pub path: PathBuf,
    /// ISO 8601 timestamp string (specta does not implement Type for chrono::DateTime)
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct ConflictFile {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct ConflictReport {
    pub has_conflicts: bool,
    pub conflicting_files: Vec<ConflictFile>,
    pub worktree_a: String,
    pub worktree_b: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_entry_serializes_all_fields() {
        let entry = WorktreeEntry {
            task_id: "abc12345-def6-7890".to_string(),
            worktree_name: "whalecode-abc12345".to_string(),
            branch_name: "whalecode/task/abc12345".to_string(),
            path: PathBuf::from("/tmp/.whalecode-worktrees/whalecode-abc12345"),
            created_at: chrono::Utc::now().to_rfc3339(),
        };

        let json = serde_json::to_value(&entry).expect("should serialize");
        assert!(json.get("task_id").is_some());
        assert!(json.get("worktree_name").is_some());
        assert!(json.get("branch_name").is_some());
        assert!(json.get("path").is_some());
        assert!(json.get("created_at").is_some());
        assert_eq!(json["task_id"], "abc12345-def6-7890");
        assert_eq!(json["worktree_name"], "whalecode-abc12345");
        assert_eq!(json["branch_name"], "whalecode/task/abc12345");
    }

    #[test]
    fn conflict_file_serializes_with_path() {
        let file = ConflictFile {
            path: "src/main.rs".to_string(),
        };

        let json = serde_json::to_value(&file).expect("should serialize");
        assert_eq!(json["path"], "src/main.rs");
    }

    #[test]
    fn conflict_report_serializes_all_fields() {
        let report = ConflictReport {
            has_conflicts: true,
            conflicting_files: vec![
                ConflictFile {
                    path: "src/main.rs".to_string(),
                },
                ConflictFile {
                    path: "Cargo.toml".to_string(),
                },
            ],
            worktree_a: "whalecode-task-a".to_string(),
            worktree_b: "whalecode-task-b".to_string(),
        };

        let json = serde_json::to_value(&report).expect("should serialize");
        assert_eq!(json["has_conflicts"], true);
        assert_eq!(json["conflicting_files"].as_array().unwrap().len(), 2);
        assert_eq!(json["worktree_a"], "whalecode-task-a");
        assert_eq!(json["worktree_b"], "whalecode-task-b");
    }

    #[test]
    fn conflict_report_empty_conflicts() {
        let report = ConflictReport {
            has_conflicts: false,
            conflicting_files: vec![],
            worktree_a: "whalecode-task-a".to_string(),
            worktree_b: "whalecode-task-b".to_string(),
        };

        let json = serde_json::to_value(&report).expect("should serialize");
        assert_eq!(json["has_conflicts"], false);
        assert_eq!(json["conflicting_files"].as_array().unwrap().len(), 0);
    }
}
