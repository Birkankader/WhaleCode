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
  EVENT_APPLY_SUMMARY,
  EVENT_BASE_BRANCH_DIRTY,
  EVENT_STASH_CREATED,
  EVENT_STASH_POP_FAILED,
  EVENT_STASH_POPPED,
  EVENT_SUBTASK_ACTIVITY,
  EVENT_SUBTASK_ANSWER_RECEIVED,
  EVENT_SUBTASK_HINT_RECEIVED,
  EVENT_SUBTASK_QUESTION_ASKED,
  EVENT_SUBTASK_THINKING,
  EVENT_WORKTREE_REVERTED,
  EVENT_COMPLETED,
  EVENT_DIFF_READY,
  EVENT_FAILED,
  EVENT_HUMAN_ESCALATION,
  EVENT_MASTER_LOG,
  EVENT_MERGE_CONFLICT,
  EVENT_MERGE_RETRY_FAILED,
  EVENT_REPLAN_STARTED,
  EVENT_STATUS_CHANGED,
  EVENT_SUBTASK_DIFF,
  EVENT_SUBTASK_LOG,
  EVENT_SUBTASK_STATE_CHANGED,
  EVENT_SUBTASKS_PROPOSED,
} from '../lib/ipc';
import { useRepoStore } from './repoStore';
import {
  FINAL_ID,
  MASTER_ID,
  isSubtaskAdded,
  isSubtaskEdited,
  useGraphStore,
} from './graphStore';

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
  invokeHandlers.set('cancel_subtask', async () => undefined);
  invokeHandlers.set('stash_and_retry_apply', async () => undefined);
  invokeHandlers.set('pop_stash', async () => undefined);
  invokeHandlers.set('retry_apply', async () => undefined);
  invokeHandlers.set('answer_subtask_question', async () => undefined);
  invokeHandlers.set('skip_subtask_question', async () => undefined);
  invokeHandlers.set('hint_subtask', async () => undefined);
  invokeHandlers.set('revert_subtask_changes', async () => undefined);
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
    // Phase 4 Step 2: happy-path detach is deferred to ApplySummary.
    // `StatusChanged(Done)` alone keeps the subscription live so the
    // summary payload can land.
    expect(s.activeSubscription).not.toBeNull();
    emit(EVENT_APPLY_SUMMARY, {
      runId: BACKEND_RUN_ID,
      commitSha: 'cccccccc00000000000000000000000000000000',
      branch: 'main',
      filesChanged: 2,
      perWorker: [
        { subtaskId: 'auth', filesChanged: 1 },
        { subtaskId: 'tests', filesChanged: 1 },
      ],
    });
    expect(state().activeSubscription).toBeNull();
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

  it('Failed with errorCategory stashes the kind and re-arms a dismissed banner on new kinds', async () => {
    // Phase 4 Step 5: SubtaskStateChanged(Failed, errorCategory=?)
    // routes through `handleSubtaskStateChanged` which populates
    // `subtaskErrorCategories` and manages the banner-dismissal latch.
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

    // First failure: stash the category, latch stays false.
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'failed',
      errorCategory: { kind: 'process-crashed' },
    });
    expect(state().subtaskErrorCategories.get('a')).toEqual({ kind: 'process-crashed' });
    expect(state().errorCategoryBannerDismissed).toBe(false);

    // User dismisses — latch flips true.
    state().dismissError();
    expect(state().errorCategoryBannerDismissed).toBe(true);

    // Same kind re-emit on the same subtask: latch stays true (no
    // surprise re-appearance).
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      state: 'failed',
      errorCategory: { kind: 'process-crashed' },
    });
    expect(state().errorCategoryBannerDismissed).toBe(true);

    // Different subtask with any category: latch re-arms to false.
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'b',
      state: 'failed',
      errorCategory: { kind: 'timeout', afterSecs: 600 },
    });
    expect(state().subtaskErrorCategories.get('b')).toEqual({
      kind: 'timeout',
      afterSecs: 600,
    });
    expect(state().errorCategoryBannerDismissed).toBe(false);
  });

  it('Failed without errorCategory leaves the store untouched (pre-Step-5 backward compat)', async () => {
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
      state: 'failed',
    });
    expect(state().subtaskErrorCategories.has('a')).toBe(false);
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

