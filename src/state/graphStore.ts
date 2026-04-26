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
  cancelSubtask as cancelSubtaskIpc,
  stashAndRetryApply as stashAndRetryApplyIpc,
  popStash as popStashIpc,
  retryApply as retryApplyIpc,
  answerSubtaskQuestion as answerSubtaskQuestionIpc,
  skipSubtaskQuestion as skipSubtaskQuestionIpc,
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
  type ApplySummary,
  type AutoApproveSuspended,
  type AutoApproved,
  type BaseBranchDirty,
  type Completed,
  type DiffReady,
  type ErrorCategoryWire,
  type EditorResult,
  type Failed,
  type FileDiff,
  type HumanEscalation,
  type MasterLog,
  type MergeConflict,
  type MergeRetryFailed,
  type ReplanStarted,
  type RunStatus,
  type StashCreated,
  type StashPopFailed,
  type StashPopped,
  type SubtaskActivity,
  type SubtaskAnswerReceived,
  type SubtaskQuestionAsked,
  type SubtaskThinking,
  type SkipResult,
  type StatusChanged,
  type SubtaskDiff,
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
   * Phase 4 Step 5: per-subtask wire-level crash category. Populated
   * from `SubtaskStateChanged` when `state === 'failed'` *and* the
   * backend supplied an `errorCategory`; other transitions leave the
   * entry untouched (Running / Retrying / Done / Skipped never carry
   * a category on the wire). Drives:
   *   - ErrorBanner's category-specific variant + locked copy.
   *   - WorkerNode's inline label next to the "Failed" status.
   *
   * Cleared on `reset` and per-subtask scrubbed alongside logs /
   * retries / provenance when a subtask is dropped from the plan.
   */
  subtaskErrorCategories: Map<string, ErrorCategoryWire>;
  /**
   * Phase 3.5 Item 6: per-subtask file diffs surfaced by the backend's
   * `run:subtask_diff` event during the Apply pre-merge pass. One entry
   * per done subtask (including empty-vec entries for subtasks that ran
   * but touched no files). The WorkerNode's "N files" chip reads this;
   * a click opens the popover that lists each file with +/- counts.
   *
   * Cleared on run reset. A subtask removed from the plan (replan drop,
   * user remove) also has its entry scrubbed alongside logs / retries /
   * provenance — same pattern as every other per-subtask map.
   */
  subtaskDiffs: Map<string, readonly FileDiff[]>;
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
  /**
   * Phase 4 Step 5: user-dismissal latch for the category-aware banner
   * path. `currentError` already self-dismisses via `dismissError`, but
   * `subtaskErrorCategories` is persistent run state (WorkerNode reads
   * it for the inline chip) so we can't clear it on dismiss. Instead we
   * flip this flag, and the banner treats a `true` value as "nothing to
   * say right now". Re-arms to `false` whenever a new `Failed`
   * transition lands a category the user hasn't seen yet — i.e. a new
   * subtask id, or a new kind on a previously-dismissed id.
   */
  errorCategoryBannerDismissed: boolean;
  /**
   * Phase 3 Step 7: set when the backend emits `run:auto_approved` for
   * the active run; the UI surfaces a transient "plan auto-approved"
   * chip on the graph canvas. Tracks the most recent pass's subtask
   * ids so the chip count matches what was dispatched. Cleared on
   * `reset` or when a new `submitTask` begins.
   */
  autoApproved: { subtaskIds: string[]; at: number } | null;
  /**
   * Phase 3 Step 7: set when the backend emits
   * `run:auto_approve_suspended` — the run hit its ceiling and fell
   * back to manual approval. `reason` is the machine key
   * (`"subtask_limit"` today) used to pick user-facing copy; the UI
   * renders a dismissable banner that stays until the run ends.
   * Latched — backend only emits once per run.
   */
  autoApproveSuspended: { reason: string } | null;
  /**
   * Phase 4 Step 2: set when the backend emits `run:apply_summary` on a
   * successful Apply. Drives the bottom-right ApplySummaryOverlay (total
   * files changed, branch, commit SHA, per-worker rows). Sticky: cleared
   * only by explicit user action — `dismissApplySummary` (Dismiss click)
   * or `reset` (new run submit). NOT cleared on `Completed` or the
   * terminal `StatusChanged(Done)` so the overlay survives the run
   * going terminal.
   *
   * Ordering invariant (from `orchestration/lifecycle.rs::finalize_applied`):
   * `DiffReady → Completed → StatusChanged(Done) → ApplySummary`. By
   * the time this slice lands the store has already transitioned to
   * `applied`, so a render reading both sees a consistent pair.
   */
  applySummary: ApplySummary | null;
  /**
   * Phase 4 Step 3: subtask ids whose worker card is expanded to show
   * the full scrollable log. Per-node, in-session only — cleared on
   * `reset` / new submit. Lives in the store (not in local component
   * state) so it survives node re-renders triggered by graph-wide
   * recomputes, is observable for tests, and so the layout pass in
   * `GraphCanvas` can promote these ids to the content-fit expanded
   * tier without prop-drilling through WorkerNode.
   *
   * Only promoted for non-proposed states: the proposed-state card is
   * already a click target (selection toggle), and there's no log
   * content to expand into. `toggleWorkerExpanded` enforces this at
   * the caller (WorkerNode gates on state); the store itself is
   * permissive so tests can set arbitrary ids.
   */
  workerExpanded: ReadonlySet<string>;
  /**
   * Bug #5 follow-up: the window between `submitTask`'s optimistic local
   * runId (`pending_*`) and the real backend runId landing is roughly an
   * IPC round-trip, but if the user clicks Cancel in that window the
   * naive path calls `cancelRunIpc('pending_xxx')` — an id the backend
   * doesn't recognise, so `cancel_run` returns `Ok(())` silently and
   * nothing actually happens. This flag defers the cancel until the real
   * id lands in `submitTask`; the tail of `submitTask` consumes it.
   */
  pendingCancel: boolean;
  /**
   * Phase 3.5 Item 1: true between the moment the user confirms cancel
   * and the moment the backend emits `StatusChanged(Cancelled)`. The
   * TopBar reads this to show a disabled "Cancelling…" affordance in
   * place of the normal cancel button so the user has a continuous
   * visual signal that their click is being honoured — the backend's
   * drain phase is bounded at ~2s but still long enough to look
   * unresponsive without an indicator.
   *
   * Cleared in `handleStatusChanged` whenever the run transitions out
   * of a cancellable state (cancelled / done / failed / rejected /
   * applied). Also cleared on `reset` so a subsequent run starts clean.
   */
  cancelInFlight: boolean;

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
   * Phase 5 Step 1: per-worker stop. Cancels exactly one subtask
   * without cancelling the run. Backend rejects with a string error
   * if the subtask is not in `running` / `retrying` / `waiting`;
   * callers render the rejection as a toast (e.g. `SubtaskActionsMenu`)
   * and the transient `subtaskCancelInFlight` flag rolls back.
   */
  cancelSubtask: (subtaskId: SubtaskId) => Promise<void>;
  /**
   * Phase 5 Step 2: stash the dirty base branch and retry Apply.
   * Clears `baseBranchDirty` + `currentError` on success once the
   * backend emits `StashCreated`. Backend rejection surfaces via
   * `currentError`; the in-flight flag rolls back.
   */
  stashAndRetryApply: () => Promise<void>;
  /**
   * Phase 5 Step 2: pop the stash recorded by
   * `stashAndRetryApply`. Backend confirms via `StashPopped`
   * (happy path — stash cleared) or `StashPopFailed` (conflict
   * preserved / missing cleared). Backend rejection surfaces via
   * `currentError`; the in-flight flag rolls back.
   */
  popStash: () => Promise<void>;
  /**
   * Phase 5 Step 3: re-attempt the merge after the user resolved the
   * conflict externally. Semantic alias for apply_run — backend
   * sends `ApplyDecision::Apply` to the re-installed oneshot.
   * Backend rejection (stale state — oneshot already consumed)
   * surfaces via `currentError` as a toast trigger.
   */
  retryApply: () => Promise<void>;
  /** Phase 5 Step 3: open or close the conflict resolver popover. */
  setConflictResolverOpen: (open: boolean) => void;
  /**
   * Phase 6 Step 3: toggle the "Show thinking" panel on a worker
   * card. No-op for workers whose adapter doesn't expose thinking
   * (Codex / Gemini per `THINKING_CAPABLE_AGENTS`); the UI gates
   * the affordance independently so the action never fires for
   * those workers in practice.
   */
  toggleWorkerThinking: (subtaskId: SubtaskId) => void;
  /**
   * Phase 5 Step 4: deliver the user's answer to a parked question.
   * Sets `questionAnswerInFlight` while the IPC is out; the store
   * clears it on the backend's next `SubtaskStateChanged(Running)`
   * (answer delivered) / `Done` (skipped) emit or on IPC rejection.
   */
  answerSubtaskQuestion: (subtaskId: SubtaskId, answer: string) => Promise<void>;
  /**
   * Phase 5 Step 4: flag the detected question as a false positive.
   * Subtask finalizes as Done with current output.
   */
  skipSubtaskQuestion: (subtaskId: SubtaskId) => Promise<void>;
  /**
   * Phase 5 Step 1: ids of subtasks with a cancel_subtask IPC in
   * flight. The footer renders "Stopping…" while an id sits here.
   * Cleared on the backend's `SubtaskStateChanged { state: cancelled }`
   * event, or on IPC rejection (the backend refused; roll back so the
   * button becomes clickable again).
   */
  subtaskCancelInFlight: ReadonlySet<SubtaskId>;
  /**
   * Phase 5 Step 2: populated while a run is in `merging` and the
   * last apply attempt surfaced `BaseBranchDirty`. The list of dirty
   * files drives the "You have uncommitted changes …" banner + the
   * one-click "Stash & retry apply" action. Cleared on any
   * non-dirty state transition (Applied / Merging after a successful
   * retry / Rejected / Cancelled).
   */
  baseBranchDirty: { files: string[] } | null;
  /**
   * Phase 5 Step 2: stash state tracked by the frontend across the
   * `run:stash_*` event family. `ref` is the opaque SHA the backend
   * emitted — the user can copy it for manual recovery. `popFailed`
   * is populated when the most recent `pop_stash` attempt surfaced a
   * conflict (stash preserved) or missing ref (stash cleared by the
   * backend); unset on success / never attempted. Cleared on
   * `reset()` so a new run starts without stale state.
   */
  stash: {
    ref: string;
    popFailed: { kind: 'conflict' | 'missing'; error: string } | null;
  } | null;
  /**
   * Phase 5 Step 2: `true` between the moment the user clicks "Stash
   * & retry" or "Pop stash" and the moment the backend confirms the
   * resulting event. UI renders a disabled / busy affordance over
   * the relevant control. Roll back on IPC rejection.
   */
  stashInFlight: 'stash-and-retry' | 'pop' | null;
  /**
   * Phase 5 Step 3: populated while a run is in `merging` with an
   * unresolved conflict. `files` is the conflicted path list from the
   * latest `MergeConflict` / `MergeRetryFailed` event. `retryAttempt`
   * starts at 0 on the initial conflict and increments with each
   * post-retry failure — the UI flips banner copy from "Merge
   * conflict" to "Still conflicted (attempt N)". Cleared on
   * applied / discarded / cancelled / reset.
   */
  mergeConflict: { files: string[]; retryAttempt: number } | null;
  /**
   * Phase 5 Step 3: `true` between the moment the user clicks "Retry
   * apply" and the moment the backend confirms the outcome (Applied /
   * MergeRetryFailed / cancelled). Disables the button + surfaces
   * "Retrying…" copy while set. Cleared on every terminal outcome
   * event and on IPC rejection.
   */
  retryApplyInFlight: boolean;
  /**
   * Phase 5 Step 3: whether the conflict resolver popover is open.
   * Auto-set to `true` on every `MergeConflict` / `MergeRetryFailed`
   * event so the user never misses an attempt. User can dismiss via
   * Escape / backdrop; the ErrorBanner's "Open resolver" action
   * flips it back to true.
   */
  conflictResolverOpen: boolean;
  /**
   * Phase 5 Step 4: active questions keyed by subtask id. Populated
   * on `run:subtask_question_asked`, cleared on
   * `run:subtask_answer_received` / `SubtaskStateChanged(Running|Done|Failed|
   * Skipped|Cancelled)`. Multiple subtasks may have pending questions
   * simultaneously — the UI renders each on its own card.
   */
  /**
   * Phase 6 Step 2 — per-subtask activity stream. Capped at 50
   * events per subtask (FIFO eviction); store memory-only, no
   * persistence. UI renders via `compressActivities` + chip-stack
   * component.
   */
  subtaskActivities: ReadonlyMap<
    SubtaskId,
    ReadonlyArray<{ event: import('../lib/ipc').ToolEvent; timestampMs: number }>
  >;
  /**
   * Phase 6 Step 3 — per-subtask thinking-block stream. Capped at
   * 500 chunks per subtask (FIFO). Currently Claude-only — Codex
   * and Gemini emit no events into this map.
   */
  subtaskThinking: ReadonlyMap<SubtaskId, ReadonlyArray<{ chunk: string; timestampMs: number }>>;
  /**
   * Phase 6 Step 3 — per-worker "Show thinking" toggle. Default off
   * (thinking is verbose; opt-in for users who want depth).
   * Membership in this set means the panel is visible for that
   * subtask; absent means hidden. Per-worker independent — toggling
   * one card doesn't affect siblings. Cleared on `reset` so a new
   * run starts clean.
   */
  workerThinkingVisible: ReadonlySet<SubtaskId>;
  pendingQuestions: ReadonlyMap<SubtaskId, { question: string }>;
  /**
   * Phase 5 Step 4: transient per-subtask flag for "the answer /
   * skip IPC is in flight." UI renders "Sending…" + disables
   * controls while set. Cleared on the terminal subtask-state emit
   * (running / done / cancelled) or on IPC rejection.
   */
  questionAnswerInFlight: ReadonlySet<SubtaskId>;
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
  /**
   * Dismiss the "auto-approve suspended" banner for the current run.
   * UI-only — the backend latch stays in place, so further passes in
   * the run stay manual regardless of dismissal.
   */
  dismissAutoApproveSuspended: () => void;
  /**
   * Dismiss the Apply-summary overlay. Resets the store to `idle`: the
   * graph data goes away, the overlay disappears, App.tsx routes back
   * to EmptyState. Semantically equivalent to the user saying "I've
   * seen the result, take me home" — there's no state after Applied
   * worth preserving since a fresh submit would `reset()` anyway.
   */
  dismissApplySummary: () => void;
  /**
   * Phase 4 Step 3: toggle worker card expand/collapse. WorkerNode
   * gates this on state (disabled in `proposed`); the store itself
   * is permissive. `GraphCanvas.buildGraph` promotes expanded ids
   * content-fit height tier (floor 200, ceiling 340, computed from
   * log-line count), and `layoutGraph` runs as usual —
   * row-max alignment means a whole row expands when any one worker
   * does, which keeps the visual grid honest.
   */
  toggleWorkerExpanded: (subtaskId: SubtaskId) => void;
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
  | 'subtaskErrorCategories'
  | 'subtaskDiffs'
  | 'originalSubtasks'
  | 'userAddedSubtaskIds'
  | 'lastAddedSubtaskId'
  | 'replanningSubtaskId'
  | 'humanEscalation'
  | 'activeSubscription'
  | 'currentError'
  | 'errorCategoryBannerDismissed'
  | 'autoApproved'
  | 'autoApproveSuspended'
  | 'applySummary'
  | 'workerExpanded'
  | 'pendingCancel'
  | 'cancelInFlight'
  | 'subtaskCancelInFlight'
  | 'baseBranchDirty'
  | 'stash'
  | 'stashInFlight'
  | 'mergeConflict'
  | 'retryApplyInFlight'
  | 'conflictResolverOpen'
  | 'pendingQuestions'
  | 'questionAnswerInFlight'
  | 'subtaskActivities'
  | 'subtaskThinking'
  | 'workerThinkingVisible'
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
  subtaskErrorCategories: new Map(),
  subtaskDiffs: new Map(),
  originalSubtasks: new Map(),
  userAddedSubtaskIds: new Set(),
  lastAddedSubtaskId: null,
  replanningSubtaskId: null,
  humanEscalation: null,
  activeSubscription: null,
  currentError: null,
  errorCategoryBannerDismissed: false,
  autoApproved: null,
  autoApproveSuspended: null,
  applySummary: null,
  workerExpanded: new Set(),
  pendingCancel: false,
  cancelInFlight: false,
  subtaskCancelInFlight: new Set(),
  baseBranchDirty: null,
  stash: null,
  stashInFlight: null,
  mergeConflict: null,
  retryApplyInFlight: false,
  conflictResolverOpen: false,
  pendingQuestions: new Map(),
  questionAnswerInFlight: new Set(),
  subtaskActivities: new Map(),
  subtaskThinking: new Map(),
  workerThinkingVisible: new Set(),
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
      // Phase 5 Step 4: backend transitions AwaitingInput → Running
      // on both answer (re-execute) and skip (finalize path). The
      // machine's equivalent is ANSWER_RECEIVED which lands back in
      // running.
      if (current === 'awaiting_input') return ['ANSWER_RECEIVED'];
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
    case 'cancelled':
      // Phase 5 Step 1: user-initiated per-worker stop (distinct from
      // run-wide cancel, which is driven through `handleStatusChanged`).
      // The node machine accepts CANCEL from every non-final state, so
      // a single dispatch is enough regardless of where the actor sits.
      return ['CANCEL'];
    case 'awaiting-input':
      // Phase 5 Step 4: backend detected a question on the worker's
      // output. Only valid from `running`. Other current states are
      // handled defensively via bridge events — the backend always
      // transitions through `running` before entering `awaiting_input`,
      // so direct jumps from other states shouldn't happen in practice.
      if (current === 'running') return ['ASK_QUESTION'];
      if (current === 'proposed') return ['APPROVE', 'START', 'ASK_QUESTION'];
      if (current === 'waiting') return ['UNBLOCK', 'START', 'ASK_QUESTION'];
      if (current === 'approved') return ['START', 'ASK_QUESTION'];
      return [];
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

    // Cancelled: sweep every non-final actor into the `cancelled` terminal
    // state so the graph stops animating. Without this, a run cancelled
    // during `planning` leaves the master node stuck in its pulsing
    // thinking loop forever — visually identical to "still running", which
    // is exactly how users read the cancel as "didn't work" (bug #5).
    // CANCEL is a no-op from `done`/`skipped` (XState finals don't accept
    // events), so it's safe to fan out blindly.
    if (mapped === 'cancelled') {
      for (const id of get().nodeActors.keys()) {
        sendTo(id, { type: 'CANCEL' });
      }
    }

    // Terminal events auto-detach. `merging` is NOT terminal — it's the
    // transient apply state, and conflicts may keep the run alive.
    // `cancelled` IS terminal: the backend's `finalize_cancelled` emits a
    // single StatusChanged(Cancelled) and stops all workers, so we detach
    // symmetrically with failed/rejected. Without this, the subscription
    // stays wired to a dead run and `submitTask`'s `priorIsTerminal`
    // guard throws "A run is already active" — a soft-lock the user can
    // only escape by full-reloading the app.
    //
    // `done` is NOT in the detach list: the backend's Phase 4 Step 2
    // apply-summary path emits `StatusChanged(Done) → ApplySummary`.
    // Detaching on `done` would kill the listener mid-sequence and drop
    // the summary payload. The applied-path detach is handled by
    // `handleApplySummary` once the overlay payload is parked.
    if (
      mapped === 'failed' ||
      mapped === 'rejected' ||
      mapped === 'cancelled'
    ) {
      detachActiveSubscription();
      // Terminal → clear the transient "Cancelling…" indicator so the
      // next run starts clean. `cancelled` is the happy path here;
      // failed/rejected also clear it because the user's intent was
      // honoured (the cancel lost the race with natural completion,
      // but the result is the same: run is over).
      if (get().cancelInFlight) {
        set({ cancelInFlight: false });
      }
      // Phase 5 Step 3: clear any parked conflict payload + transient
      // retry flag so a subsequent run starts without the resolver
      // action lingering from the prior life.
      if (
        get().mergeConflict !== null ||
        get().retryApplyInFlight ||
        get().conflictResolverOpen
      ) {
        set({
          mergeConflict: null,
          retryApplyInFlight: false,
          conflictResolverOpen: false,
        });
      }
    } else if (mapped === 'done') {
      // Same indicator-clearing semantics as the other terminals, just
      // without the detach. The subscription stays alive one more hop
      // to receive ApplySummary.
      if (get().cancelInFlight) {
        set({ cancelInFlight: false });
      }
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
        const nextCategories = new Map(state.subtaskErrorCategories);
        const nextDiffs = new Map(state.subtaskDiffs);
        // Step 3: same scrub pattern for the expand set — an expanded
        // subtask dropped by a replan shouldn't leave a dangling id
        // that would silently promote the next reused ulid to expand
        // state. Only allocate a new Set when something would actually
        // be removed, so identity stays stable on the common path.
        let nextExpanded: Set<string> | null = null;
        for (const id of removedIds) {
          nextActors.delete(id);
          nextSnaps.delete(id);
          nextLogs.delete(id);
          nextRetries.delete(id);
          nextCategories.delete(id);
          nextDiffs.delete(id);
          if (state.workerExpanded.has(id)) {
            if (!nextExpanded) nextExpanded = new Set(state.workerExpanded);
            nextExpanded.delete(id);
          }
        }
        return {
          nodeActors: nextActors,
          nodeSnapshots: nextSnaps,
          nodeLogs: nextLogs,
          subtaskRetryCounts: nextRetries,
          subtaskErrorCategories: nextCategories,
          subtaskDiffs: nextDiffs,
          ...(nextExpanded ? { workerExpanded: nextExpanded } : {}),
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

    // Phase 4 Step 5: stash the crash category *before* the state
    // transition so any subscriber that reads `subtaskErrorCategories`
    // in the same render pass as `nodeSnapshots.get(id) === 'failed'`
    // sees both fields consistent. Only populated when the backend
    // supplied one — non-failure transitions and pre-Step-5 backends
    // leave the entry absent.
    if (e.state === 'failed' && e.errorCategory !== undefined) {
      const category = e.errorCategory;
      set((state) => {
        const next = new Map(state.subtaskErrorCategories);
        const prior = next.get(e.subtaskId);
        next.set(e.subtaskId, category);
        // Re-arm the banner dismissal latch whenever a genuinely new
        // signal lands — a first-time failure for this id, or a new
        // kind on a previously-dismissed id. Same-kind re-emits (the
        // dispatcher is allowed to re-deliver `Failed` on replan
        // re-entry) leave the latch alone so the user doesn't see the
        // same banner resurrect mid-interaction.
        const rearm = prior === undefined || prior.kind !== category.kind;
        return {
          subtaskErrorCategories: next,
          ...(rearm ? { errorCategoryBannerDismissed: false } : {}),
        };
      });
    }

    const events = eventsForSubtaskState(e.state, current);
    for (const type of events) {
      sendTo(e.subtaskId, { type });
    }

    // Phase 5 Step 1: clear the per-subtask cancel-in-flight marker
    // once the backend confirms a terminal transition. `cancelled` is
    // the happy path (the cancel IPC worked); the other terminals
    // cover the race where the subtask reached `done`/`failed`/`skipped`
    // before the kill signal landed — roll back the transient UI
    // either way so the "Stopping…" badge doesn't stick.
    if (
      (e.state === 'cancelled' ||
        e.state === 'done' ||
        e.state === 'failed' ||
        e.state === 'skipped') &&
      get().subtaskCancelInFlight.has(e.subtaskId)
    ) {
      set((state) => {
        const next = new Set(state.subtaskCancelInFlight);
        next.delete(e.subtaskId);
        return { subtaskCancelInFlight: next };
      });
    }

    // Phase 5 Step 4: clear pending-question entries when the
    // subtask moves out of `awaiting-input`. `running` means the
    // backend delivered the answer and the worker is re-executing;
    // `done` / `failed` / `cancelled` / `skipped` all terminate
    // the Q&A lifecycle. The matching transient `answerInFlight`
    // marker clears on the same events.
    if (
      e.state !== 'awaiting-input' &&
      (get().pendingQuestions.has(e.subtaskId) ||
        get().questionAnswerInFlight.has(e.subtaskId))
    ) {
      set((state) => {
        const nextPending = new Map(state.pendingQuestions);
        nextPending.delete(e.subtaskId);
        const nextInFlight = new Set(state.questionAnswerInFlight);
        nextInFlight.delete(e.subtaskId);
        return {
          pendingQuestions: nextPending,
          questionAnswerInFlight: nextInFlight,
        };
      });
    }
  }

  function handleSubtaskQuestionAsked(e: SubtaskQuestionAsked) {
    if (e.runId !== get().runId) return;
    set((state) => {
      const next = new Map(state.pendingQuestions);
      next.set(e.subtaskId, { question: e.question });
      return { pendingQuestions: next };
    });
  }

  function handleSubtaskAnswerReceived(e: SubtaskAnswerReceived) {
    if (e.runId !== get().runId) return;
    // Clear the in-flight marker proactively so the "Sending…" UI
    // dismisses the moment the backend confirms delivery. The
    // pendingQuestions entry clears on the subsequent
    // `SubtaskStateChanged(Running)` emit, which follows this event
    // per the backend's ordering.
    if (!get().questionAnswerInFlight.has(e.subtaskId)) return;
    set((state) => {
      const next = new Set(state.questionAnswerInFlight);
      next.delete(e.subtaskId);
      return { questionAnswerInFlight: next };
    });
  }

  function handleSubtaskActivity(e: SubtaskActivity) {
    if (e.runId !== get().runId) return;
    set((state) => {
      const next = new Map(state.subtaskActivities);
      const existing = next.get(e.subtaskId) ?? [];
      const appended = [
        ...existing,
        { event: e.event, timestampMs: e.timestampMs },
      ];
      // FIFO cap at 50 events per subtask. Older events drop off —
      // streaming surface, not a log.
      const capped = appended.length > 50 ? appended.slice(-50) : appended;
      next.set(e.subtaskId, capped);
      return { subtaskActivities: next };
    });
  }

  function handleSubtaskThinking(e: SubtaskThinking) {
    if (e.runId !== get().runId) return;
    set((state) => {
      const next = new Map(state.subtaskThinking);
      const existing = next.get(e.subtaskId) ?? [];
      const appended = [
        ...existing,
        { chunk: e.chunk, timestampMs: e.timestampMs },
      ];
      // FIFO cap at 500 chunks per subtask — verbose surface,
      // larger budget than activities.
      const capped = appended.length > 500 ? appended.slice(-500) : appended;
      next.set(e.subtaskId, capped);
      return { subtaskThinking: next };
    });
  }

  function handleSubtaskLog(e: SubtaskLog) {
    if (e.runId !== get().runId) return;
    appendLog(e.subtaskId, e.line);
  }

  function handleSubtaskDiff(e: SubtaskDiff) {
    if (e.runId !== get().runId) return;
    // Snapshot the backend's FileDiff list verbatim. Empty `files` is
    // a valid signal ("this worker ran but touched nothing") and still
    // gets a map entry so the WorkerNode can render "0 files" rather
    // than stay blank. The stored array is frozen so downstream
    // selectors can rely on reference equality for memoisation without
    // defensive copies at the read site.
    const frozen = Object.freeze(e.files.slice());
    set((state) => {
      const next = new Map(state.subtaskDiffs);
      next.set(e.subtaskId, frozen);
      return { subtaskDiffs: next };
    });
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
    set((state) => ({
      finalNode: state.finalNode
        ? { ...state.finalNode, conflictFiles: [...e.files] }
        : state.finalNode,
      // Phase 5 Step 3: park the conflict payload so the ErrorBanner
      // can render an "Open resolver" action and the popover can
      // cross-reference the file list with `subtaskDiffs` for
      // per-worker attribution. Initial conflict is `retryAttempt: 0`.
      mergeConflict: { files: [...e.files], retryAttempt: 0 },
      retryApplyInFlight: false,
      // Auto-open the resolver on the first conflict so the user
      // sees the action surface without hunting for the banner.
      conflictResolverOpen: true,
    }));
  }

  function handleMergeRetryFailed(e: MergeRetryFailed) {
    if (e.runId !== get().runId) return;
    ensureFinalNode();
    set((state) => ({
      finalNode: state.finalNode
        ? { ...state.finalNode, conflictFiles: [...e.files] }
        : state.finalNode,
      mergeConflict: { files: [...e.files], retryAttempt: e.retryAttempt },
      retryApplyInFlight: false,
      conflictResolverOpen: true,
    }));
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
    // Phase 5 Step 2: also park the file list so the ErrorBanner can
    // render an inline "Stash & retry apply" action button. The
    // string `currentError` is kept for the existing banner copy —
    // the new action reads `baseBranchDirty` directly.
    set({ currentError: msg, baseBranchDirty: { files: [...e.files] } });
  }

  function handleStashCreated(e: StashCreated) {
    if (e.runId !== get().runId) return;
    // The backend already sent `ApplyDecision::Apply` after emitting
    // this — clear the dirty banner + stash-in-flight marker so the
    // UI transitions to "stash held" state while the merge runs.
    set({
      baseBranchDirty: null,
      currentError: null,
      stash: { ref: e.stashRef, popFailed: null },
      stashInFlight: null,
    });
  }

  function handleStashPopped(e: StashPopped) {
    if (e.runId !== get().runId) return;
    // Clean pop — clear the stash entry entirely. The "stash still
    // held" post-apply prompt dismisses itself on this transition.
    set({ stash: null, stashInFlight: null });
  }

  function handleStashPopFailed(e: StashPopFailed) {
    if (e.runId !== get().runId) return;
    // On `missing` the backend cleared the ref server-side; we
    // mirror by dropping the stash entry. On `conflict` the ref
    // persists so the user can resolve manually — we park the
    // failure details in the same `stash` entry so the UI can
    // render the pinned banner.
    if (e.kind === 'missing') {
      set({ stash: null, stashInFlight: null });
    } else {
      set({
        stash: { ref: e.stashRef, popFailed: { kind: e.kind, error: e.error } },
        stashInFlight: null,
      });
    }
  }

  function handleCompleted(e: Completed) {
    if (e.runId !== get().runId) return;
    // `Completed` fires after a successful apply. Clear any stale conflict
    // metadata and mark the run applied so App.tsx keeps the graph mounted
    // while the ApplySummaryOverlay rides on top.
    //
    // Detach is deliberately deferred to `handleApplySummary`: the backend
    // ordering is `Completed → StatusChanged(Done) → ApplySummary`, and
    // tearing down the Tauri listeners here would drop the summary
    // payload mid-sequence. For non-applied terminals the usual
    // `handleStatusChanged` detach fires instead.
    set((state) => ({
      status: 'applied',
      finalNode: state.finalNode
        ? { ...state.finalNode, conflictFiles: null }
        : state.finalNode,
      // Phase 5 Step 3: clear the conflict payload on success so a
      // subsequent Applied doesn't leave a stale banner action
      // around when the user reaches for a new task.
      mergeConflict: null,
      retryApplyInFlight: false,
      conflictResolverOpen: false,
    }));
    // Land the final actor in its terminal `done` state. No-op if Apply
    // was never clicked (actor still at idle/proposed/approved), which
    // matches reality — Completed only reaches the frontend after a
    // successful merge, by which point the actor is already in running.
    sendTo(FINAL_ID, { type: 'COMPLETE' });
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

  function handleAutoApproved(e: AutoApproved) {
    if (e.runId !== get().runId) return;
    // Surface the bypass in UI state. The approval bar never enters
    // `awaiting_approval`-visible mode for this pass because the
    // backend moves straight to `running`; this payload lets the
    // canvas display a "plan auto-approved (N subtasks)" chip.
    set({ autoApproved: { subtaskIds: e.subtaskIds, at: Date.now() } });
  }

  function handleAutoApproveSuspended(e: AutoApproveSuspended) {
    if (e.runId !== get().runId) return;
    // The backend's latch guarantees exactly one emit per run, so we
    // don't need to dedupe here. The banner copy is derived from
    // `reason` at render time.
    set({ autoApproveSuspended: { reason: e.reason } });
  }

  function handleApplySummary(e: ApplySummary) {
    if (e.runId !== get().runId) return;
    // Last event in the applied path's ordering invariant
    // (DiffReady → Completed → StatusChanged(Done) → ApplySummary).
    // Park the payload for the overlay and retire the subscription —
    // no further events are expected for this run.
    set({ applySummary: e });
    detachActiveSubscription();
  }

  function buildHandlers() {
    return {
      onStatusChanged: handleStatusChanged,
      onMasterLog: handleMasterLog,
      onSubtasksProposed: handleSubtasksProposed,
      onSubtaskStateChanged: handleSubtaskStateChanged,
      onSubtaskLog: handleSubtaskLog,
      onDiffReady: handleDiffReady,
      onSubtaskDiff: handleSubtaskDiff,
      onMergeConflict: handleMergeConflict,
      onMergeRetryFailed: handleMergeRetryFailed,
      onBaseBranchDirty: handleBaseBranchDirty,
      onStashCreated: handleStashCreated,
      onStashPopped: handleStashPopped,
      onStashPopFailed: handleStashPopFailed,
      onSubtaskQuestionAsked: handleSubtaskQuestionAsked,
      onSubtaskAnswerReceived: handleSubtaskAnswerReceived,
      onSubtaskActivity: handleSubtaskActivity,
      onSubtaskThinking: handleSubtaskThinking,
      onCompleted: handleCompleted,
      onFailed: handleFailed,
      onReplanStarted: handleReplanStarted,
      onHumanEscalation: handleHumanEscalation,
      onAutoApproved: handleAutoApproved,
      onAutoApproveSuspended: handleAutoApproveSuspended,
      onApplySummary: handleApplySummary,
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
          priorStatus === 'failed' ||
          priorStatus === 'cancelled';
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
        // Fresh submit clears any deferred-cancel flag from a previous
        // aborted submit.
        pendingCancel: false,
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

      // Consume any cancel-click that landed during the submit window.
      // The `pendingCancel` flag was set by `cancelRun` detecting the
      // optimistic `pending_*` id. Now that the real id is wired, fire
      // the backend cancel — the lifecycle task reacts with
      // `finalize_cancelled`, which emits `StatusChanged(Cancelled)`
      // and routes through the normal cancel path. Fire-and-forget:
      // errors surface via `currentError` through the same mapping
      // used by explicit user-clicks.
      if (get().pendingCancel) {
        set({ pendingCancel: false });
        void cancelRunIpc(realRunId).catch((err: unknown) => {
          // Deferred cancel failed at IPC. `cancelInFlight` was set
          // back when the user first clicked (mirroring the
          // non-deferred path); roll it back so the TopBar doesn't
          // lie about a pending cancel that will never arrive.
          set({
            currentError: `Cancel failed: ${String(err)}`,
            cancelInFlight: false,
          });
        });
      }
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

    async cancelSubtask(subtaskId) {
      const runId = get().runId;
      if (!runId || runId.startsWith('pending_')) {
        // Same rationale as cancelRun: an optimistic pending id can't
        // be cancelled server-side. Per-subtask cancel has no pending
        // equivalent (the UI surface only appears on running/retrying/
        // waiting cards, which exist only after real-id submit), so
        // silently no-op.
        return;
      }
      const prev = get().subtaskCancelInFlight;
      if (prev.has(subtaskId)) return;
      const nextInFlight = new Set(prev);
      nextInFlight.add(subtaskId);
      set({ subtaskCancelInFlight: nextInFlight });
      try {
        await cancelSubtaskIpc(runId, subtaskId);
        // Success path: the transient flag clears when the backend
        // emits `SubtaskStateChanged { state: 'cancelled' }` — see
        // `handleSubtaskStateChanged`. That keeps the "Stopping…"
        // UI alive through the ~subsecond worker-kill window.
      } catch (err) {
        // Backend rejected (wrong state, unknown subtask, etc.). Roll
        // back the in-flight flag so the button becomes clickable
        // again and surface the error string so the card's toast
        // wiring can render it.
        const rolledBack = new Set(get().subtaskCancelInFlight);
        rolledBack.delete(subtaskId);
        set({
          subtaskCancelInFlight: rolledBack,
          currentError: `Stop failed: ${String(err)}`,
        });
        throw err;
      }
    },

    async stashAndRetryApply() {
      const runId = get().runId;
      if (!runId || runId.startsWith('pending_')) return;
      if (get().stashInFlight) return;
      set({ stashInFlight: 'stash-and-retry' });
      try {
        await stashAndRetryApplyIpc(runId);
        // Success path: the transient flag clears when the backend
        // emits `StashCreated` (see handleStashCreated). That keeps
        // the "Stashing…" UI alive through the ~100ms stash + merge
        // kickoff window.
      } catch (err) {
        set({
          stashInFlight: null,
          currentError: `Stash & retry failed: ${String(err)}`,
        });
        throw err;
      }
    },

    async popStash() {
      const runId = get().runId;
      if (!runId || runId.startsWith('pending_')) return;
      if (get().stashInFlight) return;
      set({ stashInFlight: 'pop' });
      try {
        await popStashIpc(runId);
        // Flag clears on StashPopped or StashPopFailed.
      } catch (err) {
        set({
          stashInFlight: null,
          currentError: `Pop stash failed: ${String(err)}`,
        });
        throw err;
      }
    },

    setConflictResolverOpen(open) {
      set({ conflictResolverOpen: open });
    },

    async answerSubtaskQuestion(subtaskId, answer) {
      const runId = get().runId;
      if (!runId || runId.startsWith('pending_')) return;
      if (get().questionAnswerInFlight.has(subtaskId)) return;
      const next = new Set(get().questionAnswerInFlight);
      next.add(subtaskId);
      set({ questionAnswerInFlight: next });
      try {
        await answerSubtaskQuestionIpc(runId, subtaskId, answer);
        // Clears on `handleSubtaskAnswerReceived` (normal path) or
        // on the subsequent `SubtaskStateChanged` emits (fallback).
      } catch (err) {
        const rolledBack = new Set(get().questionAnswerInFlight);
        rolledBack.delete(subtaskId);
        set({
          questionAnswerInFlight: rolledBack,
          currentError: `Answer failed: ${String(err)}`,
        });
        throw err;
      }
    },

    async skipSubtaskQuestion(subtaskId) {
      const runId = get().runId;
      if (!runId || runId.startsWith('pending_')) return;
      if (get().questionAnswerInFlight.has(subtaskId)) return;
      const next = new Set(get().questionAnswerInFlight);
      next.add(subtaskId);
      set({ questionAnswerInFlight: next });
      try {
        await skipSubtaskQuestionIpc(runId, subtaskId);
        // Clears on `SubtaskStateChanged(Done)` that the backend
        // emits after the worker task returns from resolve_qa_loop.
      } catch (err) {
        const rolledBack = new Set(get().questionAnswerInFlight);
        rolledBack.delete(subtaskId);
        set({
          questionAnswerInFlight: rolledBack,
          currentError: `Skip question failed: ${String(err)}`,
        });
        throw err;
      }
    },

    async retryApply() {
      const runId = get().runId;
      if (!runId || runId.startsWith('pending_')) return;
      if (get().retryApplyInFlight) return;
      set({ retryApplyInFlight: true });
      try {
        await retryApplyIpc(runId);
        // Flag clears on `handleMergeConflict` / `handleMergeRetryFailed`
        // (another conflict), `handleCompleted` (success), or
        // `handleStatusChanged` (cancel / failed terminal).
      } catch (err) {
        set({
          retryApplyInFlight: false,
          currentError: `Retry apply failed: ${String(err)}`,
        });
        throw err;
      }
    },

    async cancelRun() {
      const runId = get().runId;
      if (!runId) return;
      // The optimistic `pending_*` id set by `submitTask` is a local
      // placeholder — the backend hasn't seen it, so
      // `cancelRunIpc('pending_xxx')` would just return Ok(()) with no
      // effect (see `Orchestrator::cancel_run`'s "run not found → Ok"
      // branch). Defer to `pendingCancel`: the tail of `submitTask`
      // fires the cancel as soon as the real run id lands. We still
      // flip `cancelInFlight` so the TopBar shows "Cancelling…"
      // continuously across the deferred-then-fired transition.
      if (runId.startsWith('pending_')) {
        set({ pendingCancel: true, cancelInFlight: true });
        return;
      }
      // Flip the transient indicator *before* the IPC call so the UI
      // updates during the ~2s backend drain window. Cleared in
      // `handleStatusChanged` when the run reaches any terminal state.
      set({ cancelInFlight: true });
      try {
        await cancelRunIpc(runId);
      } catch (err) {
        // IPC failed outright — the run didn't receive the cancel
        // signal, so the indicator would otherwise stick. Roll it
        // back and surface the error.
        set({ currentError: `Cancel failed: ${String(err)}`, cancelInFlight: false });
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
      // Clear both the free-form error and the category-path latch.
      // The per-subtask category map itself is preserved (the
      // WorkerNode inline chip still needs it); the latch is what
      // hides the banner until a new signal re-arms it.
      set({ currentError: null, errorCategoryBannerDismissed: true });
    },

    dismissAutoApproveSuspended() {
      set({ autoApproveSuspended: null });
    },

    dismissApplySummary() {
      // Full reset — same as a fresh submit path. The overlay is the
      // last thing the user interacts with on an applied run; once
      // they dismiss it there's nothing left to inspect, so we clear
      // the graph, stop actors, and route back to EmptyState via the
      // normal idle status. `reset()` already drops `applySummary` via
      // the `...initial` spread.
      get().reset();
    },

    toggleWorkerExpanded(subtaskId) {
      set((state) => {
        const next = new Set(state.workerExpanded);
        if (next.has(subtaskId)) next.delete(subtaskId);
        else next.add(subtaskId);
        return { workerExpanded: next };
      });
    },

    toggleWorkerThinking(subtaskId) {
      set((state) => {
        const next = new Set(state.workerThinkingVisible);
        if (next.has(subtaskId)) next.delete(subtaskId);
        else next.add(subtaskId);
        return { workerThinkingVisible: next };
      });
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
        subtaskErrorCategories: new Map(),
        subtaskDiffs: new Map(),
        originalSubtasks: new Map(),
        userAddedSubtaskIds: new Set(),
        lastAddedSubtaskId: null,
        replanningSubtaskId: null,
        humanEscalation: null,
        workerExpanded: new Set(),
        subtaskCancelInFlight: new Set(),
        baseBranchDirty: null,
        stash: null,
        stashInFlight: null,
        mergeConflict: null,
        retryApplyInFlight: false,
        conflictResolverOpen: false,
        pendingQuestions: new Map(),
        questionAnswerInFlight: new Set(),
        subtaskActivities: new Map(),
        subtaskThinking: new Map(),
        workerThinkingVisible: new Set(),
      });
    },
  };
});
