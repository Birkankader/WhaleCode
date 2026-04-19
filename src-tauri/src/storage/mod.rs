//! SQLite-backed persistence for runs, subtasks, logs, and dependencies.
//!
//! Architecture note: we let `tauri-plugin-sql` manage the *frontend-visible*
//! pool (and run migrations declared via `migrations::all()`). This module
//! owns a separate `sqlx::SqlitePool` for Rust-side CRUD — both pools point
//! at the same file. Because migrations are `CREATE TABLE IF NOT EXISTS`,
//! whichever side opens first wins without conflict.
//!
//! All methods return `StorageError`, not raw `sqlx::Error`, so the rest of
//! the backend doesn't need to care that we're using sqlx.
//!
//! Step 3 only wires the pool into `lib.rs`. The orchestrator (step 8) is
//! the first real consumer, so the CRUD methods look unused to the compiler
//! until that lands — `allow(dead_code)` keeps the warning noise down.

#![allow(dead_code)]

use std::path::Path;

use chrono::{DateTime, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use crate::ipc::{AgentKind, RunStatus, SubtaskState};

pub mod error;
pub mod migrations;
pub mod models;

pub use error::{StorageError, StorageResult};
pub use models::{now_iso8601, NewRun, NewSubtask, Run, Subtask, SubtaskLog};

use models::{
    agent_kind_from_str, agent_kind_to_str, run_status_from_str, run_status_to_str,
    subtask_state_from_str, subtask_state_to_str,
};

#[derive(Clone)]
pub struct Storage {
    pool: SqlitePool,
}

impl Storage {
    /// Open the production database at `path`, creating the file and running
    /// M001 if it isn't there yet. WAL + foreign_keys are enabled per
    /// `docs/phase-2-spec.md` Step 9.
    pub async fn open(path: impl AsRef<Path>) -> StorageResult<Self> {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal);

        let pool = SqlitePoolOptions::new().connect_with(options).await?;
        Self::bootstrap(&pool).await?;
        Ok(Self { pool })
    }

    /// Test-only accessor for the underlying sqlx pool. Cross-module
    /// tests (e.g. orchestration integration tests) need raw SQL to
    /// probe columns without a dedicated read method — think the M002
    /// sticky flags (`edited_by_user`, `added_by_user`). Production
    /// code must go through typed Storage methods.
    #[cfg(test)]
    pub(crate) fn pool_for_tests(&self) -> &SqlitePool {
        &self.pool
    }

    /// In-memory DB for tests. `max_connections=1` because :memory: databases
    /// are per-connection — a larger pool would see empty tables on borrowed
    /// connections. `cache=shared` + a named URI would be the alternative;
    /// single-connection is simpler and our tests don't need parallelism.
    #[cfg(test)]
    pub async fn in_memory() -> StorageResult<Self> {
        use std::str::FromStr;
        let options = SqliteConnectOptions::from_str("sqlite::memory:")?.foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        Self::bootstrap(&pool).await?;
        Ok(Self { pool })
    }

    /// Runs the schema migrations against the pool. Idempotent — safe to
    /// call on a DB the plugin-sql runner has already initialised.
    ///
    /// M001 is fully declarative (`CREATE TABLE IF NOT EXISTS`), so running
    /// it twice is harmless. M002 uses `ALTER TABLE ADD COLUMN` which has
    /// no `IF NOT EXISTS` in SQLite — gate it on a `pragma_table_info`
    /// check so production (plugin-sql already applied) and in-memory
    /// tests (fresh pool) both work.
    async fn bootstrap(pool: &SqlitePool) -> StorageResult<()> {
        sqlx::query(migrations::M001_INITIAL_SCHEMA)
            .execute(pool)
            .await?;
        let m002_applied: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('subtasks') WHERE name = 'edited_by_user'",
        )
        .fetch_one(pool)
        .await?;
        if m002_applied == 0 {
            sqlx::query(migrations::M002_ADD_USER_EDIT_TRACKING_AND_REPLANS)
                .execute(pool)
                .await?;
        }
        Ok(())
    }

    // --- Runs -------------------------------------------------------------

    pub async fn insert_run(&self, new: &NewRun) -> StorageResult<()> {
        sqlx::query(
            "INSERT INTO runs (id, task, repo_path, master_agent, status, started_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&new.id)
        .bind(&new.task)
        .bind(&new.repo_path)
        .bind(agent_kind_to_str(new.master_agent))
        .bind(run_status_to_str(new.status))
        .bind(new.started_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn update_run_status(&self, id: &str, status: RunStatus) -> StorageResult<()> {
        let res = sqlx::query("UPDATE runs SET status = ? WHERE id = ?")
            .bind(run_status_to_str(status))
            .bind(id)
            .execute(&self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StorageError::NotFound(format!("run {id}")));
        }
        Ok(())
    }

    /// Overwrite the `error` column on a run row without changing
    /// status or timestamps. Used by the orchestrator's merge phase
    /// to record a conflict summary while the run is still in
    /// `Merging` (it hasn't failed yet — the user may retry or
    /// discard).
    ///
    /// Semantics note: the `error` column is dual-purpose. It is
    /// populated (a) when the run finalizes to `Failed` with the
    /// failure reason, and (b) while the run is in `Merging` with
    /// the last merge attempt's conflict summary. Consumers
    /// disambiguate by reading `status` alongside. Writes are
    /// last-write-wins — a retry-then-cancel sequence leaves the last
    /// conflict summary on the Cancelled row. Phase 4 will revisit by
    /// splitting this into a dedicated `conflict_files` column.
    pub async fn update_run_error(&self, id: &str, error: Option<&str>) -> StorageResult<()> {
        let res = sqlx::query("UPDATE runs SET error = ? WHERE id = ?")
            .bind(error)
            .bind(id)
            .execute(&self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StorageError::NotFound(format!("run {id}")));
        }
        Ok(())
    }

    /// Marks the run terminal: sets `status`, `finished_at`, and (optionally)
    /// `error`. Use for `done`, `failed`, `rejected`.
    pub async fn finish_run(
        &self,
        id: &str,
        status: RunStatus,
        finished_at: DateTime<Utc>,
        error: Option<&str>,
    ) -> StorageResult<()> {
        let res = sqlx::query(
            "UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?",
        )
        .bind(run_status_to_str(status))
        .bind(finished_at.to_rfc3339())
        .bind(error)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StorageError::NotFound(format!("run {id}")));
        }
        Ok(())
    }

    pub async fn get_run(&self, id: &str) -> StorageResult<Option<Run>> {
        let row = sqlx::query(
            "SELECT id, task, repo_path, master_agent, status, started_at, finished_at, error \
             FROM runs WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        row.map(row_to_run).transpose()
    }

    /// Most recent runs first. Reads `idx_runs_started_at`.
    pub async fn list_recent_runs(&self, limit: i64) -> StorageResult<Vec<Run>> {
        let rows = sqlx::query(
            "SELECT id, task, repo_path, master_agent, status, started_at, finished_at, error \
             FROM runs ORDER BY started_at DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(row_to_run).collect()
    }

    /// Runs whose status is non-terminal: anything the orchestrator
    /// would own if the app hadn't crashed. Used by startup recovery
    /// to mark them `Failed` and sweep any worktrees they left behind.
    pub async fn list_active_runs(&self) -> StorageResult<Vec<Run>> {
        let rows = sqlx::query(
            "SELECT id, task, repo_path, master_agent, status, started_at, finished_at, error \
             FROM runs \
             WHERE status IN ('planning', 'awaiting-approval', 'running', 'merging') \
             ORDER BY started_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(row_to_run).collect()
    }

    pub async fn delete_run(&self, id: &str) -> StorageResult<()> {
        sqlx::query("DELETE FROM runs WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // --- Subtasks ---------------------------------------------------------

    pub async fn insert_subtask(&self, new: &NewSubtask) -> StorageResult<()> {
        sqlx::query(
            "INSERT INTO subtasks (id, run_id, title, why, assigned_worker, state) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&new.id)
        .bind(&new.run_id)
        .bind(&new.title)
        .bind(new.why.as_deref())
        .bind(agent_kind_to_str(new.assigned_worker))
        .bind(subtask_state_to_str(new.state))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Insert a user-added subtask, stamping `added_by_user = 1` at
    /// birth. Phase 3 edit flow only — the master's initial plan uses
    /// [`Self::insert_subtask`], which leaves both M002 flags at the
    /// column default (`0`).
    pub async fn insert_user_added_subtask(&self, new: &NewSubtask) -> StorageResult<()> {
        sqlx::query(
            "INSERT INTO subtasks \
             (id, run_id, title, why, assigned_worker, state, added_by_user) \
             VALUES (?, ?, ?, ?, ?, ?, 1)",
        )
        .bind(&new.id)
        .bind(&new.run_id)
        .bind(&new.title)
        .bind(new.why.as_deref())
        .bind(agent_kind_to_str(new.assigned_worker))
        .bind(subtask_state_to_str(new.state))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Update the user-editable fields of a subtask and flip
    /// `edited_by_user` to `1`. Intended for the Phase 3
    /// `update_subtask` IPC: the orchestrator has already validated
    /// the run is `AwaitingApproval` and the subtask is `Proposed`;
    /// this is just the row write.
    ///
    /// The flag is sticky — once set, a later edit that happens to
    /// restore the master's original values still leaves the flag at
    /// `1`. That matches "did the user touch this?", not "does the
    /// current value equal the master's proposal?".
    pub async fn update_subtask_fields(
        &self,
        id: &str,
        title: &str,
        why: Option<&str>,
        assigned_worker: AgentKind,
    ) -> StorageResult<()> {
        let res = sqlx::query(
            "UPDATE subtasks \
             SET title = ?, why = ?, assigned_worker = ?, edited_by_user = 1 \
             WHERE id = ?",
        )
        .bind(title)
        .bind(why)
        .bind(agent_kind_to_str(assigned_worker))
        .bind(id)
        .execute(&self.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StorageError::NotFound(format!("subtask {id}")));
        }
        Ok(())
    }

    /// Delete a subtask by id. `subtask_dependencies` rows referencing
    /// it on either side, and `subtask_logs` / `subtask_replans` rows
    /// pointing at it, cascade away via the M001/M002 foreign keys —
    /// no manual cleanup needed.
    pub async fn delete_subtask(&self, id: &str) -> StorageResult<()> {
        let res = sqlx::query("DELETE FROM subtasks WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StorageError::NotFound(format!("subtask {id}")));
        }
        Ok(())
    }

    /// Advances a subtask's state and, when appropriate, stamps timestamps:
    /// entering `Running` sets `started_at` if unset; entering a terminal
    /// state (`Done`, `Failed`, `Skipped`) sets `finished_at`. Errors are
    /// stored when transitioning to `Failed`.
    pub async fn update_subtask_state(
        &self,
        id: &str,
        state: SubtaskState,
        error: Option<&str>,
    ) -> StorageResult<()> {
        let now = now_iso8601();
        let (set_started, set_finished) = match state {
            SubtaskState::Running => (true, false),
            SubtaskState::Done | SubtaskState::Failed | SubtaskState::Skipped => (false, true),
            _ => (false, false),
        };

        let sql = match (set_started, set_finished) {
            (true, _) => {
                "UPDATE subtasks \
                 SET state = ?, \
                     started_at = COALESCE(started_at, ?), \
                     error = ? \
                 WHERE id = ?"
            }
            (_, true) => {
                "UPDATE subtasks \
                 SET state = ?, \
                     finished_at = ?, \
                     error = ? \
                 WHERE id = ?"
            }
            _ => "UPDATE subtasks SET state = ?, error = ? WHERE id = ?",
        };

        let mut q = sqlx::query(sql).bind(subtask_state_to_str(state));
        if set_started || set_finished {
            q = q.bind(&now);
        }
        q = q.bind(error).bind(id);

        let res = q.execute(&self.pool).await?;
        if res.rows_affected() == 0 {
            return Err(StorageError::NotFound(format!("subtask {id}")));
        }
        Ok(())
    }

    pub async fn get_subtask(&self, id: &str) -> StorageResult<Option<Subtask>> {
        let row = sqlx::query(
            "SELECT id, run_id, title, why, assigned_worker, state, started_at, finished_at, error \
             FROM subtasks WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_subtask).transpose()
    }

    pub async fn list_subtasks_for_run(&self, run_id: &str) -> StorageResult<Vec<Subtask>> {
        let rows = sqlx::query(
            "SELECT id, run_id, title, why, assigned_worker, state, started_at, finished_at, error \
             FROM subtasks WHERE run_id = ? ORDER BY rowid ASC",
        )
        .bind(run_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_subtask).collect()
    }

    // --- Subtask logs -----------------------------------------------------

    pub async fn append_log(&self, subtask_id: &str, line: &str) -> StorageResult<i64> {
        let row = sqlx::query(
            "INSERT INTO subtask_logs (subtask_id, line, created_at) VALUES (?, ?, ?) RETURNING id",
        )
        .bind(subtask_id)
        .bind(line)
        .bind(now_iso8601())
        .fetch_one(&self.pool)
        .await?;
        Ok(row.try_get::<i64, _>("id")?)
    }

    pub async fn get_subtask_logs(&self, subtask_id: &str) -> StorageResult<Vec<SubtaskLog>> {
        let rows = sqlx::query(
            "SELECT id, subtask_id, line, created_at FROM subtask_logs \
             WHERE subtask_id = ? ORDER BY id ASC",
        )
        .bind(subtask_id)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|r| {
                Ok(SubtaskLog {
                    id: r.try_get("id")?,
                    subtask_id: r.try_get("subtask_id")?,
                    line: r.try_get("line")?,
                    created_at: r.try_get("created_at")?,
                })
            })
            .collect()
    }

    // --- Dependencies -----------------------------------------------------

    pub async fn insert_dependency(
        &self,
        subtask_id: &str,
        depends_on_id: &str,
    ) -> StorageResult<()> {
        sqlx::query(
            "INSERT INTO subtask_dependencies (subtask_id, depends_on_id) VALUES (?, ?)",
        )
        .bind(subtask_id)
        .bind(depends_on_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Returns the ids the given subtask depends on.
    pub async fn get_dependencies(&self, subtask_id: &str) -> StorageResult<Vec<String>> {
        let rows = sqlx::query(
            "SELECT depends_on_id FROM subtask_dependencies WHERE subtask_id = ?",
        )
        .bind(subtask_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|r| Ok(r.try_get::<String, _>("depends_on_id")?))
            .collect()
    }
}

fn row_to_run(row: sqlx::sqlite::SqliteRow) -> StorageResult<Run> {
    let master_agent: String = row.try_get("master_agent")?;
    let status: String = row.try_get("status")?;
    Ok(Run {
        id: row.try_get("id")?,
        task: row.try_get("task")?,
        repo_path: row.try_get("repo_path")?,
        master_agent: agent_kind_from_str(&master_agent)?,
        status: run_status_from_str(&status)?,
        started_at: row.try_get("started_at")?,
        finished_at: row.try_get("finished_at")?,
        error: row.try_get("error")?,
    })
}

fn row_to_subtask(row: sqlx::sqlite::SqliteRow) -> StorageResult<Subtask> {
    let assigned: String = row.try_get("assigned_worker")?;
    let state: String = row.try_get("state")?;
    Ok(Subtask {
        id: row.try_get("id")?,
        run_id: row.try_get("run_id")?,
        title: row.try_get("title")?,
        why: row.try_get("why")?,
        assigned_worker: agent_kind_from_str(&assigned)?,
        state: subtask_state_from_str(&state)?,
        started_at: row.try_get("started_at")?,
        finished_at: row.try_get("finished_at")?,
        error: row.try_get("error")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::AgentKind;

    fn sample_run(id: &str) -> NewRun {
        NewRun {
            id: id.to_string(),
            task: "refactor auth".into(),
            repo_path: "/tmp/x".into(),
            master_agent: AgentKind::Claude,
            status: RunStatus::Planning,
            started_at: Utc::now(),
        }
    }

    fn sample_subtask(id: &str, run_id: &str) -> NewSubtask {
        NewSubtask {
            id: id.to_string(),
            run_id: run_id.to_string(),
            title: "write adapter".into(),
            why: Some("needed for claude".into()),
            assigned_worker: AgentKind::Claude,
            state: SubtaskState::Proposed,
        }
    }

    #[tokio::test]
    async fn open_in_memory_runs_migrations() {
        let s = Storage::in_memory().await.unwrap();
        // Both runs tables exist: double-bootstrap must be idempotent.
        Storage::bootstrap(&s.pool).await.unwrap();
    }

    #[tokio::test]
    async fn insert_and_get_run_roundtrip() {
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        let fetched = s.get_run("r1").await.unwrap().expect("run exists");
        assert_eq!(fetched.id, "r1");
        assert_eq!(fetched.task, "refactor auth");
        assert_eq!(fetched.master_agent, AgentKind::Claude);
        assert_eq!(fetched.status, RunStatus::Planning);
        assert!(fetched.finished_at.is_none());
        assert!(fetched.error.is_none());
    }

    #[tokio::test]
    async fn update_run_status_transitions() {
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        s.update_run_status("r1", RunStatus::Running).await.unwrap();
        let r = s.get_run("r1").await.unwrap().unwrap();
        assert_eq!(r.status, RunStatus::Running);
    }

    #[tokio::test]
    async fn finish_run_stamps_timestamp_and_error() {
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        s.finish_run("r1", RunStatus::Failed, Utc::now(), Some("boom"))
            .await
            .unwrap();
        let r = s.get_run("r1").await.unwrap().unwrap();
        assert_eq!(r.status, RunStatus::Failed);
        assert!(r.finished_at.is_some());
        assert_eq!(r.error.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn update_missing_run_returns_not_found() {
        let s = Storage::in_memory().await.unwrap();
        let err = s
            .update_run_status("nope", RunStatus::Done)
            .await
            .unwrap_err();
        matches!(err, StorageError::NotFound(_));
    }

    #[tokio::test]
    async fn list_recent_runs_orders_newest_first() {
        let s = Storage::in_memory().await.unwrap();
        let mut a = sample_run("a");
        a.started_at = Utc::now() - chrono::Duration::minutes(5);
        let b = sample_run("b"); // now
        s.insert_run(&a).await.unwrap();
        s.insert_run(&b).await.unwrap();

        let list = s.list_recent_runs(10).await.unwrap();
        assert_eq!(list[0].id, "b");
        assert_eq!(list[1].id, "a");
    }

    #[tokio::test]
    async fn subtask_running_sets_started_at() {
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("s1", "r1")).await.unwrap();
        s.update_subtask_state("s1", SubtaskState::Running, None)
            .await
            .unwrap();
        let sub = s.get_subtask("s1").await.unwrap().unwrap();
        assert_eq!(sub.state, SubtaskState::Running);
        assert!(sub.started_at.is_some());
        assert!(sub.finished_at.is_none());
    }

    #[tokio::test]
    async fn subtask_terminal_states_set_finished_at() {
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("s1", "r1")).await.unwrap();
        s.update_subtask_state("s1", SubtaskState::Running, None)
            .await
            .unwrap();
        s.update_subtask_state("s1", SubtaskState::Failed, Some("nope"))
            .await
            .unwrap();
        let sub = s.get_subtask("s1").await.unwrap().unwrap();
        assert_eq!(sub.state, SubtaskState::Failed);
        assert!(sub.finished_at.is_some());
        assert_eq!(sub.error.as_deref(), Some("nope"));
    }

    #[tokio::test]
    async fn logs_append_and_query_in_insertion_order() {
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("s1", "r1")).await.unwrap();
        s.append_log("s1", "line one").await.unwrap();
        s.append_log("s1", "line two").await.unwrap();
        let logs = s.get_subtask_logs("s1").await.unwrap();
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].line, "line one");
        assert_eq!(logs[1].line, "line two");
    }

    #[tokio::test]
    async fn dependencies_insert_and_query() {
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("s1", "r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("s2", "r1")).await.unwrap();
        s.insert_dependency("s2", "s1").await.unwrap();
        let deps = s.get_dependencies("s2").await.unwrap();
        assert_eq!(deps, vec!["s1".to_string()]);
    }

    #[tokio::test]
    async fn delete_run_cascades_to_subtasks_and_logs() {
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("s1", "r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("s2", "r1")).await.unwrap();
        s.insert_dependency("s2", "s1").await.unwrap();
        s.append_log("s1", "hello").await.unwrap();

        s.delete_run("r1").await.unwrap();

        assert!(s.get_run("r1").await.unwrap().is_none());
        assert!(s.list_subtasks_for_run("r1").await.unwrap().is_empty());
        assert!(s.get_subtask_logs("s1").await.unwrap().is_empty());
        assert!(s.get_dependencies("s2").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn unknown_enum_string_surfaces_invalid_error() {
        let s = Storage::in_memory().await.unwrap();
        // Insert a run with a well-formed row, then corrupt the status.
        s.insert_run(&sample_run("r1")).await.unwrap();
        sqlx::query("UPDATE runs SET status = 'bogus' WHERE id = ?")
            .bind("r1")
            .execute(&s.pool)
            .await
            .unwrap();
        let err = s.get_run("r1").await.unwrap_err();
        assert!(matches!(err, StorageError::Invalid(_)));
    }

    // --- M002: Phase 3 prerequisite tests ----------------------------------
    //
    // These check the schema shape directly rather than going through the
    // (not-yet-written) Step 1 commands, so the migration can land as a
    // standalone prerequisite and be verified independently.

    #[tokio::test]
    async fn m002_subtask_columns_exist() {
        let s = Storage::in_memory().await.unwrap();
        let edited: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('subtasks') WHERE name = 'edited_by_user'",
        )
        .fetch_one(&s.pool)
        .await
        .unwrap();
        let added: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('subtasks') WHERE name = 'added_by_user'",
        )
        .fetch_one(&s.pool)
        .await
        .unwrap();
        assert_eq!(edited, 1, "edited_by_user column must exist after M002");
        assert_eq!(added, 1, "added_by_user column must exist after M002");
    }

    #[tokio::test]
    async fn m002_new_subtask_defaults_flags_to_zero() {
        // Existing inserts don't name the new columns — DEFAULT 0 must fill
        // them so Step 1's `update_subtask` has a baseline to flip.
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("s1", "r1")).await.unwrap();
        let flags: (i64, i64) = sqlx::query_as(
            "SELECT edited_by_user, added_by_user FROM subtasks WHERE id = ?",
        )
        .bind("s1")
        .fetch_one(&s.pool)
        .await
        .unwrap();
        assert_eq!(flags, (0, 0));
    }

    #[tokio::test]
    async fn m002_subtask_replans_table_exists_and_cascades() {
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("orig", "r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("repl", "r1")).await.unwrap();
        sqlx::query(
            "INSERT INTO subtask_replans \
             (original_subtask_id, replacement_subtask_id, reason, created_at) \
             VALUES (?, ?, ?, ?)",
        )
        .bind("orig")
        .bind("repl")
        .bind("master couldn't finish")
        .bind(now_iso8601())
        .execute(&s.pool)
        .await
        .unwrap();

        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM subtask_replans")
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(before, 1);

        // Deleting the original subtask must cascade into subtask_replans.
        // This is how Phase 2's delete_run will stay consistent in Phase 3
        // without extra cleanup code.
        s.delete_run("r1").await.unwrap();
        let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM subtask_replans")
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(after, 0, "subtask_replans must CASCADE on run delete");
    }

    #[tokio::test]
    async fn m002_bootstrap_is_idempotent_on_second_call() {
        // Production has two runners racing for the same DB (plugin-sql +
        // Rust pool). bootstrap() must be safe to call repeatedly; if the
        // ADD COLUMN fires twice SQLite errors "duplicate column name".
        let s = Storage::in_memory().await.unwrap();
        Storage::bootstrap(&s.pool).await.expect("first re-bootstrap");
        Storage::bootstrap(&s.pool).await.expect("second re-bootstrap");
    }

    #[tokio::test]
    async fn insert_user_added_subtask_sets_added_flag() {
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        s.insert_user_added_subtask(&sample_subtask("s1", "r1"))
            .await
            .unwrap();
        let flags: (i64, i64) = sqlx::query_as(
            "SELECT edited_by_user, added_by_user FROM subtasks WHERE id = ?",
        )
        .bind("s1")
        .fetch_one(&s.pool)
        .await
        .unwrap();
        assert_eq!(flags, (0, 1));
    }

    #[tokio::test]
    async fn update_subtask_fields_flips_edited_flag() {
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("s1", "r1")).await.unwrap();
        s.update_subtask_fields("s1", "new title", Some("new why"), AgentKind::Codex)
            .await
            .unwrap();
        let sub = s.get_subtask("s1").await.unwrap().unwrap();
        assert_eq!(sub.title, "new title");
        assert_eq!(sub.why.as_deref(), Some("new why"));
        assert_eq!(sub.assigned_worker, AgentKind::Codex);
        let edited: i64 =
            sqlx::query_scalar("SELECT edited_by_user FROM subtasks WHERE id = ?")
                .bind("s1")
                .fetch_one(&s.pool)
                .await
                .unwrap();
        assert_eq!(edited, 1);
    }

    #[tokio::test]
    async fn update_subtask_fields_clears_why_when_none() {
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("s1", "r1")).await.unwrap();
        s.update_subtask_fields("s1", "t", None, AgentKind::Claude)
            .await
            .unwrap();
        let sub = s.get_subtask("s1").await.unwrap().unwrap();
        assert!(sub.why.is_none());
    }

    #[tokio::test]
    async fn update_subtask_fields_missing_id_is_not_found() {
        let s = Storage::in_memory().await.unwrap();
        let err = s
            .update_subtask_fields("ghost", "t", None, AgentKind::Claude)
            .await
            .unwrap_err();
        assert!(matches!(err, StorageError::NotFound(_)));
    }

    #[tokio::test]
    async fn delete_subtask_cascades_dependencies_and_logs() {
        // subtask_dependencies references subtasks(id) on both sides ON
        // DELETE CASCADE (M001), so removing a subtask cleans rows it
        // participates in whether as depender or dependent.
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("s1", "r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("s2", "r1")).await.unwrap();
        s.insert_dependency("s2", "s1").await.unwrap();
        s.append_log("s1", "log line").await.unwrap();

        s.delete_subtask("s1").await.unwrap();

        assert!(s.get_subtask("s1").await.unwrap().is_none());
        // s2's dependency row went with s1.
        assert!(s.get_dependencies("s2").await.unwrap().is_empty());
        // Logs cascade on subtask deletion.
        assert!(s.get_subtask_logs("s1").await.unwrap().is_empty());
        // Sibling row untouched.
        assert!(s.get_subtask("s2").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn delete_subtask_missing_id_is_not_found() {
        let s = Storage::in_memory().await.unwrap();
        let err = s.delete_subtask("ghost").await.unwrap_err();
        assert!(matches!(err, StorageError::NotFound(_)));
    }

    #[tokio::test]
    async fn retrying_subtask_state_round_trips_through_storage() {
        // SubtaskState::Retrying is Phase 3 plumbing; the text-column
        // persistence just has to carry the variant in both directions
        // without surprises until Step 3b emits it for real.
        let s = Storage::in_memory().await.unwrap();
        s.insert_run(&sample_run("r1")).await.unwrap();
        s.insert_subtask(&sample_subtask("s1", "r1")).await.unwrap();
        s.update_subtask_state("s1", SubtaskState::Running, None)
            .await
            .unwrap();
        let started_at_before = s
            .get_subtask("s1")
            .await
            .unwrap()
            .unwrap()
            .started_at
            .clone();

        s.update_subtask_state("s1", SubtaskState::Retrying, None)
            .await
            .unwrap();
        let sub = s.get_subtask("s1").await.unwrap().unwrap();
        assert_eq!(sub.state, SubtaskState::Retrying);
        // Neither Running's started_at stamp is cleared, nor is a new
        // finished_at set — Retrying is a transient mid-attempt state.
        assert_eq!(sub.started_at, started_at_before);
        assert!(sub.finished_at.is_none());
    }
}
