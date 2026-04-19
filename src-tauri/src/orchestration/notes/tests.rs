//! Integration tests for `SharedNotes`.
//!
//! Each test runs in its own tempdir, so they parallelize cleanly.
//! The consolidation tests use an in-memory mock agent that implements
//! just enough of [`AgentImpl`] to drive `summarize`; real adapters
//! are wired end-to-end by the orchestrator, not here.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::agents::{
    AgentError, AgentImpl, ExecutionResult, Plan, PlanningContext,
};
use crate::ipc::AgentKind;
use crate::storage::models::Subtask;

// -- Test helpers ----------------------------------------------------

fn sample_run() -> RunContext {
    RunContext {
        run_id: "run_abc123".to_string(),
        task: "add login flow".to_string(),
        initial_notes: "We'll add /login and /logout. Auth via JWT.".to_string(),
    }
}

async fn fresh_notes() -> (tempfile::TempDir, SharedNotes) {
    let td = tempfile::tempdir().unwrap();
    let notes = SharedNotes::new(td.path());
    (td, notes)
}

/// Tiny AgentImpl impl used by consolidation tests. Callers construct
/// one with either a canned success body or a forced error — plan()
/// and execute() are never called here, so they panic if invoked.
struct MockMaster {
    outcome: Result<String, AgentError>,
}

impl MockMaster {
    fn ok(body: impl Into<String>) -> Self {
        Self {
            outcome: Ok(body.into()),
        }
    }
    fn fail(e: AgentError) -> Self {
        Self { outcome: Err(e) }
    }
}

#[async_trait]
impl AgentImpl for MockMaster {
    fn kind(&self) -> AgentKind {
        AgentKind::Claude
    }
    fn version(&self) -> &str {
        "mock"
    }
    async fn plan(
        &self,
        _task: &str,
        _context: PlanningContext,
        _cancel: CancellationToken,
    ) -> Result<Plan, AgentError> {
        panic!("MockMaster::plan should not be called in notes tests");
    }
    async fn execute(
        &self,
        _subtask: &Subtask,
        _worktree_path: &Path,
        _shared_notes: &str,
        _extra_context: Option<&str>,
        _log_tx: mpsc::Sender<String>,
        _cancel: CancellationToken,
    ) -> Result<ExecutionResult, AgentError> {
        panic!("MockMaster::execute should not be called in notes tests");
    }
    async fn summarize(
        &self,
        _prompt: &str,
        _cancel: CancellationToken,
    ) -> Result<String, AgentError> {
        match &self.outcome {
            Ok(s) => Ok(s.clone()),
            Err(e) => Err(clone_agent_error(e)),
        }
    }
}

fn clone_agent_error(e: &AgentError) -> AgentError {
    // AgentError isn't Clone; this is enough for tests.
    match e {
        AgentError::Timeout { after_secs } => AgentError::Timeout {
            after_secs: *after_secs,
        },
        AgentError::TaskFailed { reason } => AgentError::TaskFailed {
            reason: reason.clone(),
        },
        AgentError::Cancelled => AgentError::Cancelled,
        _ => AgentError::TaskFailed {
            reason: format!("{e}"),
        },
    }
}

// -- init / read / size_bytes ---------------------------------------

#[tokio::test]
async fn init_creates_directory_and_file_with_header() {
    let (td, notes) = fresh_notes().await;
    notes.init(&sample_run()).await.unwrap();

    assert!(tokio::fs::metadata(td.path().join(".whalecode"))
        .await
        .is_ok());
    assert!(notes.path().exists());

    let body = notes.read().await.unwrap();
    assert!(body.contains("# Task: add login flow"));
    assert!(body.contains("# Run: run_abc123"));
    assert!(body.contains("## Initial context (master)"));
    assert!(body.contains("JWT"));
}

#[tokio::test]
async fn init_overwrites_existing_notes() {
    let (_td, notes) = fresh_notes().await;
    notes.init(&sample_run()).await.unwrap();
    notes
        .append_subtask_summary("s1", "Old subtask", AgentKind::Claude, "old")
        .await
        .unwrap();

    let mut next = sample_run();
    next.task = "totally different task".into();
    notes.init(&next).await.unwrap();

    let body = notes.read().await.unwrap();
    assert!(body.contains("totally different task"));
    assert!(!body.contains("Old subtask"));
}

#[tokio::test]
async fn read_before_init_returns_not_initialized() {
    let (_td, notes) = fresh_notes().await;
    match notes.read().await {
        Err(NotesError::NotInitialized) => {}
        other => panic!("expected NotInitialized, got {other:?}"),
    }
}

#[tokio::test]
async fn size_bytes_matches_body_length() {
    let (_td, notes) = fresh_notes().await;
    notes.init(&sample_run()).await.unwrap();
    let body = notes.read().await.unwrap();
    let sz = notes.size_bytes().unwrap();
    assert_eq!(sz as usize, body.len());
}

// -- append ----------------------------------------------------------

#[tokio::test]
async fn append_writes_properly_formatted_section() {
    let (_td, notes) = fresh_notes().await;
    notes.init(&sample_run()).await.unwrap();
    notes
        .append_subtask_summary(
            "s1",
            "Wire up /login endpoint",
            AgentKind::Codex,
            "Added POST /login that verifies credentials and returns a JWT.",
        )
        .await
        .unwrap();

    let body = notes.read().await.unwrap();
    assert!(body.contains("## Subtask: Wire up /login endpoint [s1] (codex)"));
    assert!(body.contains("JWT"));
}

