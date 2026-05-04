/**
 * Typed wire contract between the React frontend and the Rust backend.
 *
 * The shapes here mirror `src-tauri/src/ipc/{mod,events,commands}.rs` by
 * hand — keep the two sides in sync when editing either. Zod schemas are
 * applied at the boundary so a backend-shape drift surfaces as a parse
 * error instead of a silent `undefined` deep in the UI.
 *
 * Command wrappers wrap `invoke()`. Event subscription lives in
 * `src/lib/runSubscription.ts` — this file exports only the raw schemas
 * and event-name constants it needs.
 */

import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

// ---------- Shared scalar / enum schemas ----------

export const runIdSchema = z.string();
export type RunId = z.infer<typeof runIdSchema>;

export const subtaskIdSchema = z.string();
export type SubtaskId = z.infer<typeof subtaskIdSchema>;

export const agentKindSchema = z.enum(['claude', 'codex', 'gemini']);
export type AgentKind = z.infer<typeof agentKindSchema>;

/**
 * Agents eligible to act as the master (planner / replanner).
 * Mirror of `AgentKind::supports_master` on the Rust side — Phase 4
 * Step 1 restricts Gemini to worker-only. Update both sides in
 * lockstep when the list changes.
 */
export const MASTER_CAPABLE_AGENTS: readonly AgentKind[] = ['claude', 'codex'] as const;

/** See {@link MASTER_CAPABLE_AGENTS}. */
export function isMasterCapable(kind: AgentKind): boolean {
  return (MASTER_CAPABLE_AGENTS as readonly AgentKind[]).includes(kind);
}

/**
 * Phase 6 Step 3 — agents whose worker output exposes
 * reasoning / thinking blocks the dispatcher's parser tee can
 * extract. Step 0 diagnostic confirmed Claude is the only
 * adapter today; Codex (`exec --json`) and Gemini (text mode)
 * emit no equivalent. The thinking-toggle UI greys out for
 * non-supported workers with a tooltip pointing at this list.
 */
export const THINKING_CAPABLE_AGENTS: readonly AgentKind[] = ['claude'] as const;

/** See {@link THINKING_CAPABLE_AGENTS}. */
export function supportsThinking(kind: AgentKind): boolean {
  return (THINKING_CAPABLE_AGENTS as readonly AgentKind[]).includes(kind);
}

export const agentStatusSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    version: z.string(),
    binaryPath: z.string(),
  }),
  z.object({
    status: z.literal('broken'),
    binaryPath: z.string(),
    error: z.string(),
  }),
  z.object({ status: z.literal('not-installed') }),
]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentDetectionResultSchema = z.object({
  claude: agentStatusSchema,
  codex: agentStatusSchema,
  gemini: agentStatusSchema,
  recommendedMaster: agentKindSchema.nullable(),
});
export type AgentDetectionResult = z.infer<typeof agentDetectionResultSchema>;

export const runStatusSchema = z.enum([
  'idle',
  'planning',
  'awaiting-approval',
  'running',
  'merging',
  'done',
  'rejected',
  'failed',
  'cancelled',
  // Phase 3 Step 5: Layer-3 human escalation is active. The lifecycle
  // task is parked on a resolution channel while the UI surfaces
  // "open in editor / skip / replan again / abort". Non-terminal:
  // resolution returns the run to `running` or forwards to
  // `cancelled`/`failed`.
  'awaiting-human-fix',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const subtaskStateSchema = z.enum([
  'proposed',
  'waiting',
  'running',
  // Phase 3 prerequisite: transient state between Layer-1 failure and the
  // second attempt. The store bridges this to node-machine events in Step
  // 3a; until then `eventsForSubtaskState` returns [] for 'retrying'.
  'retrying',
  'done',
  'failed',
  'skipped',
  // Phase 5 Step 1: user-initiated per-worker stop. Terminal. Distinct
  // from `skipped` (orchestrator cascade) and `failed` (orchestrator
  // retry-exhausted) — users stopped this worker intentionally. Store
  // bridge dispatches CANCEL to the node machine.
  'cancelled',
  // Phase 5 Step 4: worker emitted a question and is paused pending
  // the user's answer. Transient; answer restarts the worker,
  // skip / timeout finalizes as `done` with current output. Backend
  // kebab-case shape is `awaiting-input` on the wire.
  'awaiting-input',
]);
export type SubtaskState = z.infer<typeof subtaskStateSchema>;

export const subtaskDataSchema = z.object({
  id: subtaskIdSchema,
  title: z.string(),
  why: z.string().nullable(),
  assignedWorker: agentKindSchema,
  dependencies: z.array(subtaskIdSchema),
  /**
   * Subtask ids this one replaces. Empty for freshly-planned subtasks;
   * populated (usually with one id) when the master produced this
   * subtask as part of a Layer-2 replan. The graph renders a "replaces
   * #N" badge on the replacement node so the user can trace lineage.
   * `.default([])` keeps older backend builds (or pre-Phase-3 fixtures)
   * compatible — the wire format serialises `[]` when empty.
   */
  replaces: z.array(subtaskIdSchema).default([]),
  /**
   * How many Layer-2 replans have already fired in this subtask's
   * lineage. `0` means "freshly planned" (the master's initial output
   * or a user-added subtask); `1` means one replan has been burned on
   * the lineage; `>= 2` means the cap is exhausted. The escalation UI
   * uses this to hide the "Try replan again" action when
   * `replanCount >= 2`. `.default(0)` keeps older backend builds (or
   * pre-Phase-3 fixtures) compatible.
   */
  replanCount: z.number().int().nonnegative().default(0),
});
export type SubtaskData = z.infer<typeof subtaskDataSchema>;

/**
 * Partial update for a proposed subtask. Mirrors
 * `ipc::SubtaskPatch` on the Rust side. Every field is independently
 * optional:
 *   - `undefined` / field absent → leave alone
 *   - `title: string`            → set (backend rejects empty after trim)
 *   - `why: null`                → clear (translated to `""` on the wire
 *                                  because the Rust side treats
 *                                  `Some("")` as "clear to None")
 *   - `why: string`              → set (empty string also clears)
 *   - `assignedWorker: AgentKind` → set (backend rejects if unavailable)
 *
 * Dependencies are not editable in Phase 3 (Q1 deferral).
 */
export const subtaskPatchSchema = z.object({
  title: z.string().optional(),
  why: z.string().nullable().optional(),
  assignedWorker: agentKindSchema.optional(),
});
export type SubtaskPatch = z.infer<typeof subtaskPatchSchema>;

/**
 * Full definition for a user-added subtask. Mirrors
 * `ipc::SubtaskDraft` on the Rust side. The backend coins the ulid,
 * so the frontend does not send an id. `why` is optional:
 * `undefined` / `null` omits the field (backend defaults to empty);
 * a string (even empty) is passed through.
 *
 * User-added subtasks are always leaves — Phase 3 does not let the
 * user express dependencies.
 */
export const subtaskDraftSchema = z.object({
  title: z.string(),
  why: z.string().nullable().optional(),
  assignedWorker: agentKindSchema,
});
export type SubtaskDraft = z.infer<typeof subtaskDraftSchema>;

// Phase 4 Step 6 — wire-level diff status.
// Mirrors `ipc::DiffStatus` on the Rust side: adjacently-tagged
// discriminated union keyed on `kind` with `Renamed` carrying the
// previous path. The UI renders a distinct header per variant
// (added → "new file", deleted → "removed", renamed → "old → new",
// binary → "binary, preview skipped", modified → normal header).
export const diffStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('added') }),
  z.object({ kind: z.literal('modified') }),
  z.object({ kind: z.literal('deleted') }),
  z.object({ kind: z.literal('renamed'), from: z.string() }),
  z.object({ kind: z.literal('binary') }),
]);
export type DiffStatus = z.infer<typeof diffStatusSchema>;

