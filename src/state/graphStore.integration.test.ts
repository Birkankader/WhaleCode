/**
 * End-to-end integration test for the event-sourced store.
 *
 * We mock `@tauri-apps/api/event` (listener registry) and `@tauri-apps/api/
 * core` (invoke), then drive a full run by calling `submitTask` and emitting
 * the `run:*` events a real backend would send. The store under test reacts
 * only to those events — no direct state mutation — which is what this
 * asserts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Tauri event mock ----------

type Listener = (evt: { payload: unknown }) => void;
const listeners = new Map<string, Set<Listener>>();

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
    };
  }),
}));

// ---------- Tauri invoke mock ----------

const invokeHandlers = new Map<string, (args: unknown) => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    const handler = invokeHandlers.get(cmd);
    if (!handler) throw new Error(`unmocked invoke: ${cmd}`);
    return handler(args);
  }),
}));

import {
  EVENT_BASE_BRANCH_DIRTY,
  EVENT_COMPLETED,
  EVENT_DIFF_READY,
  EVENT_FAILED,
  EVENT_MASTER_LOG,
  EVENT_MERGE_CONFLICT,
  EVENT_STATUS_CHANGED,
  EVENT_SUBTASK_LOG,
  EVENT_SUBTASK_STATE_CHANGED,
  EVENT_SUBTASKS_PROPOSED,
} from '../lib/ipc';
import { useRepoStore } from './repoStore';
import { FINAL_ID, MASTER_ID, useGraphStore } from './graphStore';

const BACKEND_RUN_ID = 'run-integration-001';
const REPO_PATH = '/tmp/fake-repo';

function emit(event: string, payload: unknown) {
  const bucket = listeners.get(event);
  if (!bucket) return;
  for (const handler of bucket) handler({ payload });
}

function snap(id: string) {
  return useGraphStore.getState().nodeSnapshots.get(id);
}

function state() {
  return useGraphStore.getState();
}

function seedRepo() {
  useRepoStore.setState({
    currentRepo: {
      path: REPO_PATH,
      name: 'fake-repo',
      isGitRepo: true,
      currentBranch: 'main',
    },
  });
}

beforeEach(() => {
  listeners.clear();
  invokeHandlers.clear();
  useGraphStore.getState().reset();
  seedRepo();
  invokeHandlers.set('submit_task', async () => BACKEND_RUN_ID);
  invokeHandlers.set('approve_subtasks', async () => undefined);
  invokeHandlers.set('reject_run', async () => undefined);
  invokeHandlers.set('apply_run', async () => undefined);
  invokeHandlers.set('discard_run', async () => undefined);
  invokeHandlers.set('cancel_run', async () => undefined);
});

afterEach(() => {
  useGraphStore.getState().reset();
});

describe('graphStore — submit + subscription', () => {
  it('attaches subscription, runId reflects backend, master is thinking', async () => {
    await state().submitTask('Scaffold the settings page');
    const s = state();
    expect(s.runId).toBe(BACKEND_RUN_ID);
    expect(s.status).toBe('planning');
    expect(s.taskInput).toBe('Scaffold the settings page');
    expect(snap(MASTER_ID)?.value).toBe('thinking');
    expect(s.activeSubscription).not.toBeNull();
    expect(listeners.get(EVENT_STATUS_CHANGED)?.size).toBe(1);
  });

  it('rejects concurrent submit when a run is already active', async () => {
    await state().submitTask('run 1');
    await expect(state().submitTask('run 2')).rejects.toThrow(/already active/);
  });

  it('surfaces IPC error and clears optimistic state', async () => {
    invokeHandlers.set('submit_task', async () => {
      throw new Error('backend offline');
    });
    await expect(state().submitTask('x')).rejects.toThrow('backend offline');
    const s = state();
    expect(s.runId).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.currentError).toMatch(/Failed to start run/);
  });

  it('throws when no repo is selected', async () => {
    useRepoStore.setState({ currentRepo: null });
    await expect(state().submitTask('x')).rejects.toThrow(/No repo selected/);
  });
});

describe('graphStore — happy path (realistic backend sequence)', () => {
  it('plan → approve → run → done mirrors every step', async () => {
    await state().submitTask('Build settings page');

    emit(EVENT_MASTER_LOG, { runId: BACKEND_RUN_ID, line: 'Drafting plan…' });
    expect(state().nodeLogs.get(MASTER_ID)).toEqual(['Drafting plan…']);

    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        { id: 'auth', title: 'Auth', why: null, assignedWorker: 'claude', dependencies: [] },
        {
          id: 'tests',
          title: 'Tests',
          why: null,
          assignedWorker: 'gemini',
          dependencies: ['auth'],
        },
      ],
    });
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'awaiting-approval' });

    let s = state();
    expect(s.status).toBe('awaiting_approval');
    expect(s.subtasks).toHaveLength(2);
    expect(s.subtasks[0].agent).toBe('claude');
    expect(s.subtasks[1].dependsOn).toEqual(['auth']);
    expect(snap('auth')?.value).toBe('proposed');
    expect(snap('tests')?.value).toBe('proposed');
    expect(snap(MASTER_ID)?.value).toBe('proposed');

    // User approves, backend acks with running status + per-subtask events.
    await state().approveSubtasks(['auth', 'tests']);
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'running' });

    s = state();
    expect(s.status).toBe('running');
    expect(snap(MASTER_ID)?.value).toBe('approved');
    expect(s.finalNode).not.toBeNull();
    expect(s.finalNode?.files).toEqual([]);
    expect(s.finalNode?.conflictFiles).toBeNull();

    // Backend dispatches auth first, tests waits on auth.
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'auth',
      state: 'running',
    });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'tests',
      state: 'waiting',
    });
    expect(snap('auth')?.value).toBe('running');
    expect(snap('tests')?.value).toBe('waiting');

    emit(EVENT_SUBTASK_LOG, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'auth',
      line: 'Creating src/auth.ts',
    });
    expect(state().nodeLogs.get('auth')).toEqual(['Creating src/auth.ts']);

    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'auth',
      state: 'done',
    });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'tests',
      state: 'running',
    });
    expect(snap('auth')?.value).toBe('done');
    expect(snap('tests')?.value).toBe('running');

    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'tests',
      state: 'done',
    });
    emit(EVENT_DIFF_READY, {
      runId: BACKEND_RUN_ID,
      files: [
        { path: 'src/auth.ts', additions: 10, deletions: 0 },
        { path: 'src/auth.test.ts', additions: 5, deletions: 0 },
      ],
    });
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'done' });

    s = state();
    expect(s.status).toBe('done');
    expect(snap('tests')?.value).toBe('done');
    expect(s.finalNode?.files).toEqual(['src/auth.ts', 'src/auth.test.ts']);
    expect(s.activeSubscription).toBeNull(); // auto-detached
  });

  it('failed subtask (no retries, per MAX_RETRIES=0) lands in failed directly', async () => {
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        { id: 'a', title: 'A', why: null, assignedWorker: 'claude', dependencies: [] },
      ],
    });
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'awaiting-approval' });
    await state().approveSubtasks(['a']);
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'running' });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'running',
    });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'failed',
    });
    expect(snap('a')?.value).toBe('failed');
    expect(snap('a')?.retries).toBe(0);
  });

  it('re-plan appends new subtasks and resets selection to the new wave', async () => {
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        { id: 'a', title: 'A', why: null, assignedWorker: 'claude', dependencies: [] },
      ],
    });
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'awaiting-approval' });
    await state().approveSubtasks(['a']);
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'running' });

    // Backend re-plans: emits a second subtasks_proposed + awaiting-approval.
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        { id: 'b', title: 'B', why: null, assignedWorker: 'gemini', dependencies: [] },
      ],
    });
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'awaiting-approval' });

    const s = state();
    expect(s.subtasks.map((x) => x.id)).toEqual(['a', 'b']);
    expect(s.selectedSubtaskIds).toEqual(new Set(['b']));
    expect(snap(MASTER_ID)?.value).toBe('proposed');
  });
});

describe('graphStore — terminal events auto-detach', () => {
  it('detaches subscription on status done', async () => {
    await state().submitTask('x');
    expect(state().activeSubscription).not.toBeNull();
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'done' });
    expect(state().activeSubscription).toBeNull();
  });

  it('detaches on status failed and surfaces error from Failed event', async () => {
    await state().submitTask('x');
    emit(EVENT_FAILED, { runId: BACKEND_RUN_ID, error: 'something broke' });
    const s = state();
    expect(s.activeSubscription).toBeNull();
    expect(s.status).toBe('failed');
    expect(s.currentError).toBe('something broke');
  });

  it('rejected detaches and leaves graph mounted in muted terminal state', async () => {
    await state().submitTask('x');
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'rejected' });
    const s = state();
    expect(s.status).toBe('rejected');
    expect(s.activeSubscription).toBeNull();
    expect(s.masterNode).not.toBeNull();
  });

  it('merge_conflict does NOT detach — user may retry apply', async () => {
    await state().submitTask('x');
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'merging' });
    emit(EVENT_MERGE_CONFLICT, {
      runId: BACKEND_RUN_ID,
      files: ['src/a.ts', 'src/b.ts'],
    });
    const s = state();
    expect(s.activeSubscription).not.toBeNull();
    expect(s.status).toBe('merging');
    expect(s.finalNode?.conflictFiles).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('graphStore — event payload filtering', () => {
  it('drops events whose runId does not match the active run', async () => {
    await state().submitTask('x');
    emit(EVENT_MASTER_LOG, { runId: 'some-other-run', line: 'stray' });
    expect(state().nodeLogs.get(MASTER_ID)).toBeUndefined();
  });

  it('logs malformed payloads via defaultOnParseError and drops them', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await state().submitTask('x');
    emit(EVENT_MASTER_LOG, { runId: BACKEND_RUN_ID }); // missing `line`
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('graphStore — apply / conflict / completed', () => {
  it('Completed after MergeConflict clears conflictFiles and marks applied', async () => {
    await state().submitTask('x');
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'merging' });
    emit(EVENT_MERGE_CONFLICT, { runId: BACKEND_RUN_ID, files: ['a.ts'] });
    expect(state().finalNode?.conflictFiles).toEqual(['a.ts']);

    emit(EVENT_COMPLETED, {
      runId: BACKEND_RUN_ID,
      summary: {
        runId: BACKEND_RUN_ID,
        subtaskCount: 1,
        filesChanged: 1,
        durationSecs: 5,
        commitsCreated: 1,
      },
    });
    const s = state();
    expect(s.status).toBe('applied');
    expect(s.finalNode?.conflictFiles).toBeNull();
    expect(s.activeSubscription).toBeNull();
  });

  it('DiffReady populates finalNode.files, spawns the node, and activates its actor', async () => {
    // Regression: before the activation fix, the final actor sat at
    // `idle` forever, which FinalNode rendered as a disabled Apply
    // button. DiffReady must drive the actor to `running` so the
    // merge UI is actually clickable.
    await state().submitTask('x');
    emit(EVENT_DIFF_READY, {
      runId: BACKEND_RUN_ID,
      files: [
        { path: 'src/foo.ts', additions: 10, deletions: 2 },
        { path: 'src/bar.ts', additions: 1, deletions: 0 },
      ],
    });
    expect(state().finalNode?.files).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(snap(FINAL_ID)?.value).toBe('running');
  });

  it('Completed after a clean apply lands the final actor in done', async () => {
    await state().submitTask('x');
    emit(EVENT_DIFF_READY, {
      runId: BACKEND_RUN_ID,
      files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
    });
    expect(snap(FINAL_ID)?.value).toBe('running');
    emit(EVENT_COMPLETED, {
      runId: BACKEND_RUN_ID,
      summary: {
        runId: BACKEND_RUN_ID,
        subtaskCount: 1,
        filesChanged: 1,
        durationSecs: 2,
        commitsCreated: 1,
      },
    });
    expect(snap(FINAL_ID)?.value).toBe('done');
    expect(state().status).toBe('applied');
  });

  it('submitTask after a completed/applied run resets stale state and starts fresh', async () => {
    // Regression: after Apply succeeds, `handleCompleted` sets status to
    // `applied` and detaches the subscription, but leaves `runId`
    // populated. App.tsx routes back to EmptyState, the user types a new
    // task and hits Enter — without this fix the submitTask guard threw
    // "A run is already active" and EmptyState silently swallowed the
    // error, so the UI looked frozen. Step 11 of Phase 2 verification
    // (submit another task → reach final → click Discard) was unreachable.
    await state().submitTask('x');
    emit(EVENT_DIFF_READY, {
      runId: BACKEND_RUN_ID,
      files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
    });
    emit(EVENT_COMPLETED, {
      runId: BACKEND_RUN_ID,
      summary: {
        runId: BACKEND_RUN_ID,
        subtaskCount: 1,
        filesChanged: 1,
        durationSecs: 2,
        commitsCreated: 1,
      },
    });
    expect(state().status).toBe('applied');

    await state().submitTask('next task');

    const s = state();
    expect(s.taskInput).toBe('next task');
    expect(s.runId).toBe(BACKEND_RUN_ID);
    expect(s.status).toBe('planning');
    expect(s.activeSubscription).not.toBeNull();
    expect(snap(MASTER_ID)?.value).toBe('thinking');
  });

  it('submitTask after a failed run resets stale state and starts fresh', async () => {
    // Same rationale as the applied-run case: failed is also terminal
    // and must unblock the next submit from EmptyState.
    await state().submitTask('x');
    emit(EVENT_FAILED, {
      runId: BACKEND_RUN_ID,
      error: 'master crashed',
    });
    expect(state().status).toBe('failed');

    await state().submitTask('next task');
    expect(state().status).toBe('planning');
    expect(state().taskInput).toBe('next task');
  });

  it('BaseBranchDirty surfaces via currentError without touching finalNode', async () => {
    // Regression for the step-11 failure mode: pre-flight refuses the
    // merge because the user's base branch has tracked WIP. Unlike a
    // three-way MergeConflict, no worker branch is actually in
    // conflict — the FinalNode should stay clean-apply-able and the
    // error should prompt the user to commit/stash, not re-render as
    // "conflict".
    await state().submitTask('x');
    emit(EVENT_DIFF_READY, {
      runId: BACKEND_RUN_ID,
      files: [{ path: 'src/foo.ts', additions: 3, deletions: 0 }],
    });
    emit(EVENT_BASE_BRANCH_DIRTY, {
      runId: BACKEND_RUN_ID,
      files: ['mobile/services/api.ts', 'README.md'],
    });
    const s = state();
    expect(s.currentError).not.toBeNull();
    expect(s.currentError).toContain('mobile/services/api.ts');
    expect(s.currentError).toContain('README.md');
    // Absolute repo path is included so two identically-named sibling
    // repos can be told apart from the banner alone — see commit notes
    // for the path-mismatch debugging session that motivated this.
    expect(s.currentError).toContain(REPO_PATH);
    // FinalNode stays in its happy-path shape: files populated, no
    // conflict metadata — so Apply stays clickable for the retry.
    expect(s.finalNode?.files).toEqual(['src/foo.ts']);
    expect(s.finalNode?.conflictFiles).toBeNull();
    expect(snap(FINAL_ID)?.value).toBe('running');
  });

  it('applyRun clears a stale BaseBranchDirty currentError on retry', async () => {
    await state().submitTask('x');
    emit(EVENT_DIFF_READY, {
      runId: BACKEND_RUN_ID,
      files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
    });
    emit(EVENT_BASE_BRANCH_DIRTY, {
      runId: BACKEND_RUN_ID,
      files: ['README.md'],
    });
    expect(state().currentError).toContain('README.md');

    // Stub apply_run invoke so applyRun resolves.
    invokeHandlers.set('apply_run', async () => undefined);
    await state().applyRun();
    expect(state().currentError).toBeNull();
  });
});

describe('graphStore — discard / cancel / reset', () => {
  it('discardRun invokes backend and resets store', async () => {
    await state().submitTask('x');
    await state().discardRun();
    const s = state();
    expect(s.runId).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.activeSubscription).toBeNull();
  });

  it('cancelRun invokes backend but leaves store mounted awaiting terminal event', async () => {
    await state().submitTask('x');
    await state().cancelRun();
    const s = state();
    expect(s.runId).toBe(BACKEND_RUN_ID);
    expect(s.activeSubscription).not.toBeNull();
  });

  it('reset detaches subscription and stops actors', async () => {
    await state().submitTask('x');
    const sub = state().activeSubscription;
    expect(sub).not.toBeNull();
    const actors = [...state().nodeActors.values()];
    state().reset();
    const s = state();
    expect(s.activeSubscription).toBeNull();
    expect(s.nodeActors.size).toBe(0);
    for (const a of actors) expect(a.getSnapshot().status).toBe('stopped');
  });
});
