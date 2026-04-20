/**
 * Event-sourced graph store.
 *
 * Phase 2 rewrite: the store is a pure mirror of backend `run:*` events.
 * Actions invoke IPC commands and return. Every visible state change flows
 * through a handler that the active `RunSubscription` routes events to.
 *
 * Lifecycle:
 *   submitTask → IPC submit_task → attach RunSubscription → backend emits →
 *   handlers drive actors / status / logs → terminal event auto-detaches.
 *
 * Action surface (applyRun / discardRun / cancelRun / rejectAll) only wraps
 * IPC — it does not mutate store state. All state mutations live in the
 * handler methods. This keeps the frontend/backend contract one-directional
 * and removes the class of bugs where optimistic updates diverge from
 * backend reality.
 *
 * Backend vs. frontend nomenclature:
 *   backend RunStatus uses kebab-case ('awaiting-approval'), frontend uses
 *   underscore ('awaiting_approval'). Mapped at `mapRunStatus`. Phase 3
 *   should consider unifying these when it extends RunStatus for the real
 *   retry ladder; don't unify now.
 *
 * Attach timing:
 *   backend's `submit_task` has an INVARIANT (see `orchestration/lifecycle.rs`)
 *   that it yields before emitting the first event. That yield is what lets
 *   us attach AFTER the IPC call returns without dropping events. Don't
 *   reorder this without re-checking that contract.
 */

import { createActor, type ActorRefFrom } from 'xstate';
import { create } from 'zustand';

import {
  addSubtask as addSubtaskIpc,
  applyRun as applyRunIpc,
  approveSubtasks as approveSubtasksIpc,
  cancelRun as cancelRunIpc,
  discardRun as discardRunIpc,
  manualFixSubtask as manualFixSubtaskIpc,
  markSubtaskFixed as markSubtaskFixedIpc,
  rejectRun as rejectRunIpc,
  removeSubtask as removeSubtaskIpc,
  skipSubtask as skipSubtaskIpc,
  submitTask as submitTaskIpc,
  tryReplanAgain as tryReplanAgainIpc,
  updateSubtask as updateSubtaskIpc,
  type AgentKind as BackendAgentKind,
  type BaseBranchDirty,
  type Completed,
  type DiffReady,
  type EditorResult,
  type Failed,
  type HumanEscalation,
  type MasterLog,
  type MergeConflict,
  type ReplanStarted,
  type RunStatus,
  type SkipResult,
  type StatusChanged,
  type SubtaskDraft,
  type SubtaskId,
  type SubtaskLog,
  type SubtaskPatch,
  type SubtaskState,
  type SubtaskStateChanged,
  type SubtasksProposed,
} from '../lib/ipc';
import { RunSubscription, defaultOnParseError } from '../lib/runSubscription';
import { nodeMachine, type NodeEvent, type NodeEventType, type NodeState } from './nodeMachine';
import { useRepoStore } from './repoStore';

/**
 * Frontend agent token. `'master'` is a display-only marker that selects the
 * amber master color; the underlying CLI is `selectedMasterAgent`.
 */
export type AgentKind = BackendAgentKind | 'master';

export type MasterNodeData = {
  id: 'master';
  agent: AgentKind;
  label: string;
};

export type SubtaskNodeData = {
  id: string;
  title: string;
  /**
   * Master's rationale for the subtask. `null` means the backend
   * didn't provide one (user-added subtasks with an empty draft,
   * or master omitted it); the UI shows a muted "(no rationale)"
   * placeholder rather than a blank field. Phase 3 adds inline
   * editing that rewrites this via `updateSubtask`.
   */
  why: string | null;
  agent: BackendAgentKind;
  dependsOn: string[];
  /**
   * Subtask ids this one replaces — non-empty only for master-generated
   * Layer-2 replan replacements. Drives the "replaces #N" badge on the
   * replacement node and lets the ApprovalBar detect it's showing a
   * replan plan. Defaults to `[]` for freshly-planned and user-added
   * subtasks.
   */
  replaces: string[];
  /**
   * How many Layer-2 replans have already fired on this subtask's
   * lineage. `0` = freshly planned; `>= 2` = replan cap exhausted,
   * meaning the "Try replan again" action in the escalation UI is
   * hidden. Mirrored verbatim from `SubtaskData.replanCount`. Optional
   * on the frontend type so test fixtures that build subtask
   * literals by hand can omit it — unset is treated as 0 at read
   * sites.
   */
  replanCount?: number;
};

export type FinalNodeData = {
  id: 'final';
  label: string;
  files: string[];
  /**
   * Populated by `handleMergeConflict`. Null means "no conflict" (distinct
   * from `[]`, which would be meaningless). Cleared on: fresh `submitTask`,
   * `reset`, or a successful `Completed` event. Not cleared on subsequent
   * `MergeConflict` events — latest wins. Commit 3 will render a conflict
   * variant from this field.
   */
  conflictFiles: string[] | null;
};

export type NodeSnapshot = {
  value: NodeState;
};

export type GraphStatus =
  | 'idle'
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'merging'
  | 'done'
  | 'applied'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  // Phase 3 Step 5: Layer-3 human escalation is active. The backend
  // parked the lifecycle on a resolution channel; the UI surfaces the
  // escalation actions (open in editor / skip / replan again / abort)
  // on the affected WorkerNode. Resolution returns the run to
  // `running` (Fixed/Skipped/ReplanRequested) or forwards it to a
  // terminal state (Aborted → cancelled).
  | 'awaiting_human_fix';

type NodeActorRef = ActorRefFrom<typeof nodeMachine>;