export const fileDiffSchema = z.object({
  path: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  // Phase 4 Step 6: both fields are `.optional()` for backward
  // compatibility with pre-Step-6 backends (a bundled binary that
  // still emits the old stat-only shape decodes without throwing).
  // When absent the UI falls back to the stat-only row rendering and
  // hides the per-file expand affordance; when present the inline
  // preview is available.
  status: diffStatusSchema.optional(),
  unifiedDiff: z.string().optional(),
});
export type FileDiff = z.infer<typeof fileDiffSchema>;

export const runSummarySchema = z.object({
  runId: runIdSchema,
  subtaskCount: z.number().int().nonnegative(),
  filesChanged: z.number().int().nonnegative(),
  durationSecs: z.number().int().nonnegative(),
  commitsCreated: z.number().int().nonnegative(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

// ---------- Event names (mirrors events.rs EVENT_* constants) ----------

export const EVENT_STATUS_CHANGED = 'run:status_changed' as const;
export const EVENT_MASTER_LOG = 'run:master_log' as const;
export const EVENT_SUBTASKS_PROPOSED = 'run:subtasks_proposed' as const;
export const EVENT_SUBTASK_STATE_CHANGED = 'run:subtask_state_changed' as const;
export const EVENT_SUBTASK_LOG = 'run:subtask_log' as const;
export const EVENT_DIFF_READY = 'run:diff_ready' as const;
// Phase 3.5 Item 6: per-subtask file diff. Additive — the aggregate
// `run:diff_ready` still fires at the end of the Apply pre-merge pass.
export const EVENT_SUBTASK_DIFF = 'run:subtask_diff' as const;
export const EVENT_COMPLETED = 'run:completed' as const;
// Phase 4 Step 2: final event in a successful run, emitted strictly
// after `run:status_changed(done)`. Payload drives the bottom-right
// apply-summary overlay (commit SHA, base branch, aggregate + per-
// worker file counts).
export const EVENT_APPLY_SUMMARY = 'run:apply_summary' as const;
export const EVENT_FAILED = 'run:failed' as const;
export const EVENT_MERGE_CONFLICT = 'run:merge_conflict' as const;
export const EVENT_BASE_BRANCH_DIRTY = 'run:base_branch_dirty' as const;
export const EVENT_REPLAN_STARTED = 'run:replan_started' as const;
export const EVENT_HUMAN_ESCALATION = 'run:human_escalation' as const;
// Phase 3 Step 7: auto-approve lifecycle events. `AutoApproved` fires
// when the lifecycle synthesised an approval for a plan pass instead of
// waiting on the sheet; `AutoApproveSuspended` fires exactly once per
// run when the ceiling is hit and the run falls back to manual
// approval for the remainder of its lifetime.
export const EVENT_AUTO_APPROVED = 'run:auto_approved' as const;
export const EVENT_AUTO_APPROVE_SUSPENDED = 'run:auto_approve_suspended' as const;
// Phase 5 Step 2: base-branch dirty helper events. `stash_created`
// fires when `stash_and_retry_apply` captured the dirty tree into
// `git stash`; `stash_popped` on a clean pop; `stash_pop_failed`
// when the pop conflicted (user resolves manually) or the ref was
// missing (dropped externally).
export const EVENT_STASH_CREATED = 'run:stash_created' as const;
export const EVENT_STASH_POPPED = 'run:stash_popped' as const;
export const EVENT_STASH_POP_FAILED = 'run:stash_pop_failed' as const;
// Phase 5 Step 3: subsequent merge conflict after a user `retry_apply`.
// Distinct from `run:merge_conflict` (stable Phase 2 contract) so the
// frontend can key "Still conflicted (attempt N)" copy off the
// retry counter without breaking existing consumers.
export const EVENT_MERGE_RETRY_FAILED = 'run:merge_retry_failed' as const;
// Phase 5 Step 4: worker paused pending user answer.
export const EVENT_SUBTASK_QUESTION_ASKED = 'run:subtask_question_asked' as const;
export const EVENT_SUBTASK_ANSWER_RECEIVED = 'run:subtask_answer_received' as const;
// Phase 6 Step 2: structured tool-use event parsed from worker
// output. Tee'd alongside subtask_log — log is authoritative;
// activity is a re-projection rendered as chips on the running
// card. Emitted once per parsed event; Codex apply_patch with N
// files emits N activity events.
export const EVENT_SUBTASK_ACTIVITY = 'run:subtask_activity' as const;
// Phase 6 Step 3: agent reasoning / thinking block. Currently
// Claude-only.
export const EVENT_SUBTASK_THINKING = 'run:subtask_thinking' as const;
// Phase 6 Step 4: backend confirmation that a user-injected hint
// has been parked + cancel fired. UI flips per-card indicator
// from "Sending…" to "Restarting with your hint…".
export const EVENT_SUBTASK_HINT_RECEIVED = 'run:subtask_hint_received' as const;
// Phase 7 Step 2: per-worker undo. Backend ran `git reset --hard
// HEAD` + `git clean -fd` in the subtask's worktree and tagged the
// runtime row with `revert_intent`. UI drops the worker's diff
// entry + flips the cancelled badge subtitle from "Stopped" to
// "Reverted".
export const EVENT_WORKTREE_REVERTED = 'run:worktree_reverted' as const;

// ---------- Event payload schemas ----------

export const statusChangedSchema = z.object({
  runId: runIdSchema,
  status: runStatusSchema,
});
export type StatusChanged = z.infer<typeof statusChangedSchema>;

export const masterLogSchema = z.object({
  runId: runIdSchema,
  line: z.string(),
});
export type MasterLog = z.infer<typeof masterLogSchema>;

export const subtasksProposedSchema = z.object({
  runId: runIdSchema,
  subtasks: z.array(subtaskDataSchema),
});
export type SubtasksProposed = z.infer<typeof subtasksProposedSchema>;

// Phase 4 Step 5: wire-level crash/failure classification. Surfaces on
// Failed `SubtaskStateChanged` payloads so the UI can render a
// category-specific banner (ErrorBanner) and inline chip (WorkerNode).
// Serde shape is `{ kind: "<kebab>", …extra }`; Timeout carries
// `afterSecs` for the "Timed out after Xm" copy. Cancellation does
// NOT produce a Failed state change, so there's no `cancelled` variant
// here — the backend's `AgentError::Cancelled` routes through a
// different wire event entirely.
export const errorCategoryWireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('process-crashed') }),
  z.object({ kind: z.literal('task-failed') }),
  z.object({ kind: z.literal('parse-failed') }),
  z.object({ kind: z.literal('timeout'), afterSecs: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('spawn-failed') }),
]);
export type ErrorCategoryWire = z.infer<typeof errorCategoryWireSchema>;

