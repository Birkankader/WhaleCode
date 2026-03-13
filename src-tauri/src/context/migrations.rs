use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

const MIGRATIONS: &[M] = &[
    M::up(
        "CREATE TABLE context_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            event_type TEXT NOT NULL,
            prompt TEXT,
            summary TEXT,
            project_dir TEXT NOT NULL,
            metadata TEXT,
            duration_ms INTEGER,
            cost_usd REAL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_events_project ON context_events(project_dir);
        CREATE INDEX idx_events_created ON context_events(created_at);

        CREATE TABLE file_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL REFERENCES context_events(id),
            file_path TEXT NOT NULL,
            change_type TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_file_changes_path ON file_changes(file_path);
        CREATE INDEX idx_file_changes_event ON file_changes(event_id);",
    ),
    M::up(
        "CREATE TABLE IF NOT EXISTS task_outcomes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent TEXT NOT NULL,
            task_type TEXT NOT NULL,
            success INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_task_outcomes_agent ON task_outcomes(agent);
        CREATE INDEX IF NOT EXISTS idx_task_outcomes_type ON task_outcomes(task_type);",
    ),
];

pub fn run_migrations(conn: &mut Connection) -> Result<(), rusqlite_migration::Error> {
    Migrations::new(MIGRATIONS.to_vec()).to_latest(conn)
}
