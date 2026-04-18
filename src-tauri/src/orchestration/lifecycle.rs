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

use std::sync::Arc;

use chrono::Utc;
use tokio::sync::{oneshot, RwLock};
use tokio_util::sync::CancellationToken;

use crate::agents::{AgentError, AgentImpl, Plan};
use crate::ipc::{RunId, RunStatus, SubtaskData, SubtaskId, SubtaskState};
use crate::orchestration::context::build_planning_context;
use crate::orchestration::dispatcher::{run_dispatcher, DispatchOutcome, DispatcherDeps};
use crate::orchestration::events::{EventSink, RunEvent};
use crate::orchestration::notes::{RunContext, SharedNotes};
use crate::orchestration::registry::AgentRegistry;
use crate::orchestration::run::{Run, SubtaskRuntime};
use crate::orchestration::{APPROVAL_TIMEOUT, MAX_CONCURRENT_WORKERS};
use crate::storage::models::NewSubtask;
use crate::storage::Storage;

/// What `approve_subtasks`/`reject_run` send into the waiting task.
#[derive(Debug)]
pub enum ApprovalDecision {
    /// User approved; only these subtask ids should run. Any not in
    /// the list is marked [`SubtaskState::Skipped`].
    Approve { subtask_ids: Vec<SubtaskId> },
    /// User rejected the plan outright.
    Reject,
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
}

/// Entry point for the per-run background task. Consumes the
/// `approval_rx` it was spawned with; returns nothing (errors are
/// converted into events + persisted status).
pub async fn run_lifecycle(
    deps: LifecycleDeps,
    run: Arc<RwLock<Run>>,
    master: Arc<dyn AgentImpl>,
    approval_rx: oneshot::Receiver<ApprovalDecision>,
) {
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
                    }
                    // Actual merge/apply/discard lands in 8d; the run
                    // parks in Merging until that ships.
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
    let (run_id, notes) = {
        let mut guard = run.write().await;
        guard.status = RunStatus::Cancelled;
        guard.finished_at = Some(Utc::now());
        (guard.id.clone(), guard.notes.clone())
    };
    // The notes file may not exist if we cancelled mid-planning —
    // `clear()` is idempotent, NotInitialized is ignored here.
    let _ = notes.clear().await;
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
    let run_id = {
        let mut guard = run.write().await;
        guard.status = RunStatus::Failed;
        guard.finished_at = Some(Utc::now());
        guard.id.clone()
    };
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