export const subtaskStateChangedSchema = z.object({
  runId: runIdSchema,
  subtaskId: subtaskIdSchema,
  state: subtaskStateSchema,
  // Optional for two reasons:
  //   1. Backward compat — a future pre-Step-5 backend (e.g. a user
  //      running an older bundled binary during dev) omits the field
  //      entirely; `.optional()` decodes without throwing.
  //   2. The backend only populates this for `Failed` transitions
  //      whose source is an `AgentError` it can classify. Running /
  //      Retrying / Done / Skipped emits all carry `undefined` here.
  errorCategory: errorCategoryWireSchema.optional(),
});
export type SubtaskStateChanged = z.infer<typeof subtaskStateChangedSchema>;

export const subtaskLogSchema = z.object({
  runId: runIdSchema,
  subtaskId: subtaskIdSchema,
  line: z.string(),
});
export type SubtaskLog = z.infer<typeof subtaskLogSchema>;

export const diffReadySchema = z.object({
  runId: runIdSchema,
  files: z.array(fileDiffSchema),
});
export type DiffReady = z.infer<typeof diffReadySchema>;

export const subtaskDiffSchema = z.object({
  runId: runIdSchema,
  subtaskId: subtaskIdSchema,
  files: z.array(fileDiffSchema),
});
export type SubtaskDiff = z.infer<typeof subtaskDiffSchema>;

export const completedSchema = z.object({
  runId: runIdSchema,
  summary: runSummarySchema,
});
export type Completed = z.infer<typeof completedSchema>;

/**
 * One entry in {@link ApplySummary.perWorker}. Kept tiny on purpose —
 * the graph already has the subtask title from `SubtasksProposed`;
 * the overlay looks it up by id and renders the file count.
 */
export const applySummaryPerWorkerSchema = z.object({
  subtaskId: subtaskIdSchema,
  filesChanged: z.number().int().nonnegative(),
});
export type ApplySummaryPerWorker = z.infer<typeof applySummaryPerWorkerSchema>;

/**
 * Phase 4 Step 2 payload. Fires once per successful Apply, strictly
 * after `run:status_changed(done)`. Re-projects data already produced
 * by the merge phase (commit SHA, base branch, aggregate + per-worker
 * file counts) so the overlay renders from a single payload.
 *
 * The UI contract: the graph stays mounted while the overlay is
 * visible; the user dismisses explicitly (Dismiss button) or
 * implicitly (submitting a new task). Order invariant enforced by
 * the backend and covered by an integration test — the store can
 * assume the payload arrives *after* the terminal `Completed`.
 */
export const applySummarySchema = z.object({
  runId: runIdSchema,
  commitSha: z.string(),
  branch: z.string(),
  filesChanged: z.number().int().nonnegative(),
  perWorker: z.array(applySummaryPerWorkerSchema),
});
export type ApplySummary = z.infer<typeof applySummarySchema>;

export const failedSchema = z.object({
  runId: runIdSchema,
  error: z.string(),
});
export type Failed = z.infer<typeof failedSchema>;

/**
 * Emitted when `apply_run` hit a merge conflict. The run stays in
 * `Merging`; worktrees and notes are preserved. `files` are relative to
 * the repo root. The user's next click is either Discard or Retry.
 */
