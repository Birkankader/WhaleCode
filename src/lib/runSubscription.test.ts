import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

type Listener = (evt: { payload: unknown }) => void;

// Per-test registry of listeners the production code registers via `listen`.
// Each test resets this so registrations/unregistrations don't bleed.
const listeners = new Map<string, Set<Listener>>();
const unlisten = vi.fn<(() => void | Promise<void>)>();

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: Listener) => {
    let bucket = listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      listeners.set(event, bucket);
    }
    bucket.add(handler);
    return () => {
      bucket!.delete(handler);
      unlisten();
    };
  }),
}));

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
} from './ipc';
import { defaultOnParseError, RunSubscription } from './runSubscription';

const ALL_EVENTS = [
  EVENT_STATUS_CHANGED,
  EVENT_MASTER_LOG,
  EVENT_SUBTASKS_PROPOSED,
  EVENT_SUBTASK_STATE_CHANGED,
  EVENT_SUBTASK_LOG,
  EVENT_DIFF_READY,
  EVENT_COMPLETED,
  EVENT_FAILED,
  EVENT_MERGE_CONFLICT,
];

function emit(event: string, payload: unknown) {
  const bucket = listeners.get(event);
  if (!bucket) return;
  for (const handler of bucket) handler({ payload });
}

function totalListeners(): number {
  let n = 0;
  for (const bucket of listeners.values()) n += bucket.size;
  return n;
}

beforeEach(() => {
  listeners.clear();
  unlisten.mockClear();
});

describe('RunSubscription.attach', () => {
  it('registers one listener per run:* event', async () => {
    const sub = new RunSubscription('r1', {});
    await sub.attach();
    for (const event of ALL_EVENTS) {
      expect(listeners.get(event)?.size ?? 0).toBe(1);
    }
    expect(totalListeners()).toBe(ALL_EVENTS.length);
  });

  it('detaches previous registrations when called twice in a row', async () => {
    const sub = new RunSubscription('r1', {});
    await sub.attach();
    const before = totalListeners();
    await sub.attach();
    // Still N listeners, not 2N — re-attach tore down the first batch.
    expect(totalListeners()).toBe(before);
    expect(unlisten).toHaveBeenCalledTimes(ALL_EVENTS.length);
  });
});

describe('RunSubscription.detach', () => {
  it('clears all listeners', async () => {
    const sub = new RunSubscription('r1', {});
    await sub.attach();
    await sub.detach();
    expect(totalListeners()).toBe(0);
    expect(unlisten).toHaveBeenCalledTimes(ALL_EVENTS.length);
  });

  it('is idempotent — second call is a no-op', async () => {
    const sub = new RunSubscription('r1', {});
    await sub.attach();
    await sub.detach();
    await sub.detach();
    expect(totalListeners()).toBe(0);
    // Unlisten should still only fire once per registered listener.
    expect(unlisten).toHaveBeenCalledTimes(ALL_EVENTS.length);
  });

  it('swallows errors from individual unlisten fns', async () => {
    // Force the next unlisten call to throw. The test mock's returned fn
    // calls `unlisten()` on invocation, so this fires during detach.
    unlisten.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const sub = new RunSubscription('r1', {});
    await sub.attach();
    await expect(sub.detach()).resolves.toBeUndefined();
    expect(totalListeners()).toBe(0);
  });
});