describe('graphStore — Layer-2 replan + Layer-3 human escalation', () => {
  // The retry ladder: worker Retrying (Layer-1) → master replan (Layer-2)
  // → human escalation (Layer-3). Layer-1 is covered by the retry-counter
  // block above. These tests cover the two new event handlers that close
  // the ladder.

  async function runUntilFailure() {
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
  }

  it('ReplanStarted flips master back to thinking and sets replanningSubtaskId', async () => {
    await runUntilFailure();
    // Master is in `approved` by now — it signed off on the plan.
    expect(snap(MASTER_ID)?.value).toBe('approved');
    expect(state().replanningSubtaskId).toBeNull();

    emit(EVENT_REPLAN_STARTED, { runId: BACKEND_RUN_ID, failedSubtaskId: 'a' });

    expect(snap(MASTER_ID)?.value).toBe('thinking');
    expect(state().replanningSubtaskId).toBe('a');
  });

  it('ReplanStarted for a stranger runId is dropped', async () => {
    await runUntilFailure();
    emit(EVENT_REPLAN_STARTED, { runId: 'some-other-run', failedSubtaskId: 'a' });
    expect(snap(MASTER_ID)?.value).toBe('approved');
    expect(state().replanningSubtaskId).toBeNull();
  });

  it('replacement SubtasksProposed clears replanningSubtaskId and propagates `replaces`', async () => {
    await runUntilFailure();
    emit(EVENT_REPLAN_STARTED, { runId: BACKEND_RUN_ID, failedSubtaskId: 'a' });
    expect(state().replanningSubtaskId).toBe('a');

    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        // Failed row retained (kept visible with its `failed` snapshot).
        { id: 'a', title: 'A', why: null, assignedWorker: 'claude', dependencies: [], replaces: [] },
        // Fresh replacement.
        {
          id: 'a2',
          title: 'A (repaired)',
          why: null,
          assignedWorker: 'codex',
          dependencies: [],
          replaces: ['a'],
        },
      ],
    });

    const s = state();
    expect(s.replanningSubtaskId).toBeNull();
    const replacement = s.subtasks.find((t) => t.id === 'a2')!;
    expect(replacement.replaces).toEqual(['a']);
    // Failed row kept its `failed` snapshot — the replacement carries the
    // lineage visually via its `replaces` field, not by transitioning the
    // original.
    expect(snap('a')?.value).toBe('failed');
    expect(snap('a2')?.value).toBe('proposed');
  });

  it('HumanEscalation from a `failed` subtask drives it through escalating → human_escalation', async () => {
    await runUntilFailure();
    expect(snap('a')?.value).toBe('failed');

    emit(EVENT_HUMAN_ESCALATION, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      reason: 'master returned an empty plan',
      suggestedAction: 'consider splitting the task manually',
    });

    const s = state();
    expect(snap('a')?.value).toBe('human_escalation');
    expect(s.humanEscalation).toEqual({
      subtaskId: 'a',
      reason: 'master returned an empty plan',
      suggestedAction: 'consider splitting the task manually',
    });
    // ReplanStarted + HumanEscalation can arrive in either order; either
    // way, escalation clears the transient flag.
    expect(s.replanningSubtaskId).toBeNull();
  });

  it('HumanEscalation defaults missing suggestedAction to null', async () => {
    await runUntilFailure();
    emit(EVENT_HUMAN_ESCALATION, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      reason: 'lineage exhausted two replans',
    });
    expect(state().humanEscalation).toEqual({
      subtaskId: 'a',
      reason: 'lineage exhausted two replans',
      suggestedAction: null,
    });
  });

  it('full ladder: failure → replan_started → replacement proposal (awaiting approval again)', async () => {
    await runUntilFailure();

    // Layer-2 kicks in.
    emit(EVENT_REPLAN_STARTED, { runId: BACKEND_RUN_ID, failedSubtaskId: 'a' });
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'awaiting-approval' });
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        { id: 'a', title: 'A', why: null, assignedWorker: 'claude', dependencies: [], replaces: [] },
        {
          id: 'a2',
          title: 'A (repaired)',
          why: null,
          assignedWorker: 'codex',
          dependencies: [],
          replaces: ['a'],
        },
      ],
    });

    const s = state();
    expect(s.status).toBe('awaiting_approval');
    expect(s.replanningSubtaskId).toBeNull();
    expect(s.subtasks.find((t) => t.id === 'a2')?.replaces).toEqual(['a']);
    // Master walks back to `proposed` for the re-approval gate.
    expect(snap(MASTER_ID)?.value).toBe('proposed');
  });

  it('reset clears replanningSubtaskId and humanEscalation', async () => {
    await runUntilFailure();
    emit(EVENT_REPLAN_STARTED, { runId: BACKEND_RUN_ID, failedSubtaskId: 'a' });
    emit(EVENT_HUMAN_ESCALATION, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'a',
      reason: 'boom',
    });
    expect(state().humanEscalation).not.toBeNull();

    state().reset();
    const s = state();
    expect(s.replanningSubtaskId).toBeNull();
    expect(s.humanEscalation).toBeNull();
  });
});

