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

  it('subtask that fails without a prior Retrying lands in failed with retry count 0', async () => {
    // Phase 3 Step 3a: retry counting lives in graphStore.subtaskRetryCounts,
    // not on the machine snapshot. A first-pass FAIL never entered
    // Retrying, so the counter stays at 0.
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
    expect(state().subtaskRetryCounts.get('a') ?? 0).toBe(0);
  });

  it('re-plan replaces subtasks by id: removed subtasks drop, new ones append, retained ones stay', async () => {
    // Backend always emits the *full* current plan on re-emit (Phase 3
    // edit commands and master re-plan both work this way). The store
    // must diff-by-id: retain surviving rows, stop actors of dropped
    // rows, spawn actors for new rows.
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        { id: 'a', title: 'A', why: null, assignedWorker: 'claude', dependencies: [] },
        { id: 'b', title: 'B', why: null, assignedWorker: 'gemini', dependencies: [] },
      ],
    });
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'awaiting-approval' });
    const actorA = state().nodeActors.get('a');
    expect(actorA).toBeDefined();
    expect(state().selectedSubtaskIds).toEqual(new Set(['a', 'b']));

    // User de-selects `b` before the re-plan to test selection
    // preservation across diffs.
    state().toggleSubtaskSelection('b');
    expect(state().selectedSubtaskIds).toEqual(new Set(['a']));

    // Re-plan: b removed, c added, a retained (same title).
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        { id: 'a', title: 'A', why: null, assignedWorker: 'claude', dependencies: [] },
        { id: 'c', title: 'C', why: null, assignedWorker: 'codex', dependencies: [] },
      ],
    });

    const s = state();
    expect(s.subtasks.map((x) => x.id)).toEqual(['a', 'c']);
    // Actor identity for `a` is preserved across the re-emit so any
    // intermediate state (logs, Step 3a retry counters) survives.
    expect(s.nodeActors.get('a')).toBe(actorA);
    // `b` was dropped — actor is gone and its derived state (snapshot,
    // logs) cleaned up so a later backend stray event can't revive it.
    expect(s.nodeActors.has('b')).toBe(false);
    expect(s.nodeSnapshots.has('b')).toBe(false);
    expect(s.nodeLogs.has('b')).toBe(false);
    expect(actorA?.getSnapshot().status).toBe('active');
    // Selection: `a` (deliberately kept) + `c` (newcomer auto-select).
    expect(s.selectedSubtaskIds).toEqual(new Set(['a', 'c']));
    expect(snap('c')?.value).toBe('proposed');
    expect(snap(MASTER_ID)?.value).toBe('proposed');
  });
});

describe('graphStore — retry counter (Phase 3 Step 3a)', () => {
  // Counter semantics: every backend `Retrying` event bumps the count
  // for that subtask id, including retries that eventually succeed.
  // Cleared when the subtask is removed from the plan via diff, or
  // when the store is reset.

  async function runToFirstRunning() {
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
  }

  it('running → retrying bumps counter to 1 and drives the machine to retrying', async () => {
    await runToFirstRunning();
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'retrying',
    });
    expect(state().subtaskRetryCounts.get('a')).toBe(1);
    expect(snap('a')?.value).toBe('retrying');
  });

  it('two retry events bump the counter to 2 (cumulative, not high-water)', async () => {
    await runToFirstRunning();
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'retrying',
    });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'running',
    });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'retrying',
    });
    expect(state().subtaskRetryCounts.get('a')).toBe(2);
    expect(snap('a')?.value).toBe('retrying');
  });

  it('retrying → running keeps the counter at 1 (recovered retry still shows "retry 1")', async () => {
    await runToFirstRunning();
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'retrying',
    });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'running',
    });
    expect(state().subtaskRetryCounts.get('a')).toBe(1);
    expect(snap('a')?.value).toBe('running');
  });

  it('running → failed without a retry keeps counter at 0', async () => {
    await runToFirstRunning();
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'failed',
    });
    expect(state().subtaskRetryCounts.get('a') ?? 0).toBe(0);
    expect(snap('a')?.value).toBe('failed');
  });

  it('retrying → failed preserves the counter (ladder progression needs the history)', async () => {
    await runToFirstRunning();
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'retrying',
    });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'failed',
    });
    expect(state().subtaskRetryCounts.get('a')).toBe(1);
    expect(snap('a')?.value).toBe('failed');
  });

  it('remove via diff clears the counter', async () => {
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        { id: 'a', title: 'A', why: null, assignedWorker: 'claude', dependencies: [] },
        { id: 'b', title: 'B', why: null, assignedWorker: 'gemini', dependencies: [] },
      ],
    });
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'awaiting-approval' });
    await state().approveSubtasks(['a', 'b']);
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'running' });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'running',
    });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'retrying',
    });
    expect(state().subtaskRetryCounts.get('a')).toBe(1);

    // Re-emit drops `a` — its retry counter should be cleaned up too.
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        { id: 'b', title: 'B', why: null, assignedWorker: 'gemini', dependencies: [] },
      ],
    });
    expect(state().subtaskRetryCounts.has('a')).toBe(false);
  });

  it('reset clears all retry counters', async () => {
    await runToFirstRunning();
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'retrying',
    });
    expect(state().subtaskRetryCounts.get('a')).toBe(1);
    state().reset();
    expect(state().subtaskRetryCounts.size).toBe(0);
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

