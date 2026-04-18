//! Database schema and migration definitions.
//!
//! Migration 1 lands the full Phase 2 schema: runs, subtasks, subtask_logs,
//! subtask_dependencies — plus indexes for foreign-key lookups and the
//! "most recent runs" read pattern that Phase 6 will consume.
//!
//! Rules:
//!   1. Once a migration ships, never edit it. Add a new one (M002, M003…).
//!   2. Keep SQL idempotent where practical (`IF NOT EXISTS`) so the
//!      Storage-side runner and the plugin-sql-side runner don't fight on
//!      first boot.
//!   3. Timestamps are ISO 8601 strings (`TEXT`) — never unix epoch ints.
//!      See `super::models::now_iso8601`.

use tauri_plugin_sql::{Migration, MigrationKind};

/// Initial schema. See phase-2-spec.md Step 9 for the canonical definition.
pub const M001_INITIAL_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  master_agent TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  title TEXT NOT NULL,
  why TEXT,
  assigned_worker TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subtask_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subtask_id TEXT NOT NULL,
  line TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (subtask_id) REFERENCES subtasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subtask_dependencies (
  subtask_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  PRIMARY KEY (subtask_id, depends_on_id),
  FOREIGN KEY (subtask_id) REFERENCES subtasks(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_id) REFERENCES subtasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_subtasks_run_id ON subtasks(run_id);
CREATE INDEX IF NOT EXISTS idx_subtask_logs_subtask_id ON subtask_logs(subtask_id);
"#;

/// Migration list consumed by `tauri_plugin_sql::Builder::add_migrations`.
/// Ordered by `version`; never renumber a shipped migration.
pub fn all() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "initial_schema",
        sql: M001_INITIAL_SCHEMA,
        kind: MigrationKind::Up,
    }]
}