describe('graphStore — terminal events auto-detach', () => {
  it('detaches subscription after ApplySummary (not on plain status done)', async () => {
    // Phase 4 Step 2: detach for the applied path is deferred to the
    // terminal ApplySummary event so the overlay payload isn't dropped
    // mid-sequence. `StatusChanged(Done)` on its own is not enough.
    await state().submitTask('x');
    expect(state().activeSubscription).not.toBeNull();
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'done' });
    expect(state().activeSubscription).not.toBeNull();
    emit(EVENT_APPLY_SUMMARY, {
      runId: BACKEND_RUN_ID,
      commitSha: 'bbbbbbbb00000000000000000000000000000000',
      branch: 'main',
      filesChanged: 0,
      perWorker: [],
    });
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
    let s = state();
    expect(s.status).toBe('applied');
    expect(s.finalNode?.conflictFiles).toBeNull();
    // Phase 4 Step 2: detach is now deferred to ApplySummary so the
    // summary event can land through the same subscription. Until that
    // arrives the subscription stays live.
    expect(s.activeSubscription).not.toBeNull();

    emit(EVENT_APPLY_SUMMARY, {
      runId: BACKEND_RUN_ID,
      commitSha: 'aaaaaaaa00000000000000000000000000000000',
      branch: 'main',
      filesChanged: 1,
      perWorker: [],
    });
    s = state();
    expect(s.activeSubscription).toBeNull();
  });

  it('SubtaskDiff populates subtaskDiffs map keyed by subtask id', async () => {
    // Phase 3.5 Item 6: per-subtask diff arrives incrementally during
    // the Apply pre-merge pass. Each event fills in one map entry;
    // siblings coexist; empty-file vecs are preserved (the UI uses
    // them to render "0 files" rather than hide the chip).
    await state().submitTask('x');
    emit(EVENT_SUBTASK_DIFF, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'sub-a',
      files: [
        { path: 'src/a.ts', additions: 5, deletions: 1 },
        { path: 'src/b.ts', additions: 2, deletions: 0 },
      ],
    });
    emit(EVENT_SUBTASK_DIFF, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'sub-b',
      files: [],
    });

    const diffs = state().subtaskDiffs;
    expect(diffs.get('sub-a')).toEqual([
      { path: 'src/a.ts', additions: 5, deletions: 1 },
      { path: 'src/b.ts', additions: 2, deletions: 0 },
    ]);
    expect(diffs.get('sub-b')).toEqual([]);
  });

  it('SubtaskDiff scoped to another run is ignored', async () => {
    await state().submitTask('x');
    emit(EVENT_SUBTASK_DIFF, {
      runId: 'some-other-run',
      subtaskId: 'sub-a',
      files: [{ path: 'ignored.ts', additions: 1, deletions: 0 }],
    });
    expect(state().subtaskDiffs.has('sub-a')).toBe(false);
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

  it('ApplySummary payload is parked on applySummary slice and graph state is preserved', async () => {
    // Phase 4 Step 2. Backend's ordering invariant is
    // DiffReady → Completed → StatusChanged(Done) → ApplySummary.
    // The frontend should flip to `applied` on Completed and ONLY then
    // receive the summary — and the graph data (subtasks, finalNode)
    // must survive the transition so the overlay's per-worker rows
    // can resolve titles from the store.
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        {
          id: 'sub-a',
          title: 'Worker A',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
          replaces: [],
          replanCount: 0,
        },
        {
          id: 'sub-b',
          title: 'Worker B',
          why: null,
          assignedWorker: 'codex',
          dependencies: [],
          replaces: [],
          replanCount: 0,
        },
      ],
    });
    emit(EVENT_DIFF_READY, {
      runId: BACKEND_RUN_ID,
      files: [
        { path: 'src/a.ts', additions: 1, deletions: 0 },
        { path: 'src/b.ts', additions: 2, deletions: 1 },
      ],
    });
    emit(EVENT_COMPLETED, {
      runId: BACKEND_RUN_ID,
      summary: {
        runId: BACKEND_RUN_ID,
        subtaskCount: 2,
        filesChanged: 2,
        durationSecs: 3,
        commitsCreated: 1,
      },
    });
    expect(state().status).toBe('applied');
    expect(state().applySummary).toBeNull();

    emit(EVENT_APPLY_SUMMARY, {
      runId: BACKEND_RUN_ID,
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      branch: 'main',
      filesChanged: 2,
      perWorker: [
        { subtaskId: 'sub-a', filesChanged: 1 },
        { subtaskId: 'sub-b', filesChanged: 1 },
      ],
    });

    const s = state();
    // Payload parked verbatim.
    expect(s.applySummary).toEqual({
      runId: BACKEND_RUN_ID,
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      branch: 'main',
      filesChanged: 2,
      perWorker: [
        { subtaskId: 'sub-a', filesChanged: 1 },
        { subtaskId: 'sub-b', filesChanged: 1 },
      ],
    });
    // Graph state preserved — the overlay reads titles from these maps.
    expect(s.subtasks.map((st) => st.id)).toEqual(['sub-a', 'sub-b']);
    expect(s.finalNode?.files).toEqual(['src/a.ts', 'src/b.ts']);
    // Status stays `applied` through the overlay lifetime.
    expect(s.status).toBe('applied');
  });

  it('ApplySummary from a stray run is dropped', async () => {
    await state().submitTask('x');
    emit(EVENT_APPLY_SUMMARY, {
      runId: 'some-other-run',
      commitSha: 'deadbeef00000000000000000000000000000000',
      branch: 'main',
      filesChanged: 1,
      perWorker: [],
    });
    expect(state().applySummary).toBeNull();
  });

  it('dismissApplySummary clears the slice and returns the store to idle', async () => {
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
    emit(EVENT_APPLY_SUMMARY, {
      runId: BACKEND_RUN_ID,
      commitSha: 'cafebabe00000000000000000000000000000000',
      branch: 'main',
      filesChanged: 1,
      perWorker: [],
    });
    expect(state().applySummary).not.toBeNull();
    expect(state().status).toBe('applied');

    state().dismissApplySummary();
    const s = state();
    expect(s.applySummary).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.runId).toBeNull();
    expect(s.subtasks).toEqual([]);
    expect(s.finalNode).toBeNull();
  });

  it('submitTask after an applied run clears the previous applySummary', async () => {
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
    emit(EVENT_APPLY_SUMMARY, {
      runId: BACKEND_RUN_ID,
      commitSha: 'aaaaaaaa00000000000000000000000000000000',
      branch: 'main',
      filesChanged: 1,
      perWorker: [],
    });
    expect(state().applySummary).not.toBeNull();

    // Fresh submit triggers reset(), which must drop the stale overlay
    // payload along with every other run-scoped slice.
    await state().submitTask('next');
    expect(state().applySummary).toBeNull();
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

  it('StatusChanged(cancelled) detaches subscription and unblocks submitTask', async () => {
    // Regression: before treating `cancelled` as terminal in
    // `handleStatusChanged` / `submitTask.priorIsTerminal`, the
    // subscription stayed wired after the backend emitted the final
    // StatusChanged(Cancelled), so `submitTask` threw "A run is already
    // active" and the user was soft-locked until a full reload. This
    // test mirrors the real backend shape: cancel_run returns, then
    // `finalize_cancelled` emits the single terminal event.
    await state().submitTask('x');
    await state().cancelRun();
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'cancelled' });

    const post = state();
    expect(post.status).toBe('cancelled');
    expect(post.activeSubscription).toBeNull();

    // A fresh task must go through without throwing. `submitTask`'s
    // prior-run cleanup path runs `reset()` before attaching the new
    // subscription; the new `runId` is the same mock value, but the
    // important assertion is that the call resolves.
    invokeHandlers.set('submit_task', async () => 'run-integration-002');
    await expect(state().submitTask('y')).resolves.toBeUndefined();
    expect(state().runId).toBe('run-integration-002');
    expect(state().status).toBe('planning');
  });

  it('preserves graph state (subtasks, logs, snapshots) when run is cancelled', async () => {
    // Convention: terminal states (done/failed/rejected/cancelled) leave
    // the graph on screen so the user can inspect the run before moving
    // on. App.tsx routes back to EmptyState only on user action (submit,
    // discard, reset) — not on the terminal event itself. This test
    // documents that the cancel path follows the same rule.
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        {
          id: 'one',
          title: 'First step',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
        },
      ],
    });
    emit(EVENT_MASTER_LOG, { runId: BACKEND_RUN_ID, line: 'planning...' });
    emit(EVENT_SUBTASK_LOG, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      line: 'working...',
    });

    await state().cancelRun();
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'cancelled' });

    const s = state();
    expect(s.status).toBe('cancelled');
    expect(s.runId).toBe(BACKEND_RUN_ID);
    expect(s.subtasks).toHaveLength(1);
    expect(s.nodeSnapshots.has('one')).toBe(true);
    expect(s.nodeLogs.get(MASTER_ID)?.length ?? 0).toBeGreaterThan(0);
    expect(s.nodeLogs.get('one')?.length ?? 0).toBeGreaterThan(0);
    // Subscription is torn down, but the per-run state stays until the
    // next `submitTask` / `reset` / `discardRun` clears it.
    expect(s.activeSubscription).toBeNull();
  });

  it('StatusChanged(cancelled) sweeps every actor into the cancelled state', async () => {
    // Bug #5: without the CANCEL fan-out in `handleStatusChanged`, the
    // master node stayed in `thinking` forever after the user confirmed
    // a cancel — visually identical to "still running", which is
    // exactly how users read the cancel as "didn't work." The fan-out
    // blanket-dispatches CANCEL to every non-final actor; final states
    // (done/skipped) no-op as XState drops events once a machine is done.
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        { id: 'a', title: 'A', why: null, assignedWorker: 'claude', dependencies: [] },
        { id: 'b', title: 'B', why: null, assignedWorker: 'claude', dependencies: [] },
      ],
    });
    // Snapshots before cancel — SubtasksProposed fanned PROPOSE to
    // master + each subtask, so they're all in `proposed`. None are
    // in a final state yet.
    expect(snap(MASTER_ID)?.value).toBe('proposed');
    expect(snap('a')?.value).toBe('proposed');
    expect(snap('b')?.value).toBe('proposed');

    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'cancelled' });

    // Post-cancel: every actor lands on `cancelled` so the graph stops
    // animating. The master in particular must not be stuck on
    // `thinking` — that was the "master alone on screen" symptom.
    expect(snap(MASTER_ID)?.value).toBe('cancelled');
    expect(snap('a')?.value).toBe('cancelled');
    expect(snap('b')?.value).toBe('cancelled');
  });

  it('cancelRun during submit window defers until the real run id lands', async () => {
    // Bug #5 race: between `submitTask` setting the optimistic
    // `pending_*` id and the real backend id landing, a user click on
    // Cancel would call `cancelRunIpc('pending_xxx')` — an id the
    // backend doesn't recognise, so `cancel_run` returns `Ok(())` with
    // no effect and the cancel silently vanished. The fix stashes a
    // `pendingCancel` flag and fires the IPC once the real id is set.
    //
    // We simulate the window by making `submit_task` hang on a promise
    // we control; `cancelRun` fires mid-hang; we resolve, observe the
    // flag got consumed, and assert the real id was sent to
    // `cancel_run` (not the `pending_*` placeholder).
    let resolveSubmit: (id: string) => void = () => undefined;
    const submitPromise = new Promise<string>((resolve) => {
      resolveSubmit = resolve;
    });
    invokeHandlers.set('submit_task', () => submitPromise);

    const cancelCalls: unknown[] = [];
    invokeHandlers.set('cancel_run', async (args) => {
      cancelCalls.push(args);
      return undefined;
    });

    const submitTaskPromise = state().submitTask('x');

    // Mid-submit: the optimistic id is a `pending_*` placeholder.
    expect(state().runId?.startsWith('pending_')).toBe(true);
    expect(state().pendingCancel).toBe(false);

    // User clicks Cancel while the IPC is still in flight. cancelRun
    // sees the pending id and stashes the intent instead of calling
    // the backend with a bogus id.
    await state().cancelRun();
    expect(cancelCalls).toEqual([]);
    expect(state().pendingCancel).toBe(true);

    // Backend eventually returns the real run id — `submitTask`'s
    // tail consumes the flag and fires a cancel with the real id.
    resolveSubmit(BACKEND_RUN_ID);
    await submitTaskPromise;

    // Drain the microtask that handles the deferred cancel.
    await Promise.resolve();
    await Promise.resolve();

    expect(state().pendingCancel).toBe(false);
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]).toMatchObject({ runId: BACKEND_RUN_ID });
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

  // Phase 4 Step 3 — workerExpanded lifecycle.
  it('reset clears workerExpanded', () => {
    useGraphStore.setState({
      workerExpanded: new Set(['sub-a', 'sub-b']),
    });
    state().reset();
    expect(state().workerExpanded.size).toBe(0);
  });

  it('toggleWorkerExpanded adds and removes ids', () => {
    const { toggleWorkerExpanded } = state();
    toggleWorkerExpanded('sub-a');
    expect(state().workerExpanded.has('sub-a')).toBe(true);
    toggleWorkerExpanded('sub-b');
    expect(state().workerExpanded.has('sub-b')).toBe(true);
    expect(state().workerExpanded.size).toBe(2);
    toggleWorkerExpanded('sub-a');
    expect(state().workerExpanded.has('sub-a')).toBe(false);
    expect(state().workerExpanded.has('sub-b')).toBe(true);
  });

  it('scrubs workerExpanded for ids dropped by a replan', async () => {
    // Seed a plan, expand one subtask, then replay a replan that
    // drops that id. The expand set should lose the dangling id
    // alongside nodeLogs / retries / diffs.
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        {
          id: 'keep',
          title: 'Keep',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
        },
        {
          id: 'drop',
          title: 'Drop',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
        },
      ],
    });
    useGraphStore.setState({
      workerExpanded: new Set(['keep', 'drop']),
    });
    // Replan: `drop` disappears, `keep` stays, `replacement` arrives.
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        {
          id: 'keep',
          title: 'Keep',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
        },
        {
          id: 'replacement',
          title: 'New',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
          replaces: ['drop'],
        },
      ],
    });
    const exp = state().workerExpanded;
    expect(exp.has('drop')).toBe(false);
    expect(exp.has('keep')).toBe(true);
  });
});

