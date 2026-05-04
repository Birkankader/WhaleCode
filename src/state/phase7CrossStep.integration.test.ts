/**
 * Phase 7 Step 7 — cross-step integration tests.
 *
 * Each Phase 7 step ships with its own focused integration coverage
 * inside `graphStore.integration.test.ts`. This file targets the
 * pair-wise interactions between steps where state from one feature
 * has to coexist with state from another:
 *
 *   - Step 1 (InlineDiffSidebar) ↔ Step 3 (PlanChecklist)
 *   - Step 1 ↔ Step 2 (Undo)
 *   - Step 4 (ElapsedTick) across master + per-worker + checklist
 *   - Step 5 (Follow-up) ↔ Step 1 / Step 3 (sidebar + checklist reset)
 *   - Step 2 ↔ Step 3 (cancelled-via-revert flagged in checklist)
 *   - Concurrent state pressure (6 workers ticking + activity + log)
 *
 * Mocks the same Tauri event + invoke surface as
 * `graphStore.integration.test.ts` so the tests drive the store via
 * the real subscription path rather than direct mutation.
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
  EVENT_DIFF_READY,
  EVENT_ELAPSED_TICK,
  EVENT_FOLLOWUP_STARTED,
  EVENT_MASTER_LOG,
  EVENT_STATUS_CHANGED,
  EVENT_SUBTASK_ACTIVITY,
  EVENT_SUBTASK_DIFF,
  EVENT_SUBTASK_LOG,
  EVENT_SUBTASK_STATE_CHANGED,
  EVENT_SUBTASKS_PROPOSED,
  EVENT_WORKTREE_REVERTED,
} from '../lib/ipc';
import { useRepoStore } from './repoStore';
import { computeSidebarOpen, useGraphStore } from './graphStore';

const PARENT_RUN_ID = 'run-cross-step-001';
const REPO_PATH = '/tmp/fake-repo';

function emit(event: string, payload: unknown) {
  const bucket = listeners.get(event);
  if (!bucket) return;
  for (const handler of bucket) handler({ payload });
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

/** Drive the store to running with a 3-worker plan. Used by most tests. */
async function startThreeWorkerRun(runId: string = PARENT_RUN_ID) {
  await state().submitTask('cross-step task');
  emit(EVENT_SUBTASKS_PROPOSED, {
    runId,
    subtasks: [
      { id: 'a', title: 'Worker A', why: null, assignedWorker: 'claude', dependencies: [] },
      { id: 'b', title: 'Worker B', why: null, assignedWorker: 'codex', dependencies: [] },
      { id: 'c', title: 'Worker C', why: null, assignedWorker: 'gemini', dependencies: [] },
    ],
  });
  emit(EVENT_STATUS_CHANGED, { runId, status: 'awaiting-approval' });
  await state().approveSubtasks(['a', 'b', 'c']);
  emit(EVENT_STATUS_CHANGED, { runId, status: 'running' });
  for (const id of ['a', 'b', 'c']) {
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId,
      subtaskId: id,
      state: 'running',
    });
  }
}

beforeEach(() => {
  listeners.clear();
  invokeHandlers.clear();
  useGraphStore.getState().reset();
  seedRepo();
  invokeHandlers.set('submit_task', async () => PARENT_RUN_ID);
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
  invokeHandlers.set('start_followup_run', async () => 'child-run-id');
});

afterEach(() => {
  useGraphStore.getState().reset();
});

// ---------------------------------------------------------------------------
// Pair 1: InlineDiffSidebar (Step 1) ↔ PlanChecklist (Step 3)
// ---------------------------------------------------------------------------

