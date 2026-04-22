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

use crate::agents::{AgentError, AgentImpl, Plan, ReplanContext};
use crate::ipc::{
    DiffStatus as IpcDiffStatus, FileDiff as IpcFileDiff, RunId, RunStatus, RunSummary,
    SubtaskData, SubtaskId, SubtaskState,
};
use crate::orchestration::context::build_planning_context;
use crate::orchestration::dispatcher::{
    escalate_error_text, run_dispatcher, DispatchOutcome, DispatcherDeps, EscalateToMaster,
};
use crate::orchestration::events::{EventSink, RunEvent};
use crate::orchestration::notes::{RunContext, SharedNotes};
use crate::orchestration::registry::AgentRegistry;
use crate::orchestration::run::{Run, SubtaskRuntime};
use crate::orchestration::{APPROVAL_TIMEOUT, MAX_CONCURRENT_WORKERS};
use crate::safety::SafetyGate;
use crate::settings::SettingsStore;
use crate::storage::models::NewSubtask;
use crate::storage::Storage;
use crate::worktree::{
    DependencyGraph, DiffStatus as WorktreeDiffStatus, FileDiff, MergeResult, WorktreeError,
    WorktreeManager,
};

/// How many lines of the failed subtask's worker log to include in
/// the replan prompt. Mirrors `phase-3-spec.md` §4: enough forensics
/// for the master to spot what was happening just before the failure
/// without drowning the prompt.
const REPLAN_LOG_TAIL_LINES: usize = 50;

/// Lineage cap: `count >= this` means the failed subtask has already
/// been through two replans and we must escalate rather than try a
/// third. Matches spec Decision 3 ("max 2 master replans").
pub(crate) const REPLAN_LINEAGE_CAP: u32 = 2;

/// Phase 3.5 Item 2: how often to emit "still planning… (Ns elapsed)"
/// heartbeats on the master log while waiting on `AgentImpl::plan`.
/// 10s was picked over the 5s that matches the worker log tail
/// because (a) claude typically plans in 3-5s so a single heartbeat
/// is rare on the happy path, and (b) gemini can sit silent for
/// ~230s and the user needs ~23 heartbeats, not 46.
const PLAN_HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

/// Outcome of a Layer-2 replan attempt. Distinct from [`DispatchOutcome`]
/// so the lifecycle can decide whether to loop back into approval
/// (`NewPlan`), park on human escalation (`Escalated`), or finalize the
/// run (`Error`).
enum ReplanOutcome {
    /// Master produced at least one replacement subtask, rows were
    /// persisted, and the run is back in `AwaitingApproval` with a
    /// fresh approval sender installed. Caller should loop.
    NewPlan,
    /// Layer-3 escalation: either the lineage cap was hit or the
    /// master returned an empty plan (infeasible). `HumanEscalation`
    /// has already been emitted; the lifecycle parks the run in
    /// `AwaitingHumanFix` and waits on the resolution channel.
    /// `subtask_id` is the subtask the user needs to act on; `kind`
    /// is preserved so a user-initiated `ReplanRequested` can rebuild
    /// the replan context with the same escalation reason.
    Escalated {
        reason: String,
        subtask_id: SubtaskId,
        kind: EscalateToMaster,
    },
    /// Replan itself errored (master crashed, storage write failed,
    /// etc.). Lifecycle finalizes to `Failed` with this message.
    Error(String),
}

/// What the four Layer-3 IPC commands send on the per-run resolution
/// channel. The lifecycle task is parked on this channel while the run
/// sits in `AwaitingHumanFix`; receiving any variant unblocks forward
/// progress. In Commit 2a the IPC commands still return
/// `InvalidEdit("not yet implemented")`, so production code never
/// produces these — only the lifecycle's internal `park_on_escalation`
/// receives from tests that push decisions directly via the orchestrator's
/// `resolution_senders` map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Layer3Decision {
    /// User asserts the escalated subtask is now correct (either by
    /// editing the worktree or by re-running manually). Lifecycle
    /// marks the subtask `Done` and re-enters the dispatcher so any
    /// dependents unblocked by it can run.
    Fixed(SubtaskId),
    /// User wants to drop the escalated subtask and any descendant
    /// that can't run without it. The vec carries the full forward-
    /// dependency cascade (computed by the `skip_subtask` IPC command
    /// in Commit 2b); the lifecycle marks every entry `Skipped`.
    Skipped(Vec<SubtaskId>),
    /// User wants one more Layer-2 replan attempt. Only legal when the
    /// chain's `replan_count` is below the cap; the IPC command guards
    /// this (Commit 2b) and the lifecycle double-checks via
    /// `count_replans_in_lineage`.
    ReplanRequested(SubtaskId),
    /// User gave up. Lifecycle fires the run's cancel token and drops
    /// through to `finalize_cancelled`, same terminal state as any
    /// user-cancelled run.
    Aborted,
}

/// What `approve_subtasks`/`reject_run` send into the waiting task.
#[derive(Debug)]
pub enum ApprovalDecision {
    /// User approved; only these subtask ids should run. Any not in
    /// the list is marked [`SubtaskState::Skipped`].
    Approve { subtask_ids: Vec<SubtaskId> },
    /// User rejected the plan outright.
    Reject,
}

/// Phase 3 Step 7: outcome of the auto-approve check at the top of the
/// approval wait. `Synthesized` means the lifecycle already has a
/// decision without user input; `Manual` means fall through to the
/// normal `tokio::select!` on the approval receiver.
#[derive(Debug)]
enum AutoApproveOutcome {
    Synthesized(ApprovalDecision),
    Manual,
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
    /// Read at every approval-wait entry point (initial plan + Layer-2
    /// replan) to decide whether to synthesize an `Approve(all_ids)`
    /// decision or block on the user's click. Shared with the
    /// orchestrator so a toggle change from the settings panel takes
    /// effect on the run's *next* plan pass without restart.
    pub settings: Arc<SettingsStore>,
    /// Phase 3 Step 7 integration seam. Held here so it threads
    /// cleanly into [`DispatcherDeps`] each time the lifecycle hands
    /// them over; the dispatcher consults it before Phase-7-policed
    /// worker actions.
    pub safety_gate: Arc<SafetyGate>,
    /// Shared back-reference to the Orchestrator's approval-decision
    /// sender map. After a Layer-2 replan produces fresh subtasks,
    /// the lifecycle reinstalls a new sender here so the user's next
    /// approve/reject click lands on the right receiver. On the
    /// initial approval pass this map is populated by `submit_task`
    /// and consumed by `approve_subtasks`/`reject_run` — the
    /// lifecycle doesn't touch it then.
    pub approval_senders: Arc<Mutex<HashMap<RunId, oneshot::Sender<ApprovalDecision>>>>,
    /// Shared back-reference to the Orchestrator's apply-decision
    /// sender map. On conflict the merge phase reinstalls a fresh
    /// sender here so the next `apply_run`/`discard_run` has somewhere
    /// to land.
    pub apply_senders: Arc<Mutex<HashMap<RunId, oneshot::Sender<ApplyDecision>>>>,
    /// Shared back-reference to the Orchestrator's Layer-3 resolution
    /// sender map. Populated by the lifecycle itself at the moment of
    /// parking (on a Layer-3 escalation) and consumed by the four IPC
    /// commands (`manual_fix_subtask` / `mark_subtask_fixed` /
    /// `skip_subtask` / `try_replan_again`). If an escalation cycles
    /// (user asks for `ReplanRequested`, master re-escalates), the
    /// lifecycle reinstalls a fresh sender for the next park.
    pub resolution_senders: Arc<Mutex<HashMap<RunId, oneshot::Sender<Layer3Decision>>>>,
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

