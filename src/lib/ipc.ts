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

export const fileDiffSchema = z.object({
  path: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
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

export const subtaskStateChangedSchema = z.object({
  runId: runIdSchema,
  subtaskId: subtaskIdSchema,
  state: subtaskStateSchema,
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

// Event subscription lives in `runSubscription.ts` — this file exports
// only the raw schemas + EVENT_* constants. The store consumes
// RunSubscription, not a free `listen` helper.