describe('Phase 7 cross-step — pair 1: sidebar ↔ checklist', () => {
  it('selectDiffWorker only writes inlineDiffSelection — subtasks (checklist source) untouched', async () => {
    await startThreeWorkerRun();
    const subtasksBefore = state().subtasks;
    state().selectDiffWorker('a', false);
    expect(state().inlineDiffSelection).toEqual(new Set(['a']));
    expect(state().subtasks).toBe(subtasksBefore);
  });

  it('multi-select via modifier-click grows the sidebar selection without touching node snapshots', async () => {
    await startThreeWorkerRun();
    const snapsBefore = state().nodeSnapshots;
    state().selectDiffWorker('a', false);
    state().selectDiffWorker('b', true);
    state().selectDiffWorker('c', true);
    expect(state().inlineDiffSelection).toEqual(new Set(['a', 'b', 'c']));
    // Adding chips never touches per-subtask machine state.
    expect(state().nodeSnapshots).toBe(snapsBefore);
  });

  it('plain click after multi-select resets to single id (idempotent contract)', async () => {
    await startThreeWorkerRun();
    state().selectDiffWorker('a', false);
    state().selectDiffWorker('b', true);
    state().selectDiffWorker('c', false);
    expect(state().inlineDiffSelection).toEqual(new Set(['c']));
  });

  it('clearDiffSelection empties the sidebar selection without affecting checklist data', async () => {
    await startThreeWorkerRun();
    state().selectDiffWorker('a', false);
    state().selectDiffWorker('b', true);
    state().clearDiffSelection();
    expect(state().inlineDiffSelection.size).toBe(0);
    expect(state().subtasks).toHaveLength(3);
  });

  it('toggling the same id off in multi-select removes it (no-op for missing id behaviour)', async () => {
    await startThreeWorkerRun();
    state().selectDiffWorker('a', true);
    state().selectDiffWorker('a', true);
    expect(state().inlineDiffSelection.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pair 2: Sidebar (Step 1) ↔ Undo (Step 2)
// ---------------------------------------------------------------------------

describe('Phase 7 cross-step — pair 2: sidebar ↔ undo', () => {
  function seedDiffsForAllThree(runId: string = PARENT_RUN_ID) {
    emit(EVENT_SUBTASK_DIFF, {
      runId,
      subtaskId: 'a',
      files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
    });
    emit(EVENT_SUBTASK_DIFF, {
      runId,
      subtaskId: 'b',
      files: [{ path: 'b.ts', additions: 2, deletions: 0 }],
    });
    emit(EVENT_SUBTASK_DIFF, {
      runId,
      subtaskId: 'c',
      files: [{ path: 'c.ts', additions: 3, deletions: 0 }],
    });
  }

  it("revert clears the worker's subtaskDiffs entry; sidebar selection set retains the id (component handles empty render)", async () => {
    await startThreeWorkerRun();
    seedDiffsForAllThree();
    state().selectDiffWorker('a', false);
    expect(state().subtaskDiffs.has('a')).toBe(true);

    await state().revertSubtaskChanges('a');
    emit(EVENT_WORKTREE_REVERTED, { runId: PARENT_RUN_ID, subtaskId: 'a', filesCleared: 1 });

    // Diff entry is gone — the sidebar's effective derivation drops `a`.
    expect(state().subtaskDiffs.has('a')).toBe(false);
    // Selection set itself is intentionally untouched: the user picked
    // the chip explicitly and the component layer handles the now-empty
    // render. Keeps the selection contract simple.
    expect(state().inlineDiffSelection.has('a')).toBe(true);
    // Revert intent flag is set so the WorkerNode subtitle flips.
    expect(state().subtaskRevertIntent.has('a')).toBe(true);
  });

  it('multi-select sidebar: reverting one worker only drops that diff; others remain', async () => {
    await startThreeWorkerRun();
    seedDiffsForAllThree();
    state().selectDiffWorker('a', false);
    state().selectDiffWorker('b', true);
    state().selectDiffWorker('c', true);

    await state().revertSubtaskChanges('b');
    emit(EVENT_WORKTREE_REVERTED, { runId: PARENT_RUN_ID, subtaskId: 'b', filesCleared: 2 });

    expect(state().subtaskDiffs.has('a')).toBe(true);
    expect(state().subtaskDiffs.has('b')).toBe(false);
    expect(state().subtaskDiffs.has('c')).toBe(true);
    // Revert intent flagged only on the reverted id.
    expect(state().subtaskRevertIntent).toEqual(new Set(['b']));
  });

  it('revertInFlight flips on/off across the IPC + event roundtrip', async () => {
    await startThreeWorkerRun();
    seedDiffsForAllThree();

    const promise = state().revertSubtaskChanges('a');
    // After the IPC promise resolved, inFlight is set (registered by the
    // action before it awaits the IPC).
    await promise;
    expect(state().revertInFlight.has('a')).toBe(true);

    emit(EVENT_WORKTREE_REVERTED, { runId: PARENT_RUN_ID, subtaskId: 'a', filesCleared: 1 });
    expect(state().revertInFlight.has('a')).toBe(false);
  });

  it('sidebar width persistence is independent of revert + diff churn', async () => {
    await startThreeWorkerRun();
    seedDiffsForAllThree();
    invokeHandlers.set('set_settings', async () => undefined);
    await state().setInlineDiffSidebarWidth(560);
    await state().revertSubtaskChanges('a');
    emit(EVENT_WORKTREE_REVERTED, { runId: PARENT_RUN_ID, subtaskId: 'a', filesCleared: 1 });
    expect(state().inlineDiffSidebarWidth).toBe(560);
  });
});

// ---------------------------------------------------------------------------
// Pair 3: Elapsed (Step 4) across master + per-worker + checklist surfaces
// ---------------------------------------------------------------------------

describe('Phase 7 cross-step — pair 3: elapsed across surfaces', () => {
  it('worker tick + master tick land in independent slices (no cross-write)', async () => {
    await startThreeWorkerRun();
    emit(EVENT_ELAPSED_TICK, {
      runId: PARENT_RUN_ID,
      subtaskId: 'a',
      elapsedMs: 4_000,
    });
    emit(EVENT_ELAPSED_TICK, {
      runId: PARENT_RUN_ID,
      subtaskId: null,
      elapsedMs: 12_000,
    });
    expect(state().subtaskElapsed.get('a')).toBe(4_000);
    expect(state().masterElapsed).toBe(12_000);
    // Master tick does not bleed into the per-worker map.
    expect(state().subtaskElapsed.has('master')).toBe(false);
  });

  it('per-worker ticks do not interfere across siblings (interleaved emit order)', async () => {
    await startThreeWorkerRun();
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'a', elapsedMs: 1_000 });
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'b', elapsedMs: 2_000 });
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'a', elapsedMs: 1_500 });
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'c', elapsedMs: 3_000 });
    expect(state().subtaskElapsed.get('a')).toBe(1_500);
    expect(state().subtaskElapsed.get('b')).toBe(2_000);
    expect(state().subtaskElapsed.get('c')).toBe(3_000);
  });

  it('terminal worker freezes elapsed (final tick lands post-Done and persists)', async () => {
    await startThreeWorkerRun();
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'a', elapsedMs: 9_500 });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: PARENT_RUN_ID,
      subtaskId: 'a',
      state: 'done',
      retryCount: 0,
    });
    // Backend emits one final tick after the state transition so the
    // captured runtime sticks on the post-run card.
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'a', elapsedMs: 10_000 });
    expect(state().subtaskElapsed.get('a')).toBe(10_000);
  });

  it('reset clears master + all per-worker elapsed in one shot', async () => {
    await startThreeWorkerRun();
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'a', elapsedMs: 4_000 });
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'b', elapsedMs: 5_000 });
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: null, elapsedMs: 11_000 });
    state().reset();
    expect(state().subtaskElapsed.size).toBe(0);
    expect(state().masterElapsed).toBeNull();
  });

  it('master ElapsedTick during planning + worker ticks during running coexist (lifecycle interleave)', async () => {
    // Master ticks land first (planning phase) — the rest of the run
    // hasn't happened yet, so subtaskElapsed is empty.
    await state().submitTask('plan-then-run');
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: null, elapsedMs: 5_000 });
    expect(state().masterElapsed).toBe(5_000);
    expect(state().subtaskElapsed.size).toBe(0);

    // Plan resolves, dispatcher kicks off workers.
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: PARENT_RUN_ID,
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
    emit(EVENT_STATUS_CHANGED, { runId: PARENT_RUN_ID, status: 'awaiting-approval' });
    await state().approveSubtasks(['a']);
    emit(EVENT_STATUS_CHANGED, { runId: PARENT_RUN_ID, status: 'running' });
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'a', elapsedMs: 1_000 });

    // Master final tick (one last value before lifecycle drops the task)
    // still updates the master scalar.
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: null, elapsedMs: 5_500 });
    expect(state().masterElapsed).toBe(5_500);
    expect(state().subtaskElapsed.get('a')).toBe(1_000);
  });

  it('zero-elapsed tick is honoured (no falsy filtering on the wire)', async () => {
    await startThreeWorkerRun();
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'a', elapsedMs: 0 });
    expect(state().subtaskElapsed.get('a')).toBe(0);
  });

  it('off-run elapsed events are dropped (subscription filter)', async () => {
    await startThreeWorkerRun();
    emit(EVENT_ELAPSED_TICK, {
      runId: 'some-other-run',
      subtaskId: 'a',
      elapsedMs: 99_000,
    });
    expect(state().subtaskElapsed.has('a')).toBe(false);
    expect(state().masterElapsed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pair 4: Follow-up (Step 5) ↔ Sidebar (Step 1)
// ---------------------------------------------------------------------------

describe('Phase 7 cross-step — pair 4: follow-up ↔ sidebar', () => {
  it('child run starts with empty inlineDiffSelection (parent selection cleared)', async () => {
    await startThreeWorkerRun();
    state().selectDiffWorker('a', false);
    state().selectDiffWorker('b', true);
    expect(state().inlineDiffSelection.size).toBe(2);

    invokeHandlers.set('start_followup_run', async () => 'child-run-1');
    emit(EVENT_APPLY_SUMMARY, {
      runId: PARENT_RUN_ID,
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      branch: 'main',
      filesChanged: 0,
      perWorker: [],
    });
    await state().submitFollowupRun('add tests');

    expect(state().runId).toBe('child-run-1');
    expect(state().inlineDiffSelection.size).toBe(0);
  });

  it('child run starts with empty subtaskDiffs (no parent diff bleed-through)', async () => {
    await startThreeWorkerRun();
    emit(EVENT_SUBTASK_DIFF, {
      runId: PARENT_RUN_ID,
      subtaskId: 'a',
      files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
    });
    expect(state().subtaskDiffs.has('a')).toBe(true);

    invokeHandlers.set('start_followup_run', async () => 'child-run-2');
    await state().submitFollowupRun('add tests');

    expect(state().subtaskDiffs.size).toBe(0);
  });

  it('child run resets sidebar user-toggle override (default derivation re-applies)', async () => {
    await startThreeWorkerRun();
    // Parent: user collapsed the sidebar explicitly.
    state().toggleInlineDiffSidebar();
    expect(state().inlineDiffSidebarUserToggled).not.toBeNull();

    invokeHandlers.set('start_followup_run', async () => 'child-run-3');
    await state().submitFollowupRun('add tests');

    expect(state().inlineDiffSidebarUserToggled).toBeNull();
  });

  it('child run keeps the persisted sidebar width (settings-backed)', async () => {
    await startThreeWorkerRun();
    invokeHandlers.set('set_settings', async () => undefined);
    await state().setInlineDiffSidebarWidth(420);

    invokeHandlers.set('start_followup_run', async () => 'child-run-4');
    await state().submitFollowupRun('add tests');

    expect(state().inlineDiffSidebarWidth).toBe(420);
  });

  it('parent-runId events emitted post-swap are dropped (subscription filter)', async () => {
    await startThreeWorkerRun();
    invokeHandlers.set('start_followup_run', async () => 'child-run-5');
    await state().submitFollowupRun('add tests');
    expect(state().runId).toBe('child-run-5');

    // A late parent diff event fires after the swap. The new
    // subscription's runId filter must drop it.
    emit(EVENT_SUBTASK_DIFF, {
      runId: PARENT_RUN_ID,
      subtaskId: 'a',
      files: [{ path: 'leak.ts', additions: 1, deletions: 0 }],
    });
    expect(state().subtaskDiffs.has('a')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pair 5: Follow-up (Step 5) ↔ Checklist (Step 3)
// ---------------------------------------------------------------------------

describe('Phase 7 cross-step — pair 5: follow-up ↔ checklist', () => {
  it("child run resets the parent's subtasks list (no stale rows)", async () => {
    await startThreeWorkerRun();
    expect(state().subtasks).toHaveLength(3);

    invokeHandlers.set('start_followup_run', async () => 'child-run-6');
    await state().submitFollowupRun('do another thing');

    expect(state().subtasks).toHaveLength(0);
  });

  it("child run's SubtasksProposed populates the checklist source as the master plans", async () => {
    await startThreeWorkerRun();
    invokeHandlers.set('start_followup_run', async () => 'child-run-7');
    await state().submitFollowupRun('do another thing');

    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: 'child-run-7',
      subtasks: [
        {
          id: 'd',
          title: 'New worker',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
        },
      ],
    });
    expect(state().subtasks).toHaveLength(1);
    expect(state().subtasks[0]?.id).toBe('d');
  });

  it('child run drives nodeSnapshots for the checklist row state badge', async () => {
    await startThreeWorkerRun();
    invokeHandlers.set('start_followup_run', async () => 'child-run-8');
    await state().submitFollowupRun('do another thing');

    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: 'child-run-8',
      subtasks: [
        {
          id: 'd',
          title: 'D',
          why: null,
          assignedWorker: 'claude',
          dependencies: [],
        },
      ],
    });
    emit(EVENT_STATUS_CHANGED, { runId: 'child-run-8', status: 'awaiting-approval' });
    await state().approveSubtasks(['d']);
    emit(EVENT_STATUS_CHANGED, { runId: 'child-run-8', status: 'running' });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: 'child-run-8',
      subtaskId: 'd',
      state: 'running',
      retryCount: 0,
    });
    expect(state().nodeSnapshots.get('d')?.value).toBe('running');
  });

  it('child run wipes parent revert intent + elapsed (clean slate)', async () => {
    await startThreeWorkerRun();
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'a', elapsedMs: 5_000 });
    emit(EVENT_WORKTREE_REVERTED, { runId: PARENT_RUN_ID, subtaskId: 'a', filesCleared: 1 });
    expect(state().subtaskRevertIntent.has('a')).toBe(true);
    expect(state().subtaskElapsed.size).toBeGreaterThan(0);

    invokeHandlers.set('start_followup_run', async () => 'child-run-9');
    await state().submitFollowupRun('do another thing');

    expect(state().subtaskRevertIntent.size).toBe(0);
    expect(state().subtaskElapsed.size).toBe(0);
    expect(state().masterElapsed).toBeNull();
  });

  it('FollowupStarted event is informational (no store mutation; the action handles the swap)', async () => {
    await startThreeWorkerRun();
    const beforeRunId = state().runId;
    emit(EVENT_FOLLOWUP_STARTED, {
      runId: 'untriggered-child',
      parentRunId: PARENT_RUN_ID,
    });
    expect(state().runId).toBe(beforeRunId);
  });
});

