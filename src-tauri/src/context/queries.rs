use rusqlite::{params, Connection};

use super::models::{ContextEvent, FileChangeRecord, OrchestrationRecord};
use crate::adapters::claude::ClaudeStreamEvent;

/// Record a task completion event with associated file changes in a single transaction.
pub fn record_task_completion(
    conn: &Connection,
    task_id: &str,
    tool_name: &str,
    event_type: &str,
    prompt: Option<&str>,
    summary: Option<&str>,
    project_dir: &str,
    duration_ms: Option<u64>,
    cost_usd: Option<f64>,
    files_changed: &[(String, String)],
) -> Result<i64, rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    let duration_ms_i64 = duration_ms.map(|v| v as i64);

    tx.execute(
        "INSERT INTO context_events (task_id, tool_name, event_type, prompt, summary, project_dir, duration_ms, cost_usd)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![task_id, tool_name, event_type, prompt, summary, project_dir, duration_ms_i64, cost_usd],
    )?;
    let event_id = tx.last_insert_rowid();

    for (file_path, change_type) in files_changed {
        tx.execute(
            "INSERT INTO file_changes (event_id, file_path, change_type) VALUES (?1, ?2, ?3)",
            params![event_id, file_path, change_type],
        )?;
    }

    tx.commit()?;
    Ok(event_id)
}

/// Get recent file changes for a project, ordered by created_at DESC.
pub fn get_recent_file_changes(
    conn: &Connection,
    project_dir: &str,
    limit: u32,
) -> Result<Vec<FileChangeRecord>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT fc.file_path, fc.change_type, ce.tool_name, ce.summary, fc.created_at
         FROM file_changes fc
         JOIN context_events ce ON fc.event_id = ce.id
         WHERE ce.project_dir = ?1
         ORDER BY fc.created_at DESC
         LIMIT ?2",
    )?;

    let rows = stmt.query_map(params![project_dir, limit], |row| {
        Ok(FileChangeRecord {
            file_path: row.get(0)?,
            change_type: row.get(1)?,
            tool_name: row.get(2)?,
            summary: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;

    rows.collect()
}

/// Get recent events with their associated file paths for a project.
/// Uses a single JOIN query instead of N+1 queries.
pub fn get_recent_events(
    conn: &Connection,
    project_dir: &str,
    limit: u32,
) -> Result<Vec<(ContextEvent, Vec<String>)>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT ce.id, ce.task_id, ce.tool_name, ce.event_type, ce.prompt, ce.summary,
                ce.project_dir, ce.metadata, ce.duration_ms, ce.cost_usd, ce.created_at,
                fc.file_path
         FROM context_events ce
         LEFT JOIN file_changes fc ON fc.event_id = ce.id
         WHERE ce.project_dir = ?1
         ORDER BY ce.created_at DESC, ce.id DESC
         LIMIT ?2",
    )?;

    // We may get multiple rows per event (one per file_path), but limited events.
    // Collect and group by event id.
    let rows = stmt.query_map(params![project_dir, limit * 20], |row| {
        let duration_ms_i64: Option<i64> = row.get(8)?;
        let file_path: Option<String> = row.get(11)?;
        Ok((ContextEvent {
            id: row.get(0)?,
            task_id: row.get(1)?,
            tool_name: row.get(2)?,
            event_type: row.get(3)?,
            prompt: row.get(4)?,
            summary: row.get(5)?,
            project_dir: row.get(6)?,
            metadata: row.get(7)?,
            duration_ms: duration_ms_i64.map(|v| v as u64),
            cost_usd: row.get(9)?,
            created_at: row.get(10)?,
        }, file_path))
    })?;

    let mut result: Vec<(ContextEvent, Vec<String>)> = Vec::new();
    let mut seen_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();

    for row_result in rows {
        let (event, file_path) = row_result?;
        if seen_ids.contains(&event.id) {
            // Append file_path to existing entry
            if let Some(fp) = file_path {
                if let Some(entry) = result.iter_mut().find(|(e, _)| e.id == event.id) {
                    entry.1.push(fp);
                }
            }
        } else {
            seen_ids.insert(event.id);
            if seen_ids.len() > limit as usize {
                break; // We've collected enough unique events
            }
            let files = file_path.into_iter().collect();
            result.push((event, files));
        }
    }

    Ok(result)
}

/// Record a task outcome for performance tracking.
pub fn record_task_outcome(
    conn: &Connection,
    agent: &str,
    task_type: &str,
    success: bool,
    duration_ms: u64,
) -> Result<i64, rusqlite::Error> {
    conn.execute(
        "INSERT INTO task_outcomes (agent, task_type, success, duration_ms) VALUES (?1, ?2, ?3, ?4)",
        params![agent, task_type, success as i32, duration_ms as i64],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Query agent performance stats for a given task type.
/// Returns Vec<(agent, success_rate, avg_duration_ms)> sorted by success_rate DESC.
pub fn query_agent_stats(
    conn: &Connection,
    task_type: &str,
) -> Result<Vec<(String, f64, f64)>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT agent,
                AVG(CAST(success AS REAL)) as success_rate,
                AVG(CAST(duration_ms AS REAL)) as avg_duration
         FROM task_outcomes
         WHERE task_type = ?1
         GROUP BY agent
         ORDER BY success_rate DESC, avg_duration ASC",
    )?;

    let rows = stmt.query_map(params![task_type], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, f64>(1)?,
            row.get::<_, f64>(2)?,
        ))
    })?;

    rows.collect()
}

