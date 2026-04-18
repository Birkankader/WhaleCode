//! The per-run tokio task. Drives one [`Run`] from Planning to a
//! terminal state, emitting events and persisting transitions as it
//! goes.
//!
//! Lifecycle sketch (8b covers steps 1–4; 8c–8d extend from there):
//!
//! ```text
//! submit_task ─┐
//!              ▼
//!       ┌────────────┐   plan()      ┌──────────────────┐
//!       │  Planning  │──────────────▶│ AwaitingApproval │
//!       └────────────┘   (emit       └────────┬─────────┘
//!             │          MasterLog,           │
//!             │        SubtasksProposed)      │
//!             ▼                               │
//!           Failed                   ┌────────┼──────────┐
//!          (plan err)             approve    reject    cancel / timeout
//!                                     │        │          │
//!                                     ▼        ▼          ▼
//!                                 (8c)      Rejected    Cancelled
//! ```
//!
//! Invariants:
//! - Long operations (master.plan, worker.execute, merge) never run
//!   while holding the [`Run`]'s write lock. We acquire, mutate,
//!   drop, do work, acquire again to record results.
//! - Every `.await` is either a `tokio::select!` branch including
//!   the run's [`CancellationToken`], or a call into an API that
//!   already honors it internally.
//! - On any exit path (happy or otherwise), we persist the final
//!   status, emit a terminal event, and remove the run from the
//!   orchestrator's active map so a subsequent lookup returns
//!   `None`. SQLite retains the record.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use tokio::sync::{oneshot, Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use crate::agents::{AgentError, AgentImpl, Plan};
use crate::ipc::{
    FileDiff as IpcFileDiff, RunId, RunStatus, RunSummary, SubtaskData, SubtaskId, SubtaskState,
};
use crate::orchestration::context::build_planning_context;
use crate::orchestration::dispatcher::{run_dispatcher, DispatchOutcome, DispatcherDeps};
use crate::orchestration::events::{EventSink, RunEvent};
use crate::orchestration::notes::{RunContext, SharedNotes};
use crate::orchestration::registry::AgentRegistry;
use crate::orchestration::run::{Run, SubtaskRuntime};
use crate::orchestration::{APPROVAL_TIMEOUT, MAX_CONCURRENT_WORKERS};
use crate::storage::models::NewSubtask;
use crate::storage::Storage;
use crate::worktree::{DependencyGraph, FileDiff, MergeResult, WorktreeError, WorktreeManager};

/// What `approve_subtasks`/`reject_run` send into the waiting task.
#[derive(Debug)]
pub enum ApprovalDecision {
    /// User approved; only these subtask ids should run. Any not in
    /// the list is marked [`SubtaskState::Skipped`].
    Approve { subtask_ids: Vec<SubtaskId> },
    /// User rejected the plan outright.
    Reject,
}

/// What `apply_run`/`discard_run` send into the merge-phase waiter.
#[derive(Debug)]
pub enum ApplyDecision {
    /// User accepted the aggregated diff — merge branches into
    /// `base_branch`, clean up, transition to `Done`.
    Apply,
    /// User rejected the diff (or walked away) — no merge, drop
    /// branches + worktrees, transition to `Rejected`.
    Discard,
}

/// Why the run ended up cancelled. Shapes the final event so the UI
/// can distinguish "user cancelled" from "approval timed out".
enum CancelReason {
    UserCancelled,
    ApprovalTimeout,
}

/// Dependencies the lifecycle task needs. Bundled into one struct so
/// the spawn call stays readable and future fields (cost tracker,
/// retry policy) land as struct-level changes rather than N new
/// function args.
pub struct LifecycleDeps {
    pub storage: Arc<Storage>,
    pub event_sink: Arc<dyn EventSink>,
    pub registry: Arc<dyn AgentRegistry>,
    /// Shared back-reference to the Orchestrator's apply-decision
    /// sender map. On conflict the merge phase reinstalls a fresh
    /// sender here so the next `apply_run`/`discard_run` has somewhere
    /// to land.
    pub apply_senders: Arc<Mutex<HashMap<RunId, oneshot::Sender<ApplyDecision>>>>,
    /// How long to wait on the apply/discard decision before auto-
    /// discarding. Plumbed through from the orchestrator so tests can
    /// shrink it without changing the global constant.
    pub apply_timeout: std::time::Duration,
}

