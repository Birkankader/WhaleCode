//! Database schema and migration definitions.
//!
//! Migration 1 lands the full Phase 2 schema: runs, subtasks, subtask_logs,
//! subtask_dependencies — plus indexes for foreign-key lookups and the
//! "most recent runs" read pattern that Phase 6 will consume.
//!
//! Migration 2 (Phase 3 prerequisite) adds user-edit tracking to `subtasks`
//! and a normalized `subtask_replans` table for master re-plan lineage.
//! See `docs/phase-3-spec.md` "Prerequisite: Storage migration M002."
//!
//! Rules:
//!   1. Once a migration ships, never edit it. Add a new one (M003, M004…).
//!   2. Keep SQL idempotent where practical (`IF NOT EXISTS`) so the
//!      Storage-side runner and the plugin-sql-side runner don't fight on
//!      first boot.
//!   3. Timestamps are ISO 8601 strings (`TEXT`) — never unix epoch ints.
//!      See `super::models::now_iso8601`.
//!   4. `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS` in SQLite. The
//!      Storage-side bootstrap checks `pragma_table_info` before applying
//!      M002 so production (plugin-sql has already applied it) and tests
//!      (fresh in-memory pool) both behave. Future schema-changing
//!      migrations should follow the same column-existence pattern.

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

/// Phase 3 schema additions: user-edit tracking on `subtasks` + normalized
/// re-plan relationships in `subtask_replans`. See `docs/phase-3-spec.md`
/// "Prerequisite: Storage migration M002" for the rationale.
///
/// The ALTER TABLE statements are not idempotent — callers must gate them
/// on column existence (plugin-sql tracks applied versions automatically;
/// the Rust-side `bootstrap` uses `pragma_table_info`).
pub const M002_ADD_USER_EDIT_TRACKING_AND_REPLANS: &str = r#"
ALTER TABLE subtasks ADD COLUMN edited_by_user INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subtasks ADD COLUMN added_by_user INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS subtask_replans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_subtask_id TEXT NOT NULL,
  replacement_subtask_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (original_subtask_id) REFERENCES subtasks(id) ON DELETE CASCADE,
  FOREIGN KEY (replacement_subtask_id) REFERENCES subtasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subtask_replans_original ON subtask_replans(original_subtask_id);
CREATE INDEX IF NOT EXISTS idx_subtask_replans_replacement ON subtask_replans(replacement_subtask_id);
"#;

/// Migration list consumed by `tauri_plugin_sql::Builder::add_migrations`.
/// Ordered by `version`; never renumber a shipped migration.
pub fn all() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "initial_schema",
            sql: M001_INITIAL_SCHEMA,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "phase3_user_edit_tracking_and_replans",
            sql: M002_ADD_USER_EDIT_TRACKING_AND_REPLANS,
            kind: MigrationKind::Up,
        },
    ]
}