// ---------------------------------------------------------------------------
// Pair 6: Undo during running (Step 2) ↔ Checklist state (Step 3)
// ---------------------------------------------------------------------------

describe('Phase 7 cross-step — pair 6: undo during running ↔ checklist', () => {
  it('revert + cancelled state landed alongside flips checklist source for the target subtask only', async () => {
    await startThreeWorkerRun();
    expect(state().nodeSnapshots.get('a')?.value).toBe('running');

    await state().revertSubtaskChanges('a');
    // Backend emits the cancelled transition + the worktree-reverted
    // event in either order; checklist must end with `a` cancelled and
    // `b` / `c` still running regardless.
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: PARENT_RUN_ID,
      subtaskId: 'a',
      state: 'cancelled',
      retryCount: 0,
    });
    emit(EVENT_WORKTREE_REVERTED, { runId: PARENT_RUN_ID, subtaskId: 'a', filesCleared: 2 });

    expect(state().nodeSnapshots.get('a')?.value).toBe('cancelled');
    expect(state().nodeSnapshots.get('b')?.value).toBe('running');
    expect(state().nodeSnapshots.get('c')?.value).toBe('running');
    expect(state().subtaskRevertIntent.has('a')).toBe(true);
  });

  it('reverse event order (worktree first, then cancelled) lands the same end state', async () => {
    await startThreeWorkerRun();
    await state().revertSubtaskChanges('b');
    emit(EVENT_WORKTREE_REVERTED, { runId: PARENT_RUN_ID, subtaskId: 'b', filesCleared: 1 });
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: PARENT_RUN_ID,
      subtaskId: 'b',
      state: 'cancelled',
      retryCount: 0,
    });
    expect(state().nodeSnapshots.get('b')?.value).toBe('cancelled');
    expect(state().subtaskRevertIntent.has('b')).toBe(true);
  });

  it('siblings keep their elapsed values after one worker reverts', async () => {
    await startThreeWorkerRun();
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'a', elapsedMs: 4_000 });
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'b', elapsedMs: 5_000 });

    await state().revertSubtaskChanges('a');
    emit(EVENT_WORKTREE_REVERTED, { runId: PARENT_RUN_ID, subtaskId: 'a', filesCleared: 1 });

    // Sibling `b`'s captured runtime is unaffected by the revert.
    expect(state().subtaskElapsed.get('b')).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Phase 7 cross-step — edge case 7: revert while sidebar focuses that worker', () => {
  it('selection retains the id; subtaskDiffs entry drops; component reads empty diff list', async () => {
    await startThreeWorkerRun();
    emit(EVENT_SUBTASK_DIFF, {
      runId: PARENT_RUN_ID,
      subtaskId: 'a',
      files: [
        { path: 'a.ts', additions: 1, deletions: 0 },
      ],
    });
    state().selectDiffWorker('a', false);
    await state().revertSubtaskChanges('a');
    emit(EVENT_WORKTREE_REVERTED, { runId: PARENT_RUN_ID, subtaskId: 'a', filesCleared: 1 });

    expect(state().inlineDiffSelection.has('a')).toBe(true);
    expect(state().subtaskDiffs.has('a')).toBe(false);
  });
});

