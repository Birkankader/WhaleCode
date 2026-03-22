use rusqlite::Connection;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use parking_lot::Mutex;

use super::migrations::run_migrations;
use super::models::OrchestrationRecord;

#[derive(Clone)]
pub struct ContextStore {
    pub(crate) conn: Arc<Mutex<Connection>>,
}

impl ContextStore {
    /// Execute a function with access to the underlying SQLite connection.
    /// Locks the mutex, calls the closure, and maps rusqlite errors to String.
    pub fn with_conn<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    {
        let conn = self.conn.lock();
        f(&conn).map_err(|e| e.to_string())
    }

    pub fn new(db_path: &Path) -> Result<Self, rusqlite::Error> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
                    Some(format!("Failed to create directory: {}", e)),
                )
            })?;
        }

        let mut conn = Connection::open(db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "busy_timeout", "5000")?;
        run_migrations(&mut conn)
            .map_err(|e| rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
                Some(format!("Migration failed: {}", e)),
            ))?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn record_task_outcome(
        &self,
        agent: &str,
        task_type: &str,
        success: bool,
        duration_ms: u64,
    ) -> Result<i64, String> {
        self.with_conn(|conn| {
            super::queries::record_task_outcome(conn, agent, task_type, success, duration_ms)
        })
    }

    pub fn query_agent_stats(
        &self,
        task_type: &str,
    ) -> Result<Vec<(String, f64, f64)>, String> {
        self.with_conn(|conn| super::queries::query_agent_stats(conn, task_type))
    }

    pub fn record_orchestration_stats(
        &self,
        task_id: &str,
        agent_count: u32,
        duration_secs: u64,
        success: bool,
    ) -> Result<(), String> {
        self.with_conn(|conn| {
            super::queries::record_orchestration_stats(conn, task_id, agent_count, duration_secs, success)
        })
    }

    pub fn get_orchestration_history(
        &self,
        limit: u32,
    ) -> Result<Vec<OrchestrationRecord>, String> {
        self.with_conn(|conn| super::queries::get_orchestration_history(conn, limit))
    }

    pub fn db_path_for_project(app_data_dir: &Path, project_dir: &str) -> PathBuf {
        let mut hasher = DefaultHasher::new();
        project_dir.hash(&mut hasher);
        let hash = format!("{:x}", hasher.finish());
        app_data_dir.join("contexts").join(format!("{}.db", hash))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_db_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("whalecode_tests").join(name);
        let _ = fs::remove_dir_all(&dir);
        dir.join("test.db")
    }

    #[test]
    fn creates_database_file() {
        let db_path = temp_db_path("creates_db");
        let _store = ContextStore::new(&db_path).unwrap();
        assert!(db_path.exists(), "Database file should exist after init");
    }

    #[test]
    fn tables_exist_after_init() {
        let db_path = temp_db_path("tables_exist");
        let store = ContextStore::new(&db_path).unwrap();
        let conn = store.conn.lock();

        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert!(tables.contains(&"context_events".to_string()));
        assert!(tables.contains(&"file_changes".to_string()));
    }

    #[test]
    fn wal_mode_active() {
        let db_path = temp_db_path("wal_mode");
        let store = ContextStore::new(&db_path).unwrap();
        let conn = store.conn.lock();

        let mode: String = conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
    }

    #[test]
    fn foreign_keys_enabled() {
        let db_path = temp_db_path("foreign_keys");
        let store = ContextStore::new(&db_path).unwrap();
        let conn = store.conn.lock();

        let fk: i32 = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert_eq!(fk, 1, "Foreign keys should be enabled");

        // Verify file_changes.event_id references context_events.id by attempting
        // to insert a file_change with a non-existent event_id
        let result = conn.execute(
            "INSERT INTO file_changes (event_id, file_path, change_type) VALUES (9999, 'test.rs', 'modified')",
            [],
        );
        assert!(result.is_err(), "Foreign key constraint should reject invalid event_id");
    }

    #[test]
    fn persistence_across_reconnection() {
        let db_path = temp_db_path("persistence");

        // Open, insert data, close
        {
            let store = ContextStore::new(&db_path).unwrap();
            let conn = store.conn.lock();
            conn.execute(
                "INSERT INTO context_events (task_id, tool_name, event_type, project_dir)
                 VALUES ('t1', 'claude', 'task_completed', '/project')",
                [],
            )
            .unwrap();
        }

        // Reopen and verify data persists
        {
            let store = ContextStore::new(&db_path).unwrap();
            let conn = store.conn.lock();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM context_events", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 1, "Data should persist across close/reopen");
        }
    }

    #[test]
    fn db_path_for_project_deterministic() {
        let app_dir = Path::new("/tmp/whalecode");
        let path1 = ContextStore::db_path_for_project(app_dir, "/home/user/project");
        let path2 = ContextStore::db_path_for_project(app_dir, "/home/user/project");
        assert_eq!(path1, path2, "Same project should produce same path");
    }

    #[test]
    fn db_path_for_project_different_dirs() {
        let app_dir = Path::new("/tmp/whalecode");
        let path1 = ContextStore::db_path_for_project(app_dir, "/home/user/project-a");
        let path2 = ContextStore::db_path_for_project(app_dir, "/home/user/project-b");
        assert_ne!(path1, path2, "Different projects should produce different paths");
    }
}