// Phase 3 Step 2 — provenance tracking for the "edited" / "added" badges.
describe('graphStore — edit/add provenance (Phase 3 Step 2)', () => {
  async function setupAwaitingApproval() {
    await state().submitTask('Build settings page');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        { id: 'auth', title: 'Auth', why: 'login first', assignedWorker: 'claude', dependencies: [] },
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
  }

  it('snapshots an original for every master-proposed subtask on first emit', async () => {
    await setupAwaitingApproval();
    const s = state();
    const authOrig = s.originalSubtasks.get('auth');
    expect(authOrig).toEqual({ title: 'Auth', why: 'login first', agent: 'claude' });
    expect(s.originalSubtasks.get('tests')).toEqual({
      title: 'Tests',
      why: null,
      agent: 'gemini',
    });
    expect(isSubtaskEdited(s, 'auth')).toBe(false);
    expect(isSubtaskAdded(s, 'auth')).toBe(false);
  });

  it('does NOT re-snapshot an original when a subtask_proposed re-emits the same id with edits', async () => {
    await setupAwaitingApproval();
    // Simulate backend re-emitting after an update_subtask edit landed.
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        {
          id: 'auth',
          title: 'Auth (edited)',
          why: 'login first',
          assignedWorker: 'claude',
          dependencies: [],
        },
        {
          id: 'tests',
          title: 'Tests',
          why: null,
          assignedWorker: 'gemini',
          dependencies: ['auth'],
        },
      ],
    });
    const s = state();
    expect(s.originalSubtasks.get('auth')).toEqual({
      title: 'Auth',
      why: 'login first',
      agent: 'claude',
    });
    expect(isSubtaskEdited(s, 'auth')).toBe(true);
    expect(isSubtaskEdited(s, 'tests')).toBe(false);
  });

  it('reverting to original flips isSubtaskEdited back to false', async () => {
    await setupAwaitingApproval();
    // Edit …
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        {
          id: 'auth',
          title: 'Auth (edited)',
          why: 'login first',
          assignedWorker: 'claude',
          dependencies: [],
        },
        {
          id: 'tests',
          title: 'Tests',
          why: null,
          assignedWorker: 'gemini',
          dependencies: ['auth'],
        },
      ],
    });
    expect(isSubtaskEdited(state(), 'auth')).toBe(true);
    // … then revert via another re-emit with the original fields.
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        {
          id: 'auth',
          title: 'Auth',
          why: 'login first',
          assignedWorker: 'claude',
          dependencies: [],
        },
        {
          id: 'tests',
          title: 'Tests',
          why: null,
          assignedWorker: 'gemini',
          dependencies: ['auth'],
        },
      ],
    });
    expect(isSubtaskEdited(state(), 'auth')).toBe(false);
  });

  it('addSubtask → returned id enters userAddedSubtaskIds and lastAddedSubtaskId', async () => {
    await setupAwaitingApproval();
    invokeHandlers.set('add_subtask', async () => 'user-1');
    const id = await state().addSubtask({
      title: '',
      why: null,
      assignedWorker: 'claude',
    });
    expect(id).toBe('user-1');
    const s = state();
    expect(s.userAddedSubtaskIds.has('user-1')).toBe(true);
    expect(s.lastAddedSubtaskId).toBe('user-1');
  });

  it('user-added subtask reports isSubtaskAdded=true, isSubtaskEdited=false (even after edits)', async () => {
    await setupAwaitingApproval();
    invokeHandlers.set('add_subtask', async () => 'user-1');
    await state().addSubtask({ title: '', why: null, assignedWorker: 'claude' });

    // Backend re-emits with the new user-added row.
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        { id: 'auth', title: 'Auth', why: 'login first', assignedWorker: 'claude', dependencies: [] },
        {
          id: 'tests',
          title: 'Tests',
          why: null,
          assignedWorker: 'gemini',
          dependencies: ['auth'],
        },
        {
          id: 'user-1',
          title: '',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
        },
      ],
    });
    const s = state();
    // User-added never gets snapshotted as an original …
    expect(s.originalSubtasks.has('user-1')).toBe(false);
    // … so it never counts as "edited", only "added".
    expect(isSubtaskAdded(s, 'user-1')).toBe(true);
    expect(isSubtaskEdited(s, 'user-1')).toBe(false);
  });

  it('clearLastAddedSubtaskId is a one-shot and tolerates repeated calls', async () => {
    await setupAwaitingApproval();
    invokeHandlers.set('add_subtask', async () => 'user-2');
    await state().addSubtask({ title: '', why: null, assignedWorker: 'claude' });
    expect(state().lastAddedSubtaskId).toBe('user-2');
    state().clearLastAddedSubtaskId();
    expect(state().lastAddedSubtaskId).toBeNull();
    // Repeated call is a no-op (regression guard against flashing `set` on
    // every layout-effect tick of a non-just-added WorkerNode).
    state().clearLastAddedSubtaskId();
    expect(state().lastAddedSubtaskId).toBeNull();
  });

  it('removing a subtask scrubs originalSubtasks and userAddedSubtaskIds entries', async () => {
    await setupAwaitingApproval();
    invokeHandlers.set('add_subtask', async () => 'user-1');
    await state().addSubtask({ title: '', why: null, assignedWorker: 'claude' });
    // Backend re-emits without 'tests' and without 'user-1'.
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        { id: 'auth', title: 'Auth', why: 'login first', assignedWorker: 'claude', dependencies: [] },
      ],
    });
    const s = state();
    expect(s.originalSubtasks.has('tests')).toBe(false);
    expect(s.userAddedSubtaskIds.has('user-1')).toBe(false);
    // But 'auth' is still retained as an original.
    expect(s.originalSubtasks.has('auth')).toBe(true);
  });

  it('reset clears all three new tracking fields', async () => {
    await setupAwaitingApproval();
    invokeHandlers.set('add_subtask', async () => 'user-1');
    await state().addSubtask({ title: '', why: null, assignedWorker: 'claude' });
    state().reset();
    const s = state();
    expect(s.originalSubtasks.size).toBe(0);
    expect(s.userAddedSubtaskIds.size).toBe(0);
    expect(s.lastAddedSubtaskId).toBeNull();
  });
});