/// Entry point for the per-run background task. Consumes the
/// `approval_rx` and `apply_rx` it was spawned with; returns nothing
/// (errors are converted into events + persisted status).
pub async fn run_lifecycle(
    deps: LifecycleDeps,
    run: Arc<RwLock<Run>>,
    master: Arc<dyn AgentImpl>,
    approval_rx: oneshot::Receiver<ApprovalDecision>,
    apply_rx: oneshot::Receiver<ApplyDecision>,
) {
    // Yield before the first emit so `submit_task` (which spawned us)
    // has a chance to return `RunId` to its caller before any event
    // hits the wire. See the INVARIANT comment on `Orchestrator::
    // submit_task` — the frontend's RunSubscription cannot attach
    // until it has the RunId, so the backend must not emit anything
    // inside `submit_task`'s synchronous body.
    tokio::task::yield_now().await;

    let (run_id, repo_root, cancel, notes, task_text, master_kind) = {
        let r = run.read().await;
        (
            r.id.clone(),
            r.repo_root.clone(),
            r.cancel_token.clone(),
            r.notes.clone(),
            r.task.clone(),
            r.master,
        )
    };

    // -- Planning phase ---------------------------------------------
    // Emit the initial status transition now that we're past the
    // yield point. This used to live in `submit_task`; moved here to
    // preserve the attach-before-first-event invariant.
    deps.event_sink
        .emit(RunEvent::StatusChanged {
            run_id: run_id.clone(),
            status: RunStatus::Planning,
        })
        .await;
    deps.event_sink
        .emit(RunEvent::MasterLog {
            run_id: run_id.clone(),
            line: format!("planning with {:?} ({})…", master_kind, master.version()),
        })
        .await;

    let available_workers = deps.registry.available().await;
    let ctx = build_planning_context(&repo_root, available_workers).await;

    let plan_result = tokio::select! {
        p = master.plan(&task_text, ctx, cancel.clone()) => p,
        _ = cancel.cancelled() => Err(AgentError::Cancelled),
    };

    let plan = match plan_result {
        Ok(p) => p,
        Err(AgentError::Cancelled) => {
            finalize_cancelled(&deps, &run, CancelReason::UserCancelled).await;
            return;
        }
        Err(e) => {
            finalize_failed(&deps, &run, format!("planning failed: {e}")).await;
            return;
        }
    };

    // Plan succeeded: initialize shared notes, record subtasks in
    // memory + SQLite, emit SubtasksProposed, transition to
    // AwaitingApproval.
    if let Err(e) = initialize_run_from_plan(&deps, &run, &notes, &plan, &task_text).await {
        finalize_failed(&deps, &run, format!("failed to record plan: {e}")).await;
        return;
    }

    // -- Approval wait ----------------------------------------------
    let decision = tokio::select! {
        d = approval_rx => match d {
            Ok(d) => d,
            // Sender dropped without deciding: treat as reject so the
            // run doesn't hang. Only happens if the orchestrator is
            // torn down; commands consume the sender.
            Err(_) => ApprovalDecision::Reject,
        },
        _ = cancel.cancelled() => {
            finalize_cancelled(&deps, &run, CancelReason::UserCancelled).await;
            return;
        }
        _ = tokio::time::sleep(APPROVAL_TIMEOUT) => {
            deps.event_sink.emit(RunEvent::MasterLog {
                run_id: run_id.clone(),
                line: "approval timed out after 30 minutes; auto-rejecting.".into(),
            }).await;
            finalize_rejected(&deps, &run).await;
            return;
        }
    };

    match decision {
        ApprovalDecision::Reject => {
            finalize_rejected(&deps, &run).await;
        }
        ApprovalDecision::Approve { subtask_ids } => {
            if let Err(e) = record_approval(&deps, &run, &subtask_ids).await {
                finalize_failed(&deps, &run, format!("recording approval failed: {e}")).await;
                return;
            }
            let dispatcher_deps = DispatcherDeps {
                storage: deps.storage.clone(),
                event_sink: deps.event_sink.clone(),
                registry: deps.registry.clone(),
            };
            let outcome = run_dispatcher(
                &dispatcher_deps,
                run.clone(),
                master.clone(),
                MAX_CONCURRENT_WORKERS,
            )
            .await;
            match outcome {
                DispatchOutcome::AllDone => {
                    if let Err(e) = transition_to_merging(&deps, &run).await {
                        finalize_failed(&deps, &run, e).await;
                        return;
                    }
                    merge_phase(&deps, &run, apply_rx).await;
                }
                DispatchOutcome::Failed { error } => {
                    finalize_failed(&deps, &run, error).await;
                }
                DispatchOutcome::Cancelled => {
                    finalize_cancelled(&deps, &run, CancelReason::UserCancelled).await;
                }
            }
        }
    }
}

