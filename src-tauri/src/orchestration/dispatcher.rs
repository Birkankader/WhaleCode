//! Worker scheduling for an approved [`Run`].
//!
//! The dispatcher owns the "execute" phase end-to-end: from the moment
//! approved subtasks should start running through to every one of them
//! reaching a terminal state. It is called once per run and returns a
//! [`DispatchOutcome`] that the lifecycle turns into the next status
//! transition (Merging / Failed / Cancelled).
//!
//! Shape:
//! 1. Cascade-skip any subtask whose deps were already Skipped/Failed
//!    (e.g. an approved child of an un-approved parent).
//! 2. Pre-resolve one [`AgentImpl`] per unique worker kind so each
//!    spawn is just an `Arc::clone`.
//! 3. Flip approved subtasks Proposed → Waiting (persisted + emitted).
//! 4. Main loop:
//!      - Pick ready subtasks (`Waiting`, all deps `Done`, not in
//!        flight), spawn up to `max_concurrent` workers.
//!      - `tokio::select!` on `join_set.join_next()` vs
//!        `cancel.cancelled()`.
//!      - Worker `Done` → persist, emit, append notes, maybe consolidate.
//!      - Worker `Failed` → fail-fast the whole run.
//!      - Worker `Cancelled` → drain the rest and return `Cancelled`.
//!      - Re-cascade between iterations so a newly failed/skipped
//!        subtask propagates to its waiting dependents.
//! 5. Exit when every subtask is terminal.
//!
//! Locking discipline mirrors the rest of the orchestration module:
//! the per-run `RwLock` is acquired only to read or mutate the `Run`
//! struct; every `await` on storage, event emission, worker execution,
//! or notes I/O happens with the lock released. This keeps workers
//! progressing in parallel — a slow storage write can't freeze the
//! other workers' state transitions.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::Command as TokioCommand;
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

/// Overall budget for `drain_as_skipped` to finish awaiting in-flight
/// workers after a fail-fast / cancel. Workers that honour the cancel
/// token finish in milliseconds once `run_streaming` sees the kill;
/// the deadline is a backstop for the case where a worker wedges on
/// post-kill I/O despite the group kill in `agents/process.rs`. Hitting
/// the deadline triggers `join_set.abort_all()` so the run can still
/// reach its terminal status.
const DRAIN_DEADLINE: Duration = Duration::from_secs(2);

use crate::agents::{AgentError, AgentImpl, ExecutionResult};
use crate::ipc::events::ErrorCategoryWire;
use crate::ipc::{AgentKind, RunId, SubtaskId, SubtaskState};
use crate::orchestration::events::{EventSink, RunEvent};
use crate::orchestration::notes::{SharedNotes, CONSOLIDATE_THRESHOLD_BYTES};
use crate::orchestration::registry::AgentRegistry;
use crate::orchestration::run::{Run, SubtaskRuntime};
use crate::storage::models::Subtask;
use crate::storage::Storage;
use crate::worktree::WorktreeManager;

/// Terminal outcome of a dispatch attempt.
#[derive(Debug)]
pub enum DispatchOutcome {
    /// Every approved subtask ended in `Done` (or was validly
    /// Skipped). Lifecycle should transition to Merging.
    AllDone,
    /// At least one subtask failed and we aborted the rest. The run
    /// should transition to Failed.
    Failed { error: String },
    /// The run's cancel token fired; any in-flight workers have been
    /// awaited out. Lifecycle finalizes to Cancelled.
    Cancelled,
    /// A subtask escalated past Layer 1 (retry exhausted or a
    /// deterministic failure that skipped retry). The failed subtask
    /// has been marked Failed in storage + emitted; any other
    /// in-flight workers were drained (skipped) before returning.
    /// The lifecycle decides what happens next: either invoke
    /// Layer 2 (`Orchestrator::replan_subtask`) or, if the failed
    /// subtask's lineage already burned two replans, surface Layer 3
    /// (`HumanEscalation` + `Failed`).
    ///
    /// `kind` carries the original `EscalateToMaster` signal so the
    /// lifecycle's replan helper can fold the error into the prompt
    /// for the master. Distinct from `Failed` so the lifecycle can
    /// branch on it without parsing error strings.
    NeedsReplan {
        failed_subtask_id: SubtaskId,
        kind: EscalateToMaster,
    },
}

/// Bundle the dispatcher pulls state + sinks from. Mirrors
/// [`crate::orchestration::lifecycle::LifecycleDeps`] deliberately —
/// the lifecycle hands its own fields straight through.
pub struct DispatcherDeps {
    pub storage: Arc<Storage>,
    pub event_sink: Arc<dyn EventSink>,
    pub registry: Arc<dyn AgentRegistry>,
    /// Phase 3 Step 7 integration seam. The dispatcher consults this
    /// before invoking worker-level actions that Phase 7 will police
    /// (file writes / deletes / shell invocations). Today it always
    /// returns `true`; the seam is the point.
    pub safety_gate: Arc<crate::safety::SafetyGate>,
}