// Phase 5 Step 1 — per-worker stop.
describe('graphStore — Phase 5 Step 1 cancelSubtask', () => {
  it('sets subtaskCancelInFlight on click and clears it on SubtaskStateChanged(cancelled)', async () => {
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        {
          id: 'one',
          title: 'First',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
        },
      ],
    });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      state: 'running',
    });

    await state().cancelSubtask('one');
    // After IPC resolves but before the backend emits cancelled, the
    // flag is still set (the UI renders "Stopping…").
    expect(state().subtaskCancelInFlight.has('one')).toBe(true);

    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      state: 'cancelled',
    });
    expect(state().subtaskCancelInFlight.has('one')).toBe(false);
    expect(snap('one')?.value).toBe('cancelled');
  });

  it('surfaces IPC rejection as currentError and rolls back in-flight flag', async () => {
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        {
          id: 'one',
          title: 'First',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
        },
      ],
    });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      state: 'done',
    });

    invokeHandlers.set('cancel_subtask', async () => {
      throw 'subtask 01... is in state Done, expected running | retrying | waiting';
    });

    await expect(state().cancelSubtask('one')).rejects.toBeDefined();
    expect(state().subtaskCancelInFlight.has('one')).toBe(false);
    expect(state().currentError).toMatch(/Stop failed/);
  });

  it('clears subtaskCancelInFlight if the subtask races to done before cancel confirms', async () => {
    // Edge case the spec calls out: cancel_subtask in flight, backend
    // emits `done` first (worker finished before kill signal landed).
    // The transient UI must roll back so the card doesn't stick on
    // "Stopping…" forever.
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        {
          id: 'one',
          title: 'First',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
        },
      ],
    });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      state: 'running',
    });

    await state().cancelSubtask('one');
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      state: 'done',
    });
    expect(state().subtaskCancelInFlight.has('one')).toBe(false);
  });

  it('no-op on pending_* runId (no real run yet)', async () => {
    // Explicit optimistic-id path — cancel_subtask must not fire IPC
    // with a pending_* id the backend doesn't recognise.
    useGraphStore.setState({ runId: 'pending_xxx' });
    let calls = 0;
    invokeHandlers.set('cancel_subtask', async () => {
      calls += 1;
    });
    await state().cancelSubtask('whatever');
    expect(calls).toBe(0);
  });
});

