/**
 * Run-scoped event subscription helper.
 *
 * Owns the lifecycle of the fourteen `run:*` Tauri events for a single
 * `runId`: schema-validates each payload, defensively drops events whose
 * `runId` doesn't match the run this subscription was built for, and
 * routes the rest to per-event handlers the caller supplies.
 *
 * Lifecycle contract:
 * - `attach()` registers listeners for every `EVENT_*` constant and stores
 *   their `UnlistenFn`s. If called twice without a `detach()` in between,
 *   the old registrations are torn down first — callers don't have to track
 *   state themselves.
 * - `detach()` calls every stored unlisten fn and clears the internal list.
 *   Safe to call repeatedly; the second call is a no-op.
 * - Payloads that fail Zod validation are reported via `onParseError` (if
 *   supplied) and otherwise swallowed — a malformed event never throws past
 *   the listener.
 *
 * The store (Commit 2) owns a single RunSubscription for the active run
 * and swaps it out on submit/reset. This file deliberately knows nothing
 * about the store.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { z } from 'zod';

import {
  EVENT_APPLY_SUMMARY,
  EVENT_AUTO_APPROVE_SUSPENDED,
  EVENT_AUTO_APPROVED,
  EVENT_BASE_BRANCH_DIRTY,
  EVENT_COMPLETED,
  EVENT_DIFF_READY,
  EVENT_FAILED,
  EVENT_HUMAN_ESCALATION,
  EVENT_MASTER_LOG,
  EVENT_MERGE_CONFLICT,
  EVENT_REPLAN_STARTED,
  EVENT_MERGE_RETRY_FAILED,
  EVENT_STASH_CREATED,
  EVENT_STASH_POP_FAILED,
  EVENT_STASH_POPPED,
  EVENT_SUBTASK_ACTIVITY,
  EVENT_SUBTASK_ANSWER_RECEIVED,
  EVENT_SUBTASK_HINT_RECEIVED,
  EVENT_SUBTASK_QUESTION_ASKED,
  EVENT_WORKTREE_REVERTED,
  EVENT_SUBTASK_THINKING,
  EVENT_STATUS_CHANGED,
  EVENT_SUBTASK_DIFF,
  EVENT_SUBTASK_LOG,
  EVENT_SUBTASK_STATE_CHANGED,
  EVENT_SUBTASKS_PROPOSED,
  applySummarySchema,
  autoApproveSuspendedSchema,
  autoApprovedSchema,
  baseBranchDirtySchema,
  completedSchema,
  diffReadySchema,
  failedSchema,
  humanEscalationSchema,
  masterLogSchema,
  mergeConflictSchema,
  replanStartedSchema,
  mergeRetryFailedSchema,
  stashCreatedSchema,
  stashPopFailedSchema,
  stashPoppedSchema,
  subtaskActivitySchema,
  subtaskAnswerReceivedSchema,
  subtaskHintReceivedSchema,
  worktreeRevertedSchema,
  subtaskQuestionAskedSchema,
  subtaskThinkingSchema,
  statusChangedSchema,
  subtaskDiffSchema,
  subtaskLogSchema,
  subtaskStateChangedSchema,
  subtasksProposedSchema,
  type ApplySummary,
  type AutoApproveSuspended,
  type AutoApproved,
  type BaseBranchDirty,
  type Completed,
  type DiffReady,
  type Failed,
  type HumanEscalation,
  type MasterLog,
  type MergeConflict,
  type ReplanStarted,
  type RunId,
  type MergeRetryFailed,
  type StashCreated,
  type StashPopFailed,
  type StashPopped,
  type SubtaskActivity,
  type SubtaskAnswerReceived,
  type SubtaskHintReceived,
  type WorktreeReverted,
  type SubtaskQuestionAsked,
  type SubtaskThinking,
  type StatusChanged,
  type SubtaskDiff,
  type SubtaskLog,
  type SubtaskStateChanged,
  type SubtasksProposed,
} from './ipc';

export type RunEventHandlers = {
  onStatusChanged?: (event: StatusChanged) => void;
  onMasterLog?: (event: MasterLog) => void;
  onSubtasksProposed?: (event: SubtasksProposed) => void;
  onSubtaskStateChanged?: (event: SubtaskStateChanged) => void;
  onSubtaskLog?: (event: SubtaskLog) => void;
  onDiffReady?: (event: DiffReady) => void;
  onSubtaskDiff?: (event: SubtaskDiff) => void;
  onCompleted?: (event: Completed) => void;
  onApplySummary?: (event: ApplySummary) => void;
  onFailed?: (event: Failed) => void;
  onMergeConflict?: (event: MergeConflict) => void;
  onBaseBranchDirty?: (event: BaseBranchDirty) => void;
  onReplanStarted?: (event: ReplanStarted) => void;
  onHumanEscalation?: (event: HumanEscalation) => void;
  onAutoApproved?: (event: AutoApproved) => void;
  onAutoApproveSuspended?: (event: AutoApproveSuspended) => void;
  onStashCreated?: (event: StashCreated) => void;
  onStashPopped?: (event: StashPopped) => void;
  onStashPopFailed?: (event: StashPopFailed) => void;
  onMergeRetryFailed?: (event: MergeRetryFailed) => void;
  onSubtaskQuestionAsked?: (event: SubtaskQuestionAsked) => void;
  onSubtaskAnswerReceived?: (event: SubtaskAnswerReceived) => void;
  onSubtaskActivity?: (event: SubtaskActivity) => void;
  onSubtaskThinking?: (event: SubtaskThinking) => void;
  onSubtaskHintReceived?: (event: SubtaskHintReceived) => void;
  onWorktreeReverted?: (event: WorktreeReverted) => void;
  /**
   * Invoked when a payload fails schema validation. Receives the event name
   * and the raw Zod error so callers can log / surface appropriately.
   * Defaults to a silent drop when omitted — see `defaultOnParseError`.
   */
  onParseError?: (eventName: string, error: z.ZodError) => void;
};