#[derive(Debug)]
enum WorkerOutcome {
    Done(ExecutionResult),
    /// Hard failure the dispatcher can't re-plan its way out of
    /// (setup error, panic, commit failure after a successful
    /// execute). Run should transition to Failed.
    Failed(String),
    Cancelled,
    /// Layer-1 retry is exhausted or the failure was deterministic —
    /// carries the original `EscalateToMaster` so the main loop can
    /// return `DispatchOutcome::NeedsReplan` and the lifecycle can
    /// feed the error into the master's replan prompt.
    Escalate(EscalateToMaster),
}

/// Layer-1 escalation signal. Produced by [`execute_subtask_with_retry`]
/// when the worker failed and can't recover locally; the dispatcher
/// maps it onto [`WorkerOutcome::Failed`] / [`WorkerOutcome::Cancelled`]
/// for Phase 2's fail-fast behaviour. Phase 4 (master re-plan) will
/// branch on the discriminant to route `Exhausted` / `Deterministic`
/// into Layer 2 while still short-circuiting `UserCancelled` — the
/// variant split is deliberately coarse-grained so the retry function
/// stays a stable contract across phases.
#[derive(Debug, Clone)]
#[allow(dead_code)] // Fields inspected in Step 4 (Layer 2 routing).
pub enum EscalateToMaster {
    /// Cancellation came from outside (user, run token). No retry
    /// happened; no Layer 2 will happen. The dispatcher's cancel path
    /// handles cleanup.
    UserCancelled,
    /// Retry would deterministically fail (e.g. `SpawnFailed`). Layer
    /// 1 was skipped; Layer 2 should pick this up directly.
    Deterministic(AgentError),
    /// Layer 1 ran and both attempts failed. The second (retry)
    /// failure is the one carried here — most recent, most diagnostic.
    Exhausted(AgentError),
}

impl EscalateToMaster {
    fn cancelled() -> Self {
        Self::UserCancelled
    }
    fn deterministic(err: AgentError) -> Self {
        Self::Deterministic(err)
    }
    fn exhausted(err: AgentError) -> Self {
        Self::Exhausted(err)
    }
}

/// Log-stream marker the frontend treats as a "retry" visual
/// separator. Kept as a reserved prefix (no new IPC field) so
/// existing log plumbing carries it end-to-end without a schema
/// change. See `WorkerNode` log rendering.
const RETRY_LOG_MARKER: &str = "[whalecode] retry";

/// Layer-1 retry ladder for one subtask.
///
/// Runs `agent.execute` up to twice:
///   * Attempt 1 with `extra_context: None`.
///   * If the error is retryable (anything except `Cancelled` and
///     `SpawnFailed`), persist + emit `SubtaskState::Retrying`, then
///     attempt 2 with the first error folded into `extra_context`.
///   * On retry success, persist + emit `SubtaskState::Running`; the
///     worker path then follows its normal `Done` transition.
///   * On retry failure, persist + emit `SubtaskState::Failed` and
///     surface `EscalateToMaster::Exhausted` so the dispatcher can
///     fail-fast the run (Phase 2 behaviour preserved until Step 4).
///
/// Phase 3 Decision 2: the retry count lives on the frontend
/// (`graphStore.subtaskRetryCounts`, bumped by the `Retrying` event).
/// This function does not manage an attempt counter of its own — it
/// is hard-coded to "one retry", matching phase-3-spec.md §3d.
#[allow(clippy::too_many_arguments)]
async fn execute_subtask_with_retry(
    storage: &Storage,
    event_sink: &dyn EventSink,
    run_id: &RunId,
    subtask_row: &Subtask,
    agent: &dyn AgentImpl,
    worktree_path: &Path,
    shared_notes: &str,
    log_tx: mpsc::Sender<String>,
    cancel: CancellationToken,
) -> Result<ExecutionResult, EscalateToMaster> {
    // Attempt 1: no retry context, behaves exactly like Phase 2.
    let first = agent
        .execute(
            subtask_row,
            worktree_path,
            shared_notes,
            None,
            log_tx.clone(),
            cancel.clone(),
        )
        .await;
    let err = match first {
        Ok(result) => return Ok(result),
        // Cancellation short-circuits Layer 1 — user intent wins.
        Err(AgentError::Cancelled) => return Err(EscalateToMaster::cancelled()),
        // Deterministic failures (binary missing, permission error)
        // skip Layer 1 and escalate straight to Layer 2 — retrying
        // only burns time without changing the outcome.
        Err(e @ AgentError::SpawnFailed { .. }) => {
            return Err(EscalateToMaster::deterministic(e))
        }
        Err(e) => e,
    };

    let prev_err = format!("{err}");

    // Transition Running -> Retrying (persisted + emitted). Frontend
    // bridge sees `Retrying` and sends `START_RETRY` to the node
    // machine; `subtaskRetryCounts` increments exactly once per emit.
    if let Err(e) = storage
        .update_subtask_state(&subtask_row.id, SubtaskState::Retrying, None)
        .await
    {
        eprintln!(
            "[dispatcher] update_subtask_state(retrying, {}) failed: {e}",
            subtask_row.id
        );
    }
    event_sink
        .emit(RunEvent::SubtaskStateChanged {
            run_id: run_id.clone(),
            subtask_id: subtask_row.id.clone(),
            state: SubtaskState::Retrying,
            error_category: None,
        })
        .await;

    // Log separator — the frontend's WorkerNode renders a thin rule
    // when it sees this marker so the user can see the boundary
    // between attempts. Prefix is reserved, see RETRY_LOG_MARKER.
    let separator = format!("{RETRY_LOG_MARKER}: {prev_err}");
    let _ = storage.append_log(&subtask_row.id, &separator).await;
    event_sink
        .emit(RunEvent::SubtaskLog {
            run_id: run_id.clone(),
            subtask_id: subtask_row.id.clone(),
            line: separator,
        })
        .await;

    // Attempt 2: previous error folded into the prompt.
    let retry_context = format!(
        "Previous attempt failed with: {prev_err}\n\nPlease retry with awareness of the above error."
    );
    let retry = agent
        .execute(
            subtask_row,
            worktree_path,
            shared_notes,
            Some(&retry_context),
            log_tx,
            cancel,
        )
        .await;

    match retry {
        Ok(result) => {
            // Flip Retrying -> Running so the frontend (and the rest
            // of the dispatcher) sees the normal "worker executing"
            // state again. `on_worker_done` will take it to Done.
            if let Err(e) = storage
                .update_subtask_state(&subtask_row.id, SubtaskState::Running, None)
                .await
            {
                eprintln!(
                    "[dispatcher] update_subtask_state(running-after-retry, {}) failed: {e}",
                    subtask_row.id
                );
            }
            event_sink
                .emit(RunEvent::SubtaskStateChanged {
                    run_id: run_id.clone(),
                    subtask_id: subtask_row.id.clone(),
                    state: SubtaskState::Running,
                    error_category: None,
                })
                .await;
            Ok(result)
        }
        // Retry cancelled — treat like first-attempt cancellation
        // so the dispatcher drains cleanly. We do *not* emit
        // `Failed`; cancellation is not a retry outcome.
        Err(AgentError::Cancelled) => Err(EscalateToMaster::cancelled()),
        Err(e) => {
            // Leave the subtask in the transient `Retrying` state in
            // storage and do *not* emit `Failed` here — the dispatcher
            // owns the terminal transition (it also stamps `finished_at`
            // on the in-memory `SubtaskRuntime` and cascades the fail-
            // fast to the rest of the run). This keeps the event
            // sequence Retrying → Failed with exactly one `Failed` emit.
            Err(EscalateToMaster::exhausted(e))
        }
    }
}