/// Record orchestration stats for a completed orchestration run.
pub fn record_orchestration_stats(
    conn: &Connection,
    task_id: &str,
    agent_count: u32,
    duration_secs: u64,
    success: bool,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO orchestration_history (task_id, agent_count, duration_secs, success) VALUES (?1, ?2, ?3, ?4)",
        params![task_id, agent_count as i64, duration_secs as i64, success as i32],
    )?;
    Ok(())
}

/// Get recent orchestration history records, ordered by created_at DESC.
pub fn get_orchestration_history(
    conn: &Connection,
    limit: u32,
) -> Result<Vec<OrchestrationRecord>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, task_id, agent_count, duration_secs, success, created_at
         FROM orchestration_history
         ORDER BY created_at DESC
         LIMIT ?1",
    )?;

    let rows = stmt.query_map(params![limit], |row| {
        let success_int: i32 = row.get(4)?;
        Ok(OrchestrationRecord {
            id: row.get::<_, i64>(0)? as i32,
            task_id: row.get(1)?,
            agent_count: row.get::<_, i64>(2)? as u32,
            duration_secs: row.get::<_, i64>(3)? as u32,
            success: success_int != 0,
            created_at: row.get(5)?,
        })
    })?;

    rows.collect()
}

/// Extract file changes from Claude stream events (Write = created, Edit = modified).
// Planned for future use: auto-recording file changes from agent output.
#[allow(dead_code)]
pub fn extract_file_changes_from_claude_events(
    events: &[ClaudeStreamEvent],
) -> Vec<(String, String)> {
    let mut changes = Vec::new();

    for event in events {
        if let ClaudeStreamEvent::ToolUse { name: Some(name), input: Some(input) } = event {
            let change_type = match name.as_str() {
                "Write" => "created",
                "Edit" => "modified",
                _ => continue,
            };

            if let Some(file_path) = input.get("file_path").and_then(|v| v.as_str()) {
                changes.push((file_path.to_string(), change_type.to_string()));
            }
        }
    }

    changes
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
    fn test_record_and_query_task_outcomes() {
        let conn = setup_db();

        // Record some outcomes
        record_task_outcome(&conn, "claude", "refactor", true, 5000).unwrap();
        record_task_outcome(&conn, "claude", "refactor", true, 3000).unwrap();
        record_task_outcome(&conn, "claude", "refactor", false, 8000).unwrap();
        record_task_outcome(&conn, "gemini", "refactor", true, 4000).unwrap();
        record_task_outcome(&conn, "gemini", "refactor", true, 6000).unwrap();

        let stats = query_agent_stats(&conn, "refactor").unwrap();
        assert_eq!(stats.len(), 2);

        // Gemini: 2/2 = 1.0 success rate
        assert_eq!(stats[0].0, "gemini");
        assert!((stats[0].1 - 1.0).abs() < 0.01);

        // Claude: 2/3 ~ 0.667 success rate
        assert_eq!(stats[1].0, "claude");
        assert!((stats[1].1 - 0.6667).abs() < 0.01);
    }

    #[test]
    fn test_query_agent_stats_empty() {
        let conn = setup_db();

        let stats = query_agent_stats(&conn, "nonexistent").unwrap();
        assert!(stats.is_empty());
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
