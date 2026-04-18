/**
 * Run-scoped event subscription helper.
 *
 * Owns the lifecycle of the nine `run:*` Tauri events for a single `runId`:
 * schema-validates each payload, defensively drops events whose `runId`
 * doesn't match the run this subscription was built for, and routes the
 * rest to per-event handlers the caller supplies.
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
  EVENT_COMPLETED,
  EVENT_DIFF_READY,
  EVENT_FAILED,
  EVENT_MASTER_LOG,
  EVENT_MERGE_CONFLICT,
  EVENT_STATUS_CHANGED,
  EVENT_SUBTASK_LOG,
  EVENT_SUBTASK_STATE_CHANGED,
  EVENT_SUBTASKS_PROPOSED,
  completedSchema,
  diffReadySchema,
  failedSchema,
  masterLogSchema,
  mergeConflictSchema,
  statusChangedSchema,
  subtaskLogSchema,
  subtaskStateChangedSchema,
  subtasksProposedSchema,
  type Completed,
  type DiffReady,
  type Failed,
  type MasterLog,
  type MergeConflict,
  type RunId,
  type StatusChanged,
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
  onCompleted?: (event: Completed) => void;
  onFailed?: (event: Failed) => void;
  onMergeConflict?: (event: MergeConflict) => void;
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
        event: EVENT_COMPLETED,
        schema: completedSchema,
        handler: this.handlers.onCompleted as ((e: unknown) => void) | undefined,
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