/// Entry point. Blocks until every subtask is terminal, the run is
/// cancelled, or the first subtask fails (fail-fast).
pub async fn run_dispatcher(
    deps: &DispatcherDeps,
    run: Arc<RwLock<Run>>,
    master: Arc<dyn AgentImpl>,
    max_concurrent: usize,
) -> DispatchOutcome {
    let (run_id, cancel, worktree_mgr, notes) = {
        let r = run.read().await;
        (
            r.id.clone(),
            r.cancel_token.clone(),
            r.worktree_mgr.clone(),
            r.notes.clone(),
        )
    };

    // Cascade over any un-approved-parent situations before we pick
    // work. The approval step leaves un-approved subtasks as Skipped;
    // approved children of those need to cascade before they'd
    // otherwise be eligible.
    cascade_skip(deps, &run, &run_id).await;

    let worker_cache = match resolve_workers(deps, &run).await {
        Ok(c) => c,
        Err(e) => return DispatchOutcome::Failed { error: e },
    };

    if let Err(e) = transition_approved_to_waiting(deps, &run, &run_id).await {
        return DispatchOutcome::Failed {
            error: format!("waiting transition failed: {e}"),
        };
    }

    let mut join_set: JoinSet<(SubtaskId, WorkerOutcome)> = JoinSet::new();
    let mut in_flight: HashSet<SubtaskId> = HashSet::new();

    loop {
        cascade_skip(deps, &run, &run_id).await;

        let (all_terminal, ready) = {
            let r = run.read().await;
            (
                r.subtasks.iter().all(SubtaskRuntime::is_terminal),
                pick_ready(&r.subtasks, &in_flight),
            )
        };

        for sub_id in ready {
            if join_set.len() >= max_concurrent {
                break;
            }
            match dispatch_one(
                deps,
                &run,
                &run_id,
                &sub_id,
                &worktree_mgr,
                &notes,
                &worker_cache,
                &cancel,
                &mut join_set,
            )
            .await
            {
                Ok(()) => {
                    in_flight.insert(sub_id);
                }
                Err(err) => {
                    // Couldn't even spawn: treat as a subtask failure
                    // and fail-fast the run. No AgentError in scope
                    // here (setup errors are plain strings), so no
                    // category chip on the banner for this path.
                    mark_failed(deps, &run, &run_id, &sub_id, err.clone(), None).await;
                    cancel.cancel();
                    drain_as_skipped(deps, &run, &run_id, &mut join_set, &mut in_flight).await;
                    return DispatchOutcome::Failed {
                        error: format!("subtask {sub_id} setup failed: {err}"),
                    };
                }
            }
        }

        if join_set.is_empty() {
            if all_terminal {
                return DispatchOutcome::AllDone;
            }
            // Defensive: with no work in flight and nothing ready,
            // every non-terminal subtask is blocked on deps the
            // cascade should already have handled. Surface as failure
            // rather than spinning forever.
            let stuck = {
                let r = run.read().await;
                r.subtasks.iter().any(|s| !s.is_terminal())
            };
            if !stuck {
                return DispatchOutcome::AllDone;
            }
            return DispatchOutcome::Failed {
                error: "dispatch deadlock: non-terminal subtasks with unsatisfiable dependencies"
                    .into(),
            };
        }

        tokio::select! {
            Some(joined) = join_set.join_next() => {
                let (sub_id, outcome) = match joined {
                    Ok(pair) => pair,
                    Err(e) => {
                        cancel.cancel();
                        drain_as_skipped(deps, &run, &run_id, &mut join_set, &mut in_flight).await;
                        return DispatchOutcome::Failed {
                            error: format!("worker task panicked: {e}"),
                        };
                    }
                };
                in_flight.remove(&sub_id);
                match outcome {
                    WorkerOutcome::Done(res) => {
                        on_worker_done(deps, &run, &run_id, &sub_id, &res, &notes).await;
                        maybe_consolidate(
                            &notes,
                            master.as_ref(),
                            &cancel,
                            &deps.event_sink,
                            &run_id,
                        )
                        .await;
                    }
                    WorkerOutcome::Failed(err) => {
                        // `WorkerOutcome::Failed` carries a plain
                        // string (setup / post-execute commit error),
                        // no AgentError to classify.
                        mark_failed(deps, &run, &run_id, &sub_id, err.clone(), None).await;
                        cancel.cancel();
                        drain_as_skipped(deps, &run, &run_id, &mut join_set, &mut in_flight).await;
                        return DispatchOutcome::Failed {
                            error: format!("subtask {sub_id} failed: {err}"),
                        };
                    }
                    WorkerOutcome::Cancelled => {
                        mark_skipped(deps, &run, &run_id, &sub_id).await;
                        drain_as_skipped(deps, &run, &run_id, &mut join_set, &mut in_flight).await;
                        return DispatchOutcome::Cancelled;
                    }
                    WorkerOutcome::Escalate(kind) => {
                        // Mark the failing subtask as Failed with the
                        // escalation's error text, then hand control
                        // back to the lifecycle with the rest of the
                        // run's state *preserved*. We deliberately do
                        // NOT fire `cancel.cancel()` and do NOT call
                        // `drain_as_skipped` — that was the Phase-3
                        // fail-fast behaviour, but Layer 3 (commit 2b)
                        // needs any `Waiting` subtasks to stay
                        // `Waiting` so that a `Fixed` / `Skipped`
                        // resolution can re-enter the dispatcher and
                        // let dependents progress. Any sibling workers
                        // that are still in flight continue running;
                        // they're awaited to natural completion by
                        // `await_in_flight_naturally` so their outputs
                        // persist (Done) or propagate (Failed cascades
                        // on re-entry). The lifecycle's replan /
                        // escalation helpers decide what to do next.
                        let err_msg = escalate_error_text(&kind);
                        let category = escalate_error_category(&kind);
                        mark_failed(deps, &run, &run_id, &sub_id, err_msg, category).await;
                        await_in_flight_naturally(
                            deps,
                            &run,
                            &run_id,
                            &notes,
                            master.as_ref(),
                            &cancel,
                            &mut join_set,
                            &mut in_flight,
                        )
                        .await;
                        return DispatchOutcome::NeedsReplan {
                            failed_subtask_id: sub_id,
                            kind,
                        };
                    }
                }
            }
            _ = cancel.cancelled() => {
                drain_as_skipped(deps, &run, &run_id, &mut join_set, &mut in_flight).await;
                return DispatchOutcome::Cancelled;
            }
        }
    }
}