// -- Merge phase -----------------------------------------------------

/// Outcome of one pass through the apply/discard loop. `Retry` means
/// we hit a conflict, emitted `MergeConflict`, and are waiting for the
/// user's next click.
enum MergeStepOutcome {
    Applied(MergeResult),
    Discarded,
    Cancelled,
    Failed(String),
    /// Apply hit a conflict; worktrees and notes preserved, apply
    /// oneshot reinstalled. Loop again to wait for the next click.
    Retry,
}

/// Drive the run from `Merging` to its terminal state.
///
/// Flow:
/// 1. Aggregate diffs across all `Done` subtasks (dedupe by path,
///    last-wins). Emit `DiffReady`.
/// 2. Wait on the apply oneshot (or cancel / timeout).
/// 3. On Apply: call `merge_all`. `Ok` → clean up + Done + `Completed`;
///    `MergeConflict` → reinstall oneshot, keep Merging, emit
///    `MergeConflict`, loop; other `Err` → clean up + Failed.
/// 4. On Discard or timeout: clean up, no merge, → Rejected.
/// 5. On cancel while waiting: behave like Discard but terminal state
///    is Cancelled.
async fn merge_phase(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
    apply_rx: oneshot::Receiver<ApplyDecision>,
) {
    let (run_id, cancel, worktree_mgr, notes, started_at) = {
        let r = run.read().await;
        (
            r.id.clone(),
            r.cancel_token.clone(),
            r.worktree_mgr.clone(),
            r.notes.clone(),
            r.started_at,
        )
    };

    // -- Aggregate diffs across Done subtasks ------------------------
    // "Last-in-iteration-order wins" — iterate the subtask vec in
    // insertion order (plan order) and overwrite.
    let done_ids: Vec<SubtaskId> = {
        let r = run.read().await;
        r.subtasks
            .iter()
            .filter(|s| s.is_done())
            .map(|s| s.id.clone())
            .collect()
    };

    let mut by_path: HashMap<PathBuf, FileDiff> = HashMap::new();
    let mut order: Vec<PathBuf> = Vec::new();
    for sub_id in &done_ids {
        let diffs = match worktree_mgr.diff(sub_id).await {
            Ok(d) => d,
            Err(e) => {
                // A single subtask's diff failing is logged and skipped
                // rather than failing the whole merge — the other
                // subtasks may still merge cleanly. If everything
                // failed the user sees an empty DiffReady and can
                // discard.
                deps.event_sink
                    .emit(RunEvent::MasterLog {
                        run_id: run_id.clone(),
                        line: format!("diff for {sub_id} failed: {e}"),
                    })
                    .await;
                continue;
            }
        };
        for fd in diffs {
            if !by_path.contains_key(&fd.path) {
                order.push(fd.path.clone());
            }
            by_path.insert(fd.path.clone(), fd);
        }
    }
    let wire_files: Vec<IpcFileDiff> = order
        .iter()
        .filter_map(|p| by_path.get(p).map(worktree_to_ipc_diff))
        .collect();

    deps.event_sink
        .emit(RunEvent::DiffReady {
            run_id: run_id.clone(),
            files: wire_files,
        })
        .await;

    // -- Wait loop. On MergeConflict we reinstall a fresh oneshot ----
    // and wait again for the user's next click.
    let mut current_rx = apply_rx;
    loop {
        let decision = tokio::select! {
            d = &mut current_rx => match d {
                Ok(d) => d,
                // Sender dropped mid-flight (shouldn't happen outside
                // of shutdown); treat as Discard so we don't hang.
                Err(_) => ApplyDecision::Discard,
            },
            _ = cancel.cancelled() => {
                // Cancel while waiting: discard path with Cancelled
                // terminal state.
                finalize_discard(deps, run, run_id.clone(), worktree_mgr.clone(), notes.clone(), TerminalOnDiscard::Cancelled).await;
                return;
            }
            _ = tokio::time::sleep(deps.apply_timeout) => {
                deps.event_sink.emit(RunEvent::MasterLog {
                    run_id: run_id.clone(),
                    line: format!(
                        "apply timed out after {}s; auto-discarding.",
                        deps.apply_timeout.as_secs()
                    ),
                }).await;
                finalize_discard(deps, run, run_id.clone(), worktree_mgr.clone(), notes.clone(), TerminalOnDiscard::Rejected).await;
                return;
            }
        };

        match decision {
            ApplyDecision::Discard => {
                finalize_discard(
                    deps,
                    run,
                    run_id.clone(),
                    worktree_mgr.clone(),
                    notes.clone(),
                    TerminalOnDiscard::Rejected,
                )
                .await;
                return;
            }
            ApplyDecision::Apply => {
                match apply_step(deps, run, &run_id, &worktree_mgr).await {
                    MergeStepOutcome::Applied(res) => {
                        finalize_applied(
                            deps,
                            run,
                            &run_id,
                            &worktree_mgr,
                            &notes,
                            &done_ids,
                            &res,
                            started_at,
                        )
                        .await;
                        return;
                    }
                    MergeStepOutcome::Failed(err) => {
                        // Non-conflict merge failure. `finalize_failed`
                        // owns the notes + worktree cleanup.
                        finalize_failed(deps, run, err).await;
                        return;
                    }
                    MergeStepOutcome::Cancelled => {
                        // Cancel observed during merge itself: per
                        // spec, let git finish (already did) then
                        // finalize. `finalize_cancelled` owns cleanup.
                        finalize_cancelled(deps, run, CancelReason::UserCancelled).await;
                        return;
                    }
                    MergeStepOutcome::Retry => {
                        // Conflict: reinstall a fresh oneshot sender
                        // into the shared map so the UI's next click
                        // has somewhere to land. `apply_senders` is
                        // on the Orchestrator, which we don't hold a
                        // handle to — but `submit_task` already stored
                        // one for us; that sender was consumed when
                        // the user clicked Apply. Reinstall.
                        let (new_tx, new_rx) = oneshot::channel();
                        install_apply_sender(deps, &run_id, new_tx).await;
                        current_rx = new_rx;
                        // Loop back to wait on the new receiver.
                        continue;
                    }
                    MergeStepOutcome::Discarded => {
                        // Unreachable from apply_step, but keeps the
                        // match exhaustive for future changes.
                        return;
                    }
                }
            }
        }
    }
}