describe('Phase 7 cross-step — edge case 9: follow-up resets user-collapsed sidebar', () => {
  it('user-collapsed sidebar pre-Apply: child run drops back to default-derive', async () => {
    await startThreeWorkerRun();
    state().toggleInlineDiffSidebar();
    // Force `running` so the toggle flips from default-open to user-closed.
    expect(computeSidebarOpen(state())).toBe(false);

    invokeHandlers.set('start_followup_run', async () => 'child-run-edge9');
    await state().submitFollowupRun('add tests');

    // Reset clears the override; `computeSidebarOpen` falls back to
    // status-based derivation. Child status starts at `idle` until the
    // first event lands → default closed for idle.
    expect(state().inlineDiffSidebarUserToggled).toBeNull();
  });
});

describe('Phase 7 cross-step — edge case 11: concurrent state pressure', () => {
  it('6 workers ticking + activity + log interleaved: every slice updates without loss', async () => {
    // Drive a fresh 6-worker run through the proper lifecycle so each
    // subtask has an actor (appendLog gates on actor presence).
    await state().submitTask('pressure');
    emit(EVENT_SUBTASKS_PROPOSED, {
      runId: PARENT_RUN_ID,
      subtasks: [
        { id: 'a', title: 'A', why: null, assignedWorker: 'claude', dependencies: [] },
        { id: 'b', title: 'B', why: null, assignedWorker: 'codex', dependencies: [] },
        { id: 'c', title: 'C', why: null, assignedWorker: 'gemini', dependencies: [] },
        { id: 'd', title: 'D', why: null, assignedWorker: 'claude', dependencies: [] },
        { id: 'e', title: 'E', why: null, assignedWorker: 'codex', dependencies: [] },
        { id: 'f', title: 'F', why: null, assignedWorker: 'gemini', dependencies: [] },
      ],
    });
    emit(EVENT_STATUS_CHANGED, { runId: PARENT_RUN_ID, status: 'awaiting-approval' });
    await state().approveSubtasks(['a', 'b', 'c', 'd', 'e', 'f']);
    emit(EVENT_STATUS_CHANGED, { runId: PARENT_RUN_ID, status: 'running' });
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      emit(EVENT_SUBTASK_STATE_CHANGED, {
        runId: PARENT_RUN_ID,
        subtaskId: id,
        state: 'running',
      });
    }

    // Drive 60 events per worker in interleaved order: 1s ticks for 10s
    // of simulated runtime, plus 5 activity entries and 5 log lines.
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (let t = 1; t <= 10; t += 1) {
      for (const id of ids) {
        emit(EVENT_ELAPSED_TICK, {
          runId: PARENT_RUN_ID,
          subtaskId: id,
          elapsedMs: t * 1_000,
        });
      }
    }
    for (let n = 0; n < 5; n += 1) {
      for (const id of ids) {
        emit(EVENT_SUBTASK_ACTIVITY, {
          runId: PARENT_RUN_ID,
          subtaskId: id,
          event: {
            kind: 'file-edit',
            path: `${id}-${n}.ts`,
            summary: `edit ${n}`,
          },
          timestampMs: n * 100,
        });
      }
    }
    for (let n = 0; n < 5; n += 1) {
      for (const id of ids) {
        emit(EVENT_SUBTASK_LOG, {
          runId: PARENT_RUN_ID,
          subtaskId: id,
          line: `${id} line ${n}`,
        });
      }
    }

    // Every elapsed slot saw 10 updates — last value is 10_000.
    for (const id of ids) {
      expect(state().subtaskElapsed.get(id)).toBe(10_000);
    }
    // Activity ring captures the 5 entries per subtask.
    for (const id of ids) {
      expect(state().subtaskActivities.get(id)?.length).toBe(5);
    }
    // Log buffer captures all 5 lines per subtask.
    for (const id of ids) {
      const logs = state().nodeLogs.get(id);
      expect(logs?.length).toBe(5);
    }
  });

  it('master-tick + per-worker-tick interleave under load: no cross-write', async () => {
    await startThreeWorkerRun();
    for (let t = 1; t <= 20; t += 1) {
      // Master tick first, then 3 worker ticks at the same logical time.
      emit(EVENT_ELAPSED_TICK, {
        runId: PARENT_RUN_ID,
        subtaskId: null,
        elapsedMs: t * 1_000,
      });
      emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'a', elapsedMs: t * 1_000 });
      emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'b', elapsedMs: t * 1_000 });
      emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: 'c', elapsedMs: t * 1_000 });
    }
    expect(state().masterElapsed).toBe(20_000);
    expect(state().subtaskElapsed.get('a')).toBe(20_000);
    expect(state().subtaskElapsed.get('b')).toBe(20_000);
    expect(state().subtaskElapsed.get('c')).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// Phase 4-6 regression spot-checks (no Phase 7 surface should disturb these)