// -- State transitions ----------------------------------------------

async fn transition_approved_to_waiting(
    deps: &DispatcherDeps,
    run: &Arc<RwLock<Run>>,
    run_id: &RunId,
) -> Result<(), String> {
    let moved: Vec<SubtaskId> = {
        let mut guard = run.write().await;
        let mut ids = Vec::new();
        for s in guard.subtasks.iter_mut() {
            if matches!(s.state, SubtaskState::Proposed) {
                s.state = SubtaskState::Waiting;
                ids.push(s.id.clone());
            }
        }
        ids
    };
    for id in &moved {
        deps.storage
            .update_subtask_state(id, SubtaskState::Waiting, None)
            .await
            .map_err(|e| format!("update_subtask_state(waiting, {id}): {e}"))?;
        deps.event_sink
            .emit(RunEvent::SubtaskStateChanged {
                run_id: run_id.clone(),
                subtask_id: id.clone(),
                state: SubtaskState::Waiting,
                error_category: None,
            })
            .await;
    }
    Ok(())
}

async fn cascade_skip(deps: &DispatcherDeps, run: &Arc<RwLock<Run>>, run_id: &RunId) {
    // Iterate to a fixed point: a newly-skipped subtask may in turn
    // cascade to its own dependents. Small graphs (≤~10 nodes), so
    // the O(n·changes) cost is irrelevant.
    loop {
        let to_skip: Vec<SubtaskId> = {
            let guard = run.read().await;
            let state_of: HashMap<&SubtaskId, SubtaskState> =
                guard.subtasks.iter().map(|s| (&s.id, s.state)).collect();
            guard
                .subtasks
                .iter()
                .filter(|s| matches!(s.state, SubtaskState::Waiting | SubtaskState::Proposed))
                .filter(|s| {
                    s.dependency_ids.iter().any(|d| {
                        matches!(
                            state_of.get(d).copied(),
                            Some(SubtaskState::Skipped | SubtaskState::Failed)
                        )
                    })
                })
                .map(|s| s.id.clone())
                .collect()
        };
        if to_skip.is_empty() {
            return;
        }
        for id in to_skip {
            mark_skipped(deps, run, run_id, &id).await;
        }
    }
}