export const mergeConflictSchema = z.object({
  runId: runIdSchema,
  files: z.array(z.string()),
});
export type MergeConflict = z.infer<typeof mergeConflictSchema>;

/**
 * Emitted when `apply_run` bailed before merging because the user's
 * base-branch working tree has tracked uncommitted changes — `git
 * merge` would refuse to overwrite them. Run stays in `Merging`, the
 * user commits or stashes, then clicks Apply again.
 */
export const baseBranchDirtySchema = z.object({
  runId: runIdSchema,
  files: z.array(z.string()),
});
export type BaseBranchDirty = z.infer<typeof baseBranchDirtySchema>;

/**
 * Phase 5 Step 2 payload for {@link EVENT_STASH_CREATED}. Fires
 * exactly once per successful `stash_and_retry_apply` invocation,
 * *before* the follow-up merge attempt starts. `stashRef` is the
 * commit SHA of the stash entry — the frontend keeps it as an opaque
 * identifier for the "Show stash ref" affordance on the post-apply
 * prompt; the backend uses it to pop the right entry regardless of
 * manual `git stash` invocations between push and pop.
 */
export const stashCreatedSchema = z.object({
  runId: runIdSchema,
  stashRef: z.string(),
});
export type StashCreated = z.infer<typeof stashCreatedSchema>;

/** Phase 5 Step 2 payload for {@link EVENT_STASH_POPPED}. */
export const stashPoppedSchema = z.object({
  runId: runIdSchema,
  stashRef: z.string(),
});
export type StashPopped = z.infer<typeof stashPoppedSchema>;

/**
 * Phase 5 Step 2 payload for {@link EVENT_STASH_POP_FAILED}.
 * `kind` discriminates conflict (user resolves manually + drops) vs
 * missing (ref was gone). Both carry `stashRef` so the UI can
 * surface it in the pinned banner for manual recovery.
 */
export const stashPopFailedSchema = z.object({
  runId: runIdSchema,
  stashRef: z.string(),
  kind: z.enum(['conflict', 'missing']),
  error: z.string(),
});
export type StashPopFailed = z.infer<typeof stashPopFailedSchema>;

/**
 * Phase 5 Step 3 payload for {@link EVENT_MERGE_RETRY_FAILED}. Same
 * file-set as {@link mergeConflictSchema}; `retryAttempt` starts at
 * 1 on the first retry failure (initial conflict carries implicit
 * attempt 0 and fires as `MergeConflict`).
 */
export const mergeRetryFailedSchema = z.object({
  runId: runIdSchema,
  files: z.array(z.string()),
  retryAttempt: z.number().int().nonnegative(),
});
export type MergeRetryFailed = z.infer<typeof mergeRetryFailedSchema>;

/**
 * Phase 5 Step 4 payload for {@link EVENT_SUBTASK_QUESTION_ASKED}.
 * `question` is the detected text (verbatim line that triggered the
 * heuristic); UI renders it without truncation. `detectionMethod`
 * is reserved for future structured signals — Step 0 found only
 * heuristic detection available today.
 */
export const subtaskQuestionAskedSchema = z.object({
  runId: runIdSchema,
  subtaskId: subtaskIdSchema,
  question: z.string(),
  detectionMethod: z.enum(['heuristic-trailing-question-mark']),
});
export type SubtaskQuestionAsked = z.infer<typeof subtaskQuestionAskedSchema>;

/**
 * Phase 6 Step 2 — discriminated union mirroring the Rust
 * `ToolEvent` enum. Wire shape: `{kind: "...", ...fields}`. UI
 * renders a chip per variant; `Other` is the escape hatch for
 * unmodeled tools / format drift.
 */
export const toolEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file-read'),
    path: z.string(),
    lines: z.tuple([z.number().int(), z.number().int()]).optional(),
  }),
  z.object({
    kind: z.literal('file-edit'),
    path: z.string(),
    summary: z.string(),
  }),
  z.object({
    kind: z.literal('bash'),
    command: z.string(),
  }),
  z.object({
    kind: z.literal('search'),
    query: z.string(),
    paths: z.array(z.string()).default([]),
  }),
  z.object({
    kind: z.literal('other'),
    toolName: z.string(),
    detail: z.string(),
  }),
]);
export type ToolEvent = z.infer<typeof toolEventSchema>;

/** Phase 6 Step 2 payload for {@link EVENT_SUBTASK_ACTIVITY}. */
export const subtaskActivitySchema = z.object({
  runId: runIdSchema,
  subtaskId: subtaskIdSchema,
  event: toolEventSchema,
  timestampMs: z.number().int().nonnegative(),
});
export type SubtaskActivity = z.infer<typeof subtaskActivitySchema>;

/** Phase 6 Step 3 payload for {@link EVENT_SUBTASK_THINKING}. */
export const subtaskThinkingSchema = z.object({
  runId: runIdSchema,
  subtaskId: subtaskIdSchema,
  chunk: z.string(),
  timestampMs: z.number().int().nonnegative(),
});
export type SubtaskThinking = z.infer<typeof subtaskThinkingSchema>;

/** Phase 6 Step 4 payload for {@link EVENT_SUBTASK_HINT_RECEIVED}. */
export const subtaskHintReceivedSchema = z.object({
  runId: runIdSchema,
  subtaskId: subtaskIdSchema,
  hint: z.string(),
  timestampMs: z.number().int().nonnegative(),
});
export type SubtaskHintReceived = z.infer<typeof subtaskHintReceivedSchema>;

/** Phase 7 Step 2 payload for {@link EVENT_WORKTREE_REVERTED}. */
export const worktreeRevertedSchema = z.object({
  runId: runIdSchema,
  subtaskId: subtaskIdSchema,
  filesCleared: z.number().int().nonnegative(),
});
export type WorktreeReverted = z.infer<typeof worktreeRevertedSchema>;

/** Phase 5 Step 4 payload for {@link EVENT_SUBTASK_ANSWER_RECEIVED}. */
export const subtaskAnswerReceivedSchema = z.object({
  runId: runIdSchema,
  subtaskId: subtaskIdSchema,
});
export type SubtaskAnswerReceived = z.infer<typeof subtaskAnswerReceivedSchema>;