describe('graphStore — Phase 5 Step 2 stash & retry / pop', () => {
  it('BaseBranchDirty populates baseBranchDirty; StashCreated clears it and stores the ref', async () => {
    await state().submitTask('x');
    emit(EVENT_BASE_BRANCH_DIRTY, {
      runId: BACKEND_RUN_ID,
      files: ['seed.txt'],
    });
    expect(state().baseBranchDirty?.files).toEqual(['seed.txt']);
    expect(state().currentError).toMatch(/uncommitted changes/);

    emit(EVENT_STASH_CREATED, {
      runId: BACKEND_RUN_ID,
      stashRef: '0123456789abcdef0123456789abcdef01234567',
    });
    expect(state().baseBranchDirty).toBeNull();
    expect(state().currentError).toBeNull();
    expect(state().stash?.ref).toBe(
      '0123456789abcdef0123456789abcdef01234567',
    );
    expect(state().stashInFlight).toBeNull();
  });

  it('stashAndRetryApply sets in-flight and IPC rejection rolls back', async () => {
    await state().submitTask('x');
    emit(EVENT_BASE_BRANCH_DIRTY, {
      runId: BACKEND_RUN_ID,
      files: ['seed.txt'],
    });
    invokeHandlers.set('stash_and_retry_apply', async () => {
      throw 'git stash failed';
    });
    await expect(state().stashAndRetryApply()).rejects.toBeDefined();
    expect(state().stashInFlight).toBeNull();
    expect(state().currentError).toMatch(/stash & retry failed/i);
  });

  it('StashPopped clears the stash entry entirely', async () => {
    await state().submitTask('x');
    emit(EVENT_STASH_CREATED, {
      runId: BACKEND_RUN_ID,
      stashRef: 'abc',
    });
    expect(state().stash?.ref).toBe('abc');
    emit(EVENT_STASH_POPPED, {
      runId: BACKEND_RUN_ID,
      stashRef: 'abc',
    });
    expect(state().stash).toBeNull();
    expect(state().stashInFlight).toBeNull();
  });

  it('StashPopFailed conflict preserves ref + records failure; missing clears the entry', async () => {
    await state().submitTask('x');
    emit(EVENT_STASH_CREATED, {
      runId: BACKEND_RUN_ID,
      stashRef: 'abc',
    });
    emit(EVENT_STASH_POP_FAILED, {
      runId: BACKEND_RUN_ID,
      stashRef: 'abc',
      kind: 'conflict',
      error: 'stash pop produced conflicts',
    });
    expect(state().stash?.popFailed?.kind).toBe('conflict');
    expect(state().stash?.ref).toBe('abc');

    emit(EVENT_STASH_POP_FAILED, {
      runId: BACKEND_RUN_ID,
      stashRef: 'abc',
      kind: 'missing',
      error: 'stash ref was missing; nothing to pop',
    });
    expect(state().stash).toBeNull();
  });

  it('no-op on pending_* runId (no real run yet)', async () => {
    useGraphStore.setState({ runId: 'pending_xxx' });
    let stashCalls = 0;
    let popCalls = 0;
    invokeHandlers.set('stash_and_retry_apply', async () => {
      stashCalls += 1;
    });
    invokeHandlers.set('pop_stash', async () => {
      popCalls += 1;
    });
    await state().stashAndRetryApply();
    await state().popStash();
    expect(stashCalls).toBe(0);
    expect(popCalls).toBe(0);
  });
});