export type GraphState = {
  runId: string | null;
  taskInput: string;
  masterNode: MasterNodeData | null;
  subtasks: SubtaskNodeData[];
  finalNode: FinalNodeData | null;
  status: GraphStatus;
  selectedMasterAgent: BackendAgentKind;
  selectedSubtaskIds: Set<string>;
  nodeActors: Map<string, NodeActorRef>;
  nodeSnapshots: Map<string, NodeSnapshot>;
  nodeLogs: Map<string, string[]>;
  /**
   * Per-subtask retry counter — the number of times the backend has
   * entered `SubtaskState::Retrying` for that id, counted cumulatively
   * across the run. Phase 3 Step 3a moved this out of the XState
   * machine context (see `nodeMachine.ts` header comment) so the UI
   * has a single source of truth and the machine stays context-free.
   *
   * Semantics: a retry that *succeeds* still contributes to the count —
   * the badge "retry 1" on a currently-running subtask means "this
   * subtask needed a retry and recovered", which is useful signal.
   * Cleared on run reset and when a subtask is removed from the plan.
   */
  subtaskRetryCounts: Map<string, number>;
  /**
   * Phase 3 Step 2 — "edited" / "added" badge provenance. Edited state is
   * derived by comparing the current subtask row to its captured original
   * (snapshotted the *first* time an id appears in a run:subtasks_proposed
   * event for ids not already marked user-added). User-added ids skip the
   * original snapshot entirely — their badge is "added", not "edited".
   *
   * The backend's storage layer persists `edited_by_user` for re-plan
   * prompt assembly (see `docs/phase-3-spec.md` Common Pitfalls), but the
   * event payload doesn't expose it yet. For the UI badge we compute it
   * client-side from these two maps — correct as long as the browser tab
   * stays open for the life of the run, which matches every other piece
   * of session-scoped state in the store.
   */
  originalSubtasks: Map<string, { title: string; why: string | null; agent: BackendAgentKind }>;
  userAddedSubtaskIds: Set<string>;
  /**
   * Set by `addSubtask` to the just-returned id, cleared as soon as the
   * WorkerNode reads it once. Drives the "new node auto-enters edit mode
   * on the title" interaction. One-shot — subsequent renders of the same
   * node don't auto-focus.
   */
  lastAddedSubtaskId: string | null;
  /**
   * Id of the subtask currently being replanned by the master. Set by
   * `handleReplanStarted`, cleared by the next `handleSubtasksProposed`
   * (which carries the replacement plan) or by `handleHumanEscalation`
   * (which short-circuits the replan). Used only for internal signalling
   * — the "replan mode" ApprovalBar copy is instead derived from whether
   * any incoming subtask has a non-empty `replaces` field, which is
   * resilient to out-of-order events.
   */
  replanningSubtaskId: string | null;
  /**
   * Set by `handleHumanEscalation` when the retry ladder is exhausted.
   * The banner/overlay surfaces `reason` verbatim and `suggestedAction`
   * as CTA copy; the subtask node flips to the `human_escalation`
   * visual via its XState actor. Cleared on `reset` / new submit.
   */
  humanEscalation: {
    subtaskId: string;
    reason: string;
    suggestedAction: string | null;
  } | null;
  /** Live subscription to the active run's events. Null between runs. */
  activeSubscription: RunSubscription | null;
  /** Last surfaced error (IPC failure or backend `Failed` event). */
  currentError: string | null;

  setMasterAgent: (agent: BackendAgentKind) => void;
  submitTask: (input: string, masterAgent?: BackendAgentKind) => Promise<void>;
  toggleSubtaskSelection: (id: string) => void;
  selectAll: () => void;
  selectNone: () => void;
  approveSubtasks: (ids: string[]) => Promise<void>;
  rejectAll: () => Promise<void>;
  applyRun: () => Promise<void>;
  discardRun: () => Promise<void>;
  cancelRun: () => Promise<void>;
  /**
   * Phase 3 plan-edit actions. Valid only while the run is in
   * `awaiting_approval`. None of these mutate the store directly —
   * on success the backend re-emits `run:subtasks_proposed` with the
   * updated plan, and the store's diff-by-id handler reconciles.
   * Failures map backend error strings to user-facing messages on
   * `currentError` and rethrow so the caller can surface per-row
   * feedback.
   */
  updateSubtask: (subtaskId: SubtaskId, patch: SubtaskPatch) => Promise<void>;
  addSubtask: (draft: SubtaskDraft) => Promise<SubtaskId>;
  removeSubtask: (subtaskId: SubtaskId) => Promise<void>;
  /**
   * Phase 3 Step 5 Layer-3 escalation actions. Valid only when the run
   * status is `awaiting_human_fix` and `subtaskId` is the escalated
   * subtask. All four wrap IPC, surface errors via `currentError`
   * through `mapEditError(_, 'Action')`, and rethrow so the calling
   * button can surface per-row feedback. On success the backend
   * resumes the lifecycle and emits the matching state-change events
   * — the store does not mutate optimistically.
   *
   * `manualFixSubtask` additionally writes the worktree path to the
   * system clipboard when the backend reports `method === 'clipboard-only'`
   * (no editor launched); the UI surfaces a short message via
   * `currentError` so the user knows where to paste it. Calls that
   * open the editor directly resolve silently.
   */
  manualFixSubtask: (subtaskId: SubtaskId) => Promise<EditorResult>;
  markSubtaskFixed: (subtaskId: SubtaskId) => Promise<void>;
  skipSubtask: (subtaskId: SubtaskId) => Promise<SkipResult>;
  tryReplanAgain: (subtaskId: SubtaskId) => Promise<void>;
  /**
   * One-shot consumer for `lastAddedSubtaskId`. The just-mounted
   * WorkerNode calls this in a layout effect after reading the flag so
   * re-renders of the same node don't re-enter edit mode.
   */
  clearLastAddedSubtaskId: () => void;
  dismissError: () => void;
  reset: () => void;
};

export const MASTER_ID = 'master' as const;
export const FINAL_ID = 'final' as const;

/**
 * True if the subtask has been edited from master's original proposal.
 * User-added subtasks always return false (they don't have a "master
 * original" to diff against — their badge is "added", not "edited").
 * Also returns false for ids we've never seen an original for, which
 * can happen transiently during store warmup — safer to underreport
 * than to flash a false edit badge.
 */
export function isSubtaskEdited(state: GraphState, id: string): boolean {
  if (state.userAddedSubtaskIds.has(id)) return false;
  const original = state.originalSubtasks.get(id);
  if (!original) return false;
  const current = state.subtasks.find((s) => s.id === id);
  if (!current) return false;
  return (
    current.title !== original.title ||
    current.why !== original.why ||
    current.agent !== original.agent
  );
}

