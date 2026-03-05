use rusqlite::Connection;

use super::queries;

/// Build a context preamble string from recent project events.
///
/// Assembles recent history into a prompt prefix bounded by max_events and max_chars.
/// Returns an empty string if no events exist (producing a clean prompt).
pub fn build_context_preamble(
    conn: &Connection,
    project_dir: &str,
    max_events: u32,
    max_chars: usize,
) -> Result<String, rusqlite::Error> {
    let events = queries::get_recent_events(conn, project_dir, max_events)?;

    if events.is_empty() {
        return Ok(String::new());
    }

    let header = "## Recent Project Context\n\n";
    let mut preamble = header.to_string();

    for (event, file_paths) in &events {
        let summary = event
            .summary
            .as_deref()
            .unwrap_or("no summary");
        let files_str = if file_paths.is_empty() {
            String::new()
        } else {
            format!("\n  Files: {}", file_paths.join(", "))
        };
        let entry = format!(
            "- [{}] {} ({}): {}{}\n",
            event.created_at, event.tool_name, event.event_type, summary, files_str
        );

        if preamble.len() + entry.len() > max_chars {
            break;
        }

        preamble.push_str(&entry);
    }

    Ok(preamble)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::migrations::run_migrations;
    use crate::context::queries::record_task_completion;

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    #[test]
    fn empty_history_produces_empty_string() {
        let conn = setup_db();
        let result = build_context_preamble(&conn, "/proj", 5, 2000).unwrap();
        assert!(result.is_empty(), "Empty history should produce empty string");
    }

    #[test]
    fn single_event_produces_preamble_with_header() {
        let conn = setup_db();
        record_task_completion(
            &conn, "t1", "claude", "task_completed",
            Some("fix bug"), Some("Fixed null pointer"),
            "/proj", Some(1000), Some(0.01),
            &[("src/main.rs".to_string(), "modified".to_string())],
        ).unwrap();

        let result = build_context_preamble(&conn, "/proj", 5, 2000).unwrap();
        assert!(result.starts_with("## Recent Project Context\n\n"), "Should have header");
        assert!(result.contains("claude"), "Should contain tool name");
        assert!(result.contains("Fixed null pointer"), "Should contain summary");
        assert!(result.contains("src/main.rs"), "Should contain file path");
    }

    #[test]
    fn multiple_events_in_reverse_chronological_order() {
        let conn = setup_db();

        // Insert events with explicit timestamps to control ordering
        conn.execute(
            "INSERT INTO context_events (task_id, tool_name, event_type, summary, project_dir, created_at)
             VALUES ('t1', 'claude', 'task_completed', 'First task', '/proj', datetime('now', '-2 hours'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO context_events (task_id, tool_name, event_type, summary, project_dir, created_at)
             VALUES ('t2', 'gemini', 'task_completed', 'Second task', '/proj', datetime('now', '-1 hour'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO context_events (task_id, tool_name, event_type, summary, project_dir, created_at)
             VALUES ('t3', 'claude', 'task_completed', 'Third task', '/proj', datetime('now'))",
            [],
        ).unwrap();

        let result = build_context_preamble(&conn, "/proj", 5, 4000).unwrap();
        let third_pos = result.find("Third task").unwrap();
        let second_pos = result.find("Second task").unwrap();
        let first_pos = result.find("First task").unwrap();
        assert!(third_pos < second_pos, "Most recent should come first");
        assert!(second_pos < first_pos, "Second should come before first");
    }

    #[test]
    fn preamble_truncated_at_max_chars() {
        let conn = setup_db();

        // Insert several events
        for i in 0..10 {
            record_task_completion(
                &conn,
                &format!("task-{}", i),
                "claude",
                "task_completed",
                None,
                Some(&format!("Summary for task {}", i)),
                "/proj",
                None,
                None,
                &[("file.rs".to_string(), "modified".to_string())],
            ).unwrap();
        }

        // Use a small max_chars to force truncation
        let result = build_context_preamble(&conn, "/proj", 10, 200).unwrap();
        assert!(result.len() <= 200, "Preamble should not exceed max_chars, got {}", result.len());
        // Should have at least the header and one entry
        assert!(result.contains("## Recent Project Context"));
    }

    #[test]
    fn events_with_file_paths_included() {
        let conn = setup_db();
        record_task_completion(
            &conn, "t1", "claude", "task_completed",
            None, Some("Did stuff"), "/proj", None, None,
            &[
                ("src/a.rs".to_string(), "modified".to_string()),
                ("src/b.rs".to_string(), "created".to_string()),
            ],
        ).unwrap();

        let result = build_context_preamble(&conn, "/proj", 5, 2000).unwrap();
        assert!(result.contains("src/a.rs"), "Should contain first file");
        assert!(result.contains("src/b.rs"), "Should contain second file");
    }

    #[test]
    fn events_with_no_summary_show_placeholder() {
        let conn = setup_db();
        record_task_completion(
            &conn, "t1", "claude", "task_completed",
            None, None, "/proj", None, None, &[],
        ).unwrap();

        let result = build_context_preamble(&conn, "/proj", 5, 2000).unwrap();
        assert!(result.contains("no summary"), "Should show 'no summary' placeholder");
    }

    #[test]
    fn max_events_parameter_limits_events() {
        let conn = setup_db();
        for i in 0..5 {
            record_task_completion(
                &conn,
                &format!("task-{}", i),
                "claude",
                "task_completed",
                None,
                Some(&format!("Task {} summary", i)),
                "/proj",
                None,
                None,
                &[],
            ).unwrap();
        }

        // Only allow 2 events
        let result = build_context_preamble(&conn, "/proj", 2, 10000).unwrap();
        // Count the number of "- [" occurrences (each event entry starts with this)
        let event_count = result.matches("- [").count();
        assert_eq!(event_count, 2, "Should only include 2 events, got {}", event_count);
    }
}