/**
 * Emitted right before the orchestrator calls `AgentImpl::replan` on the
 * master. The failed worker has already burned its Layer-1 retry budget;
 * the master is now being asked for a replacement. UI response: flip the
 * master chip to thinking and mark `failedSubtaskId` as the one being
 * replanned.
 */
export const replanStartedSchema = z.object({
  runId: runIdSchema,
  failedSubtaskId: subtaskIdSchema,
});
export type ReplanStarted = z.infer<typeof replanStartedSchema>;

/**
 * Emitted when the retry ladder is exhausted — either the failed
 * subtask's lineage already burned two replans, or the master returned
 * an empty plan (infeasible). `reason` is a short human-readable
 * sentence; `suggestedAction`, when present, is the master's proposal
 * for what to try next. UI response: mark `subtaskId` as escalated, show
 * `reason` alongside the failing node, and expose `suggestedAction` as
 * the CTA copy.
 */
export const humanEscalationSchema = z.object({
  runId: runIdSchema,
  subtaskId: subtaskIdSchema,
  reason: z.string(),
  suggestedAction: z.string().optional(),
});
export type HumanEscalation = z.infer<typeof humanEscalationSchema>;

/**
 * Emitted once per plan pass (initial or replan) when the auto-approve
 * bypass synthesised an Approve for the current plan. `subtaskIds` is
 * the set actually dispatched — mirrors the ApprovalDecision::Approve
 * wire shape. The graph store flips the approval bar off for the pass
 * and surfaces a transient "auto-approved" affordance.
 */
export const autoApprovedSchema = z.object({
  runId: runIdSchema,
  subtaskIds: z.array(subtaskIdSchema),
});
export type AutoApproved = z.infer<typeof autoApprovedSchema>;

/**
 * Emitted exactly once per run when approving the current plan pass
 * would push the run past `maxSubtasksPerAutoApprovedRun`. The backend
 * latches the suspension flag on the run so subsequent passes stay
 * manual even if the user toggles auto-approve back on mid-run. The UI
 * surfaces a banner explaining the fallback and what to do next.
 *
 * `reason` is a machine-readable key — today only `"subtask_limit"` is
 * emitted, but future safety-gate integrations (Phase 7) will add more.
 * The UI translates known keys into human copy; unknown keys fall
 * through to the raw string.
 */
export const autoApproveSuspendedSchema = z.object({
  runId: runIdSchema,
  reason: z.string(),
});
export type AutoApproveSuspended = z.infer<typeof autoApproveSuspendedSchema>;

// ---------- Recovery ----------

/**
 * One entry in the boot-time recovery report: a run that was
 * non-terminal when the app last exited. The backend has already
 * marked it `Failed` and swept worktrees by the time the frontend
 * reads this — the banner is a heads-up, not an action prompt.
 */
export const recoveryEntrySchema = z.object({
  task: z.string(),
  repoPath: z.string(),
});
export type RecoveryEntry = z.infer<typeof recoveryEntrySchema>;

/**
 * Boot-time migration notice produced by `settings::migrate`. Today
 * the only producer is the Phase 4 Step 1 Gemini demotion; later
 * phases can add new `kind` values. The backend owns the user-
 * facing copy (`message`) so the frontend only has to render it.
 * Read-once via `consumeMigrationNotices`.
 */
export const migrationKindSchema = z.enum(['gemini-master-demoted']);
export type MigrationKind = z.infer<typeof migrationKindSchema>;

export const migrationNoticeSchema = z.object({
  kind: migrationKindSchema,
  message: z.string(),
});
export type MigrationNotice = z.infer<typeof migrationNoticeSchema>;

// ---------- Settings ----------

export const settingsSchema = z.object({
  lastRepo: z.string().nullable(),
  masterAgent: agentKindSchema,
  claudeBinaryPath: z.string().optional(),
  codexBinaryPath: z.string().optional(),
  geminiBinaryPath: z.string().optional(),
  /**
   * Preferred editor command (e.g. `"code"`, `"nvim"`). Passed to the
   * backend's Layer-3 editor fallback chain. Optional; omission and
   * explicit `null` both mean "no preference, use $EDITOR or platform
   * default".
   */
  editor: z.string().optional(),
  /**
   * Phase 3 Step 7: when `true`, plan approvals (initial + replans)
   * synthesise an approve-all decision instead of showing the approval
   * sheet. Defaults to `false`. Missing in legacy settings payloads →
   * default.
   */
  autoApprove: z.boolean().default(false),
  /**
   * Hard ceiling on how many subtasks a single auto-approved run may
   * dispatch across all plan passes. The backend suspends auto-approve
   * for the run when an approval would cross this line. Positive
   * integer; 20 is the default.
   */
  maxSubtasksPerAutoApprovedRun: z.number().int().positive().default(20),
  /**
   * `true` after the user has acknowledged the auto-approve consent
   * modal at least once. The modal shows on first activation; flipping
   * auto-approve back off does not clear this flag.
   */
  autoApproveConsentGiven: z.boolean().default(false),
  /**
   * Phase 7 Step 1: persisted width (px) of the InlineDiffSidebar.
   * Backend clamps to 320-720; absent/null = use frontend default of
   * 480.
   */
  inlineDiffSidebarWidth: z.number().int().min(320).max(720).optional(),
});
export type Settings = z.infer<typeof settingsSchema>;

/**
 * Partial shape accepted by `set_settings`. Keys omitted are left untouched;
 * `lastRepo` may be explicitly `null` to clear it.
 */
export type SettingsPatch = Partial<{
  lastRepo: string | null;
  masterAgent: AgentKind;
  claudeBinaryPath: string | null;
  codexBinaryPath: string | null;
  geminiBinaryPath: string | null;
  editor: string | null;
  autoApprove: boolean;
  maxSubtasksPerAutoApprovedRun: number;
  autoApproveConsentGiven: boolean;
  inlineDiffSidebarWidth: number | null;
}>;

