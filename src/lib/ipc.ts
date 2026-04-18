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
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const subtaskStateSchema = z.enum([
  'proposed',
  'waiting',
  'running',
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
});
export type SubtaskData = z.infer<typeof subtaskDataSchema>;

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

// Event subscription lives in `runSubscription.ts` — this file exports
// only the raw schemas + EVENT_* constants. The store consumes
// RunSubscription, not a free `listen` helper.