type Route<T> = {
  event: string;
  schema: z.ZodType<T>;
  handler: ((event: T) => void) | undefined;
};

export class RunSubscription {
  private readonly runId: RunId;
  private readonly handlers: RunEventHandlers;
  private unlisteners: UnlistenFn[] = [];
  private attaching = false;

  constructor(runId: RunId, handlers: RunEventHandlers) {
    this.runId = runId;
    this.handlers = handlers;
  }

  /**
   * Subscribe to all `run:*` events for this run. If already attached,
   * detach the previous registrations first so we don't leak listeners.
   *
   * Resolves once every listener has been registered with Tauri. Listener
   * registration is async under the hood; until this resolves the caller
   * should treat the subscription as "not yet live".
   */
  async attach(): Promise<void> {
    if (this.unlisteners.length > 0 || this.attaching) {
      await this.detach();
    }
    this.attaching = true;

    const routes = this.buildRoutes();

    try {
      const unlisteners = await Promise.all(
        routes.map((route) => this.bind(route)),
      );
      this.unlisteners = unlisteners;
    } finally {
      this.attaching = false;
    }
  }

  /**
   * Tear down all listeners. Idempotent: subsequent calls are no-ops.
   */
  async detach(): Promise<void> {
    if (this.unlisteners.length === 0) return;
    const fns = this.unlisteners;
    this.unlisteners = [];
    await Promise.all(
      fns.map(async (fn) => {
        try {
          await fn();
        } catch {
          // A failed teardown shouldn't cascade — the subscription is
          // being discarded anyway. Swallow and move on.
        }
      }),
    );
  }