// ---------- Repo ----------

export const repoInfoSchema = z.object({
  path: z.string(),
  name: z.string(),
  isGitRepo: z.boolean(),
  currentBranch: z.string().nullable(),
});
export type RepoInfo = z.infer<typeof repoInfoSchema>;

export const repoInvalidReasonSchema = z.enum([
  'not_a_directory',
  'not_a_git_repo',
  'inaccessible',
]);
export type RepoInvalidReason = z.infer<typeof repoInvalidReasonSchema>;

export const repoValidationSchema = z.discriminatedUnion('valid', [
  z.object({ valid: z.literal(true), info: repoInfoSchema }),
  z.object({ valid: z.literal(false), reason: repoInvalidReasonSchema }),
]);
export type RepoValidation = z.infer<typeof repoValidationSchema>;

// ---------- Command wrappers ----------

export async function submitTask(input: string, repoPath: string): Promise<RunId> {
  const raw = await invoke<unknown>('submit_task', { input, repoPath });
  return runIdSchema.parse(raw);
}

export async function approveSubtasks(
  runId: RunId,
  subtaskIds: SubtaskId[],
): Promise<void> {
  await invoke('approve_subtasks', { runId, subtaskIds });
}

export async function rejectRun(runId: RunId): Promise<void> {
  await invoke('reject_run', { runId });
}

export async function applyRun(runId: RunId): Promise<void> {
  await invoke('apply_run', { runId });
}

export async function discardRun(runId: RunId): Promise<void> {
  await invoke('discard_run', { runId });
}

export async function cancelRun(runId: RunId): Promise<void> {
  await invoke('cancel_run', { runId });
}

/**
 * Phase 5 Step 1: per-worker stop.
 *
 * Cancels exactly one subtask while leaving the rest of the run
 * running. Bypasses the retry ladder entirely (Layer 1 / Layer 2 /
 * Layer 3). Backend rejects with `WrongSubtaskState` string error if
 * the subtask is not in `running` / `retrying` / `waiting` — the UI
 * surfaces the rejection as a toast. Idempotent: firing twice on the
 * same subtask returns `Ok(())` the first time and `WrongSubtaskState`
 * the second (the first fire moved it to `cancelled`).
 */
export async function cancelSubtask(
  runId: RunId,
  subtaskId: SubtaskId,
): Promise<void> {
  await invoke('cancel_subtask', { runId, subtaskId });
}

/**
 * Phase 7 Step 2: per-worker undo (revert worktree changes).
 *
 * Like {@link cancelSubtask} but additionally wipes the worker's
 * worktree (`git reset --hard HEAD` + `git clean -fd`) and tags the
 * runtime row with `revert_intent`. Backend rejects with a string
 * error if the subtask is in `proposed` / `skipped` (no worktree) or
 * already carries `revert_intent` (idempotency / rate-limit guard).
 *
 * Cascade: dependent subtasks still in `waiting` / `proposed` flip
 * to `skipped` (same path the cancel cascade uses); already-running
 * dependents are left alone — they may have consumed the now-
 * reverted output but reverting their downstream is out of scope.
 */
export async function revertSubtaskChanges(
  runId: RunId,
  subtaskId: SubtaskId,
): Promise<void> {
  await invoke('revert_subtask_changes', { runId, subtaskId });
}

/**
 * Phase 5 Step 2: stash the dirty base branch and retry Apply. One-
 * click remediation for the `BaseBranchDirty` banner — backend runs
 * `git stash push -u -m "whalecode: before apply <run_id>"` and
 * immediately re-sends the apply decision to the merge oneshot.
 * Emits `run:stash_created` on success; merge may still produce a
 * `run:merge_conflict` after — the stash entry persists across that
 * and `pop_stash` targets the right commit regardless.
 */
export async function stashAndRetryApply(runId: RunId): Promise<void> {
  await invoke('stash_and_retry_apply', { runId });
}

/**
 * Phase 5 Step 2: pop the stash captured by `stash_and_retry_apply`.
 * User-initiated (no auto-pop after Apply — the stashed changes may
 * conflict with just-applied diffs and the user should see the state
 * before deciding). Emits `run:stash_popped` on clean apply,
 * `run:stash_pop_failed` on conflict or missing.
 */
export async function popStash(runId: RunId): Promise<void> {
  await invoke('pop_stash', { runId });
}

/**
 * Phase 5 Step 3: retry a merge that just conflicted. Semantic
 * alias for `apply_run` — the lifecycle has already re-installed the
 * apply oneshot on the MergeConflict branch, so this re-enters the
 * merge attempt with whatever resolutions the user landed externally
 * on the base branch. Rejects with `WrongState` / `RunNotFound` if
 * the oneshot was consumed (e.g. the user raced a discard / cancel
 * click); UI toasts the error.
 */
export async function retryApply(runId: RunId): Promise<void> {
  await invoke('retry_apply', { runId });
}

/**
 * Phase 5 Step 4: deliver the user's answer to a parked question.
 * Subtask must be in `awaiting-input`; rejection (wrong state,
 * already answered, subtask unknown) returns a string error the UI
 * toasts. Empty answers permitted.
 */
export async function answerSubtaskQuestion(
  runId: RunId,
  subtaskId: SubtaskId,
  answer: string,
): Promise<void> {
  await invoke('answer_subtask_question', { runId, subtaskId, answer });
}

/**
 * Phase 5 Step 4: false-positive escape hatch. User flags the
 * detected question as non-actionable → subtask finalizes as
 * `Done` with current output preserved.
 */
export async function skipSubtaskQuestion(
  runId: RunId,
  subtaskId: SubtaskId,
): Promise<void> {
  await invoke('skip_subtask_question', { runId, subtaskId });
}

/**
 * Phase 6 Step 4: inject a mid-execution hint into a running
 * worker. Worker stops gracefully (Phase 5 cancel mechanism) and
 * re-dispatches with the hint appended to its prompt. Bypasses
 * Layer 1 retry budget. Concurrent-hint guard rejects with
 * `WrongSubtaskState` if a previous hint is still pending.
 */