#[tokio::test]
async fn append_twice_same_subtask_is_rejected() {
    let (_td, notes) = fresh_notes().await;
    notes.init(&sample_run()).await.unwrap();
    notes
        .append_subtask_summary("s1", "t", AgentKind::Claude, "first")
        .await
        .unwrap();

    match notes
        .append_subtask_summary("s1", "t", AgentKind::Claude, "second attempt")
        .await
    {
        Err(NotesError::DuplicateSubtaskSummary { subtask_id }) => {
            assert_eq!(subtask_id, "s1");
        }
        other => panic!("expected DuplicateSubtaskSummary, got {other:?}"),
    }
    // Second call must not have corrupted the file.
    let body = notes.read().await.unwrap();
    assert!(body.contains("first"));
    assert!(!body.contains("second attempt"));
}

#[tokio::test]
async fn concurrent_appends_serialize_cleanly() {
    let (_td, notes) = fresh_notes().await;
    notes.init(&sample_run()).await.unwrap();
    let notes = Arc::new(notes);

    let mut joins = Vec::new();
    for i in 0..6 {
        let notes = notes.clone();
        joins.push(tokio::spawn(async move {
            let id = format!("s{i}");
            let title = format!("Task {i}");
            notes
                .append_subtask_summary(&id, &title, AgentKind::Gemini, "done")
                .await
        }));
    }
    for j in joins {
        j.await.unwrap().unwrap();
    }

    let body = notes.read().await.unwrap();
    for i in 0..6 {
        assert!(body.contains(&format!("[s{i}]")), "missing s{i} in body");
    }
}

// -- consolidate -----------------------------------------------------

#[tokio::test]
async fn consolidate_replaces_file_with_master_output() {
    let (_td, notes) = fresh_notes().await;
    notes.init(&sample_run()).await.unwrap();
    // Pad the notes a bit so the replace is visible.
    for i in 0..4 {
        notes
            .append_subtask_summary(
                &format!("s{i}"),
                &format!("task {i}"),
                AgentKind::Claude,
                "did a thing",
            )
            .await
            .unwrap();
    }

    let master = MockMaster::ok("# Task: add login flow\nConsolidated to one line.\n");
    notes.consolidate(&master).await.unwrap();

    let body = notes.read().await.unwrap();
    assert!(body.contains("Consolidated to one line"));
    assert!(!body.contains("[s0]"));
    assert!(body.ends_with('\n'));
}

#[tokio::test]
async fn consolidate_failure_leaves_file_untouched() {
    let (_td, notes) = fresh_notes().await;
    notes.init(&sample_run()).await.unwrap();
    let before = notes.read().await.unwrap();

    let master = MockMaster::fail(AgentError::Timeout { after_secs: 42 });
    match notes.consolidate(&master).await {
        Err(NotesError::ConsolidationFailed { cause }) => {
            assert!(cause.contains("42") || cause.to_lowercase().contains("timed out"));
        }
        other => panic!("expected ConsolidationFailed, got {other:?}"),
    }

    // File content unchanged.
    let after = notes.read().await.unwrap();
    assert_eq!(before, after);
}

#[tokio::test]
async fn consolidate_empty_response_is_rejected() {
    let (_td, notes) = fresh_notes().await;
    notes.init(&sample_run()).await.unwrap();
    let before = notes.read().await.unwrap();

    let master = MockMaster::ok("   \n  \t\n");
    match notes.consolidate(&master).await {
        Err(NotesError::ConsolidationFailed { cause }) => {
            assert!(cause.to_lowercase().contains("empty"));
        }
        other => panic!("expected ConsolidationFailed, got {other:?}"),
    }
    assert_eq!(before, notes.read().await.unwrap());
}

// -- clear -----------------------------------------------------------

#[tokio::test]
async fn clear_removes_the_file_and_is_idempotent() {
    let (_td, notes) = fresh_notes().await;
    notes.init(&sample_run()).await.unwrap();
    notes.clear().await.unwrap();
    assert!(!notes.path().exists());

    // Second call: no-op, not an error.
    notes.clear().await.unwrap();

    // And subsequent reads now surface NotInitialized.
    match notes.read().await {
        Err(NotesError::NotInitialized) => {}
        other => panic!("expected NotInitialized, got {other:?}"),
    }
}

// -- atomic write ----------------------------------------------------

#[tokio::test]
async fn append_leaves_no_tmp_files_behind() {
    // Narrow sanity check that write_atomic cleans up after itself.
    // A real "mid-write crash" can't be simulated deterministically,
    // but we can at least assert the happy path leaves no .tmp
    // sibling.
    let (_td, notes) = fresh_notes().await;
    notes.init(&sample_run()).await.unwrap();
    notes
        .append_subtask_summary("s1", "t", AgentKind::Claude, "done")
        .await
        .unwrap();

    let parent = notes.path().parent().unwrap();
    let mut dir = tokio::fs::read_dir(parent).await.unwrap();
    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name();
        let lossy = name.to_string_lossy();
        assert!(
            !lossy.ends_with(".tmp"),
            "unexpected tmp file left behind: {lossy}"
        );
    }
}

// -- path ------------------------------------------------------------

#[tokio::test]
async fn path_is_under_dot_whalecode() {
    let td = tempfile::tempdir().unwrap();
    let notes = SharedNotes::new(td.path());
    assert_eq!(
        notes.path(),
        &PathBuf::from(td.path())
            .join(".whalecode")
            .join("notes.md")
    );
}
