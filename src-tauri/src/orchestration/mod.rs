//! Run orchestration: the single owner of every in-flight run's state.
//!
//! External callers never mutate a [`Run`] directly. IPC commands
//! ([`crate::ipc::commands`]) forward to methods on [`Orchestrator`],
//! which dispatches into a per-run tokio task. Each task drives the
//! state machine end-to-end: planning → approval → execute → merge →
//! cleanup, with cooperative cancellation at every `.await`.
//!
//! Layout:
//! - `events` — internal event enum + [`EventSink`] trait so tests
//!   can observe without a Tauri runtime.
//! - `context` — builds the [`crate::agents::PlanningContext`] from
//!   the target repo (directory tree, instruction files, git log).
//! - `notes` — `SharedNotes` file: init + append + consolidate.
//! - `run` — in-memory per-run state ([`Run`], [`SubtaskRuntime`]).
//!
//! Steps 8b-8e fill in planning, dispatch, merge, and tests. This
//! file today just wires the pieces together and holds the
//! [`Orchestrator`] shell.

#![allow(dead_code)] // Dispatcher / lifecycle methods land in 8b-8e.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, RwLock};

use crate::ipc::RunId;
use crate::settings::SettingsStore;
use crate::storage::Storage;

pub mod context;
pub mod events;
pub mod notes;
pub mod run;

#[allow(unused_imports)] // consumed in 8b+; re-exported now so later commits are mechanical
pub use events::{EventSink, RunEvent, TauriEventSink};
#[allow(unused_imports)]
pub use run::{Run, SubtaskRuntime};

/// Maximum worker tasks permitted to run concurrently within a single
/// run. Keeps CPU, subprocess, and API-rate pressure bounded. The
/// value is a product knob, not a performance tuning one — four
/// independent code-writing agents at once is already a lot to
/// review.
pub const MAX_CONCURRENT_WORKERS: usize = 4;

/// How long to wait for the user to approve or reject a plan before
/// auto-rejecting. Phase 2 hardcodes this; a later phase may surface
/// it as a setting. 30 minutes is long enough to grab coffee and
/// short enough that a forgotten approval doesn't hold a worktree
/// directory open forever.
pub const APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Single owner of all in-flight runs. IPC commands route through
/// this; the per-run tokio task lives behind the `RwLock` and is
/// driven from `submit_task`.
///
/// The `runs` map is `Arc<Mutex<…>>` rather than `RwLock<…>` because
/// the common access pattern is "insert or remove a whole entry",
/// which wants exclusive access anyway. The inner per-run `RwLock`
/// exists so a read-only snapshot (status, subtasks for the UI) can
/// happen without blocking a transition.
pub struct Orchestrator {
    pub(crate) settings: Arc<SettingsStore>,
    pub(crate) storage: Arc<Storage>,
    pub(crate) event_sink: Arc<dyn EventSink>,
    pub(crate) runs: Arc<Mutex<HashMap<RunId, Arc<RwLock<Run>>>>>,
    pub(crate) max_concurrent_workers: usize,
}

impl Orchestrator {
    pub fn new(
        settings: Arc<SettingsStore>,
        storage: Arc<Storage>,
        event_sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            settings,
            storage,
            event_sink,
            runs: Arc::new(Mutex::new(HashMap::new())),
            max_concurrent_workers: MAX_CONCURRENT_WORKERS,
        }
    }

    /// Look up a run by id without mutating. Returns `None` if the
    /// run isn't in the active map — either it never existed or it
    /// reached a terminal state and was removed.
    pub async fn get_run(&self, id: &RunId) -> Option<Arc<RwLock<Run>>> {
        self.runs.lock().await.get(id).cloned()
    }

    /// Number of currently-active runs. Used only in tests so far;
    /// kept on the public surface because Phase 6 run-history UI
    /// will want it.
    pub async fn active_run_count(&self) -> usize {
        self.runs.lock().await.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::events::RecordingEventSink;
    use crate::settings::SettingsStore;
    use std::path::PathBuf;

    async fn make() -> Orchestrator {
        let settings = Arc::new(SettingsStore::load_at(PathBuf::from(
            "/tmp/whalecode-settings-never-written.json",
        )));
        let storage = Arc::new(Storage::in_memory().await.unwrap());
        let sink = Arc::new(RecordingEventSink::default());
        Orchestrator::new(settings, storage, sink)
    }

    #[tokio::test]
    async fn new_orchestrator_starts_empty() {
        let orch = make().await;
        assert_eq!(orch.active_run_count().await, 0);
        assert!(orch.get_run(&"nope".into()).await.is_none());
    }
}