export async function hintSubtask(
  runId: RunId,
  subtaskId: SubtaskId,
  hint: string,
): Promise<void> {
  await invoke('hint_subtask', { runId, subtaskId, hint });
}

// ---------- Phase 3 plan-edit commands ----------
//
// All three reject unless the run is `AwaitingApproval` and the target
// subtask (if any) is `Proposed`. Success emits a fresh
// `run:subtasks_proposed` event carrying the updated plan — the store
// reacts to *that*, not to the command return. Do not mutate store
// state optimistically here.

/**
 * Apply a partial update to a proposed subtask. The `why` field uses
 * `null` as the caller-facing "clear" sentinel; we translate that to
 * the empty-string sentinel the Rust orchestrator recognises (see
 * `ipc::SubtaskPatch` docs). Absent fields are omitted from the wire
 * payload so they land as `None` server-side — "leave alone".
 */
export async function updateSubtask(
  runId: RunId,
  subtaskId: SubtaskId,
  patch: SubtaskPatch,
): Promise<void> {
  const wire: { title?: string; why?: string; assignedWorker?: AgentKind } = {};
  if (patch.title !== undefined) wire.title = patch.title;
  if (patch.why !== undefined) wire.why = patch.why === null ? '' : patch.why;
  if (patch.assignedWorker !== undefined) wire.assignedWorker = patch.assignedWorker;
  await invoke('update_subtask', { runId, subtaskId, patch: wire });
}

/**
 * Append a user-drafted subtask. Returns the server-coined ulid so
 * the UI can address the new row (e.g. to immediately open it for
 * editing again). `why: null` and `why: undefined` are equivalent —
 * both omit the field, which the backend defaults to empty.
 */
export async function addSubtask(
  runId: RunId,
  draft: SubtaskDraft,
): Promise<SubtaskId> {
  const wire: { title: string; why?: string; assignedWorker: AgentKind } = {
    title: draft.title,
    assignedWorker: draft.assignedWorker,
  };
  if (draft.why !== undefined && draft.why !== null) wire.why = draft.why;
  const raw = await invoke<unknown>('add_subtask', { runId, draft: wire });
  return subtaskIdSchema.parse(raw);
}

/**
 * Remove a proposed subtask. Rejects with `HasDependents` if another
 * proposed subtask still declares it as a dependency; the UI should
 * surface the mapped message and ask the user to remove dependents
 * first.
 */
export async function removeSubtask(
  runId: RunId,
  subtaskId: SubtaskId,
): Promise<void> {
  await invoke('remove_subtask', { runId, subtaskId });
}

export async function detectAgents(): Promise<AgentDetectionResult> {
  const raw = await invoke<unknown>('detect_agents');
  return agentDetectionResultSchema.parse(raw);
}

export async function setMasterAgent(agent: AgentKind): Promise<Settings> {
  const raw = await invoke<unknown>('set_master_agent', { agent });
  return settingsSchema.parse(raw);
}

export async function getSettings(): Promise<Settings> {
  const raw = await invoke<unknown>('get_settings');
  return settingsSchema.parse(raw);
}

export async function setSettings(patch: SettingsPatch): Promise<Settings> {
  const raw = await invoke<unknown>('set_settings', { patch });
  return settingsSchema.parse(raw);
}

/**
 * Opens the native folder dialog. Resolves to `null` when the user cancels,
 * or a `RepoInfo` where `isGitRepo` may be `false` if they picked a non-git
 * folder — the UI gatekeeps on that flag before persisting `lastRepo`.
 */
export async function pickRepo(): Promise<RepoInfo | null> {
  const raw = await invoke<unknown>('pick_repo');
  if (raw === null) return null;
  return repoInfoSchema.parse(raw);
}

export async function validateRepo(path: string): Promise<RepoValidation> {
  const raw = await invoke<unknown>('validate_repo', { path });
  return repoValidationSchema.parse(raw);
}

/**
 * Drain the boot-time recovery report. Called once from App.tsx's
 * init effect; the backend has already marked any active-at-crash
 * runs as `Failed` and swept their worktrees, this just surfaces
 * the fact so the user knows a cleanup happened. Read-once: a
 * second call returns `[]`.
 */
export async function consumeRecoveryReport(): Promise<RecoveryEntry[]> {
  const raw = await invoke<unknown>('consume_recovery_report');
  return z.array(recoveryEntrySchema).parse(raw);
}

/**
 * Drain the boot-time migration notices stashed by
 * `settings::migrate`. Sibling of {@link consumeRecoveryReport} —
 * one-shot, returns `[]` after the first call. Surface each
 * `message` once to the user (e.g. as a banner).
 */
export async function consumeMigrationNotices(): Promise<MigrationNotice[]> {
  const raw = await invoke<unknown>('consume_migration_notices');
  return z.array(migrationNoticeSchema).parse(raw);
}

// ---------- Phase 3 Step 5 Layer-3 escalation commands ----------

/**
 * Which tier of the editor-fallback chain won on the backend. The UI
 * uses this to decide whether to also copy the worktree path to the
 * system clipboard:
 *
 *   - `configured` / `environment` / `platform-default` — a spawner
 *     returned `Ok`. The user should see their editor pop up; we stay
 *     silent.
 *   - `clipboard-only` — nothing launched. The backend doesn't touch
 *     the OS clipboard itself (to avoid pulling in a Rust clipboard
 *     crate), so the UI reads `result.path` and writes it via
 *     `navigator.clipboard.writeText`, then surfaces a toast.
 *
 * Kebab-case on the wire (see `src-tauri/src/editor.rs` — `#[serde(rename_all = "kebab-case")]`).
 */
export const editorMethodSchema = z.enum([
  'configured',
  'environment',
  'platform-default',
  'clipboard-only',
]);
export type EditorMethod = z.infer<typeof editorMethodSchema>;