/** True if the subtask was added by the user via `addSubtask`. */
export function isSubtaskAdded(state: GraphState, id: string): boolean {
  return state.userAddedSubtaskIds.has(id);
}

/**
 * UX-preview BFS: how many *transitive* dependents the given subtask
 * has in the store's current plan. The count excludes the origin
 * itself, matching the copy the EscalationActions confirm uses
 * ("Skip subtask? This will also skip N dependent subtasks.").
 *
 * The count is pre-trimmed to ids that are still on the DAG — done /
 * skipped / failed subtasks don't produce meaningful cascade entries
 * since the backend's `compute_skip_cascade` only flips Waiting /
 * Proposed rows. We can't read XState snapshots from a pure helper,
 * so we approximate by walking every subtask that depends on the
 * origin; the backend's authoritative `SkipResult.skippedCount` is
 * what ultimately renders in the post-skip toast.
 *
 * Algorithm matches `src-tauri/src/orchestration/mod.rs::compute_skip_cascade`:
 *   - seed BFS queue with origin
 *   - pop id; find every subtask whose `dependsOn` includes id
 *   - push any not-yet-seen into queue + result
 *   - return result.size - 1 (exclude origin)
 */
export function computeSkipCascadeCount(
  subtasks: readonly SubtaskNodeData[],
  originId: string,
): number {
  // Index dependents so the BFS is O(V + E) rather than O(V × E). Each
  // entry: parent-id → the ids that list parent-id in their dependsOn.
  const dependentsOf = new Map<string, string[]>();
  for (const s of subtasks) {
    for (const dep of s.dependsOn) {
      const arr = dependentsOf.get(dep);
      if (arr) arr.push(s.id);
      else dependentsOf.set(dep, [s.id]);
    }
  }

  const visited = new Set<string>([originId]);
  const queue: string[] = [originId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const kids = dependentsOf.get(cur);
    if (!kids) continue;
    for (const k of kids) {
      if (visited.has(k)) continue;
      visited.add(k);
      queue.push(k);
    }
  }

  // Exclude the origin itself from the count — the copy reads
  // "… will also skip {N} dependent subtasks", singular/plural based
  // on the caller.
  return visited.size - 1;
}

const initial: Pick<
  GraphState,
  | 'runId'
  | 'taskInput'
  | 'masterNode'
  | 'subtasks'
  | 'finalNode'
  | 'status'
  | 'selectedMasterAgent'
  | 'selectedSubtaskIds'
  | 'nodeActors'
  | 'nodeSnapshots'
  | 'nodeLogs'
  | 'subtaskRetryCounts'
  | 'originalSubtasks'
  | 'userAddedSubtaskIds'
  | 'lastAddedSubtaskId'
  | 'replanningSubtaskId'
  | 'humanEscalation'
  | 'activeSubscription'
  | 'currentError'
> = {
  runId: null,
  taskInput: '',
  masterNode: null,
  subtasks: [],
  finalNode: null,
  status: 'idle',
  selectedMasterAgent: 'claude',
  selectedSubtaskIds: new Set(),
  nodeActors: new Map(),
  nodeSnapshots: new Map(),
  nodeLogs: new Map(),
  subtaskRetryCounts: new Map(),
  originalSubtasks: new Map(),
  userAddedSubtaskIds: new Set(),
  lastAddedSubtaskId: null,
  replanningSubtaskId: null,
  humanEscalation: null,
  activeSubscription: null,
  currentError: null,
};

function mapRunStatus(s: RunStatus): GraphStatus {
  // Kebab-case backend → underscore frontend. See file-top comment — Phase 3
  // should consider unifying these when it extends RunStatus.
  switch (s) {
    case 'idle':
      return 'idle';
    case 'planning':
      return 'planning';
    case 'awaiting-approval':
      return 'awaiting_approval';
    case 'running':
      return 'running';
    case 'merging':
      return 'merging';
    case 'done':
      return 'done';
    case 'rejected':
      return 'rejected';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'awaiting-human-fix':
      return 'awaiting_human_fix';
  }
}

/**
 * Translate a backend-reported SubtaskState into the NodeEvent(s) the local
 * machine needs to land in the matching state. Uses the current snapshot to
 * disambiguate transitions that have multiple reachable paths.
 */
function eventsForSubtaskState(
  target: SubtaskState,
  current: NodeState | undefined,
): NodeEventType[] {
  switch (target) {
    case 'proposed':
      // Normally covered by SubtasksProposed spawning the actor; this is
      // the redundant signal. No-op unless actor somehow skipped PROPOSE.
      return current === undefined || current === 'idle' ? ['PROPOSE'] : [];
    case 'waiting':
      // Backend may jump proposed→waiting if a subtask is approved but its
      // dependency is still pending. Bridge via APPROVE → BLOCK.
      if (current === 'proposed') return ['APPROVE', 'BLOCK'];
      if (current === 'approved') return ['BLOCK'];
      return [];
    case 'running':
      // Backend's subtask_state_changed for an approved subtask jumps
      // straight to 'running' — the machine's `approved` state is a
      // frontend-only waypoint the backend doesn't model. Bridge it
      // here so the actor lands where backend expects. From `retrying`
      // a running signal means the retry took — emit RETRY_SUCCESS so
      // the machine rejoins the happy path.
      if (current === 'retrying') return ['RETRY_SUCCESS'];
      if (current === 'proposed') return ['APPROVE', 'START'];
      if (current === 'waiting') return ['UNBLOCK', 'START'];
      if (current === 'approved') return ['START'];
      return [];
    case 'retrying':
      // Step 3a: backend-driven retry entry. From `running`, START_RETRY
      // directly; from earlier lifecycle states, bridge to `running`
      // first and then START_RETRY so the machine doesn't skip the
      // `running` waypoint (keeps log-visibility rules and edge
      // animations consistent). The counter is bumped in the handler
      // before this function runs — see `handleSubtaskStateChanged`.
      if (current === 'running') return ['START_RETRY'];
      if (current === 'proposed') return ['APPROVE', 'START', 'START_RETRY'];
      if (current === 'waiting') return ['UNBLOCK', 'START', 'START_RETRY'];
      if (current === 'approved') return ['START', 'START_RETRY'];
      return [];
    case 'done':
      // Bridge the same approved-waypoint gap if backend jumps
      // proposed/waiting/approved → done (e.g. a no-op subtask).
      // From `retrying` a done is unusual but legal — treat as
      // retry-recovered-then-completed.
      if (current === 'retrying') return ['RETRY_SUCCESS', 'COMPLETE'];
      if (current === 'proposed') return ['APPROVE', 'START', 'COMPLETE'];
      if (current === 'waiting') return ['UNBLOCK', 'START', 'COMPLETE'];
      if (current === 'approved') return ['START', 'COMPLETE'];
      return ['COMPLETE'];
    case 'failed':
      // From `running` → terminal FAIL (no branching guard; retry
      // arrives as a follow-up Retrying event if at all). From
      // `retrying` → RETRY_FAIL so we leave the retry sub-state
      // cleanly. Bridge from earlier states for backend shortcuts
      // (e.g. master re-plan invalidation before START).
      if (current === 'retrying') return ['RETRY_FAIL'];
      if (current === 'proposed') return ['APPROVE', 'START', 'FAIL'];
      if (current === 'waiting') return ['UNBLOCK', 'START', 'FAIL'];
      if (current === 'approved') return ['START', 'FAIL'];
      return ['FAIL'];
    case 'skipped':
      // SKIP is only defined from `proposed` and `human_escalation` in the
      // machine. From other states (approved mid-cancel, etc.) we leave
      // the actor where it is — the terminal run status already conveys
      // "run ended" visually via the muted graph.
      return ['SKIP'];
  }
}