/// Perform one `merge_all` attempt. Returns `Applied` on success,
/// `Retry` on MergeConflict (conflict is emitted + error persisted),
/// `Failed` on other git errors, `Cancelled` if the run's cancel token
/// fired mid-merge.
async fn apply_step(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
    run_id: &RunId,
    worktree_mgr: &Arc<WorktreeManager>,
) -> MergeStepOutcome {
    // Collect ids + dep graph of the Done subtasks.
    let (ids, graph) = build_merge_inputs(run).await;

    // merge_all itself is not cancel-aware (the whole op is a handful
    // of git commands). Per spec: let it finish, then decide.
    let res = worktree_mgr.merge_all(&ids, &graph).await;
    match res {
        Ok(r) => {
            // If cancel fired while git was running, treat as cancel
            // and clean up accordingly.
            if run.read().await.cancel_token.is_cancelled() {
                return MergeStepOutcome::Cancelled;
            }
            MergeStepOutcome::Applied(r)
        }
        Err(WorktreeError::MergeConflict { files }) => {
            let summary = conflict_summary(&files);
            // Record conflict on the run row. Storage semantics for
            // `error` when `status == Merging` are "last merge
            // attempt's conflict summary". Phase 6 may split this
            // into its own column.
            if let Err(e) = deps
                .storage
                .update_run_error(run_id, Some(&summary))
                .await
            {
                eprintln!("[orchestrator] update_run_error(conflict) failed: {e}");
            }
            deps.event_sink
                .emit(RunEvent::MergeConflict {
                    run_id: run_id.clone(),
                    files,
                })
                .await;
            MergeStepOutcome::Retry
        }
        Err(e) => MergeStepOutcome::Failed(format!("merge_all: {e}")),
    }
}