// -- Readiness + spawn ----------------------------------------------

fn pick_ready(subs: &[SubtaskRuntime], in_flight: &HashSet<SubtaskId>) -> Vec<SubtaskId> {
    let done: HashSet<&SubtaskId> = subs
        .iter()
        .filter(|s| s.is_done())
        .map(|s| &s.id)
        .collect();
    subs.iter()
        .filter(|s| matches!(s.state, SubtaskState::Waiting))
        .filter(|s| !in_flight.contains(&s.id))
        .filter(|s| s.dependency_ids.iter().all(|d| done.contains(d)))
        .map(|s| s.id.clone())
        .collect()
}

async fn resolve_workers(
    deps: &DispatcherDeps,
    run: &Arc<RwLock<Run>>,
) -> Result<HashMap<AgentKind, Arc<dyn AgentImpl>>, String> {
    let kinds: HashSet<AgentKind> = {
        let r = run.read().await;
        r.subtasks
            .iter()
            .filter(|s| matches!(s.state, SubtaskState::Proposed | SubtaskState::Waiting))
            .map(|s| s.data.assigned_worker)
            .collect()
    };
    let mut cache = HashMap::with_capacity(kinds.len());
    for k in kinds {
        let agent = deps
            .registry
            .get(k)
            .await
            .map_err(|e| format!("worker {k:?} unavailable: {e}"))?;
        cache.insert(k, agent);
    }
    Ok(cache)
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_one(
    deps: &DispatcherDeps,
    run: &Arc<RwLock<Run>>,
    run_id: &RunId,
    sub_id: &SubtaskId,
    worktree_mgr: &Arc<WorktreeManager>,
    notes: &Arc<SharedNotes>,
    worker_cache: &HashMap<AgentKind, Arc<dyn AgentImpl>>,
    cancel: &CancellationToken,
    join_set: &mut JoinSet<(SubtaskId, WorkerOutcome)>,
) -> Result<(), String> {
    let worktree_path = worktree_mgr
        .create(run_id, sub_id)
        .await
        .map_err(|e| format!("worktree create: {e}"))?;

    let (subtask_row, worker_kind) = {
        let mut guard = run.write().await;
        let s = guard
            .find_subtask_mut(sub_id)
            .ok_or_else(|| "subtask vanished mid-dispatch".to_string())?;
        s.mark_running(worktree_path.clone());
        (to_storage_subtask(s, run_id), s.data.assigned_worker)
    };

    deps.storage
        .update_subtask_state(sub_id, SubtaskState::Running, None)
        .await
        .map_err(|e| format!("update_subtask_state(running): {e}"))?;
    deps.event_sink
        .emit(RunEvent::SubtaskStateChanged {
            run_id: run_id.clone(),
            subtask_id: sub_id.clone(),
            state: SubtaskState::Running,
            error_category: None,
        })
        .await;

    let notes_snapshot = notes.read().await.unwrap_or_default();
    let worker = worker_cache
        .get(&worker_kind)
        .cloned()
        .ok_or_else(|| "worker adapter missing from cache".to_string())?;

    let (log_tx, log_rx) = mpsc::channel::<String>(64);
    tokio::spawn(forward_logs(
        deps.storage.clone(),
        deps.event_sink.clone(),
        run_id.clone(),
        sub_id.clone(),
        log_rx,
    ));

    let sub_cancel = cancel.clone();
    let sub_id_owned = sub_id.clone();
    let run_id_owned = run_id.clone();
    let storage = deps.storage.clone();
    let event_sink = deps.event_sink.clone();
    join_set.spawn(async move {
        // Phase 3 Step 3b: route through the Layer-1 retry ladder
        // instead of calling `execute` directly. `execute_subtask_with_retry`
        // owns the Retrying/Running transitions and log separator; on
        // success (first attempt or recovered retry) it returns the
        // same `ExecutionResult` the direct call used to. On escalation
        // it maps onto `WorkerOutcome::Failed` so Phase 2's fail-fast
        // dispatcher behaviour is preserved until Step 4 adds Layer 2.
        let execute_result = execute_subtask_with_retry(
            storage.as_ref(),
            event_sink.as_ref(),
            &run_id_owned,
            &subtask_row,
            worker.as_ref(),
            &worktree_path,
            &notes_snapshot,
            log_tx,
            sub_cancel,
        )
        .await;

        let outcome = match execute_result {
            // Real-world CLI agents rarely commit their own work — the
            // worktree is an implementation detail and we don't want to
            // rely on prompt discipline across three different CLIs. So
            // the orchestrator owns commit semantics: after a successful
            // execute we stage + commit whatever the worker left behind.
            // A clean worktree (agent decided nothing needed doing) is a
            // legitimate outcome; only a failing commit fails the run.
            Ok(r) => match commit_worker_changes(
                &worktree_path,
                &subtask_row.title,
                subtask_row.why.as_deref(),
                worker_kind,
                &run_id_owned,
            )
            .await
            {
                Ok(true) => WorkerOutcome::Done(r),
                Ok(false) => {
                    eprintln!(
                        "[dispatcher] worker {sub_id_owned} left worktree {} clean; marking done with no changes",
                        worktree_path.display()
                    );
                    WorkerOutcome::Done(r)
                }
                Err(e) => WorkerOutcome::Failed(format!("commit failed: {e}")),
            },
            Err(EscalateToMaster::UserCancelled) => WorkerOutcome::Cancelled,
            // Preserve the variant through to the main loop so the
            // lifecycle can pattern-match on `Deterministic` vs
            // `Exhausted` when building the replan prompt (the retry
            // count surfaces differently) rather than parsing strings.
            Err(kind @ (EscalateToMaster::Deterministic(_) | EscalateToMaster::Exhausted(_))) => {
                WorkerOutcome::Escalate(kind)
            }
        };
        (sub_id_owned, outcome)
    });
    Ok(())
}

/// Stage and commit everything the worker left in its worktree.
///
/// Returns `Ok(true)` when a commit was created, `Ok(false)` when the
/// worktree was already clean (a legitimate no-op outcome — the agent
/// decided nothing needed doing), and `Err` when any git invocation
/// failed. The caller turns `Err` into a subtask failure so the
/// "mysterious zero diff at merge time" bug can't recur silently.
///
/// Identity env vars are forced on the commit so fresh installs or
/// CI machines without a global `user.name`/`user.email` don't crash
/// the run. The on-disk worktree branch is discarded after apply, so
/// the WhaleCode identity never appears on the user's main branch.
async fn commit_worker_changes(
    worktree_path: &Path,
    subtask_title: &str,
    subtask_why: Option<&str>,
    agent_kind: AgentKind,
    run_id: &RunId,
) -> Result<bool, String> {
    let status = TokioCommand::new("git")
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
        return Ok(false);
    }

    let add = TokioCommand::new("git")
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

    let agent_label = match agent_kind {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Gemini => "gemini",
    };
    let why = subtask_why.unwrap_or("(no rationale given)");
    let message =
        format!("whalecode: {subtask_title}\n\n{why}\n\nGenerated by {agent_label} for run {run_id}.");
    let commit = TokioCommand::new("git")
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
    Ok(true)
}