describe('graphStore — Phase 5 Step 3 merge conflict resolver', () => {
  it('MergeConflict populates mergeConflict with retryAttempt 0 and auto-opens resolver', async () => {
    await state().submitTask('x');
    emit(EVENT_MERGE_CONFLICT, {
      runId: BACKEND_RUN_ID,
      files: ['shared.txt'],
    });
    expect(state().mergeConflict).toEqual({
      files: ['shared.txt'],
      retryAttempt: 0,
    });
    expect(state().conflictResolverOpen).toBe(true);
  });

  it('MergeRetryFailed updates retryAttempt and re-opens resolver', async () => {
    await state().submitTask('x');
    emit(EVENT_MERGE_CONFLICT, {
      runId: BACKEND_RUN_ID,
      files: ['shared.txt'],
    });
    useGraphStore.setState({ conflictResolverOpen: false });
    emit(EVENT_MERGE_RETRY_FAILED, {
      runId: BACKEND_RUN_ID,
      files: ['shared.txt'],
      retryAttempt: 2,
    });
    expect(state().mergeConflict).toEqual({
      files: ['shared.txt'],
      retryAttempt: 2,
    });
    expect(state().conflictResolverOpen).toBe(true);
  });

  it('retryApply sets in-flight and IPC rejection rolls back', async () => {
    await state().submitTask('x');
    emit(EVENT_MERGE_CONFLICT, {
      runId: BACKEND_RUN_ID,
      files: ['x.txt'],
    });
    invokeHandlers.set('retry_apply', async () => {
      throw 'wrong state';
    });
    await expect(state().retryApply()).rejects.toBeDefined();
    expect(state().retryApplyInFlight).toBe(false);
    expect(state().currentError).toMatch(/retry apply failed/i);
  });

  it('Completed clears mergeConflict + conflictResolverOpen', async () => {
    await state().submitTask('x');
    emit(EVENT_MERGE_CONFLICT, {
      runId: BACKEND_RUN_ID,
      files: ['x.txt'],
    });
    expect(state().mergeConflict).not.toBeNull();
    emit('run:completed' as string, {
      runId: BACKEND_RUN_ID,
      summary: {
        runId: BACKEND_RUN_ID,
        subtaskCount: 1,
        filesChanged: 1,
        durationSecs: 1,
        commitsCreated: 1,
      },
    });
    expect(state().mergeConflict).toBeNull();
    expect(state().conflictResolverOpen).toBe(false);
  });

  it('rejected status clears mergeConflict + conflictResolverOpen', async () => {
    await state().submitTask('x');
    emit(EVENT_MERGE_CONFLICT, {
      runId: BACKEND_RUN_ID,
      files: ['x.txt'],
    });
    emit(EVENT_STATUS_CHANGED, { runId: BACKEND_RUN_ID, status: 'rejected' });
    expect(state().mergeConflict).toBeNull();
    expect(state().conflictResolverOpen).toBe(false);
  });

  it('no-op on pending_* runId', async () => {
    useGraphStore.setState({ runId: 'pending_xxx' });
    let calls = 0;
    invokeHandlers.set('retry_apply', async () => {
      calls += 1;
    });
    await state().retryApply();
    expect(calls).toBe(0);
  });
});

describe('graphStore — Phase 5 Step 4 interactive Q&A', () => {
  it('SubtaskQuestionAsked populates pendingQuestions', async () => {
    await state().submitTask('x');
    emit(EVENT_SUBTASK_QUESTION_ASKED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      question: 'Should I use A or B?',
      detectionMethod: 'heuristic-trailing-question-mark',
    });
    expect(state().pendingQuestions.get('one')?.question).toBe(
      'Should I use A or B?',
    );
  });

  it('SubtaskAnswerReceived clears questionAnswerInFlight', async () => {
    await state().submitTask('x');
    useGraphStore.setState({
      questionAnswerInFlight: new Set(['one']),
    });
    emit(EVENT_SUBTASK_ANSWER_RECEIVED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
    });
    expect(state().questionAnswerInFlight.has('one')).toBe(false);
  });

  it('SubtaskStateChanged(running) clears pendingQuestions when leaving awaiting-input', async () => {
    await state().submitTask('x');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: BACKEND_RUN_ID,
      subtasks: [
        {
          id: 'one',
          title: 'One',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
        },
      ],
    });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      state: 'running',
    });
    emit(EVENT_SUBTASK_QUESTION_ASKED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      question: '?',
      detectionMethod: 'heuristic-trailing-question-mark',
    });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      state: 'awaiting-input',
    });
    expect(state().pendingQuestions.has('one')).toBe(true);

    // Answer arrives → backend flips state back to running.
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      state: 'running',
    });
    expect(state().pendingQuestions.has('one')).toBe(false);
  });

  it('answerSubtaskQuestion sets in-flight and rejection rolls back', async () => {
    await state().submitTask('x');
    invokeHandlers.set('answer_subtask_question', async () => {
      throw 'wrong state';
    });
    await expect(state().answerSubtaskQuestion('one', 'A')).rejects.toBeDefined();
    expect(state().questionAnswerInFlight.has('one')).toBe(false);
    expect(state().currentError).toMatch(/answer failed/i);
  });

  it('skipSubtaskQuestion sets in-flight and rejection rolls back', async () => {
    await state().submitTask('x');
    invokeHandlers.set('skip_subtask_question', async () => {
      throw 'wrong state';
    });
    await expect(state().skipSubtaskQuestion('one')).rejects.toBeDefined();
    expect(state().questionAnswerInFlight.has('one')).toBe(false);
    expect(state().currentError).toMatch(/skip question failed/i);
  });

  it('no-op on pending_* runId', async () => {
    useGraphStore.setState({ runId: 'pending_xxx' });
    let calls = 0;
    invokeHandlers.set('answer_subtask_question', async () => {
      calls += 1;
    });
    invokeHandlers.set('skip_subtask_question', async () => {
      calls += 1;
    });
    await state().answerSubtaskQuestion('one', 'A');
    await state().skipSubtaskQuestion('one');
    expect(calls).toBe(0);
  });
});