// Local wire-shape helpers so mock invoke handlers can capture args
// without falling back to `any`. Match the shape built by the
// wrappers in `src/lib/ipc.ts`; the string unions stay loose on
// purpose — these types are only used to read test assertions.
type UpdateArgs = {
  runId: string;
  subtaskId: string;
  patch: { title?: string; why?: string; assignedWorker?: string };
};
type AddArgs = {
  runId: string;
  draft: { title: string; why?: string; assignedWorker: string };
};
type RemoveArgs = { runId: string; subtaskId: string };

describe('graphStore — Phase 3 edit actions', () => {
  // All three actions share the same contract: guard on activeRunId,
  // delegate to IPC, NEVER mutate store state directly — the backend
  // re-emits `run:subtasks_proposed` on success and the diff-by-id
  // handler reconciles. These tests fire the re-emit manually after
  // the IPC mock resolves to exercise the full round-trip.

  async function seedAwaitingApproval() {
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        { id: 'a', title: 'A', why: null, assignedWorker: 'claude', dependencies: [] },
        {
          id: 'b',
          title: 'B',
          why: null,
          assignedWorker: 'gemini',
          dependencies: ['a'],
        },
      ],
    });
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'awaiting-approval' });
  }

  describe('updateSubtask', () => {
    it('happy path: invokes IPC with translated patch, re-emit updates data in place', async () => {
      await seedAwaitingApproval();
      const actorA = state().nodeActors.get('a');
      expect(actorA).toBeDefined();

      let invokedArgs: UpdateArgs | undefined;
      invokeHandlers.set('update_subtask', async (args) => {
        invokedArgs = args as UpdateArgs;
        return undefined;
      });

      await state().updateSubtask('a', {
        title: 'A renamed',
        why: 'new rationale',
        assignedWorker: 'codex',
      });

      expect(invokedArgs).toEqual({
        runId: BACKEND_RUN_ID,
        subtaskId: 'a',
        patch: {
          title: 'A renamed',
          why: 'new rationale',
          assignedWorker: 'codex',
        },
      });

      // Backend re-emits the full plan with the new fields.
      emit(EVENT_SUBTASKS_PROPOSED, {
        runId: BACKEND_RUN_ID,
        subtasks: [
          {
            id: 'a',
            title: 'A renamed',
            why: 'new rationale',
            assignedWorker: 'codex',
            dependencies: [],
          },
          {
            id: 'b',
            title: 'B',
            why: null,
            assignedWorker: 'gemini',
            dependencies: ['a'],
          },
        ],
      });

      const s = state();
      const aRow = s.subtasks.find((t) => t.id === 'a')!;
      expect(aRow.title).toBe('A renamed');
      expect(aRow.why).toBe('new rationale');
      expect(aRow.agent).toBe('codex');
      // Actor identity preserved across the edit — critical for
      // Step 3a retry-state survival.
      expect(s.nodeActors.get('a')).toBe(actorA);
      expect(actorA?.getSnapshot().status).toBe('active');
    });

    it('translates null `why` to empty string on the wire (clear semantics)', async () => {
      await seedAwaitingApproval();
      let invokedArgs: UpdateArgs | undefined;
      invokeHandlers.set('update_subtask', async (args) => {
        invokedArgs = args as UpdateArgs;
        return undefined;
      });
      await state().updateSubtask('a', { why: null });
      expect(invokedArgs?.patch.why).toBe('');
    });

    it('omits undefined fields from the wire payload (leave-alone semantics)', async () => {
      await seedAwaitingApproval();
      let invokedArgs: UpdateArgs | undefined;
      invokeHandlers.set('update_subtask', async (args) => {
        invokedArgs = args as UpdateArgs;
        return undefined;
      });
      await state().updateSubtask('a', { title: 'only-title' });
      expect(invokedArgs?.patch).toEqual({ title: 'only-title' });
      expect(invokedArgs && 'why' in invokedArgs.patch).toBe(false);
      expect(invokedArgs && 'assignedWorker' in invokedArgs.patch).toBe(false);
    });

    it('maps backend errors to a user-facing currentError', async () => {
      await seedAwaitingApproval();
      invokeHandlers.set('update_subtask', async () => {
        throw new Error('invalid edit: title must not be empty');
      });
      await expect(
        state().updateSubtask('a', { title: '   ' }),
      ).rejects.toThrow();
      expect(state().currentError).toBe('Title is required.');
    });

    it('maps SubtaskNotFound to "no longer exists"', async () => {
      await seedAwaitingApproval();
      invokeHandlers.set('update_subtask', async () => {
        throw new Error('subtask ghost not found');
      });
      await expect(
        state().updateSubtask('ghost', { title: 't' }),
      ).rejects.toThrow();
      expect(state().currentError).toBe('Subtask no longer exists.');
    });

    it('maps WrongSubtaskState to "no longer editable"', async () => {
      await seedAwaitingApproval();
      invokeHandlers.set('update_subtask', async () => {
        throw new Error('subtask a is in state Running, expected proposed');
      });
      await expect(state().updateSubtask('a', { title: 't' })).rejects.toThrow();
      expect(state().currentError).toBe('Subtask is no longer editable.');
    });

    it('maps WrongState (run not awaiting-approval) to a clear message', async () => {
      await seedAwaitingApproval();
      invokeHandlers.set('update_subtask', async () => {
        throw new Error('run x is in state Running, expected awaiting-approval');
      });
      await expect(state().updateSubtask('a', { title: 't' })).rejects.toThrow();
      expect(state().currentError).toBe('Run is no longer awaiting approval.');
    });

    it('maps an unavailable worker to a helpful message', async () => {
      await seedAwaitingApproval();
      invokeHandlers.set('update_subtask', async () => {
        throw new Error('invalid edit: assigned worker Gemini is not available');
      });
      await expect(
        state().updateSubtask('a', { assignedWorker: 'gemini' }),
      ).rejects.toThrow();
      expect(state().currentError).toBe(
        'Selected agent is not available on this system.',
      );
    });

    it('falls through to raw error for unmapped shapes', async () => {
      await seedAwaitingApproval();
      invokeHandlers.set('update_subtask', async () => {
        throw new Error('some brand-new failure');
      });
      await expect(state().updateSubtask('a', { title: 't' })).rejects.toThrow();
      expect(state().currentError).toMatch(/Update failed:/);
      expect(state().currentError).toMatch(/some brand-new failure/);
    });

    it('guards on no active run — skips IPC and resolves quietly', async () => {
      useGraphStore.getState().reset();
      const spy = vi.fn();
      invokeHandlers.set('update_subtask', async (args) => {
        spy(args);
        return undefined;
      });
      await state().updateSubtask('a', { title: 't' });
      expect(spy).not.toHaveBeenCalled();
      expect(state().currentError).toBeNull();
    });
  });

  describe('addSubtask', () => {
    it('happy path: invokes IPC, returns server id, re-emit appends the row', async () => {
      await seedAwaitingApproval();
      const priorSelection = new Set(state().selectedSubtaskIds);

      let invokedArgs: AddArgs | undefined;
      invokeHandlers.set('add_subtask', async (args) => {
        invokedArgs = args as AddArgs;
        return 'new-id-42';
      });

      const returnedId = await state().addSubtask({
        title: 'C',
        why: 'because',
        assignedWorker: 'codex',
      });

      expect(returnedId).toBe('new-id-42');
      expect(invokedArgs).toEqual({
        runId: BACKEND_RUN_ID,
        draft: {
          title: 'C',
          why: 'because',
          assignedWorker: 'codex',
        },
      });

      emit(EVENT_SUBTASKS_PROPOSED, {
        runId: BACKEND_RUN_ID,
        subtasks: [
          { id: 'a', title: 'A', why: null, assignedWorker: 'claude', dependencies: [] },
          {
            id: 'b',
            title: 'B',
            why: null,
            assignedWorker: 'gemini',
            dependencies: ['a'],
          },
          {
            id: 'new-id-42',
            title: 'C',
            why: 'because',
            assignedWorker: 'codex',
            dependencies: [],
          },
        ],
      });

      const s = state();
      expect(s.subtasks.map((t) => t.id)).toEqual(['a', 'b', 'new-id-42']);
      // New row spawned a fresh actor.
      expect(s.nodeActors.has('new-id-42')).toBe(true);
      expect(snap('new-id-42')?.value).toBe('proposed');
      // Newcomer auto-selected; prior selections preserved.
      expect(s.selectedSubtaskIds.has('new-id-42')).toBe(true);
      for (const id of priorSelection) {
        expect(s.selectedSubtaskIds.has(id)).toBe(true);
      }
    });

    it('omits why from wire when null or undefined', async () => {
      await seedAwaitingApproval();
      const captured: AddArgs[] = [];
      invokeHandlers.set('add_subtask', async (args) => {
        captured.push(args as AddArgs);
        return 'id';
      });
      await state().addSubtask({ title: 'C', assignedWorker: 'codex' });
      await state().addSubtask({ title: 'D', why: null, assignedWorker: 'codex' });
      expect('why' in captured[0].draft).toBe(false);
      expect('why' in captured[1].draft).toBe(false);
    });

    it('rejected IPC maps through mapEditError and sets currentError', async () => {
      await seedAwaitingApproval();
      invokeHandlers.set('add_subtask', async () => {
        throw new Error('invalid edit: title must not be empty');
      });
      await expect(
        state().addSubtask({ title: '', assignedWorker: 'claude' }),
      ).rejects.toThrow();
      expect(state().currentError).toBe('Title is required.');
    });

    it('guard failure throws and sets currentError (can\'t return a fake id)', async () => {
      useGraphStore.getState().reset();
      const spy = vi.fn();
      invokeHandlers.set('add_subtask', async (args) => {
        spy(args);
        return 'id';
      });
      await expect(
        state().addSubtask({ title: 'C', assignedWorker: 'codex' }),
      ).rejects.toThrow(/No active run/);
      expect(spy).not.toHaveBeenCalled();
      expect(state().currentError).toMatch(/No active run/);
    });
  });

  describe('removeSubtask', () => {
    it('happy path: invokes IPC, re-emit drops the row and cleans up the actor', async () => {
      await seedAwaitingApproval();
      const actorB = state().nodeActors.get('b');
      expect(actorB).toBeDefined();

      let invokedArgs: RemoveArgs | undefined;
      invokeHandlers.set('remove_subtask', async (args) => {
        invokedArgs = args as RemoveArgs;
        return undefined;
      });

      await state().removeSubtask('b');
      expect(invokedArgs).toEqual({ runId: BACKEND_RUN_ID, subtaskId: 'b' });

      emit(EVENT_SUBTASKS_PROPOSED, {
        runId: BACKEND_RUN_ID,
        subtasks: [
          { id: 'a', title: 'A', why: null, assignedWorker: 'claude', dependencies: [] },
        ],
      });

      const s = state();
      expect(s.subtasks.map((t) => t.id)).toEqual(['a']);
      expect(s.nodeActors.has('b')).toBe(false);
      expect(s.nodeSnapshots.has('b')).toBe(false);
      expect(s.nodeLogs.has('b')).toBe(false);
      // Actor was stopped (not just dropped): verifies no leaked
      // XState subscription after removal.
      expect(actorB?.getSnapshot().status).toBe('stopped');
      // Selection intersects with incoming — `b` dropped out.
      expect(s.selectedSubtaskIds.has('b')).toBe(false);
    });

    it('maps HasDependents to the "remove dependents first" message', async () => {
      await seedAwaitingApproval();
      invokeHandlers.set('remove_subtask', async () => {
        throw new Error(
          'subtask a has dependents in the plan; remove them first',
        );
      });
      await expect(state().removeSubtask('a')).rejects.toThrow();
      expect(state().currentError).toMatch(/another subtask depends/);
    });

    it('guards on no active run — skips IPC and resolves quietly', async () => {
      useGraphStore.getState().reset();
      const spy = vi.fn();
      invokeHandlers.set('remove_subtask', async (args) => {
        spy(args);
        return undefined;
      });
      await state().removeSubtask('a');
      expect(spy).not.toHaveBeenCalled();
      expect(state().currentError).toBeNull();
    });
  });

  it('store reflects the `why` field carried by subtask data', async () => {
    // Regression: before the SubtaskNodeData change, `why` was
    // silently dropped on the way into the store, so the edit row in
    // Step 2 would have rendered a stale/empty rationale after the
    // re-emit.
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        {
          id: 'a',
          title: 'A',
          why: 'initial rationale',
          assignedWorker: 'claude',
          dependencies: [],
        },
      ],
    });
    expect(state().subtasks[0].why).toBe('initial rationale');

    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        {
          id: 'a',
          title: 'A',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
        },
      ],
    });
    expect(state().subtasks[0].why).toBeNull();
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

  it('rejectAll invokes backend and resets store', async () => {
    // Regression: without the reset the graph stayed on screen in its
    // "awaiting approval" layout — ApprovalBar hidden (status flipped
    // to `rejected`) but the Master + proposed subtask cards stuck
    // around with no affordance to move on. Mirror discardRun: user
    // said no → drop the graph → back to EmptyState.
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        {
          id: 'one',
          title: 'Add naber.txt greeting',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
        },
      ],
    });
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'awaiting-approval' });
    expect(state().subtasks).toHaveLength(1);
    expect(state().status).toBe('awaiting_approval');

    await state().rejectAll();

    const s = state();
    expect(s.runId).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.subtasks).toHaveLength(0);
    expect(s.activeSubscription).toBeNull();
    expect(s.nodeActors.size).toBe(0);
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