export const editorResultSchema = z.object({
  method: editorMethodSchema,
  path: z.string(),
});
export type EditorResult = z.infer<typeof editorResultSchema>;

/**
 * Response from `skip_subtask`. `skippedCount` includes the escalated
 * subtask itself; a leaf escalation with no dependents returns `1`.
 * `skippedIds` is the full list in BFS traversal order — the UI reads
 * the length for the confirmation toast and ignores the ids (the
 * state-change events for each will land on the wire separately and
 * drive the per-node actors).
 */
export const skipResultSchema = z.object({
  skippedCount: z.number().int().nonnegative(),
  skippedIds: z.array(subtaskIdSchema),
});
export type SkipResult = z.infer<typeof skipResultSchema>;

/**
 * Ask the backend to resolve the worktree path for the escalated
 * subtask and open it in the user's editor. The response reports
 * which tier of the fallback chain succeeded so the UI can surface
 * "opened in <tier>" or "copied to clipboard" feedback — the
 * command never throws on `clipboard-only`; that's a valid outcome.
 *
 * Rejects only on state-mismatch errors: run not parked in
 * `AwaitingHumanFix`, unknown subtask id, subtask not the one
 * currently escalated.
 */
export async function manualFixSubtask(
  runId: RunId,
  subtaskId: SubtaskId,
): Promise<EditorResult> {
  const raw = await invoke<unknown>('manual_fix_subtask', { runId, subtaskId });
  return editorResultSchema.parse(raw);
}

/**
 * Tell the backend the user finished editing the escalated subtask's
 * worktree. The orchestrator stages and commits any pending changes
 * (a clean worktree is a legitimate no-op), flips the subtask to
 * `Done`, re-enters the dispatcher, and any previously-`Waiting`
 * dependents progress. Rejects on state-mismatch errors.
 */
export async function markSubtaskFixed(
  runId: RunId,
  subtaskId: SubtaskId,
): Promise<void> {
  await invoke('mark_subtask_fixed', { runId, subtaskId });
}

/**
 * Skip the escalated subtask. The backend does a BFS forward through
 * the dependency graph and marks every transitive dependent
 * `Skipped` too; the returned `SkipResult` carries the total count +
 * ids for UI feedback. Rejects on state-mismatch errors.
 */
export async function skipSubtask(
  runId: RunId,
  subtaskId: SubtaskId,
): Promise<SkipResult> {
  const raw = await invoke<unknown>('skip_subtask', { runId, subtaskId });
  return skipResultSchema.parse(raw);
}

/**
 * Ask the master for another replan attempt on the escalated
 * subtask's lineage. Only valid when `replanCount < 2` (the lineage
 * cap); the backend rejects with a "replan cap exhausted" error if
 * the UI fails to gate on the count — defence in depth, the button
 * is hidden past the cap but races are possible on rapid clicks.
 */
export async function tryReplanAgain(
  runId: RunId,
  subtaskId: SubtaskId,
): Promise<void> {
  await invoke('try_replan_again', { runId, subtaskId });
}

// ---------- Phase 4 Step 4 worktree inspection commands ----------

/**
 * Did the terminal-open affordance find a spawner, or does the frontend
 * need to fall back to copying the path? Mirrors
 * `worktree_actions::TerminalMethod` on the Rust side.
 *
 *   - `spawned` — a terminal emulator was launched; UI toasts "opened
 *     terminal at ...".
 *   - `clipboard-only` — nothing launched (no candidate resolved or
 *     every spawn failed). UI copies `result.path` via
 *     `navigator.clipboard.writeText` and toasts a fallback message.
 *
 * Kebab-case on the wire (see `worktree_actions.rs` —
 * `#[serde(rename_all = "kebab-case")]`).
 */
export const terminalMethodSchema = z.enum(['spawned', 'clipboard-only']);
export type TerminalMethod = z.infer<typeof terminalMethodSchema>;

export const terminalResultSchema = z.object({
  method: terminalMethodSchema,
  path: z.string(),
});
export type TerminalResult = z.infer<typeof terminalResultSchema>;

/**
 * Look up the worktree path for an inspectable subtask. Pure query,
 * no side effects — used by "Copy path" so the menu item doesn't
 * accidentally shell anything out. Rejects if the run/subtask is
 * unknown, the subtask is in a pre-start state, or the worktree has
 * been reaped (cancelled terminal path clears worktrees).
 */
export async function getSubtaskWorktreePath(
  runId: RunId,
  subtaskId: SubtaskId,
): Promise<string> {
  const raw = await invoke<unknown>('get_subtask_worktree_path', { runId, subtaskId });
  return z.string().parse(raw);
}

/**
 * Reveal the subtask's worktree in the platform file manager (Finder /
 * Explorer / xdg-open delegate). Returns the resolved path on success.
 * Rejects with a "no file manager registered" message when the reveal
 * spawner failed (or no handler exists on this platform) — the UI
 * should surface that as an error toast and let the user fall back to
 * Copy path.
 */
export async function revealWorktree(
  runId: RunId,
  subtaskId: SubtaskId,
): Promise<string> {
  const raw = await invoke<unknown>('reveal_worktree', { runId, subtaskId });
  return z.string().parse(raw);
}

/**
 * Open a terminal emulator at the subtask's worktree. Never rejects on
 * "no terminal found" — the backend returns `{ method: 'clipboard-only',
 * path }` in that case, and the UI branches on `method` to copy the
 * path + toast the fallback. Does reject if the run/subtask lookup
 * fails (unknown id, pre-start state, missing worktree on disk).
 */
export async function openTerminalAt(
  runId: RunId,
  subtaskId: SubtaskId,
): Promise<TerminalResult> {
  const raw = await invoke<unknown>('open_terminal_at', { runId, subtaskId });
  return terminalResultSchema.parse(raw);
}

// Event subscription lives in `runSubscription.ts` — this file exports
// only the raw schemas + EVENT_* constants. The store consumes
// RunSubscription, not a free `listen` helper.