async fn forward_logs(
    storage: Arc<Storage>,
    sink: Arc<dyn EventSink>,
    run_id: RunId,
    subtask_id: SubtaskId,
    mut rx: mpsc::Receiver<String>,
) {
    while let Some(line) = rx.recv().await {
        // Best-effort persistence: a log line dropped on the floor is
        // not worth failing the subtask. The event still goes out.
        let _ = storage.append_log(&subtask_id, &line).await;
        sink.emit(RunEvent::SubtaskLog {
            run_id: run_id.clone(),
            subtask_id: subtask_id.clone(),
            line,
        })
        .await;
    }
}

// -- Completion handlers --------------------------------------------

async fn on_worker_done(
    deps: &DispatcherDeps,
    run: &Arc<RwLock<Run>>,
    run_id: &RunId,
    sub_id: &SubtaskId,
    res: &ExecutionResult,
    notes: &Arc<SharedNotes>,
) {
    let (worker_kind, title) = {
        let mut guard = run.write().await;
        let Some(s) = guard.find_subtask_mut(sub_id) else {
            return;
        };
        s.mark_done();
        (s.data.assigned_worker, s.data.title.clone())
    };
    if let Err(e) = deps
        .storage
        .update_subtask_state(sub_id, SubtaskState::Done, None)
        .await
    {
        eprintln!("[dispatcher] update_subtask_state(done, {sub_id}) failed: {e}");
    }
    deps.event_sink
        .emit(RunEvent::SubtaskStateChanged {
            run_id: run_id.clone(),
            subtask_id: sub_id.clone(),
            state: SubtaskState::Done,
            error_category: None,
        })
        .await;
    if let Err(e) = notes
        .append_subtask_summary(sub_id, &title, worker_kind, &res.summary)
        .await
    {
        eprintln!("[dispatcher] append_subtask_summary({sub_id}) failed: {e}");
    }
}