function newLocalRunId(): string {
  return `pending_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Map a backend edit-command error string into a user-facing message.
 *
 * Tauri's command layer stringifies `OrchestratorError` via
 * `map_err(|e| e.to_string())` before it reaches the frontend, so the
 * error we see here is the output of `thiserror`'s `Display` impl —
 * see `src-tauri/src/orchestration/mod.rs` for the exact phrasings
 * that back each match arm. We look for stable substrings rather than
 * relying on exact equality so a small rewording on the Rust side
 * doesn't silently fall through to the generic fallback.
 *
 * `action` is the verb the UI would have used ("Update", "Add",
 * "Remove") so the fallback message reads naturally.
 */
function mapEditError(
  err: unknown,
  action: 'Update' | 'Add' | 'Remove' | 'Action',
): string {
  const raw = String(err);
  const lower = raw.toLowerCase();

  if (lower.includes('title must not be empty')) {
    return 'Title is required.';
  }
  if (lower.includes('assigned worker') && lower.includes('not available')) {
    return 'Selected agent is not available on this system.';
  }
  if (lower.includes('has dependents')) {
    return 'Cannot remove — another subtask depends on this one. Remove dependents first.';
  }
  if (lower.includes('subtask') && lower.includes('not found')) {
    return 'Subtask no longer exists.';
  }
  if (lower.includes('subtask') && lower.includes('expected proposed')) {
    return 'Subtask is no longer editable.';
  }
  if (
    lower.includes('run') &&
    lower.includes('expected awaiting-approval')
  ) {
    return 'Run is no longer awaiting approval.';
  }
  if (lower.includes('run') && lower.includes('not found')) {
    return 'Run no longer exists.';
  }
  // Phase 3 Step 5 Layer-3 variants. The orchestrator's error shapes are
  // defined in `src-tauri/src/orchestration/mod.rs::OrchestratorError`;
  // we match on the stable human phrasing the Display impl emits.
  if (lower.includes('replan') && lower.includes('cap exhausted')) {
    return 'Cannot replan: maximum attempts reached.';
  }
  if (lower.includes('expected awaiting-human-fix')) {
    return 'This action is no longer available — the escalation was already resolved.';
  }
  if (lower.includes('not the escalated subtask')) {
    return 'This action is no longer available — a different subtask is escalated.';
  }
  // Unknown shape — surface the raw message so at least we don't lie
  // about the failure. The verb in front keeps it readable.
  return `${action} failed: ${raw}`;
}

export const useGraphStore = create<GraphState>((set, get) => {
  function spawnActor(id: string): NodeActorRef {
    const actor = createActor(nodeMachine);
    actor.subscribe((snap) => {
      set((state) => {
        const nextSnaps = new Map(state.nodeSnapshots);
        nextSnaps.set(id, { value: snap.value as NodeState });
        return { nodeSnapshots: nextSnaps };
      });
    });
    actor.start();
    return actor;
  }

  function registerActor(id: string): NodeActorRef {
    const actor = spawnActor(id);
    set((state) => {
      const nextActors = new Map(state.nodeActors);
      nextActors.set(id, actor);
      return { nodeActors: nextActors };
    });
    return actor;
  }

  function sendTo(id: string, event: NodeEvent): void {
    const actor = get().nodeActors.get(id);
    if (!actor) return;
    actor.send(event);
  }

  function ensureFinalNode() {
    if (get().finalNode) return;
    set({ finalNode: { id: FINAL_ID, label: 'Merge', files: [], conflictFiles: null } });
    registerActor(FINAL_ID);
  }

  function appendLog(id: string, line: string) {
    if (!get().nodeActors.has(id)) return;
    set((state) => {
      const next = new Map(state.nodeLogs);
      next.set(id, [...(next.get(id) ?? []), line]);
      return { nodeLogs: next };
    });
  }

  function detachActiveSubscription() {
    const sub = get().activeSubscription;
    if (!sub) return;
    set({ activeSubscription: null });
    // Fire-and-forget: detach is idempotent and tolerates teardown errors.
    void sub.detach();
  }

  // ---------- Event handlers ----------

  function handleStatusChanged(e: StatusChanged) {
    if (e.runId !== get().runId) return;
    const mapped = mapRunStatus(e.status);
    set({ status: mapped });

    // Spawn the final node on first entry into running. Matches Phase 1
    // behavior: node sits empty with the apply button disabled until
    // DiffReady populates files.
    if (mapped === 'running' && !get().finalNode) {
      ensureFinalNode();
    }

    // Master lifecycle: planning → thinking, awaiting_approval → proposed,
    // running → approved. Keeps the master node label consistent with the
    // overall run state without separate master-specific events.
    if (mapped === 'planning') sendTo(MASTER_ID, { type: 'THINK' });
    if (mapped === 'running') sendTo(MASTER_ID, { type: 'APPROVE' });

    // Terminal events auto-detach. `merging` is NOT terminal — it's the
    // transient apply state, and conflicts may keep the run alive.
    if (mapped === 'done' || mapped === 'failed' || mapped === 'rejected') {
      detachActiveSubscription();
    }
  }

  function handleMasterLog(e: MasterLog) {
    if (e.runId !== get().runId) return;
    appendLog(MASTER_ID, e.line);
  }

  function handleSubtasksProposed(e: SubtasksProposed) {
    if (e.runId !== get().runId) return;

    // Diff the incoming plan against the current one by id.
    //
    //   retained → update data fields (title/why/worker/deps) in-place,
    //              keep the actor reference so any per-node state
    //              (node machine snapshot, logs, retry counters once
    //              Step 3a lands) survives a master re-plan or a
    //              user edit round-trip.
    //   new      → spawn a fresh actor + PROPOSE.
    //   removed  → stop the actor, drop it from the maps, drop logs.
    //
    // Phase 3 edit commands (`update/add/remove_subtask`) re-emit the
    // *full* current plan, so append-only semantics would silently
    // lose user-visible state on edits. The diff is also the right
    // shape for Step 3's master re-plan path, where the backend may
    // invalidate proposed subtasks while keeping the done/running
    // ones untouched.
    const incomingIds = new Set(e.subtasks.map((s) => s.id));
    const currentSubtasks = get().subtasks;
    const currentIds = new Set(currentSubtasks.map((s) => s.id));

    const removedIds: string[] = [];
    for (const s of currentSubtasks) {
      if (!incomingIds.has(s.id)) removedIds.push(s.id);
    }
    if (removedIds.length > 0) {
      for (const id of removedIds) {
        const actor = get().nodeActors.get(id);
        if (actor) actor.stop();
      }
      set((state) => {
        const nextActors = new Map(state.nodeActors);
        const nextSnaps = new Map(state.nodeSnapshots);
        const nextLogs = new Map(state.nodeLogs);
        const nextRetries = new Map(state.subtaskRetryCounts);
        for (const id of removedIds) {
          nextActors.delete(id);
          nextSnaps.delete(id);
          nextLogs.delete(id);
          nextRetries.delete(id);
        }
        return {
          nodeActors: nextActors,
          nodeSnapshots: nextSnaps,
          nodeLogs: nextLogs,
          subtaskRetryCounts: nextRetries,
        };
      });
    }

    // Scrub provenance maps by the authoritative incoming id set rather
    // than `removedIds`. This handles a subtle add-then-remove race: a
    // user-added id lands in `userAddedSubtaskIds` via `addSubtask`'s
    // optimistic `set` BEFORE the backend's follow-up subtasks_proposed
    // adds it to `state.subtasks`. If that subtask is subsequently
    // removed without ever surfacing in the store list, the
    // `removedIds` walk misses it. Walking the tracking maps directly
    // closes that gap and is idempotent on the common path.
    const trackedOriginals = [...get().originalSubtasks.keys()];
    const trackedAdded = [...get().userAddedSubtaskIds];
    const orphanOriginals = trackedOriginals.filter((id) => !incomingIds.has(id));
    const orphanAdded = trackedAdded.filter((id) => !incomingIds.has(id));
    if (orphanOriginals.length > 0 || orphanAdded.length > 0) {
      set((state) => {
        const nextOriginals = new Map(state.originalSubtasks);
        const nextAdded = new Set(state.userAddedSubtaskIds);
        for (const id of orphanOriginals) nextOriginals.delete(id);
        for (const id of orphanAdded) nextAdded.delete(id);
        return {
          originalSubtasks: nextOriginals,
          userAddedSubtaskIds: nextAdded,
        };
      });
    }

    // Build the next subtasks list in incoming order (DAG layout
    // should follow the master's intent), spawning actors only for
    // brand-new ids.
    const nextSubtasks: SubtaskNodeData[] = [];
    const newIds: string[] = [];
    const pendingOriginals: Array<
      [string, { title: string; why: string | null; agent: BackendAgentKind }]
    > = [];
    const addedIds = get().userAddedSubtaskIds;
    const currentOriginals = get().originalSubtasks;
    for (const st of e.subtasks) {
      nextSubtasks.push({
        id: st.id,
        title: st.title,
        why: st.why,
        agent: st.assignedWorker,
        dependsOn: st.dependencies,
        replaces: st.replaces,
        replanCount: st.replanCount,
      });
      if (!currentIds.has(st.id)) {
        newIds.push(st.id);
        const actor = registerActor(st.id);
        actor.send({ type: 'PROPOSE' });
      }
      // Snapshot the master-original the first time we see a subtask
      // that isn't user-added. Skipped for already-known ids so a
      // post-edit re-emit doesn't stomp the baseline we're diffing
      // the "edited" badge against.
      if (
        !currentOriginals.has(st.id) &&
        !addedIds.has(st.id)
      ) {
        pendingOriginals.push([
          st.id,
          { title: st.title, why: st.why, agent: st.assignedWorker },
        ]);
      }
    }

    // Master transitions to proposed. On re-plan (master was approved),
    // route through thinking → proposed; on first wave (master thinking),
    // just PROPOSE. Machine no-ops PROPOSE from proposed, so re-emit is safe.
    const masterSnap = get().nodeSnapshots.get(MASTER_ID)?.value;
    if (masterSnap === 'approved') {
      sendTo(MASTER_ID, { type: 'THINK' });
    }
    sendTo(MASTER_ID, { type: 'PROPOSE' });

    // Selection: keep the user's prior picks intact across edits
    // (intersect with incoming), auto-select brand-new rows so
    // master-added / user-added subtasks aren't silently excluded
    // from the next Approve click. On the initial emit, priorSel is
    // empty and newIds is every incoming id — which reduces to
    // "select all", matching Phase 2 behaviour.
    set((state) => {
      const priorSel = state.selectedSubtaskIds;
      const nextSelected = new Set<string>();
      for (const id of priorSel) {
        if (incomingIds.has(id)) nextSelected.add(id);
      }
      for (const id of newIds) nextSelected.add(id);
      const nextOriginals =
        pendingOriginals.length > 0
          ? new Map(state.originalSubtasks)
          : state.originalSubtasks;
      for (const [id, snapshot] of pendingOriginals) {
        nextOriginals.set(id, snapshot);
      }
      return {
        subtasks: nextSubtasks,
        selectedSubtaskIds: nextSelected,
        originalSubtasks: nextOriginals,
        // Any pending replan completes when the next plan lands —
        // whether or not this emit actually carries the replacements
        // (a user edit during awaiting_approval also re-emits). The
        // ApprovalBar reads `replaces` on the nextSubtasks to decide
        // its copy variant, which is a strictly stronger signal.
        replanningSubtaskId: null,
      };
    });
  }

  function handleSubtaskStateChanged(e: SubtaskStateChanged) {
    if (e.runId !== get().runId) return;
    const current = get().nodeSnapshots.get(e.subtaskId)?.value;

    // Bump the retry counter *before* we transition the actor so a
    // subscriber that reads the snapshot + counter in the same render
    // pass sees both the `retrying` state and the incremented count.
    // Every backend Retrying event counts, including retries that
    // eventually succeed — see `subtaskRetryCounts` doc on GraphState
    // for the rationale.
    if (e.state === 'retrying') {
      set((state) => {
        const next = new Map(state.subtaskRetryCounts);
        next.set(e.subtaskId, (next.get(e.subtaskId) ?? 0) + 1);
        return { subtaskRetryCounts: next };
      });
    }

    const events = eventsForSubtaskState(e.state, current);
    for (const type of events) {
      sendTo(e.subtaskId, { type });
    }
  }

  function handleSubtaskLog(e: SubtaskLog) {
    if (e.runId !== get().runId) return;
    appendLog(e.subtaskId, e.line);
  }

  function handleDiffReady(e: DiffReady) {
    if (e.runId !== get().runId) return;
    ensureFinalNode();
    set((state) => {
      if (!state.finalNode) return state;
      return {
        finalNode: {
          ...state.finalNode,
          files: e.files.map((f) => f.path),
        },
      };
    });
    // Drive the final node's XState actor into `running` so FinalNode
    // renders its Apply button as enabled. Without this the actor sits
    // at `idle` forever and the merge UI looks clickable but is inert.
    // The machine no-ops unknown transitions from a later state, so
    // re-sending the full chain is safe on repeat DiffReady events
    // (e.g. master re-plan between approval and merge).
    const finalSnap = get().nodeSnapshots.get(FINAL_ID)?.value;
    if (finalSnap === 'idle') {
      sendTo(FINAL_ID, { type: 'PROPOSE' });
      sendTo(FINAL_ID, { type: 'APPROVE' });
      sendTo(FINAL_ID, { type: 'START' });
    }
  }

  function handleMergeConflict(e: MergeConflict) {
    if (e.runId !== get().runId) return;
    ensureFinalNode();
    set((state) => {
      if (!state.finalNode) return state;
      return {
        finalNode: {
          ...state.finalNode,
          conflictFiles: [...e.files],
        },
      };
    });
  }

  function handleBaseBranchDirty(e: BaseBranchDirty) {
    if (e.runId !== get().runId) return;
    // Distinct from MergeConflict: the user's base-branch WIP blocked
    // the merge before it started. Worker branches are clean, so we
    // don't want to paint the FinalNode as conflicting — it's still a
    // clean apply once the user tidies their own tree. Surface the
    // failure through `currentError` (ErrorBanner picks it up) with a
    // clear instruction and the offending file list so they know
    // exactly what to commit or stash.
    //
    // Prefix the absolute repo path so two same-named repos in
    // different parent dirs (e.g. `~/Projects/foo` vs
    // `~/Projects/archive/foo`) don't trick the user into cleaning
    // the wrong one. Cheap to include; saves a real debugging hour.
    const repoPath = useRepoStore.getState().currentRepo?.path;
    const where = repoPath ? ` in ${repoPath}` : '';
    const list = e.files.join(', ');
    const msg =
      e.files.length === 1
        ? `You have uncommitted changes${where}: ${list}. Commit or stash it, then click Apply again.`
        : `You have uncommitted changes${where} in ${e.files.length} files (${list}). Commit or stash them, then click Apply again.`;
    set({ currentError: msg });
  }

  function handleCompleted(e: Completed) {
    if (e.runId !== get().runId) return;
    // `Completed` fires after a successful apply. Clear any stale conflict
    // metadata, mark the run applied so App.tsx routes back to EmptyState,
    // and detach.
    set((state) => ({
      status: 'applied',
      finalNode: state.finalNode
        ? { ...state.finalNode, conflictFiles: null }
        : state.finalNode,
    }));
    // Land the final actor in its terminal `done` state. No-op if Apply
    // was never clicked (actor still at idle/proposed/approved), which
    // matches reality — Completed only reaches the frontend after a
    // successful merge, by which point the actor is already in running.
    sendTo(FINAL_ID, { type: 'COMPLETE' });
    detachActiveSubscription();
  }

  function handleFailed(e: Failed) {
    if (e.runId !== get().runId) return;
    set({ currentError: e.error, status: 'failed' });
    detachActiveSubscription();
  }

  function handleReplanStarted(e: ReplanStarted) {
    if (e.runId !== get().runId) return;
    // Flip the master chip back to "thinking" for the duration of the
    // replan call. The master actor is in `approved` by now (it signed
    // off on the original plan); the transition is approved → thinking
    // via THINK, and the follow-up `run:subtasks_proposed` walks it
    // back to `proposed` (see handleSubtasksProposed).
    const masterSnap = get().nodeSnapshots.get(MASTER_ID)?.value;
    if (masterSnap === 'approved') {
      sendTo(MASTER_ID, { type: 'THINK' });
    }
    set({ replanningSubtaskId: e.failedSubtaskId });
  }

  function handleHumanEscalation(e: HumanEscalation) {
    if (e.runId !== get().runId) return;
    // Drive the failed subtask's actor through the escalation path.
    // Backend invariants: the subtask's state is `Failed` by the time
    // HumanEscalation fires, so the local actor should be at `failed`.
    // Bridge through `escalating` in a single synchronous pair of
    // sends — XState processes events in order.
    const current = get().nodeSnapshots.get(e.subtaskId)?.value;
    if (current === 'failed') {
      sendTo(e.subtaskId, { type: 'ESCALATE' });
      sendTo(e.subtaskId, { type: 'HUMAN_NEEDED' });
    } else if (current === 'escalating') {
      // ReplanStarted → (master errored or returned empty plan) →
      // HumanEscalation without an intervening SubtasksProposed.
      // Actor is already in `escalating` from a prior ESCALATE send.
      sendTo(e.subtaskId, { type: 'HUMAN_NEEDED' });
    }
    set({
      replanningSubtaskId: null,
      humanEscalation: {
        subtaskId: e.subtaskId,
        reason: e.reason,
        suggestedAction: e.suggestedAction ?? null,
      },
    });
  }

  function buildHandlers() {
    return {
      onStatusChanged: handleStatusChanged,
      onMasterLog: handleMasterLog,
      onSubtasksProposed: handleSubtasksProposed,
      onSubtaskStateChanged: handleSubtaskStateChanged,
      onSubtaskLog: handleSubtaskLog,
      onDiffReady: handleDiffReady,
      onMergeConflict: handleMergeConflict,
      onBaseBranchDirty: handleBaseBranchDirty,
      onCompleted: handleCompleted,
      onFailed: handleFailed,
      onReplanStarted: handleReplanStarted,
      onHumanEscalation: handleHumanEscalation,
      onParseError: defaultOnParseError,
    };
  }

  // ---------- Public actions ----------

  return {
    ...initial,

    setMasterAgent(agent) {
      set({ selectedMasterAgent: agent });
    },

    async submitTask(input, masterAgent) {
      // `handleCompleted` / `handleFailed` mark the run terminal but
      // leave `runId` populated (the final graph is still on-screen
      // until the user acts). Once App.tsx routes back to EmptyState
      // (on `applied` / `rejected` / `failed`) the user can legally
      // submit a new task — clean up the stale run first. Only refuse
      // when there's genuinely a live run in flight.
      const { runId: priorRunId, status: priorStatus } = get();
      if (priorRunId !== null) {
        const priorIsTerminal =
          priorStatus === 'applied' ||
          priorStatus === 'rejected' ||
          priorStatus === 'failed';
        if (!priorIsTerminal) {
          throw new Error(
            'A run is already active. Reset or discard the current run before submitting again.',
          );
        }
        get().reset();
      }

      const repoPath = useRepoStore.getState().currentRepo?.path;
      if (!repoPath) {
        throw new Error('No repo selected');
      }

      const agent = masterAgent ?? get().selectedMasterAgent;

      // Optimistic master actor + planning status — gives instant feedback
      // while the IPC round-trip happens. Backend's status_changed(Planning)
      // will re-confirm once the subscription is attached.
      const masterActor = registerActor(MASTER_ID);
      masterActor.send({ type: 'THINK' });
      set({
        runId: newLocalRunId(),
        taskInput: input,
        masterNode: { id: MASTER_ID, agent: 'master', label: 'Master' },
        selectedMasterAgent: agent,
        status: 'planning',
        currentError: null,
      });

      let realRunId: string;
      try {
        realRunId = await submitTaskIpc(input, repoPath);
      } catch (err) {
        get().reset();
        set({ currentError: `Failed to start run: ${String(err)}` });
        throw err;
      }

      const subscription = new RunSubscription(realRunId, buildHandlers());
      try {
        await subscription.attach();
      } catch (err) {
        // Attach failed — we can't observe the run. Best effort: ask backend
        // to cancel so we don't leak a detached run, then clear.
        void cancelRunIpc(realRunId).catch(() => undefined);
        get().reset();
        set({ currentError: `Failed to subscribe to run: ${String(err)}` });
        throw err;
      }

      set({ runId: realRunId, activeSubscription: subscription });
    },

    toggleSubtaskSelection(id) {
      set((state) => {
        const next = new Set(state.selectedSubtaskIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return { selectedSubtaskIds: next };
      });
    },

    selectAll() {
      set((state) => ({
        selectedSubtaskIds: new Set(state.subtasks.map((s) => s.id)),
      }));
    },

    selectNone() {
      set({ selectedSubtaskIds: new Set() });
    },

    async approveSubtasks(ids) {
      const runId = get().runId;
      if (!runId) return;
      try {
        await approveSubtasksIpc(runId, ids);
      } catch (err) {
        set({ currentError: `Approval failed: ${String(err)}` });
        throw err;
      }
    },

    async rejectAll() {
      const runId = get().runId;
      if (!runId) return;
      try {
        await rejectRunIpc(runId);
      } catch (err) {
        set({ currentError: `Reject failed: ${String(err)}` });
        throw err;
      }
      // Mirror `discardRun`: the user said no, the backend has the
      // rejection, we drop the graph immediately and land back in
      // EmptyState. Without this the run stays on screen in its
      // "awaiting approval" layout — ApprovalBar is gone (status has
      // flipped to `rejected`) but the Master + proposed subtask
      // cards stay, with no UI affordance to move on. The eventual
      // `StatusChanged(rejected)` event from the backend lands on a
      // detached subscription and is safely ignored.
      get().reset();
    },

    async applyRun() {
      const runId = get().runId;
      if (!runId) return;
      // Clear any stale "base branch dirty" / "apply failed" error from a
      // prior attempt. If the new attempt fails the same way, the
      // event handler will repopulate with the fresh file list.
      set({ currentError: null });
      try {
        await applyRunIpc(runId);
      } catch (err) {
        set({ currentError: `Apply failed: ${String(err)}` });
        throw err;
      }
    },

    async discardRun() {
      const runId = get().runId;
      if (!runId) {
        // No active run — user still expects the graph to clear.
        get().reset();
        return;
      }
      try {
        await discardRunIpc(runId);
      } catch (err) {
        set({ currentError: `Discard failed: ${String(err)}` });
        throw err;
      }
      get().reset();
    },

    async cancelRun() {
      const runId = get().runId;
      if (!runId) return;
      try {
        await cancelRunIpc(runId);
      } catch (err) {
        set({ currentError: `Cancel failed: ${String(err)}` });
        throw err;
      }
    },

    async updateSubtask(subtaskId, patch) {
      const runId = get().runId;
      if (!runId) return;
      try {
        await updateSubtaskIpc(runId, subtaskId, patch);
      } catch (err) {
        set({ currentError: mapEditError(err, 'Update') });
        throw err;
      }
      // Backend emits a fresh `run:subtasks_proposed` on success — the
      // diff-by-id handler picks it up and updates the subtask in
      // place. We don't touch store state here.
    },

    async addSubtask(draft) {
      const runId = get().runId;
      if (!runId) {
        // Unlike update/remove, `addSubtask` has a return value — we
        // can't silently resolve with a fake id. Treat no-run as a
        // hard failure so the caller's edit row surfaces feedback.
        const msg = 'No active run to add a subtask to.';
        set({ currentError: msg });
        throw new Error(msg);
      }
      try {
        const id = await addSubtaskIpc(runId, draft);
        // Mark as user-added *before* the handler sees the follow-up
        // run:subtasks_proposed — that handler checks this set to
        // decide whether to snapshot an "original" for the edited-badge
        // diff. User-added ids skip the snapshot (they get "added"
        // instead of "edited"). Also stash id so the newly-mounted
        // WorkerNode enters edit mode on its title; the flag is one-
        // shot, consumed by clearLastAddedSubtaskId below.
        set((state) => {
          const next = new Set(state.userAddedSubtaskIds);
          next.add(id);
          return { userAddedSubtaskIds: next, lastAddedSubtaskId: id };
        });
        return id;
      } catch (err) {
        set({ currentError: mapEditError(err, 'Add') });
        throw err;
      }
    },

    async removeSubtask(subtaskId) {
      const runId = get().runId;
      if (!runId) return;
      try {
        await removeSubtaskIpc(runId, subtaskId);
      } catch (err) {
        set({ currentError: mapEditError(err, 'Remove') });
        throw err;
      }
      // Backend's follow-up run:subtasks_proposed will drop the id from
      // the subtasks list via the diff-by-id handler, which also scrubs
      // originalSubtasks / userAddedSubtaskIds. No store mutation here.
    },

    async manualFixSubtask(subtaskId) {
      const runId = get().runId;
      if (!runId) {
        const msg = 'No active run.';
        set({ currentError: msg });
        throw new Error(msg);
      }
      let result: EditorResult;
      try {
        result = await manualFixSubtaskIpc(runId, subtaskId);
      } catch (err) {
        set({ currentError: mapEditError(err, 'Action') });
        throw err;
      }
      // clipboard-only is the bottom tier of the backend's editor
      // fallback chain — nothing launched. The frontend owns the
      // clipboard write (so the Rust side stays free of a clipboard
      // crate) and we surface a short info line via `currentError`
      // so the user sees where to paste. The other tiers resolve
      // silently — the user's editor is already popping up.
      if (result.method === 'clipboard-only') {
        try {
          await navigator.clipboard.writeText(result.path);
          set({
            currentError: `Path copied to clipboard: ${result.path}\nOpen the worktree in your editor, make changes, then click "I fixed it".`,
          });
        } catch {
          // Clipboard write can be denied (non-focused iframe, old
          // browser permissions). Degrade to "here's the path" — the
          // user can still copy it manually from the banner.
          set({
            currentError: `Open this worktree in your editor, then click "I fixed it": ${result.path}`,
          });
        }
      }
      return result;
    },

    async markSubtaskFixed(subtaskId) {
      const runId = get().runId;
      if (!runId) return;
      try {
        await markSubtaskFixedIpc(runId, subtaskId);
      } catch (err) {
        set({ currentError: mapEditError(err, 'Action') });
        throw err;
      }
      // Backend re-enters dispatcher and emits state changes
      // (subtask → Done, run → Running, any Waiting dependents
      // unblock). Store mutations land through the event path.
    },

    async skipSubtask(subtaskId) {
      const runId = get().runId;
      if (!runId) {
        const msg = 'No active run.';
        set({ currentError: msg });
        throw new Error(msg);
      }
      let result: SkipResult;
      try {
        result = await skipSubtaskIpc(runId, subtaskId);
      } catch (err) {
        set({ currentError: mapEditError(err, 'Action') });
        throw err;
      }
      // The backend emits SubtaskStateChanged(Skipped) for every
      // cascaded id, which drives the per-node actors. The count
      // is returned so the caller can surface a confirmation toast
      // — we don't mutate store state here.
      return result;
    },

    async tryReplanAgain(subtaskId) {
      const runId = get().runId;
      if (!runId) return;
      try {
        await tryReplanAgainIpc(runId, subtaskId);
      } catch (err) {
        set({ currentError: mapEditError(err, 'Action') });
        throw err;
      }
      // Backend emits ReplanStarted and flips the run back to
      // `planning` — the ReplanStarted handler drives the master
      // chip back to thinking.
    },

    clearLastAddedSubtaskId() {
      // Guard the no-op case so callers can fire-and-forget from a
      // layout effect without flashing `set` on every render.
      if (get().lastAddedSubtaskId === null) return;
      set({ lastAddedSubtaskId: null });
    },

    dismissError() {
      set({ currentError: null });
    },

    reset() {
      detachActiveSubscription();
      for (const actor of get().nodeActors.values()) actor.stop();
      set({
        ...initial,
        nodeActors: new Map(),
        nodeSnapshots: new Map(),
        nodeLogs: new Map(),
        subtaskRetryCounts: new Map(),
        originalSubtasks: new Map(),
        userAddedSubtaskIds: new Set(),
        lastAddedSubtaskId: null,
        replanningSubtaskId: null,
        humanEscalation: null,
      });
    },
  };
});