describe('graphStore — Phase 6 Step 2 activity stream', () => {
  it('SubtaskActivity appends to subtaskActivities map', async () => {
    await state().submitTask('x');
    emit(EVENT_SUBTASK_ACTIVITY, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      event: { kind: 'file-read', path: 'src/auth.ts' },
      timestampMs: 1000,
    });
    const stored = state().subtaskActivities.get('one');
    expect(stored).toHaveLength(1);
    expect(stored?.[0].event.kind).toBe('file-read');
  });

  it('caps subtaskActivities at 50 events with FIFO eviction', async () => {
    await state().submitTask('x');
    for (let i = 0; i < 60; i++) {
      emit(EVENT_SUBTASK_ACTIVITY, {
        runId: BACKEND_RUN_ID,
        subtaskId: 'one',
        event: { kind: 'bash', command: `cmd-${i}` },
        timestampMs: 1000 + i,
      });
    }
    const stored = state().subtaskActivities.get('one');
    expect(stored).toHaveLength(50);
    // Oldest dropped: first event held should be cmd-10.
    expect(stored?.[0].event.kind === 'bash' && (stored?.[0].event as { command: string }).command).toBe('cmd-10');
    // Latest held: cmd-59.
    expect(
      stored?.[49].event.kind === 'bash' &&
        (stored?.[49].event as { command: string }).command,
    ).toBe('cmd-59');
  });

  it('per-subtask activities are independent', async () => {
    await state().submitTask('x');
    emit(EVENT_SUBTASK_ACTIVITY, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      event: { kind: 'file-read', path: 'a.ts' },
      timestampMs: 1000,
    });
    emit(EVENT_SUBTASK_ACTIVITY, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'two',
      event: { kind: 'file-edit', path: 'b.ts', summary: 'edited' },
      timestampMs: 1100,
    });
    expect(state().subtaskActivities.get('one')).toHaveLength(1);
    expect(state().subtaskActivities.get('two')).toHaveLength(1);
  });
});

describe('graphStore — Phase 6 Step 3 thinking stream', () => {
  it('SubtaskThinking appends to subtaskThinking map', async () => {
    await state().submitTask('x');
    emit(EVENT_SUBTASK_THINKING, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      chunk: 'reasoning here',
      timestampMs: 1000,
    });
    const stored = state().subtaskThinking.get('one');
    expect(stored).toHaveLength(1);
    expect(stored?.[0].chunk).toBe('reasoning here');
  });

  it('caps subtaskThinking at 500 chunks with FIFO eviction', async () => {
    await state().submitTask('x');
    for (let i = 0; i < 510; i++) {
      emit(EVENT_SUBTASK_THINKING, {
        runId: BACKEND_RUN_ID,
        subtaskId: 'one',
        chunk: `chunk-${i}`,
        timestampMs: 1000 + i,
      });
    }
    const stored = state().subtaskThinking.get('one');
    expect(stored).toHaveLength(500);
    expect(stored?.[0].chunk).toBe('chunk-10');
    expect(stored?.[499].chunk).toBe('chunk-509');
  });
});

describe('graphStore — Phase 6 Step 4 hint injection', () => {
  it('hintSubtask sets hintInFlight membership and clears on SubtaskHintReceived', async () => {
    await state().submitTask('x');
    await state().hintSubtask('one', 'use approach B');
    expect(state().hintInFlight.has('one')).toBe(true);

    emit(EVENT_SUBTASK_HINT_RECEIVED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      hint: 'use approach B',
      timestampMs: 1000,
    });
    expect(state().hintInFlight.has('one')).toBe(false);
  });

  it('hintSubtask rejection rolls back in-flight + surfaces currentError', async () => {
    await state().submitTask('x');
    invokeHandlers.set('hint_subtask', async () => {
      throw 'hint already in flight';
    });
    await expect(state().hintSubtask('one', 'h')).rejects.toBeDefined();
    expect(state().hintInFlight.has('one')).toBe(false);
    expect(state().currentError).toMatch(/hint failed/i);
  });

  it('concurrent hint dedup — second call while in flight is no-op', async () => {
    await state().submitTask('x');
    let calls = 0;
    invokeHandlers.set('hint_subtask', async () => {
      calls += 1;
      // Hold the IPC pending so second call lands while first is
      // still in flight.
      await new Promise((r) => setTimeout(r, 50));
    });
    const first = state().hintSubtask('one', 'a');
    const second = state().hintSubtask('one', 'b');
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  it('no-op on pending_* runId', async () => {
    useGraphStore.setState({ runId: 'pending_xxx' });
    let calls = 0;
    invokeHandlers.set('hint_subtask', async () => {
      calls += 1;
    });
    await state().hintSubtask('one', 'h');
    expect(calls).toBe(0);
  });
});

describe('graphStore — Phase 7 Step 2 worktree revert', () => {
  it('revertSubtaskChanges sets revertInFlight; WorktreeReverted clears + tags revert_intent', async () => {
    await state().submitTask('x');
    // Seed a diff so the revert handler has something to clear.
    useGraphStore.setState((s) => {
      const next = new Map(s.subtaskDiffs);
      next.set('one', [{ path: 'a.ts', additions: 1, deletions: 0 }]);
      return { subtaskDiffs: next };
    });

    await state().revertSubtaskChanges('one');
    expect(state().revertInFlight.has('one')).toBe(true);

    emit(EVENT_WORKTREE_REVERTED, {
      runId: BACKEND_RUN_ID,
      subtaskId: 'one',
      filesCleared: 3,
    });

    // In-flight cleared, intent tagged, diff entry dropped.
    expect(state().revertInFlight.has('one')).toBe(false);
    expect(state().subtaskRevertIntent.has('one')).toBe(true);
    expect(state().subtaskDiffs.has('one')).toBe(false);
  });

  it('revertSubtaskChanges rejection rolls back inFlight + surfaces currentError', async () => {
    await state().submitTask('x');
    invokeHandlers.set('revert_subtask_changes', async () => {
      throw 'wrong state';
    });
    await expect(state().revertSubtaskChanges('one')).rejects.toBeDefined();
    expect(state().revertInFlight.has('one')).toBe(false);
    expect(state().currentError).toMatch(/Undo failed/i);
  });

  it('no-op on pending_* runId', async () => {
    useGraphStore.setState({ runId: 'pending_xxx' });
    let calls = 0;
    invokeHandlers.set('revert_subtask_changes', async () => {
      calls += 1;
    });
    await state().revertSubtaskChanges('one');
    expect(calls).toBe(0);
  });

  it('reset clears subtaskRevertIntent + revertInFlight', async () => {
    await state().submitTask('x');
    useGraphStore.setState({
      subtaskRevertIntent: new Set(['one']),
      revertInFlight: new Set(['two']),
    });
    state().reset();
    expect(state().subtaskRevertIntent.size).toBe(0);
    expect(state().revertInFlight.size).toBe(0);
  });
});
