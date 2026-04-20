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
export const EVENT_COMPLETED = 'run:completed' as const;
export const EVENT_FAILED = 'run:failed' as const;
export const EVENT_MERGE_CONFLICT = 'run:merge_conflict' as const;
export const EVENT_BASE_BRANCH_DIRTY = 'run:base_branch_dirty' as const;
export const EVENT_REPLAN_STARTED = 'run:replan_started' as const;
export const EVENT_HUMAN_ESCALATION = 'run:human_escalation' as const;

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

export const completedSchema = z.object({
  runId: runIdSchema,
  summary: runSummarySchema,
});
export type Completed = z.infer<typeof completedSchema>;

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

// ---------- Settings ----------

export const settingsSchema = z.object({
  lastRepo: z.string().nullable(),
  masterAgent: agentKindSchema,
  claudeBinaryPath: z.string().optional(),
  codexBinaryPath: z.string().optional(),
  geminiBinaryPath: z.string().optional(),
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

// Event subscription lives in `runSubscription.ts` — this file exports
// only the raw schemas + EVENT_* constants. The store consumes
// RunSubscription, not a free `listen` helper.