/// Finalize a successful Apply: cleanup, mark Done, emit Completed.
#[allow(clippy::too_many_arguments)]
async fn finalize_applied(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
    run_id: &RunId,
    worktree_mgr: &Arc<WorktreeManager>,
    notes: &Arc<SharedNotes>,
    done_ids: &[SubtaskId],
    res: &MergeResult,
    started_at: chrono::DateTime<Utc>,
) {
    let _ = notes.clear().await;
    if let Err(e) = worktree_mgr.cleanup_all().await {
        // Log but continue — the run succeeded; cleanup failure is
        // advisory. `cleanup_orphans_on_startup` sweeps leftovers.
        deps.event_sink
            .emit(RunEvent::MasterLog {
                run_id: run_id.clone(),
                line: format!("cleanup_all: {e}"),
            })
            .await;
    }
    let now = Utc::now();
    {
        let mut guard = run.write().await;
        guard.status = RunStatus::Done;
        guard.finished_at = Some(now);
    }
    if let Err(e) = deps
        .storage
        // `Done` overwrites any prior conflict summary in `error`.
        .finish_run(run_id, RunStatus::Done, now, None)
        .await
    {
        eprintln!("[orchestrator] finish_run(done) failed: {e}");
    }
    let summary = RunSummary {
        run_id: run_id.clone(),
        subtask_count: done_ids.len() as u32,
        files_changed: res.files_changed.len() as u32,
        duration_secs: (now - started_at).num_seconds().max(0) as u64,
        commits_created: res.commits_created as u32,
    };
    deps.event_sink
        .emit(RunEvent::Completed {
            run_id: run_id.clone(),
            summary,
        })
        .await;
    deps.event_sink
        .emit(RunEvent::StatusChanged {
            run_id: run_id.clone(),
            status: RunStatus::Done,
        })
        .await;
}

/// Finalize a Discard / timeout / cancel-while-waiting. Same cleanup
/// steps; terminal status and emitted event differ by `mode`.
enum TerminalOnDiscard {
    Rejected,
    Cancelled,
}

async fn finalize_discard(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
    run_id: RunId,
    worktree_mgr: Arc<WorktreeManager>,
    notes: Arc<SharedNotes>,
    mode: TerminalOnDiscard,
) {
    let _ = notes.clear().await;
    if let Err(e) = worktree_mgr.cleanup_all().await {
        deps.event_sink
            .emit(RunEvent::MasterLog {
                run_id: run_id.clone(),
                line: format!("cleanup_all on discard: {e}"),
            })
            .await;
    }
    match mode {
        TerminalOnDiscard::Rejected => {
            let now = Utc::now();
            {
                let mut guard = run.write().await;
                guard.status = RunStatus::Rejected;
                guard.finished_at = Some(now);
            }
            if let Err(e) = deps
                .storage
                .finish_run(&run_id, RunStatus::Rejected, now, None)
                .await
            {
                eprintln!("[orchestrator] finish_run(rejected-discard) failed: {e}");
            }
            deps.event_sink
                .emit(RunEvent::StatusChanged {
                    run_id,
                    status: RunStatus::Rejected,
                })
                .await;
        }
        TerminalOnDiscard::Cancelled => {
            finalize_cancelled(deps, run, CancelReason::UserCancelled).await;
        }
    }
}