async fn maybe_consolidate(
    notes: &Arc<SharedNotes>,
    master: &dyn AgentImpl,
    cancel: &CancellationToken,
    event_sink: &Arc<dyn EventSink>,
    run_id: &RunId,
) {
    let size = notes.size_bytes().unwrap_or(0);
    if size < CONSOLIDATE_THRESHOLD_BYTES {
        return;
    }
    event_sink
        .emit(RunEvent::MasterLog {
            run_id: run_id.clone(),
            line: format!("consolidating shared notes ({size} bytes)…"),
        })
        .await;
    // `notes.consolidate` currently opens its own cancel token; wrap
    // in select! so the dispatcher doesn't hang if the run is
    // cancelled mid-consolidate. Dropping the future cancels the
    // master call via normal async-drop semantics.
    tokio::select! {
        res = notes.consolidate(master) => {
            if let Err(e) = res {
                event_sink
                    .emit(RunEvent::MasterLog {
                        run_id: run_id.clone(),
                        line: format!("notes consolidation failed: {e}"),
                    })
                    .await;
            }
        }
        _ = cancel.cancelled() => {}
    }
}

async fn mark_failed(
    deps: &DispatcherDeps,
    run: &Arc<RwLock<Run>>,
    run_id: &RunId,
    sub_id: &SubtaskId,
    error: String,
    error_category: Option<ErrorCategoryWire>,
) {
    {
        let mut guard = run.write().await;
        if let Some(s) = guard.find_subtask_mut(sub_id) {
            s.mark_failed(error.clone());
        }
    }
    if let Err(e) = deps
        .storage
        .update_subtask_state(sub_id, SubtaskState::Failed, Some(&error))
        .await
    {
        eprintln!("[dispatcher] update_subtask_state(failed, {sub_id}) failed: {e}");
    }
    deps.event_sink
        .emit(RunEvent::SubtaskStateChanged {
            run_id: run_id.clone(),
            subtask_id: sub_id.clone(),
            state: SubtaskState::Failed,
            error_category,
        })
        .await;
}

async fn mark_skipped(
    deps: &DispatcherDeps,
    run: &Arc<RwLock<Run>>,
    run_id: &RunId,
    sub_id: &SubtaskId,
) {
    let changed = {
        let mut guard = run.write().await;
        match guard.find_subtask_mut(sub_id) {
            Some(s) if !s.is_terminal() => {
                s.mark_skipped();
                true
            }
            _ => false,
        }
    };
    if !changed {
        return;
    }
    if let Err(e) = deps
        .storage
        .update_subtask_state(sub_id, SubtaskState::Skipped, None)
        .await
    {
        eprintln!("[dispatcher] update_subtask_state(skipped, {sub_id}) failed: {e}");
    }
    deps.event_sink
        .emit(RunEvent::SubtaskStateChanged {
            run_id: run_id.clone(),
            subtask_id: sub_id.clone(),
            state: SubtaskState::Skipped,
            error_category: None,
        })
        .await;
}

/// Drain any in-flight workers while preserving their natural
/// outcomes. Used on the `NeedsReplan` return path (Commit 2b) where
/// the dispatcher hands control back to the lifecycle but the run is
/// NOT terminating: siblings that were already running should commit
/// their completions, failures should surface through the normal
/// cascade on re-entry, and waiting subtasks must not be touched.
///
/// The run's `cancel_token` is NOT fired here — the lifecycle's
/// `do_replan_subtask` / `handle_escalation` path decides whether to
/// keep the token live (so the user can cancel during park) or swap
/// it for a fresh one (after `ResumeDispatch`). Contrast with
/// `drain_as_skipped`, which *does* mark every waiting subtask as
/// Skipped because it's only called on terminating paths.
#[allow(clippy::too_many_arguments)]
async fn await_in_flight_naturally(
    deps: &DispatcherDeps,
    run: &Arc<RwLock<Run>>,
    run_id: &RunId,
    notes: &Arc<SharedNotes>,
    master: &dyn AgentImpl,
    cancel: &CancellationToken,
    join_set: &mut JoinSet<(SubtaskId, WorkerOutcome)>,
    in_flight: &mut HashSet<SubtaskId>,
) {
    while let Some(joined) = join_set.join_next().await {
        let (sub_id, outcome) = match joined {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("[dispatcher] worker task panicked during drain: {e}");
                continue;
            }
        };
        in_flight.remove(&sub_id);
        match outcome {
            WorkerOutcome::Done(res) => {
                on_worker_done(deps, run, run_id, &sub_id, &res, notes).await;
                maybe_consolidate(notes, master, cancel, &deps.event_sink, run_id).await;
            }
            WorkerOutcome::Failed(err) => {
                mark_failed(deps, run, run_id, &sub_id, err, None).await;
            }
            WorkerOutcome::Cancelled => {
                mark_skipped(deps, run, run_id, &sub_id).await;
            }
            WorkerOutcome::Escalate(kind) => {
                // A second in-flight worker also escalated while we
                // were draining. Mark it Failed too; the lifecycle
                // only handles one failed subtask per replan call,
                // but persisting both as Failed keeps storage honest
                // and cascade_skip on re-entry picks up any
                // dependents that should now be skipped.
                let err_msg = escalate_error_text(&kind);
                let category = escalate_error_category(&kind);
                mark_failed(deps, run, run_id, &sub_id, err_msg, category).await;
            }
        }
    }
}