describe('RunSubscription payload routing', () => {
  it('routes valid payloads to the matching handler', async () => {
    const onStatusChanged = vi.fn();
    const sub = new RunSubscription('r1', { onStatusChanged });
    await sub.attach();
    emit(EVENT_STATUS_CHANGED, { runId: 'r1', status: 'running' });
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
    expect(onStatusChanged).toHaveBeenCalledWith({ runId: 'r1', status: 'running' });
  });

  it('defensively drops events whose runId does not match', async () => {
    const onStatusChanged = vi.fn();
    const sub = new RunSubscription('r1', { onStatusChanged });
    await sub.attach();
    emit(EVENT_STATUS_CHANGED, { runId: 'OTHER', status: 'running' });
    expect(onStatusChanged).not.toHaveBeenCalled();
  });

  it('invokes onParseError for malformed payloads and swallows the event', async () => {
    const onStatusChanged = vi.fn();
    const onParseError = vi.fn();
    const sub = new RunSubscription('r1', { onStatusChanged, onParseError });
    await sub.attach();
    // `status` is not a legal RunStatus — schema rejects.
    emit(EVENT_STATUS_CHANGED, { runId: 'r1', status: 'not-a-real-status' });
    expect(onParseError).toHaveBeenCalledTimes(1);
    expect(onParseError.mock.calls[0][0]).toBe(EVENT_STATUS_CHANGED);
    expect(onStatusChanged).not.toHaveBeenCalled();
  });

  it('silently drops malformed payloads when onParseError is not supplied', async () => {
    const onStatusChanged = vi.fn();
    const sub = new RunSubscription('r1', { onStatusChanged });
    await sub.attach();
    // Must not throw past the listener.
    expect(() => emit(EVENT_STATUS_CHANGED, { garbage: true })).not.toThrow();
    expect(onStatusChanged).not.toHaveBeenCalled();
  });

  it('routes each event type to the right handler in isolation', async () => {
    const handlers = {
      onStatusChanged: vi.fn(),
      onMasterLog: vi.fn(),
      onSubtasksProposed: vi.fn(),
      onSubtaskStateChanged: vi.fn(),
      onSubtaskLog: vi.fn(),
      onDiffReady: vi.fn(),
      onCompleted: vi.fn(),
      onFailed: vi.fn(),
      onMergeConflict: vi.fn(),
    };
    const sub = new RunSubscription('r1', handlers);
    await sub.attach();

    emit(EVENT_MASTER_LOG, { runId: 'r1', line: 'hello' });
    emit(EVENT_SUBTASKS_PROPOSED, { runId: 'r1', subtasks: [] });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: 'r1',
      subtaskId: 's1',
      state: 'running',
    });
    emit(EVENT_SUBTASK_LOG, { runId: 'r1', subtaskId: 's1', line: 'log' });
    emit(EVENT_DIFF_READY, { runId: 'r1', files: [] });
    emit(EVENT_COMPLETED, {
      runId: 'r1',
      summary: {
        runId: 'r1',
        subtaskCount: 0,
        filesChanged: 0,
        durationSecs: 0,
        commitsCreated: 0,
      },
    });
    emit(EVENT_FAILED, { runId: 'r1', error: 'boom' });
    emit(EVENT_MERGE_CONFLICT, { runId: 'r1', files: ['a.ts'] });

    expect(handlers.onMasterLog).toHaveBeenCalledTimes(1);
    expect(handlers.onSubtasksProposed).toHaveBeenCalledTimes(1);
    expect(handlers.onSubtaskStateChanged).toHaveBeenCalledTimes(1);
    expect(handlers.onSubtaskLog).toHaveBeenCalledTimes(1);
    expect(handlers.onDiffReady).toHaveBeenCalledTimes(1);
    expect(handlers.onCompleted).toHaveBeenCalledTimes(1);
    expect(handlers.onFailed).toHaveBeenCalledTimes(1);
    expect(handlers.onMergeConflict).toHaveBeenCalledTimes(1);
    // Omitted: status_changed handler was wired but not emitted here.
    expect(handlers.onStatusChanged).not.toHaveBeenCalled();
  });

  it('tolerates events for which no handler was supplied', async () => {
    const sub = new RunSubscription('r1', {});
    await sub.attach();
    expect(() =>
      emit(EVENT_STATUS_CHANGED, { runId: 'r1', status: 'running' }),
    ).not.toThrow();
  });

  it('stops delivering events after detach', async () => {
    const onStatusChanged = vi.fn();
    const sub = new RunSubscription('r1', { onStatusChanged });
    await sub.attach();
    await sub.detach();
    emit(EVENT_STATUS_CHANGED, { runId: 'r1', status: 'running' });
    expect(onStatusChanged).not.toHaveBeenCalled();
  });
});

describe('defaultOnParseError', () => {
  it('warns once per invocation without throwing', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = z.object({ n: z.number() }).safeParse({ n: 'no' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(() => defaultOnParseError('run:status_changed', result.error)).not.toThrow();
    }
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