async fn build_merge_inputs(run: &Arc<RwLock<Run>>) -> (Vec<String>, DependencyGraph) {
    let guard = run.read().await;
    let ids: Vec<String> = guard
        .subtasks
        .iter()
        .filter(|s| s.is_done())
        .map(|s| s.id.clone())
        .collect();
    let done_set: std::collections::HashSet<&String> = ids.iter().collect();
    let mut graph = DependencyGraph::new();
    for s in guard.subtasks.iter().filter(|s| s.is_done()) {
        // Only keep deps that also ended in Done — a skipped/failed
        // dependency has no branch to merge first.
        let deps: Vec<String> = s
            .dependency_ids
            .iter()
            .filter(|d| done_set.contains(*d))
            .cloned()
            .collect();
        graph.insert(s.id.clone(), deps);
    }
    (ids, graph)
}

fn worktree_to_ipc_diff(fd: &FileDiff) -> IpcFileDiff {
    IpcFileDiff {
        path: fd.path.to_string_lossy().into_owned(),
        additions: fd.additions as u32,
        deletions: fd.deletions as u32,
    }
}

fn conflict_summary(files: &[PathBuf]) -> String {
    let joined = files
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    format!("merge conflict in {} file(s): {joined}", files.len())
}

/// Store a fresh apply-decision sender so the next `apply_run` /
/// `discard_run` click has somewhere to land. The Orchestrator's
/// `apply_senders` map is shared through [`LifecycleDeps`]; this is a
/// simple insert into it, replacing any stale sender.
async fn install_apply_sender(
    deps: &LifecycleDeps,
    run_id: &RunId,
    tx: oneshot::Sender<ApplyDecision>,
) {
    deps.apply_senders.lock().await.insert(run_id.clone(), tx);
}

/// Flip the run to Merging. 8d's merge logic reads this as its cue to
/// start.
async fn transition_to_merging(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
) -> Result<(), String> {
    let run_id = {
        let mut guard = run.write().await;
        guard.status = RunStatus::Merging;
        guard.id.clone()
    };
    deps.storage
        .update_run_status(&run_id, RunStatus::Merging)
        .await
        .map_err(|e| format!("update_run_status(merging): {e}"))?;
    deps.event_sink
        .emit(RunEvent::StatusChanged {
            run_id,
            status: RunStatus::Merging,
        })
        .await;
    Ok(())
}

/// Hydrate [`Run::subtasks`], persist to SQLite, init shared notes
/// with the master's reasoning, and emit
/// [`RunEvent::SubtasksProposed`] + the AwaitingApproval transition.
async fn initialize_run_from_plan(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
    notes: &Arc<SharedNotes>,
    plan: &Plan,
    task_text: &str,
) -> Result<(), String> {
    let (run_id, subtasks, deps_to_persist) = {
        let mut guard = run.write().await;
        let run_id = guard.id.clone();
        let subtask_ids: Vec<SubtaskId> = (0..plan.subtasks.len())
            .map(|_| ulid_subtask_id())
            .collect();
        let mut runtimes: Vec<SubtaskRuntime> = Vec::with_capacity(plan.subtasks.len());
        let mut deps_edges: Vec<(SubtaskId, SubtaskId)> = Vec::new();
        for (i, ps) in plan.subtasks.iter().enumerate() {
            let dep_ids: Vec<SubtaskId> = ps
                .dependencies
                .iter()
                .filter_map(|idx| subtask_ids.get(*idx).cloned())
                .collect();
            for d in &dep_ids {
                deps_edges.push((subtask_ids[i].clone(), d.clone()));
            }
            runtimes.push(SubtaskRuntime::new(
                subtask_ids[i].clone(),
                ps.clone(),
                dep_ids,
            ));
        }
        let proposed: Vec<SubtaskData> = runtimes.iter().map(to_subtask_data).collect();
        guard.subtasks = runtimes;
        (run_id, proposed, deps_edges)
    };

    // Initialize shared notes with the master's reasoning as the
    // "initial context" section. Failure here is fatal — workers
    // read this file.
    notes
        .init(&RunContext {
            run_id: run_id.clone(),
            task: task_text.to_string(),
            initial_notes: plan.reasoning.clone(),
        })
        .await
        .map_err(|e| format!("notes init: {e}"))?;

    // Persist subtasks + dependencies.
    for s in &subtasks {
        deps.storage
            .insert_subtask(&NewSubtask {
                id: s.id.clone(),
                run_id: run_id.clone(),
                title: s.title.clone(),
                why: s.why.clone(),
                assigned_worker: s.assigned_worker,
                state: SubtaskState::Proposed,
            })
            .await
            .map_err(|e| format!("insert_subtask: {e}"))?;
    }
    for (child, parent) in &deps_to_persist {
        deps.storage
            .insert_dependency(child, parent)
            .await
            .map_err(|e| format!("insert_dependency: {e}"))?;
    }

    // Transition to AwaitingApproval in memory + DB.
    {
        let mut guard = run.write().await;
        guard.status = RunStatus::AwaitingApproval;
    }
    deps.storage
        .update_run_status(&run_id, RunStatus::AwaitingApproval)
        .await
        .map_err(|e| format!("update_run_status: {e}"))?;

    deps.event_sink
        .emit(RunEvent::SubtasksProposed {
            run_id: run_id.clone(),
            subtasks,
        })
        .await;
    deps.event_sink
        .emit(RunEvent::StatusChanged {
            run_id,
            status: RunStatus::AwaitingApproval,
        })
        .await;

    Ok(())
}