    // Phase 3.5 Item 2: the master CLI is opaque while it plans — claude
    // uses `--print --output-format json` which emits the envelope only
    // at completion, and gemini can sit silent for ~230s (see the
    // benchmark in `docs/KNOWN_ISSUES.md`). Without a heartbeat the user
    // stares at a spinning chip with no sense of progress. Emit a
    // `MasterLog` every `PLAN_HEARTBEAT_INTERVAL` with elapsed seconds so
    // the master-log surface shows motion. The ticker stops naturally
    // when `plan()` resolves and the select arm drops the future.
    let plan_started = std::time::Instant::now();
    let mut heartbeat = tokio::time::interval(PLAN_HEARTBEAT_INTERVAL);
    // First tick fires immediately — skip it; the "planning with …"
    // line emitted above already establishes the T=0 signal.
    heartbeat.tick().await;
    let plan_fut = master.plan(&task_text, ctx, cancel.clone());
    tokio::pin!(plan_fut);
    let plan_result = loop {
        tokio::select! {
            p = &mut plan_fut => break p,
            _ = cancel.cancelled() => break Err(AgentError::Cancelled),
            _ = heartbeat.tick() => {
                let elapsed = plan_started.elapsed().as_secs();
                deps.event_sink
                    .emit(RunEvent::MasterLog {
                        run_id: run_id.clone(),
                        line: format!("still planning… ({elapsed}s elapsed)"),
                    })
                    .await;
            }
        }
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

    // -- Approval + dispatch loop ----------------------------------
    //
    // The loop exists so Layer-2 replans can re-enter the approval
    // phase: when the dispatcher returns `NeedsReplan`, we ask the
    // master for a replacement plan, re-emit `SubtasksProposed`,
    // reinstall the approval oneshot, and wait for the user to
    // approve again. Initial-plan and replan passes share the same
    // approval semantics (reject / timeout / cancel paths are
    // identical), so they share the same code.
    //
    // `current_approval_rx` is owned across iterations; on replan we
    // replace it with a freshly-minted receiver whose sender we've
    // stashed in `deps.approval_senders`.
    let mut current_approval_rx = approval_rx;
    let mut current_cancel = cancel;
    loop {
        // Phase 3 Step 7: if auto-approve is on and the run hasn't
        // tripped the ceiling, synthesize an approval and skip the
        // wait. The helper either:
        //   - returns `Synthesized(Approve(ids))` — the run has a
        //     decision without user input; we also drop the sender
        //     stash so a racing user click errors cleanly instead of
        //     landing on a dead receiver;
        //   - emits `AutoApproveSuspended` (once) and returns `Manual` —
        //     the run falls through to the normal wait path for this
        //     and every subsequent plan pass in the run.
        let decision = match try_auto_approve(&deps, &run, &run_id).await {
            AutoApproveOutcome::Synthesized(d) => {
                // Remove + drop the pending sender so a late
                // `approve_subtasks` / `reject_run` click surfaces
                // `WrongState` rather than racing the lifecycle.
                deps.approval_senders.lock().await.remove(&run_id);
                d
            }
            AutoApproveOutcome::Manual => tokio::select! {
                d = &mut current_approval_rx => match d {
                    Ok(d) => d,
                    // Sender dropped without deciding: treat as reject so
                    // the run doesn't hang. Only happens if the orchestrator
                    // is torn down; commands consume the sender.
                    Err(_) => ApprovalDecision::Reject,
                },
                _ = current_cancel.cancelled() => {
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
            },
        };

        match decision {
            ApprovalDecision::Reject => {
                finalize_rejected(&deps, &run).await;
                return;
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
                    safety_gate: deps.safety_gate.clone(),
                };

                // Inner dispatch/escalation loop. A `Fixed` / `Skipped`
                // resolution from the Layer-3 handler returns
                // `ResumeDispatch`, which wants us to re-enter
                // `run_dispatcher` without re-walking the approval
                // sheet; `continue` here achieves that. Only an
                // `AllDone` / `Failed` / `Cancelled` / `ResumeApproval`
                // / `Terminated` breaks out — the first three
                // terminate the run, the fourth falls back to the
                // outer approval loop.
                loop {
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
                            return;
                        }
                        DispatchOutcome::Failed { error } => {
                            finalize_failed(&deps, &run, error).await;
                            return;
                        }
                        DispatchOutcome::Cancelled => {
                            finalize_cancelled(&deps, &run, CancelReason::UserCancelled).await;
                            return;
                        }
                        DispatchOutcome::NeedsReplan {
                            failed_subtask_id,
                            kind,
                        } => {
                            // Layer-2: ask the master for a replacement plan.
                            // `do_replan_subtask` installs a fresh approval
                            // sender on success + resets the run's cancel
                            // token so the next dispatch pass can run
                            // cleanly. It emits all relevant events
                            // (ReplanStarted / SubtasksProposed /
                            // StatusChanged / HumanEscalation) itself.
                            match do_replan_subtask(
                                &deps,
                                &run,
                                master.as_ref(),
                                &run_id,
                                &task_text,
                                &repo_root,
                                &failed_subtask_id,
                                kind,
                            )
                            .await
                            {
                                ReplanOutcome::NewPlan => {
                                    // Reinstall a fresh approval oneshot for
                                    // the next iteration; refresh the cancel
                                    // token snapshot from the run (the helper
                                    // minted a new one).
                                    let (new_tx, new_rx) = oneshot::channel();
                                    deps.approval_senders
                                        .lock()
                                        .await
                                        .insert(run_id.clone(), new_tx);
                                    current_approval_rx = new_rx;
                                    current_cancel = run.read().await.cancel_token.clone();
                                    break; // back to outer approval loop
                                }
                                ReplanOutcome::Escalated {
                                    reason,
                                    subtask_id,
                                    kind,
                                } => {
                                    // Layer-3: hand off to the escalation
                                    // handler. It parks the run in
                                    // `AwaitingHumanFix`, waits on the
                                    // resolution channel, and either resumes
                                    // dispatch (Fixed / Skipped), loops back
                                    // to approval (ReplanRequested →
                                    // NewPlan), or finalizes (Aborted /
                                    // cancel / internal error).
                                    match handle_escalation(
                                        &deps,
                                        &run,
                                        master.as_ref(),
                                        &run_id,
                                        &task_text,
                                        &repo_root,
                                        subtask_id,
                                        reason,
                                        kind,
                                    )
                                    .await
                                    {
                                        EscalationResolved::ResumeDispatch => {
                                            // Fresh cancel token — the
                                            // dispatcher's `NeedsReplan`
                                            // path no longer fires cancel,
                                            // but `do_replan_subtask` may
                                            // have on a cycle-through, and
                                            // a defensive swap keeps the
                                            // next dispatcher pass clean.
                                            // `current_cancel` stays tied
                                            // to the approval-waiter path
                                            // and will be refreshed if we
                                            // ever break out to the outer
                                            // loop (via `ResumeApproval`).
                                            let fresh = CancellationToken::new();
                                            {
                                                let mut guard = run.write().await;
                                                guard.cancel_token = fresh;
                                                guard.status = RunStatus::Running;
                                            }
                                            if let Err(e) = deps
                                                .storage
                                                .update_run_status(
                                                    &run_id,
                                                    RunStatus::Running,
                                                )
                                                .await
                                            {
                                                finalize_failed(
                                                    &deps,
                                                    &run,
                                                    format!(
                                                        "update_run_status(running-after-resolve): {e}"
                                                    ),
                                                )
                                                .await;
                                                return;
                                            }
                                            deps.event_sink
                                                .emit(RunEvent::StatusChanged {
                                                    run_id: run_id.clone(),
                                                    status: RunStatus::Running,
                                                })
                                                .await;
                                            continue; // re-enter run_dispatcher
                                        }
                                        EscalationResolved::ResumeApproval(new_rx) => {
                                            current_approval_rx = new_rx;
                                            current_cancel =
                                                run.read().await.cancel_token.clone();
                                            break; // back to outer approval loop
                                        }
                                        EscalationResolved::Terminated => return,
                                    }
                                }
                                ReplanOutcome::Error(err) => {
                                    finalize_failed(&deps, &run, err).await;
                                    return;
                                }
                            }
                        }
                    }
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
    // Phase 4 Step 2: per-worker file counts re-projected from the
    // same diffs pass, kept in plan order to match the overlay's
    // attribution rows. Entries with zero files are included — the
    // overlay renders them as "0 files" (honest signal that the
    // worker ran but touched nothing).
    let mut per_worker_counts: Vec<(SubtaskId, u32)> =
        Vec::with_capacity(done_ids.len());
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
        // Phase 3.5 Item 6: emit a per-subtask diff *before* folding
        // into the aggregate. The UI uses this for the per-worker
        // "N files" chip + click-to-inspect popover; the aggregate
        // `DiffReady` still drives the final node. Always emit — an
        // empty `files` vec is a valid signal ("this worker ran but
        // touched nothing"), and keeps the frontend map in sync with
        // the set of done subtasks rather than silently skipping.
        let per_subtask_wire: Vec<IpcFileDiff> =
            diffs.iter().map(worktree_to_ipc_diff).collect();
        per_worker_counts.push((sub_id.clone(), per_subtask_wire.len() as u32));
        deps.event_sink
            .emit(RunEvent::SubtaskDiff {
                run_id: run_id.clone(),
                subtask_id: sub_id.clone(),
                files: per_subtask_wire,
            })
            .await;
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
                            &per_worker_counts,
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
        Err(WorktreeError::BaseBranchDirty { files }) => {
            // User's base branch has tracked WIP; `git merge` would
            // refuse to overwrite it. Symmetric with `MergeConflict`:
            // leave worktrees + branches intact, stash the error on
            // the run, emit a dedicated event the UI can turn into a
            // clean "commit or stash" prompt, and retry after the
            // next click.
            let summary = dirty_base_summary(&files);
            if let Err(e) = deps
                .storage
                .update_run_error(run_id, Some(&summary))
                .await
            {
                eprintln!("[orchestrator] update_run_error(dirty_base) failed: {e}");
            }
            deps.event_sink
                .emit(RunEvent::BaseBranchDirty {
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
///
/// Event ordering (invariant — Phase 4 Step 2):
///   `DiffReady` → `Completed` → `StatusChanged(Done)` → `ApplySummary`
///
/// `ApplySummary` is the last event in the run and carries the
/// re-projected merge outputs for the bottom-right overlay. Capturing
/// `branch` before the worktree cleanup is belt-and-braces — the
/// WorktreeManager's `base_branch` field is stable across cleanup,
/// but reading it up front keeps the emit free of any teardown
/// ordering assumptions.
#[allow(clippy::too_many_arguments)]
async fn finalize_applied(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
    run_id: &RunId,
    worktree_mgr: &Arc<WorktreeManager>,
    notes: &Arc<SharedNotes>,
    done_ids: &[SubtaskId],
    res: &MergeResult,
    per_worker_counts: &[(SubtaskId, u32)],
    started_at: chrono::DateTime<Utc>,
) {
    // Capture the base branch *before* cleanup so the wire payload
    // reflects the branch the merge actually landed on, independent
    // of any later mutation.
    let branch = worktree_mgr.base_branch().to_string();
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
    let files_changed = res.files_changed.len() as u32;
    let summary = RunSummary {
        run_id: run_id.clone(),
        subtask_count: done_ids.len() as u32,
        files_changed,
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
    deps.event_sink
        .emit(RunEvent::ApplySummary {
            run_id: run_id.clone(),
            commit_sha: res.commit_sha.clone(),
            branch,
            files_changed,
            per_worker: per_worker_counts.to_vec(),
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
        status: worktree_to_ipc_status(&fd.status),
        additions: fd.additions as u32,
        deletions: fd.deletions as u32,
        // Clone the patch body onto the wire. `FileDiff::patch` is
        // already the unified-diff output of `git diff base..HEAD --
        // <path>` — empty for `Binary` files, non-empty for every
        // other variant. The frontend feeds this straight into the
        // Shiki `diff` grammar in the popover; no post-processing on
        // this side.
        unified_diff: fd.patch.clone(),
    }
}

fn worktree_to_ipc_status(status: &WorktreeDiffStatus) -> IpcDiffStatus {
    match status {
        WorktreeDiffStatus::Added => IpcDiffStatus::Added,
        WorktreeDiffStatus::Modified => IpcDiffStatus::Modified,
        WorktreeDiffStatus::Deleted => IpcDiffStatus::Deleted,
        WorktreeDiffStatus::Renamed { from } => IpcDiffStatus::Renamed {
            from: from.to_string_lossy().into_owned(),
        },
        WorktreeDiffStatus::Binary => IpcDiffStatus::Binary,
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

fn dirty_base_summary(files: &[PathBuf]) -> String {
    let joined = files
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "base branch has {} uncommitted file(s): {joined}. Commit or stash, then retry.",
        files.len()
    )
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
        // Initial plan: every subtask is fresh, lineage is empty, so
        // `replan_count = 0` across the board. The wire-side default
        // already matches — no need to run `build_subtasks_wire` here
        // and take N storage round-trips for a known-zero answer.
        let proposed: Vec<SubtaskData> = runtimes.iter().map(SubtaskRuntime::to_data).collect();
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

/// Phase 3 Step 7: decide whether the lifecycle can skip the approval
/// sheet and synthesize an approval decision directly.
///
/// The bypass fires when *all* of the following hold:
///   - `Settings::auto_approve` is `true` at the moment of this call.
///   - The run hasn't already been suspended this session (a prior
///     plan pass hitting the ceiling latches [`Run::auto_approve_suspended`]
///     and never retries auto-approve for this run).
///   - Approving the current Proposed set wouldn't push
///     [`Run::auto_approved_count`] past
///     `Settings::max_subtasks_per_auto_approved_run`.
///
/// Emission contract:
///   - On synthesis: emits [`RunEvent::AutoApproved`] with the list of
///     approved ids. The approval `tokio::select!` is skipped; the
///     caller also drops the stashed sender so a racing user click
///     doesn't land on a dead receiver.
///   - On ceiling trip: emits [`RunEvent::AutoApproveSuspended`] with
///     `reason = "subtask_limit"` **exactly once** (the latched flag
///     prevents re-emission on later plan passes), then returns
///     [`AutoApproveOutcome::Manual`] so the normal approval wait
///     takes over.
///   - Disabled / already suspended / settings lock poisoned: returns
///     `Manual` silently — no emit, no state change.
///
/// A subtle case: if the settings snapshot fails (poisoned lock) we
/// conservatively stay manual so a lock panic doesn't quietly
/// auto-approve work the user never consented to.
async fn try_auto_approve(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
    run_id: &RunId,
) -> AutoApproveOutcome {
    let (enabled, max) = match deps.settings.snapshot() {
        Ok(s) => (s.auto_approve, s.max_subtasks_per_auto_approved_run),
        Err(_) => return AutoApproveOutcome::Manual,
    };
    if !enabled {
        return AutoApproveOutcome::Manual;
    }

    // Short-circuit if this run already tripped the ceiling — no re-
    // emit, and no re-walk of the subtasks vec.
    {
        let guard = run.read().await;
        if guard.auto_approve_suspended {
            return AutoApproveOutcome::Manual;
        }
    }

    let (eligible, total_after) = {
        let guard = run.read().await;
        let eligible: Vec<SubtaskId> = guard
            .subtasks
            .iter()
            .filter(|s| s.state == SubtaskState::Proposed)
            .map(|s| s.id.clone())
            .collect();
        let total_after = guard
            .auto_approved_count
            .saturating_add(eligible.len() as u32);
        (eligible, total_after)
    };

    // Defensive: a plan pass with zero Proposed rows shouldn't happen
    // (we're inside the approval wait because at least one row was
    // emitted) but if it ever did, synthesizing `Approve(empty)` would
    // flip every prior terminal row to Skipped through `record_approval`.
    // Stay manual instead so the user's approval sheet handles the
    // empty-plan edge cleanly.
    if eligible.is_empty() {
        return AutoApproveOutcome::Manual;
    }

    if total_after > max {
        // Latch the suspension flag before emitting so a caller that
        // ends up re-entering this helper (future refactor) doesn't
        // double-emit.
        {
            let mut guard = run.write().await;
            guard.auto_approve_suspended = true;
        }
        deps.event_sink
            .emit(RunEvent::AutoApproveSuspended {
                run_id: run_id.clone(),
                reason: "subtask_limit".into(),
            })
            .await;
        return AutoApproveOutcome::Manual;
    }

    {
        let mut guard = run.write().await;
        guard.auto_approved_count = total_after;
    }
    deps.event_sink
        .emit(RunEvent::AutoApproved {
            run_id: run_id.clone(),
            subtask_ids: eligible.clone(),
        })
        .await;
    AutoApproveOutcome::Synthesized(ApprovalDecision::Approve {
        subtask_ids: eligible,
    })
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
            } else if s.state == SubtaskState::Proposed {
                // Only skip still-proposed rows. On a Layer-2 replan
                // the runtime contains Done/Failed subtasks from the
                // prior dispatch pass; those are terminal and must
                // not be overwritten by a blanket "wasn't approved
                // this pass" skip.
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
                error_category: None,
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

// -- Layer-2 replan --------------------------------------------------

/// Run one Layer-2 replan pass.
///
/// Called from the approval/dispatch loop when the dispatcher returns
/// [`DispatchOutcome::NeedsReplan`]. Steps:
///   1. Emit `ReplanStarted` so the UI can flip the master chip.
///   2. Check the lineage cap (`count_replans_in_lineage >=
///      [`REPLAN_LINEAGE_CAP`]`) — if hit, emit `HumanEscalation` and
///      return [`ReplanOutcome::Escalated`].
///   3. Build a [`ReplanContext`] from the failed subtask's runtime
///      row, the worker log tail, and summaries of whatever
///      already-completed subtasks landed in the prior pass.
///   4. Call `master.replan`. An `Err` returns
///      [`ReplanOutcome::Error`]; an `Ok` with an empty `subtasks`
///      list means "infeasible" → emit `HumanEscalation` +
///      [`ReplanOutcome::Escalated`].
///   5. On success, assign fresh ids, persist new subtask rows,
///      insert dependency + replan lineage edges, append runtime
///      entries to [`Run::subtasks`] with `replaces = [failed_id]`,
///      reset the run's cancel token to a fresh one (the dispatcher
///      cancelled the previous one), re-emit `SubtasksProposed`,
///      transition back to `AwaitingApproval`, and return
///      [`ReplanOutcome::NewPlan`].
///
/// The helper does **not** install the approval sender — the caller
/// does that (it owns the receiver too, so they belong in the same
/// scope). The helper also does not wait on the approval; it just
/// transitions the run back to `AwaitingApproval` so the next loop
/// iteration blocks on the oneshot.
#[allow(clippy::too_many_arguments)]
async fn do_replan_subtask(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
    master: &dyn AgentImpl,
    run_id: &RunId,
    task_text: &str,
    repo_root: &std::path::Path,
    failed_subtask_id: &SubtaskId,
    kind: EscalateToMaster,
) -> ReplanOutcome {
    // 1. Emit ReplanStarted.
    deps.event_sink
        .emit(RunEvent::ReplanStarted {
            run_id: run_id.clone(),
            failed_subtask_id: failed_subtask_id.clone(),
        })
        .await;

    // 2. Lineage-cap check.
    let prior_replans = match deps
        .storage
        .count_replans_in_lineage(failed_subtask_id)
        .await
    {
        Ok(n) => n,
        Err(e) => {
            return ReplanOutcome::Error(format!("count_replans_in_lineage: {e}"));
        }
    };
    if prior_replans >= REPLAN_LINEAGE_CAP {
        let reason = format!(
            "retry budget exhausted: subtask already replanned {prior_replans} time(s) without success"
        );
        deps.event_sink
            .emit(RunEvent::HumanEscalation {
                run_id: run_id.clone(),
                subtask_id: failed_subtask_id.clone(),
                reason: reason.clone(),
                suggested_action: None,
            })
            .await;
        return ReplanOutcome::Escalated {
            reason,
            subtask_id: failed_subtask_id.clone(),
            kind: kind.clone(),
        };
    }

    // 3. Build ReplanContext from the current run state.
    let ctx = match build_replan_context(
        deps,
        run,
        task_text,
        repo_root,
        failed_subtask_id,
        &kind,
        prior_replans,
    )
    .await
    {
        Ok(c) => c,
        Err(e) => return ReplanOutcome::Error(e),
    };

    // 4. Call master.replan.
    //
    // The dispatcher's earlier `cancel.cancel()` already fired the
    // run's existing cancel token, so we must swap it for a fresh one
    // *before* awaiting the master — otherwise the master call would
    // short-circuit immediately. Do it now; if replan fails we still
    // want the fresh token in place for subsequent operations, and
    // the caller reads it from the run when reinstalling the
    // approval receiver.
    let fresh_cancel = CancellationToken::new();
    {
        let mut guard = run.write().await;
        guard.cancel_token = fresh_cancel.clone();
    }
    let plan_result = tokio::select! {
        p = master.replan(ctx, fresh_cancel.clone()) => p,
        _ = fresh_cancel.cancelled() => Err(AgentError::Cancelled),
    };

    let plan = match plan_result {
        Ok(p) => p,
        Err(AgentError::Cancelled) => {
            // User cancelled during the replan call. Fold the cancel
            // back into the run so the outer loop's cancel branch
            // catches it and finalizes.
            fresh_cancel.cancel();
            return ReplanOutcome::Error("replan cancelled".to_string());
        }
        Err(e) => {
            return ReplanOutcome::Error(format!("master.replan failed: {e}"));
        }
    };

    // 5. Handle empty plan (infeasible) vs new subtasks.
    if plan.subtasks.is_empty() {
        let reason = if plan.reasoning.trim().is_empty() {
            "master returned an empty replan (no path forward proposed)".to_string()
        } else {
            plan.reasoning.trim().to_string()
        };
        deps.event_sink
            .emit(RunEvent::HumanEscalation {
                run_id: run_id.clone(),
                subtask_id: failed_subtask_id.clone(),
                reason: reason.clone(),
                suggested_action: None,
            })
            .await;
        return ReplanOutcome::Escalated {
            reason,
            subtask_id: failed_subtask_id.clone(),
            kind,
        };
    }

    // 6. Persist the replacement subtasks + lineage edges, stamp
    // runtime rows, re-emit SubtasksProposed, transition to
    // AwaitingApproval.
    if let Err(e) = install_replacement_subtasks(deps, run, run_id, failed_subtask_id, &plan).await
    {
        return ReplanOutcome::Error(e);
    }

    ReplanOutcome::NewPlan
}

/// Assemble a [`ReplanContext`] from the failed subtask's row, the
/// dispatcher's escalation signal, the worker log tail (from storage),
/// and summaries of already-completed subtasks.
#[allow(clippy::too_many_arguments)]
async fn build_replan_context(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
    task_text: &str,
    repo_root: &std::path::Path,
    failed_subtask_id: &SubtaskId,
    kind: &EscalateToMaster,
    prior_replans: u32,
) -> Result<ReplanContext, String> {
    // Snapshot the failed subtask + completed-subtask summaries from
    // the run under a read lock, then release before any async storage
    // work. Holding the lock across `.await` would serialize every
    // replan with every read in the run.
    let (failed_title, failed_why, completed_summaries) = {
        let guard = run.read().await;
        let failed = guard
            .find_subtask(failed_subtask_id)
            .ok_or_else(|| format!("failed subtask {failed_subtask_id} not found in run"))?;
        let title = failed.data.title.clone();
        let why = failed.data.why.clone();
        let summaries: Vec<String> = guard
            .subtasks
            .iter()
            .filter(|s| s.is_done())
            .map(|s| format!("{}: {}", s.data.title, s.data.why))
            .collect();
        (title, why, summaries)
    };

    // Fetch the worker log from storage and slice the tail.
    let all_logs = deps
        .storage
        .get_subtask_logs(failed_subtask_id)
        .await
        .map_err(|e| format!("get_subtask_logs: {e}"))?;
    let start = all_logs.len().saturating_sub(REPLAN_LOG_TAIL_LINES);
    let worker_log_tail: String = all_logs[start..]
        .iter()
        .map(|l| l.line.clone())
        .collect::<Vec<_>>()
        .join("\n");

    // Attempt-error history. For Exhausted we ideally have both
    // attempts; the first-attempt error was emitted as a log line
    // prefixed with "[whalecode] retry: ..." by the retry ladder.
    // Extract it if present so the master sees the full picture;
    // otherwise pass only the most recent error.
    let retry_marker = "[whalecode] retry: ";
    let first_attempt_err: Option<String> = all_logs
        .iter()
        .map(|l| l.line.as_str())
        .find(|line| line.starts_with(retry_marker))
        .map(|line| line[retry_marker.len()..].to_string());
    let most_recent_err = escalate_error_text(kind);
    let mut attempt_errors = Vec::new();
    if let Some(first) = first_attempt_err {
        attempt_errors.push(first);
    }
    attempt_errors.push(most_recent_err);

    // Available workers — same allow-list as initial plan.
    let available_workers = deps.registry.available().await;
    let _ = repo_root; // repo_root is carried for future use (master
                       // may re-scan the tree); currently unused by the
                       // replan prompt templates.

    Ok(ReplanContext {
        original_task: task_text.to_string(),
        repo_root: repo_root.to_path_buf(),
        failed_subtask_title: failed_title,
        failed_subtask_why: failed_why,
        attempt_errors,
        worker_log_tail,
        completed_subtask_summaries: completed_summaries,
        // `attempt_counter` in the prompt is "this replan's index in
        // the lineage, 1-based". The storage count is how many replans
        // already fired (before this one), so add one.
        attempt_counter: prior_replans + 1,
        available_workers,
    })
}

/// Append the master's replacement subtasks to the runtime + SQLite,
/// record `subtask_replans` lineage edges, re-emit `SubtasksProposed`,
/// and flip the run back to `AwaitingApproval`.
async fn install_replacement_subtasks(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
    run_id: &RunId,
    failed_subtask_id: &SubtaskId,
    plan: &Plan,
) -> Result<(), String> {
    // Assign fresh ids up-front so intra-batch dependency indices
    // resolve cleanly under the write lock.
    let new_ids: Vec<SubtaskId> = (0..plan.subtasks.len())
        .map(|_| ulid_subtask_id())
        .collect();

    let (storage_inserts, deps_edges, lineage_edges) = {
        let mut guard = run.write().await;
        let mut inserts = Vec::with_capacity(plan.subtasks.len());
        let mut dep_edges = Vec::new();
        let mut lineage = Vec::with_capacity(plan.subtasks.len());
        for (i, ps) in plan.subtasks.iter().enumerate() {
            let dep_ids: Vec<SubtaskId> = ps
                .dependencies
                .iter()
                .filter_map(|idx| new_ids.get(*idx).cloned())
                .collect();
            for d in &dep_ids {
                dep_edges.push((new_ids[i].clone(), d.clone()));
            }
            lineage.push((failed_subtask_id.clone(), new_ids[i].clone()));
            let runtime = SubtaskRuntime::new_replacement(
                new_ids[i].clone(),
                ps.clone(),
                dep_ids,
                vec![failed_subtask_id.clone()],
            );
            inserts.push(NewSubtask {
                id: new_ids[i].clone(),
                run_id: run_id.clone(),
                title: runtime.data.title.clone(),
                why: Some(runtime.data.why.clone()).filter(|w| !w.is_empty()),
                assigned_worker: runtime.data.assigned_worker,
                state: SubtaskState::Proposed,
            });
            guard.subtasks.push(runtime);
        }
        // Flip status before dropping the lock so a racing read sees
        // AwaitingApproval rather than a transient Running.
        guard.status = RunStatus::AwaitingApproval;
        (inserts, dep_edges, lineage)
    };

    for row in &storage_inserts {
        deps.storage
            .insert_subtask(row)
            .await
            .map_err(|e| format!("insert_subtask: {e}"))?;
    }
    for (child, parent) in &deps_edges {
        deps.storage
            .insert_dependency(child, parent)
            .await
            .map_err(|e| format!("insert_dependency: {e}"))?;
    }
    for (original, replacement) in &lineage_edges {
        deps.storage
            .insert_replan(
                original,
                replacement,
                Some(plan.reasoning.trim())
                    .filter(|s| !s.is_empty()),
            )
            .await
            .map_err(|e| format!("insert_replan: {e}"))?;
    }

    deps.storage
        .update_run_status(run_id, RunStatus::AwaitingApproval)
        .await
        .map_err(|e| format!("update_run_status: {e}"))?;

    // Build the wire payload *after* inserting the lineage edges so
    // the freshly-installed replacements show `replan_count >= 1`.
    let proposed_wire = {
        let guard = run.read().await;
        build_subtasks_wire(&deps.storage, &guard.subtasks).await
    };

    deps.event_sink
        .emit(RunEvent::SubtasksProposed {
            run_id: run_id.clone(),
            subtasks: proposed_wire,
        })
        .await;
    deps.event_sink
        .emit(RunEvent::StatusChanged {
            run_id: run_id.clone(),
            status: RunStatus::AwaitingApproval,
        })
        .await;
    Ok(())
}

// -- Layer-3 escalation ---------------------------------------------

/// What `handle_escalation` returns to the approval-loop caller once
/// the parked run has a resolution in hand. Distinct from
/// [`ReplanOutcome`] because the shapes of the continuations differ:
/// Layer-2 either retries approval or escalates; Layer-3 either
/// re-enters the dispatcher, rewinds to approval, or has already
/// finalized.
enum EscalationResolved {
    /// `Fixed` / `Skipped`: subtask state updated in memory + SQLite,
    /// event emitted, `escalated_subtask_ids` cleared. The run is no
    /// longer parked but is *not* yet ready to merge — any
    /// previously-Waiting dependents of the fixed-or-skipped subtask
    /// may now be eligible. The caller swaps a fresh cancel token
    /// into the run (the old one may have been cancelled by the
    /// dispatcher's failure path) and re-enters `run_dispatcher` so
    /// dependents get their chance. Only after the second dispatcher
    /// pass comes back `AllDone` do we transition to Merging.
    ResumeDispatch,
    /// `ReplanRequested` → [`ReplanOutcome::NewPlan`]: the master
    /// produced replacement subtasks, `install_replacement_subtasks`
    /// flipped status to `AwaitingApproval`, and a fresh approval
    /// sender is in the orchestrator's map. The caller resumes the
    /// approval loop with the paired receiver.
    ResumeApproval(oneshot::Receiver<ApprovalDecision>),
    /// `Aborted`, the run's cancel token fired during park, or an
    /// internal error (storage write, replan crash). The helper has
    /// already called `finalize_cancelled` / `finalize_failed`; the
    /// caller just returns.
    Terminated,
}

/// Park the run on the Layer-3 resolution channel and process the
/// resolution when it arrives. Looping because a `ReplanRequested`
/// decision may itself re-escalate (master still judges the goal
/// infeasible); each cycle re-parks with the new escalation's
/// `subtask_id` + `kind`.
///
/// Event sequence for one park pass (shown for `Fixed` resolution):
///
/// ```text
///   StatusChanged{AwaitingHumanFix}      ← from here
///   (wait on resolution_rx or cancel)
///   SubtaskStateChanged{Fixed sid → Done}
///   (returns ResumeDispatch; caller re-enters run_dispatcher)
/// ```
///
/// `HumanEscalation` itself is emitted by `do_replan_subtask`
/// *before* returning `ReplanOutcome::Escalated`, so by the time this
/// function runs the frontend has already flipped the UI into "human
/// escalation" mode. Entering here is pure lifecycle bookkeeping:
/// flip the status, stamp `escalated_subtask_ids`, and wait.
#[allow(clippy::too_many_arguments)]
async fn handle_escalation(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
    master: &dyn AgentImpl,
    run_id: &RunId,
    task_text: &str,
    repo_root: &std::path::Path,
    initial_subtask_id: SubtaskId,
    initial_reason: String,
    initial_kind: EscalateToMaster,
) -> EscalationResolved {
    // Loop variables — updated when a `ReplanRequested` yields another
    // `Escalated` (master still can't find a path). Each re-park uses
    // the fresh escalation's subtask id / kind so the next
    // `ReplanRequested` dispatches the right replan context.
    let mut subtask_id = initial_subtask_id;
    let mut kind = initial_kind;
    let mut reason = initial_reason;

    loop {
        // Park: flip to `AwaitingHumanFix`, stamp the escalated id,
        // persist + emit StatusChanged, re-read the run's cancel token
        // (may have been replaced by a prior `do_replan_subtask` pass).
        let cancel = {
            let mut guard = run.write().await;
            guard.status = RunStatus::AwaitingHumanFix;
            guard.escalated_subtask_ids = vec![subtask_id.clone()];
            guard.cancel_token.clone()
        };
        if let Err(e) = deps
            .storage
            .update_run_status(run_id, RunStatus::AwaitingHumanFix)
            .await
        {
            finalize_failed(
                deps,
                run,
                format!("update_run_status(awaiting-human-fix): {e}"),
            )
            .await;
            return EscalationResolved::Terminated;
        }
        deps.event_sink
            .emit(RunEvent::StatusChanged {
                run_id: run_id.clone(),
                status: RunStatus::AwaitingHumanFix,
            })
            .await;
        deps.event_sink
            .emit(RunEvent::MasterLog {
                run_id: run_id.clone(),
                line: format!("parked on human escalation: {}", reason.as_str()),
            })
            .await;

        // Install a resolution sender. Overwrites any stale entry from
        // a prior park in this same run (cycling re-escalations); the
        // four IPC commands (commit 2b) remove the entry when they
        // consume the sender, so a normal flow never sees a stale one.
        let (tx, mut rx) = oneshot::channel::<Layer3Decision>();
        deps.resolution_senders
            .lock()
            .await
            .insert(run_id.clone(), tx);

        let decision = tokio::select! {
            d = &mut rx => match d {
                Ok(d) => d,
                // Sender dropped without deciding — can only happen if
                // someone evicts the entry out-of-band (not in Commit
                // 2b's flow). Treat as Abort so the run doesn't hang.
                Err(_) => Layer3Decision::Aborted,
            },
            _ = cancel.cancelled() => {
                // External cancel during park. Clear the marker so
                // `finalize_cancelled`'s terminal view isn't a run that
                // still advertises an escalation.
                {
                    let mut guard = run.write().await;
                    guard.escalated_subtask_ids.clear();
                }
                // `finalize_cancelled` handles cleanup + terminal event.
                finalize_cancelled(deps, run, CancelReason::UserCancelled).await;
                return EscalationResolved::Terminated;
            }
        };

        match decision {
            Layer3Decision::Fixed(sid) => {
                if let Err(e) = resolve_fixed(deps, run, run_id, &sid).await {
                    finalize_failed(deps, run, e).await;
                    return EscalationResolved::Terminated;
                }
                return EscalationResolved::ResumeDispatch;
            }
            Layer3Decision::Skipped(sids) => {
                if let Err(e) = resolve_skipped(deps, run, run_id, &sids).await {
                    finalize_failed(deps, run, e).await;
                    return EscalationResolved::Terminated;
                }
                return EscalationResolved::ResumeDispatch;
            }
            Layer3Decision::Aborted => {
                // Fire the run's cancel token so any surviving workers
                // (there shouldn't be any — the dispatcher drained
                // before `NeedsReplan`) and any hanging awaits notice.
                // Then drop through to `finalize_cancelled`; the
                // terminal sequence is identical to an external cancel
                // so the UI doesn't care which path got us here.
                let token = {
                    let mut guard = run.write().await;
                    guard.escalated_subtask_ids.clear();
                    guard.cancel_token.clone()
                };
                token.cancel();
                finalize_cancelled(deps, run, CancelReason::UserCancelled).await;
                return EscalationResolved::Terminated;
            }
            Layer3Decision::ReplanRequested(sid) => {
                // Human granted another replan attempt. Flip back to
                // Planning so the UI chip reflects "master thinking"
                // instead of "awaiting human" while the call is in
                // flight; `install_replacement_subtasks` will transition
                // to `AwaitingApproval` on success, or we'll re-park
                // into `AwaitingHumanFix` on another Escalated.
                {
                    let mut guard = run.write().await;
                    guard.status = RunStatus::Planning;
                    guard.escalated_subtask_ids.clear();
                }
                if let Err(e) = deps
                    .storage
                    .update_run_status(run_id, RunStatus::Planning)
                    .await
                {
                    finalize_failed(
                        deps,
                        run,
                        format!("update_run_status(planning): {e}"),
                    )
                    .await;
                    return EscalationResolved::Terminated;
                }
                deps.event_sink
                    .emit(RunEvent::StatusChanged {
                        run_id: run_id.clone(),
                        status: RunStatus::Planning,
                    })
                    .await;

                match do_replan_subtask(
                    deps,
                    run,
                    master,
                    run_id,
                    task_text,
                    repo_root,
                    &sid,
                    kind.clone(),
                )
                .await
                {
                    ReplanOutcome::NewPlan => {
                        let (new_tx, new_rx) = oneshot::channel();
                        deps.approval_senders
                            .lock()
                            .await
                            .insert(run_id.clone(), new_tx);
                        return EscalationResolved::ResumeApproval(new_rx);
                    }
                    ReplanOutcome::Escalated {
                        reason: new_reason,
                        subtask_id: new_sid,
                        kind: new_kind,
                    } => {
                        // `HumanEscalation` already re-emitted by
                        // `do_replan_subtask`. Loop and re-park on the
                        // new escalation's subtask id.
                        subtask_id = new_sid;
                        kind = new_kind;
                        reason = new_reason;
                        continue;
                    }
                    ReplanOutcome::Error(err) => {
                        finalize_failed(deps, run, err).await;
                        return EscalationResolved::Terminated;
                    }
                }
            }
        }
    }
}

/// Apply a `Fixed(sid)` resolution:
///
/// 1. Stage + commit any changes the user left in the escalated
///    subtask's worktree. An already-clean worktree (user decided the
///    existing work was fine) is treated as a successful no-op —
///    nothing wrong with a zero-diff fix. A failing git invocation
///    fails the whole run (same contract as the dispatcher's
///    `commit_worker_changes`): silent zero-diff at merge time is
///    worse than a loud failure here.
/// 2. Flip the subtask's in-memory + storage state to `Done` and
///    emit `SubtaskStateChanged`.
/// 3. Clear the escalation marker.
///
/// Does NOT transition the run status — the caller (`run_lifecycle`)
/// re-enters the dispatcher and that pass flips back to Running /
/// Merging as dependents progress.
async fn resolve_fixed(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
    run_id: &RunId,
    sid: &SubtaskId,
) -> Result<(), String> {
    // Snapshot the worktree path + title under a short read lock.
    let (worktree_path, subtask_title) = {
        let guard = run.read().await;
        let s = guard
            .find_subtask(sid)
            .ok_or_else(|| format!("fixed subtask {sid} not found in run"))?;
        let wt = s
            .worktree_path
            .clone()
            .ok_or_else(|| format!("fixed subtask {sid} has no worktree path"))?;
        (wt, s.data.title.clone())
    };

    commit_manual_fix(&worktree_path, &subtask_title, run_id)
        .await
        .map_err(|e| format!("manual-fix commit: {e}"))?;

    {
        let mut guard = run.write().await;
        guard.escalated_subtask_ids.clear();
        match guard.subtasks.iter_mut().find(|s| &s.id == sid) {
            Some(s) => s.mark_done(),
            None => return Err(format!("fixed subtask {sid} not found in run")),
        }
    }
    deps.storage
        .update_subtask_state(sid, SubtaskState::Done, None)
        .await
        .map_err(|e| format!("update_subtask_state(done): {e}"))?;
    deps.event_sink
        .emit(RunEvent::SubtaskStateChanged {
            run_id: run_id.clone(),
            subtask_id: sid.clone(),
            state: SubtaskState::Done,
            error_category: None,
        })
        .await;
    Ok(())
}

/// Stage and commit any changes the user left in the escalated
/// subtask's worktree. Mirrors the dispatcher's
/// `commit_worker_changes` but with a "manual fix" commit message so
/// the merged history distinguishes agent-authored commits from
/// user-authored resolutions. An already-clean worktree is a
/// legitimate no-op — returns `Ok(())` without creating a commit.
async fn commit_manual_fix(
    worktree_path: &std::path::Path,
    subtask_title: &str,
    run_id: &RunId,
) -> Result<(), String> {
    let status = tokio::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(worktree_path)
        .output()
        .await
        .map_err(|e| format!("git status: {e}"))?;
    if !status.status.success() {
        return Err(format!(
            "git status failed: {}",
            String::from_utf8_lossy(&status.stderr).trim()
        ));
    }
    if status.stdout.iter().all(|b| b.is_ascii_whitespace()) {
        // Clean worktree: user asserted the existing state is correct.
        return Ok(());
    }

    let add = tokio::process::Command::new("git")
        .args(["add", "-A"])
        .current_dir(worktree_path)
        .output()
        .await
        .map_err(|e| format!("git add: {e}"))?;
    if !add.status.success() {
        return Err(format!(
            "git add failed: {}",
            String::from_utf8_lossy(&add.stderr).trim()
        ));
    }

    let message = format!(
        "whalecode: manual fix for {subtask_title}\n\nApplied by the user during Layer-3 escalation for run {run_id}."
    );
    let commit = tokio::process::Command::new("git")
        .args(["commit", "-m", &message])
        .env("GIT_AUTHOR_NAME", "WhaleCode")
        .env("GIT_AUTHOR_EMAIL", "whalecode@local")
        .env("GIT_COMMITTER_NAME", "WhaleCode")
        .env("GIT_COMMITTER_EMAIL", "whalecode@local")
        .current_dir(worktree_path)
        .output()
        .await
        .map_err(|e| format!("git commit: {e}"))?;
    if !commit.status.success() {
        return Err(format!(
            "git commit failed: {}",
            String::from_utf8_lossy(&commit.stderr).trim()
        ));
    }
    Ok(())
}

/// Apply a `Skipped(sids)` resolution: flip every listed subtask's
/// state to Skipped (no-op if already terminal-Skipped), persist +
/// emit per change, clear the escalation marker. The caller
/// transitions the run to Merging.
async fn resolve_skipped(
    deps: &LifecycleDeps,
    run: &Arc<RwLock<Run>>,
    run_id: &RunId,
    sids: &[SubtaskId],
) -> Result<(), String> {
    let mut changed: Vec<SubtaskId> = Vec::new();
    {
        let mut guard = run.write().await;
        guard.escalated_subtask_ids.clear();
        for sid in sids {
            if let Some(s) = guard.subtasks.iter_mut().find(|x| &x.id == sid) {
                if !matches!(s.state, SubtaskState::Skipped) {
                    s.mark_skipped();
                    changed.push(sid.clone());
                }
            }
        }
    }
    for sid in &changed {
        deps.storage
            .update_subtask_state(sid, SubtaskState::Skipped, None)
            .await
            .map_err(|e| format!("update_subtask_state(skipped, {sid}): {e}"))?;
        deps.event_sink
            .emit(RunEvent::SubtaskStateChanged {
                run_id: run_id.clone(),
                subtask_id: sid.clone(),
                state: SubtaskState::Skipped,
                error_category: None,
            })
            .await;
    }
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

fn ulid_subtask_id() -> SubtaskId {
    // Reuse ULID for subtask ids too: sortable + globally unique,
    // matches run ids, and distinguishes a specific subtask across
    // retries (Phase 3 may re-dispatch with a fresh id).
    ulid::Ulid::new().to_string()
}

/// Build the wire `Vec<SubtaskData>` from the runtime rows, stamping
/// each entry's `replan_count` with the storage-derived lineage
/// depth. Used at every `SubtasksProposed` emit site so the frontend
/// knows whether to offer the "Try replan again" action — the button
/// must disappear once the lineage cap is reached. N storage hits
/// per emit; N is small (plan sizes are in the single digits).
///
/// An error from storage is logged but does not block the emit — we
/// fall back to `to_data()` (replan_count = 0) so the user at least
/// sees the plan even if the lineage query fails.
pub(crate) async fn build_subtasks_wire(
    storage: &Storage,
    subtasks: &[SubtaskRuntime],
) -> Vec<SubtaskData> {
    let mut out = Vec::with_capacity(subtasks.len());
    for s in subtasks {
        match storage.count_replans_in_lineage(&s.id).await {
            Ok(n) => out.push(s.to_data_with_replan_count(n)),
            Err(e) => {
                eprintln!(
                    "[orchestrator] count_replans_in_lineage({}) failed: {e}; \
                     defaulting replan_count to 0",
                    s.id
                );
                out.push(s.to_data());
            }
        }
    }
    out
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
