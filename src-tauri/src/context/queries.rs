use rusqlite::Connection;

use super::models::{ContextEvent, FileChangeRecord};
use crate::adapters::claude::ClaudeStreamEvent;

/// Record a task completion event with associated file changes in a single transaction.
pub fn record_task_completion(
    _conn: &Connection,
    _task_id: &str,
    _tool_name: &str,
    _event_type: &str,
    _prompt: Option<&str>,
    _summary: Option<&str>,
    _project_dir: &str,
    _duration_ms: Option<u64>,
    _cost_usd: Option<f64>,
    _files_changed: &[(String, String)],
) -> Result<i64, rusqlite::Error> {
    todo!()
}

/// Get recent file changes for a project, ordered by created_at DESC.
pub fn get_recent_file_changes(
    _conn: &Connection,
    _project_dir: &str,
    _limit: u32,
) -> Result<Vec<FileChangeRecord>, rusqlite::Error> {
    todo!()
}

/// Get recent events with their associated file paths for a project.
pub fn get_recent_events(
    _conn: &Connection,
    _project_dir: &str,
    _limit: u32,
) -> Result<Vec<(ContextEvent, Vec<String>)>, rusqlite::Error> {
    todo!()
}

/// Extract file changes from Claude stream events (Write = created, Edit = modified).
pub fn extract_file_changes_from_claude_events(
    _events: &[ClaudeStreamEvent],
) -> Vec<(String, String)> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::migrations::run_migrations;

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    #[test]
    fn record_task_completion_inserts_event_and_file_changes() {
        let conn = setup_db();
        let files = vec![
            ("src/main.rs".to_string(), "modified".to_string()),
            ("src/lib.rs".to_string(), "created".to_string()),
        ];
        let event_id = record_task_completion(
            &conn,
            "task-1",
            "claude",
            "task_completed",
            Some("fix the bug"),
            Some("Fixed null pointer"),
            "/home/user/project",
            Some(5000),
            Some(0.05),
            &files,
        )
        .unwrap();

        assert!(event_id > 0);

        // Verify event was inserted
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM context_events", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);

        // Verify file changes were inserted
        let fc_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM file_changes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(fc_count, 2);
    }

    #[test]
    fn record_task_completion_with_empty_files() {
        let conn = setup_db();
        let files: Vec<(String, String)> = vec![];
        let event_id = record_task_completion(
            &conn,
            "task-2",
            "claude",
            "task_completed",
            None,
            Some("No changes"),
            "/home/user/project",
            None,
            None,
            &files,
        )
        .unwrap();

        assert!(event_id > 0);

        let event_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM context_events", [], |row| row.get(0))
            .unwrap();
        assert_eq!(event_count, 1);

        let fc_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM file_changes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(fc_count, 0);
    }

    #[test]
    fn get_recent_file_changes_ordered_by_created_at_desc() {
        let conn = setup_db();

        // Insert two events at different times
        conn.execute(
            "INSERT INTO context_events (task_id, tool_name, event_type, project_dir, summary, created_at) VALUES ('t1', 'claude', 'task_completed', '/proj', 'First', datetime('now', '-1 hour'))",
            [],
        ).unwrap();
        let eid1: i64 = conn.last_insert_rowid();

        conn.execute(
            "INSERT INTO context_events (task_id, tool_name, event_type, project_dir, summary, created_at) VALUES ('t2', 'gemini', 'task_completed', '/proj', 'Second', datetime('now'))",
            [],
        ).unwrap();
        let eid2: i64 = conn.last_insert_rowid();

        conn.execute(
            "INSERT INTO file_changes (event_id, file_path, change_type, created_at) VALUES (?1, 'old.rs', 'modified', datetime('now', '-1 hour'))",
            [eid1],
        ).unwrap();
        conn.execute(
            "INSERT INTO file_changes (event_id, file_path, change_type, created_at) VALUES (?1, 'new.rs', 'created', datetime('now'))",
            [eid2],
        ).unwrap();

        let changes = get_recent_file_changes(&conn, "/proj", 10).unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].file_path, "new.rs"); // most recent first
        assert_eq!(changes[1].file_path, "old.rs");
    }

    #[test]
    fn get_recent_file_changes_respects_limit() {
        let conn = setup_db();

        conn.execute(
            "INSERT INTO context_events (task_id, tool_name, event_type, project_dir) VALUES ('t1', 'claude', 'task_completed', '/proj')",
            [],
        ).unwrap();
        let eid: i64 = conn.last_insert_rowid();

        for i in 0..5 {
            conn.execute(
                "INSERT INTO file_changes (event_id, file_path, change_type) VALUES (?1, ?2, 'modified')",
                rusqlite::params![eid, format!("file{}.rs", i)],
            ).unwrap();
        }

        let changes = get_recent_file_changes(&conn, "/proj", 3).unwrap();
        assert_eq!(changes.len(), 3);
    }

    #[test]
    fn get_recent_file_changes_filters_by_project_dir() {
        let conn = setup_db();

        // Insert event for project A
        conn.execute(
            "INSERT INTO context_events (task_id, tool_name, event_type, project_dir) VALUES ('t1', 'claude', 'task_completed', '/proj-a')",
            [],
        ).unwrap();
        let eid_a: i64 = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO file_changes (event_id, file_path, change_type) VALUES (?1, 'a.rs', 'modified')",
            [eid_a],
        ).unwrap();

        // Insert event for project B
        conn.execute(
            "INSERT INTO context_events (task_id, tool_name, event_type, project_dir) VALUES ('t2', 'claude', 'task_completed', '/proj-b')",
            [],
        ).unwrap();
        let eid_b: i64 = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO file_changes (event_id, file_path, change_type) VALUES (?1, 'b.rs', 'modified')",
            [eid_b],
        ).unwrap();

        let changes = get_recent_file_changes(&conn, "/proj-a", 10).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].file_path, "a.rs");
    }

    #[test]
    fn get_recent_events_returns_events_with_file_paths() {
        let conn = setup_db();

        let files = vec![
            ("main.rs".to_string(), "modified".to_string()),
            ("lib.rs".to_string(), "created".to_string()),
        ];
        record_task_completion(
            &conn,
            "task-1",
            "claude",
            "task_completed",
            Some("do stuff"),
            Some("Did stuff"),
            "/proj",
            Some(3000),
            Some(0.03),
            &files,
        )
        .unwrap();

        let events = get_recent_events(&conn, "/proj", 10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0.task_id, "task-1");
        assert_eq!(events[0].1.len(), 2);
        assert!(events[0].1.contains(&"main.rs".to_string()));
        assert!(events[0].1.contains(&"lib.rs".to_string()));
    }

    #[test]
    fn get_recent_events_respects_limit() {
        let conn = setup_db();

        for i in 0..5 {
            record_task_completion(
                &conn,
                &format!("task-{}", i),
                "claude",
                "task_completed",
                None,
                None,
                "/proj",
                None,
                None,
                &[],
            )
            .unwrap();
        }

        let events = get_recent_events(&conn, "/proj", 3).unwrap();
        assert_eq!(events.len(), 3);
    }

    #[test]
    fn extract_file_changes_from_claude_events_finds_write_and_edit() {
        let events = vec![
            ClaudeStreamEvent::ToolUse {
                name: Some("Write".to_string()),
                input: Some(serde_json::json!({
                    "file_path": "/proj/src/main.rs",
                    "content": "fn main() {}"
                })),
            },
            ClaudeStreamEvent::ToolUse {
                name: Some("Edit".to_string()),
                input: Some(serde_json::json!({
                    "file_path": "/proj/src/lib.rs",
                    "old_string": "old",
                    "new_string": "new"
                })),
            },
            ClaudeStreamEvent::ToolUse {
                name: Some("Bash".to_string()),
                input: Some(serde_json::json!({
                    "command": "ls"
                })),
            },
        ];

        let changes = extract_file_changes_from_claude_events(&events);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0], ("/proj/src/main.rs".to_string(), "created".to_string()));
        assert_eq!(changes[1], ("/proj/src/lib.rs".to_string(), "modified".to_string()));
    }

    #[test]
    fn extract_file_changes_from_claude_events_empty_for_no_file_ops() {
        let events = vec![
            ClaudeStreamEvent::ToolUse {
                name: Some("Bash".to_string()),
                input: Some(serde_json::json!({"command": "ls"})),
            },
            ClaudeStreamEvent::Init {
                session_id: Some("abc".to_string()),
            },
            ClaudeStreamEvent::Message {
                role: Some("assistant".to_string()),
                content: None,
            },
        ];

        let changes = extract_file_changes_from_claude_events(&events);
        assert!(changes.is_empty());
    }
}