/// Mark un-picked subtasks as Skipped, persist, transition to
/// Running. The dispatcher (8c) takes over from here in the final
/// version.
async fn record_approval(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
    approved: &[SubtaskId],
) -> Result<(), String> {
    let (run_id, skipped): (RunId, Vec<SubtaskId>) = {
        let mut guard = run.write().await;
        let mut skipped = Vec::new();
        for s in guard.subtasks.iter_mut() {
            if approved.iter().any(|id| id == &s.id) {
                // State will be set to Waiting by the dispatcher
                // before it picks the ready set. Leave Proposed for
                // now.
            } else {
                s.mark_skipped();
                skipped.push(s.id.clone());
            }
        }
        guard.status = RunStatus::Running;
        (guard.id.clone(), skipped)
    };

    for id in &skipped {
        deps.storage
            .update_subtask_state(id, SubtaskState::Skipped, None)
            .await
            .map_err(|e| format!("update_subtask_state(skipped): {e}"))?;
        deps.event_sink
            .emit(RunEvent::SubtaskStateChanged {
                run_id: run_id.clone(),
                subtask_id: id.clone(),
                state: SubtaskState::Skipped,
            })
            .await;
    }

    deps.storage
        .update_run_status(&run_id, RunStatus::Running)
        .await
        .map_err(|e| format!("update_run_status: {e}"))?;
    deps.event_sink
        .emit(RunEvent::StatusChanged {
            run_id,
            status: RunStatus::Running,
        })
        .await;

    Ok(())
}

// -- Terminal paths --------------------------------------------------

async fn finalize_rejected(deps: &LifecycleDeps, run: &Arc<RwLock<Run>>) {
    let (run_id, notes) = {
        let mut guard = run.write().await;
        guard.status = RunStatus::Rejected;
        guard.finished_at = Some(Utc::now());
        (guard.id.clone(), guard.notes.clone())
    };
    // Notes were initialized after planning; clear them so the repo
    // doesn't keep stale content. Best-effort: clear failure is
    // logged via the master log channel but doesn't block the exit.
    if let Err(e) = notes.clear().await {
        deps.event_sink
            .emit(RunEvent::MasterLog {
                run_id: run_id.clone(),
                line: format!("notes cleanup on reject: {e}"),
            })
            .await;
    }
    if let Err(e) = deps
        .storage
        .finish_run(&run_id, RunStatus::Rejected, Utc::now(), None)
        .await
    {
        eprintln!("[orchestrator] finish_run(rejected) failed: {e}");
    }
    deps.event_sink
        .emit(RunEvent::StatusChanged {
            run_id,
            status: RunStatus::Rejected,
        })
        .await;
}