async fn drain_as_skipped(
    deps: &DispatcherDeps,
    run: &Arc<RwLock<Run>>,
    run_id: &RunId,
    join_set: &mut JoinSet<(SubtaskId, WorkerOutcome)>,
    in_flight: &mut HashSet<SubtaskId>,
) {
    // Wait up to `DRAIN_DEADLINE` for every in-flight worker to resolve.
    // Workers that honour the cancel token finish in milliseconds once
    // `run_streaming` sees the process-group kill; the deadline is the
    // backstop. Phase 3's closeout bug was a deadlock here — a worker
    // whose grandchildren held the stdout pipe open parked `join_next`
    // forever, stranding the run in `Running`. The bounded wait plus
    // `abort_all()` on timeout guarantees `finalize_cancelled` reaches
    // the user every time.
    let drain = async {
        while let Some(joined) = join_set.join_next().await {
            if let Ok((sub_id, _)) = joined {
                in_flight.remove(&sub_id);
                mark_skipped(deps, run, run_id, &sub_id).await;
            }
        }
    };
    if tokio::time::timeout(DRAIN_DEADLINE, drain).await.is_err() {
        eprintln!(
            "[dispatcher] drain_as_skipped exceeded {:?}; aborting {} wedged worker task(s)",
            DRAIN_DEADLINE,
            join_set.len()
        );
        join_set.abort_all();
        // Mark any still-in-flight ids as skipped — their join handles
        // were aborted, no further outcome will arrive.
        for sub_id in in_flight.drain().collect::<Vec<_>>() {
            mark_skipped(deps, run, run_id, &sub_id).await;
        }
        // Drop whatever's left on the JoinSet without awaiting; the
        // runtime reaps aborted tasks once their futures are dropped.
        join_set.detach_all();
    }
    // Mark every still-waiting subtask as skipped so the persisted
    // state reflects "did not run". Without this they'd stay as
    // Waiting in SQLite even though the run is over.
    let waiting: Vec<SubtaskId> = {
        let r = run.read().await;
        r.subtasks
            .iter()
            .filter(|s| matches!(s.state, SubtaskState::Waiting | SubtaskState::Proposed))
            .map(|s| s.id.clone())
            .collect()
    };
    for id in waiting {
        mark_skipped(deps, run, run_id, &id).await;
    }
}

// -- Helpers ---------------------------------------------------------

/// Flatten an `EscalateToMaster` into a short string suitable for
/// `mark_failed` + the frontend's error pill. The variant information
/// is preserved on [`DispatchOutcome::NeedsReplan`]; the lifecycle
/// re-derives a prompt-level rendering when it builds the replan
/// context, so this only needs to be readable.
pub(crate) fn escalate_error_text(kind: &EscalateToMaster) -> String {
    match kind {
        EscalateToMaster::UserCancelled => "cancelled".to_string(),
        EscalateToMaster::Deterministic(e) => format!("{e}"),
        EscalateToMaster::Exhausted(e) => format!("{e}"),
    }
}

/// Phase 4 Step 5. Classify an escalation into a wire-level
/// [`ErrorCategoryWire`] so the frontend can render a category-
/// specific banner + inline chip on the Failed worker card.
/// `UserCancelled` returns `None` — cancellation doesn't produce a
/// Failed state change (the dispatcher routes it through the
/// Cancelled path instead), so any caller that threads this value
/// into `mark_failed` for a cancelled escalation would be a bug
/// upstream; we surface `None` to keep this function total.
pub(crate) fn escalate_error_category(
    kind: &EscalateToMaster,
) -> Option<ErrorCategoryWire> {
    match kind {
        EscalateToMaster::UserCancelled => None,
        EscalateToMaster::Deterministic(e) | EscalateToMaster::Exhausted(e) => {
            ErrorCategoryWire::from_agent_error(e)
        }
    }
}

fn to_storage_subtask(rt: &SubtaskRuntime, run_id: &RunId) -> Subtask {
    Subtask {
        id: rt.id.clone(),
        run_id: run_id.clone(),
        title: rt.data.title.clone(),
        why: Some(rt.data.why.clone()).filter(|w| !w.is_empty()),
        assigned_worker: rt.data.assigned_worker,
        state: rt.state,
        started_at: rt.started_at.map(|d| d.to_rfc3339()),
        finished_at: rt.finished_at.map(|d| d.to_rfc3339()),
        error: rt.error.clone(),
    }
}
