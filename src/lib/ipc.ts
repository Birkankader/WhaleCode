/**
 * Typed wire contract between the React frontend and the Rust backend.
 *
 * The shapes here mirror `src-tauri/src/ipc/{mod,events,commands}.rs` by
 * hand — keep the two sides in sync when editing either. Zod schemas are
 * applied at the boundary so a backend-shape drift surfaces as a parse
 * error instead of a silent `undefined` deep in the UI.
 *
 * Command wrappers wrap `invoke()`; `listenRunEvents()` subscribes a bundle
 * of handlers to the `run:*` event family for a single run and returns a
 * single unsubscribe function.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { z } from 'zod';

// ---------- Shared scalar / enum schemas ----------

export const runIdSchema = z.string();
export type RunId = z.infer<typeof runIdSchema>;

export const subtaskIdSchema = z.string();
export type SubtaskId = z.infer<typeof subtaskIdSchema>;

export const agentKindSchema = z.enum(['claude', 'codex', 'gemini']);
export type AgentKind = z.infer<typeof agentKindSchema>;

export const agentStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), version: z.string() }),
  z.object({ status: z.literal('broken'), error: z.string() }),
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
  subtasksTotal: z.number().int().nonnegative(),
  subtasksDone: z.number().int().nonnegative(),
  subtasksFailed: z.number().int().nonnegative(),
  filesChanged: z.number().int().nonnegative(),
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

export async function setMasterAgent(agent: AgentKind): Promise<void> {
  await invoke('set_master_agent', { agent });
}

// ---------- Event subscription ----------

export type RunEventHandlers = {
  onStatusChanged?: (payload: StatusChanged) => void;
  onMasterLog?: (payload: MasterLog) => void;
  onSubtasksProposed?: (payload: SubtasksProposed) => void;
  onSubtaskStateChanged?: (payload: SubtaskStateChanged) => void;
  onSubtaskLog?: (payload: SubtaskLog) => void;
  onDiffReady?: (payload: DiffReady) => void;
  onCompleted?: (payload: Completed) => void;
  onFailed?: (payload: Failed) => void;
  /** Called when a payload fails schema validation. Default: log to console. */
  onParseError?: (event: string, error: unknown, raw: unknown) => void;
};

export type Unsubscribe = () => void;

/**
 * Subscribe to all `run:*` events for a given `runId`. Payloads for other
 * runs are ignored (Tauri emits globally). Returns a single unsubscribe
 * function that tears down every listener registered here.
 */
export async function listenRunEvents(
  runId: RunId,
  handlers: RunEventHandlers,
): Promise<Unsubscribe> {
  const unlisteners: UnlistenFn[] = [];

  const bind = async <T>(
    name: string,
    schema: z.ZodType<T>,
    handler: ((payload: T) => void) | undefined,
  ) => {
    if (!handler) return;
    const un = await listen<unknown>(name, (event) => {
      const parsed = schema.safeParse(event.payload);
      if (!parsed.success) {
        (handlers.onParseError ?? defaultOnParseError)(name, parsed.error, event.payload);
        return;
      }
      // Every run:* payload has a runId; drop events for other runs.
      const payloadRunId = (parsed.data as { runId: RunId }).runId;
      if (payloadRunId !== runId) return;
      handler(parsed.data);
    });
    unlisteners.push(un);
  };

  await Promise.all([
    bind(EVENT_STATUS_CHANGED, statusChangedSchema, handlers.onStatusChanged),
    bind(EVENT_MASTER_LOG, masterLogSchema, handlers.onMasterLog),
    bind(EVENT_SUBTASKS_PROPOSED, subtasksProposedSchema, handlers.onSubtasksProposed),
    bind(
      EVENT_SUBTASK_STATE_CHANGED,
      subtaskStateChangedSchema,
      handlers.onSubtaskStateChanged,
    ),
    bind(EVENT_SUBTASK_LOG, subtaskLogSchema, handlers.onSubtaskLog),
    bind(EVENT_DIFF_READY, diffReadySchema, handlers.onDiffReady),
    bind(EVENT_COMPLETED, completedSchema, handlers.onCompleted),
    bind(EVENT_FAILED, failedSchema, handlers.onFailed),
  ]);

  return () => {
    for (const un of unlisteners) un();
  };
}

function defaultOnParseError(event: string, error: unknown, raw: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[ipc] rejected ${event} payload`, { error, raw });
}