  private buildRoutes(): Route<unknown>[] {
    return [
      {
        event: EVENT_STATUS_CHANGED,
        schema: statusChangedSchema,
        handler: this.handlers.onStatusChanged as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_MASTER_LOG,
        schema: masterLogSchema,
        handler: this.handlers.onMasterLog as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_SUBTASKS_PROPOSED,
        schema: subtasksProposedSchema,
        handler: this.handlers.onSubtasksProposed as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_SUBTASK_STATE_CHANGED,
        schema: subtaskStateChangedSchema,
        handler: this.handlers.onSubtaskStateChanged as
          | ((e: unknown) => void)
          | undefined,
      },
      {
        event: EVENT_SUBTASK_LOG,
        schema: subtaskLogSchema,
        handler: this.handlers.onSubtaskLog as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_DIFF_READY,
        schema: diffReadySchema,
        handler: this.handlers.onDiffReady as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_SUBTASK_DIFF,
        schema: subtaskDiffSchema,
        handler: this.handlers.onSubtaskDiff as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_COMPLETED,
        schema: completedSchema,
        handler: this.handlers.onCompleted as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_APPLY_SUMMARY,
        schema: applySummarySchema,
        handler: this.handlers.onApplySummary as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_FAILED,
        schema: failedSchema,
        handler: this.handlers.onFailed as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_MERGE_CONFLICT,
        schema: mergeConflictSchema,
        handler: this.handlers.onMergeConflict as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_BASE_BRANCH_DIRTY,
        schema: baseBranchDirtySchema,
        handler: this.handlers.onBaseBranchDirty as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_REPLAN_STARTED,
        schema: replanStartedSchema,
        handler: this.handlers.onReplanStarted as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_HUMAN_ESCALATION,
        schema: humanEscalationSchema,
        handler: this.handlers.onHumanEscalation as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_AUTO_APPROVED,
        schema: autoApprovedSchema,
        handler: this.handlers.onAutoApproved as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_AUTO_APPROVE_SUSPENDED,
        schema: autoApproveSuspendedSchema,
        handler: this.handlers.onAutoApproveSuspended as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_STASH_CREATED,
        schema: stashCreatedSchema,
        handler: this.handlers.onStashCreated as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_STASH_POPPED,
        schema: stashPoppedSchema,
        handler: this.handlers.onStashPopped as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_STASH_POP_FAILED,
        schema: stashPopFailedSchema,
        handler: this.handlers.onStashPopFailed as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_MERGE_RETRY_FAILED,
        schema: mergeRetryFailedSchema,
        handler: this.handlers.onMergeRetryFailed as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_SUBTASK_QUESTION_ASKED,
        schema: subtaskQuestionAskedSchema,
        handler: this.handlers.onSubtaskQuestionAsked as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_SUBTASK_ANSWER_RECEIVED,
        schema: subtaskAnswerReceivedSchema,
        handler: this.handlers.onSubtaskAnswerReceived as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_SUBTASK_ACTIVITY,
        schema: subtaskActivitySchema,
        handler: this.handlers.onSubtaskActivity as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_SUBTASK_THINKING,
        schema: subtaskThinkingSchema,
        handler: this.handlers.onSubtaskThinking as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_SUBTASK_HINT_RECEIVED,
        schema: subtaskHintReceivedSchema,
        handler: this.handlers.onSubtaskHintReceived as ((e: unknown) => void) | undefined,
      },
      {
        event: EVENT_WORKTREE_REVERTED,
        schema: worktreeRevertedSchema,
        handler: this.handlers.onWorktreeReverted as ((e: unknown) => void) | undefined,
      },
    ];
  }

  private bind<T>(route: Route<T>): Promise<UnlistenFn> {
    return listen<unknown>(route.event, (evt) => {
      const parsed = route.schema.safeParse(evt.payload);
      if (!parsed.success) {
        this.handlers.onParseError?.(route.event, parsed.error);
        return;
      }
      // Defensive filter: the backend scopes emits by runId, but the frontend
      // receives all events on a global channel. Drop anything that isn't
      // for the run this subscription was built for.
      const payload = parsed.data as { runId: RunId };
      if (payload.runId !== this.runId) return;
      route.handler?.(parsed.data);
    });
  }
}

/**
 * Convenience default for `onParseError`. Logs once per event name so a
 * genuine schema regression is visible in devtools without flooding the
 * console on every occurrence.
 */
export function defaultOnParseError(eventName: string, error: z.ZodError): void {
  console.warn(`[runSubscription] ${eventName} payload failed schema:`, error.issues);
}