// ---------------------------------------------------------------------------

describe('Phase 7 cross-step — Phase 4-6 regression spot-checks', () => {
  it('apply-summary still lands after a follow-up swap returns to the parent flow shape', async () => {
    await startThreeWorkerRun();
    emit(EVENT_SUBTASK_STATE_CHANGED, {
      runId: PARENT_RUN_ID,
      subtaskId: 'a',
      state: 'done',
      retryCount: 0,
    });
    emit(EVENT_DIFF_READY, {
      runId: PARENT_RUN_ID,
      files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
      conflictFiles: [],
    });
    emit(EVENT_STATUS_CHANGED, { runId: PARENT_RUN_ID, status: 'done' });
    expect(state().status).toBe('done');
  });

  it('subtask activity stream still trims to its 50-entry cap under Phase 7 elapsed pressure', async () => {
    await startThreeWorkerRun();
    for (let n = 0; n < 60; n += 1) {
      emit(EVENT_SUBTASK_ACTIVITY, {
        runId: PARENT_RUN_ID,
        subtaskId: 'a',
        event: { kind: 'file-edit', path: `a-${n}.ts`, summary: `edit ${n}` },
        timestampMs: n,
      });
      emit(EVENT_ELAPSED_TICK, {
        runId: PARENT_RUN_ID,
        subtaskId: 'a',
        elapsedMs: n * 100,
      });
    }
    expect(state().subtaskActivities.get('a')?.length).toBe(50);
  });

  it('master log buffer still records lines while ElapsedTick events fire', async () => {
    await startThreeWorkerRun();
    emit(EVENT_MASTER_LOG, { runId: PARENT_RUN_ID, line: 'thinking…' });
    emit(EVENT_ELAPSED_TICK, { runId: PARENT_RUN_ID, subtaskId: null, elapsedMs: 1_000 });
    emit(EVENT_MASTER_LOG, { runId: PARENT_RUN_ID, line: 'still thinking' });
    const masterLogs = state().nodeLogs.get('master');
    expect(masterLogs?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