async fn finalize_cancelled(deps: &LifecycleDeps, run: &Arc<RwLock<Run>>, reason: CancelReason) {
    let (run_id, notes, worktree_mgr) = {
        let mut guard = run.write().await;
        guard.status = RunStatus::Cancelled;
        guard.finished_at = Some(Utc::now());
        (
            guard.id.clone(),
            guard.notes.clone(),
            guard.worktree_mgr.clone(),
        )
    };
    // Every terminal path clears notes + worktrees so disk state
    // doesn't silently accumulate. Both are best-effort: a cleanup
    // failure is logged but must not block the terminal transition.
    let _ = notes.clear().await;
    if let Err(e) = worktree_mgr.cleanup_all().await {
        eprintln!("[orchestrator] cleanup_all on cancel: {e}");
    }
    let log_line = match reason {
        CancelReason::UserCancelled => "run cancelled by user".to_string(),
        CancelReason::ApprovalTimeout => "approval timed out; auto-cancelled".to_string(),
    };
    deps.event_sink
        .emit(RunEvent::MasterLog {
            run_id: run_id.clone(),
            line: log_line,
        })
        .await;
    if let Err(e) = deps
        .storage
        .finish_run(&run_id, RunStatus::Cancelled, Utc::now(), None)
        .await
    {
        eprintln!("[orchestrator] finish_run(cancelled) failed: {e}");
    }
    deps.event_sink
        .emit(RunEvent::StatusChanged {
            run_id,
            status: RunStatus::Cancelled,
        })
        .await;
}

async fn finalize_failed(deps: &LifecycleDeps, run: &Arc<RwLock<Run>>, error: String) {
    let (run_id, notes, worktree_mgr) = {
        let mut guard = run.write().await;
        guard.status = RunStatus::Failed;
        guard.finished_at = Some(Utc::now());
        (
            guard.id.clone(),
            guard.notes.clone(),
            guard.worktree_mgr.clone(),
        )
    };
    // Same cleanup discipline as finalize_cancelled: always try to
    // tear down notes + worktrees, log on failure, proceed with the
    // terminal transition regardless.
    let _ = notes.clear().await;
    if let Err(e) = worktree_mgr.cleanup_all().await {
        eprintln!("[orchestrator] cleanup_all on failure: {e}");
    }
    if let Err(e) = deps
        .storage
        .finish_run(&run_id, RunStatus::Failed, Utc::now(), Some(&error))
        .await
    {
        eprintln!("[orchestrator] finish_run(failed) failed: {e}");
    }
    deps.event_sink
        .emit(RunEvent::Failed {
            run_id: run_id.clone(),
            error,
        })
        .await;
    deps.event_sink
        .emit(RunEvent::StatusChanged {
            run_id,
            status: RunStatus::Failed,
        })
        .await;
}

// -- Helpers ---------------------------------------------------------

fn to_subtask_data(runtime: &SubtaskRuntime) -> SubtaskData {
    SubtaskData {
        id: runtime.id.clone(),
        title: runtime.data.title.clone(),
        why: Some(runtime.data.why.clone()).filter(|w| !w.is_empty()),
        assigned_worker: runtime.data.assigned_worker,
        dependencies: runtime.dependency_ids.clone(),
    }
}

fn ulid_subtask_id() -> SubtaskId {
    // Reuse ULID for subtask ids too: sortable + globally unique,
    // matches run ids, and distinguishes a specific subtask across
    // retries (Phase 3 may re-dispatch with a fresh id).
    ulid::Ulid::new().to_string()
}

/// Strip ULID string generator into its own helper so both
/// orchestrator code and tests can use the same id shape.
pub fn new_run_id() -> RunId {
    ulid::Ulid::new().to_string()
}

/// A cancel token that has already fired. Used by the orchestrator's
/// `cancel_run` method; extracted so tests can construct the same
/// shape without importing tokio-util themselves.
pub fn fired_token() -> CancellationToken {
    let t = CancellationToken::new();
    t.cancel();
    t
}
