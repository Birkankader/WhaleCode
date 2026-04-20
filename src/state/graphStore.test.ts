/**
 * Unit tests for pure store actions that don't go through IPC.
 * Full event-driven lifecycle is covered by `graphStore.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Both mocks are required — graphStore pulls in `runSubscription`, which
// transitively imports `@tauri-apps/api/event`, and IPC wrappers import
// `@tauri-apps/api/core`. Tests that don't exercise these paths still need
// the mocks in place at module-resolution time.
const invokeMock = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined);
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { computeSkipCascadeCount, useGraphStore } from './graphStore';
import type { SubtaskNodeData } from './graphStore';

function state() {
  return useGraphStore.getState();
}

beforeEach(() => {
  useGraphStore.getState().reset();
});

afterEach(() => {
  useGraphStore.getState().reset();
});

describe('graphStore — initial', () => {
  it('starts empty and idle', () => {
    const s = state();
    expect(s.runId).toBeNull();
    expect(s.taskInput).toBe('');
    expect(s.status).toBe('idle');
    expect(s.subtasks).toEqual([]);
    expect(s.masterNode).toBeNull();
    expect(s.finalNode).toBeNull();
    expect(s.selectedSubtaskIds.size).toBe(0);
    expect(s.nodeActors.size).toBe(0);
    expect(s.nodeSnapshots.size).toBe(0);
    expect(s.nodeLogs.size).toBe(0);
    expect(s.activeSubscription).toBeNull();
    expect(s.currentError).toBeNull();
  });
});

describe('graphStore — setMasterAgent', () => {
  it('updates selectedMasterAgent', () => {
    state().setMasterAgent('gemini');
    expect(state().selectedMasterAgent).toBe('gemini');
  });
});

describe('graphStore — selection actions', () => {
  beforeEach(() => {
    // Inject subtasks directly so we can test selection logic without
    // a full run lifecycle.
    useGraphStore.setState({
      subtasks: [
        { id: 'a', title: 'A', why: null, agent: 'claude', dependsOn: [], replaces: [] },
        { id: 'b', title: 'B', why: null, agent: 'gemini', dependsOn: [], replaces: [] },
        { id: 'c', title: 'C', why: null, agent: 'codex', dependsOn: [], replaces: [] },
      ],
      selectedSubtaskIds: new Set(['a', 'b', 'c']),
    });
  });

  it('toggleSubtaskSelection flips membership', () => {
    state().toggleSubtaskSelection('a');
    expect(state().selectedSubtaskIds.has('a')).toBe(false);
    state().toggleSubtaskSelection('a');
    expect(state().selectedSubtaskIds.has('a')).toBe(true);
  });

  it('selectNone clears, selectAll restores', () => {
    state().selectNone();
    expect(state().selectedSubtaskIds.size).toBe(0);
    state().selectAll();
    expect(state().selectedSubtaskIds).toEqual(new Set(['a', 'b', 'c']));
  });
});

describe('graphStore — reset', () => {
  it('returns to initial state', () => {
    useGraphStore.setState({
      runId: 'r-1',
      taskInput: 'prior',
      status: 'running',
      currentError: 'something',
    });
    state().reset();
    const s = state();
    expect(s.runId).toBeNull();
    expect(s.taskInput).toBe('');
    expect(s.status).toBe('idle');
    expect(s.currentError).toBeNull();
    expect(s.activeSubscription).toBeNull();
  });
});

describe('computeSkipCascadeCount', () => {
  function mk(id: string, deps: string[] = []): SubtaskNodeData {
    return { id, title: id, why: null, agent: 'claude', dependsOn: deps, replaces: [] };
  }

  it('returns 0 for a leaf subtask with no dependents', () => {
    const tasks = [mk('a'), mk('b')];
    expect(computeSkipCascadeCount(tasks, 'a')).toBe(0);
  });

  it('linear chain: origin + 2 cascade = 2', () => {
    // a → b → c: skipping a should also flip b and c (2 dependents).
    const tasks = [mk('a'), mk('b', ['a']), mk('c', ['b'])];
    expect(computeSkipCascadeCount(tasks, 'a')).toBe(2);
  });

  it('diamond: counts each dependent exactly once', () => {
    // a fans out to b, c; b and c both feed d. Skip a → b, c, d (3).
    const tasks = [mk('a'), mk('b', ['a']), mk('c', ['a']), mk('d', ['b', 'c'])];
    expect(computeSkipCascadeCount(tasks, 'a')).toBe(3);
  });

  it('skipping a mid-chain node only cascades forward', () => {
    // a → b → c. Skipping b shouldn't pull in a (upstream).
    const tasks = [mk('a'), mk('b', ['a']), mk('c', ['b'])];
    expect(computeSkipCascadeCount(tasks, 'b')).toBe(1);
  });
});

describe('graphStore — Layer-3 actions', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    useGraphStore.setState({ runId: 'r-1', status: 'awaiting_human_fix' });
  });

  it('manualFixSubtask returns EditorResult and stays silent on editor-launch tiers', async () => {
    invokeMock.mockResolvedValueOnce({ method: 'configured', path: '/w/a' });
    const result = await state().manualFixSubtask('a');
    expect(result).toEqual({ method: 'configured', path: '/w/a' });
    expect(state().currentError).toBeNull();
  });

  it('manualFixSubtask surfaces clipboard guidance when method is clipboard-only', async () => {
    invokeMock.mockResolvedValueOnce({ method: 'clipboard-only', path: '/w/a' });
    // jsdom provides navigator.clipboard in happy-dom too, but stub to be safe.
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    await state().manualFixSubtask('a');
    expect(writeText).toHaveBeenCalledWith('/w/a');
    expect(state().currentError).not.toBeNull();
    expect(state().currentError).toContain('/w/a');
  });

  it('markSubtaskFixed invokes mark_subtask_fixed and stays silent on success', async () => {
    await state().markSubtaskFixed('a');
    expect(invokeMock).toHaveBeenCalledWith('mark_subtask_fixed', {
      runId: 'r-1',
      subtaskId: 'a',
    });
    expect(state().currentError).toBeNull();
  });

  it('skipSubtask returns SkipResult', async () => {
    invokeMock.mockResolvedValueOnce({ skippedCount: 3, skippedIds: ['a', 'b', 'c'] });
    const result = await state().skipSubtask('a');
    expect(result).toEqual({ skippedCount: 3, skippedIds: ['a', 'b', 'c'] });
  });

  it('tryReplanAgain invokes try_replan_again', async () => {
    await state().tryReplanAgain('a');
    expect(invokeMock).toHaveBeenCalledWith('try_replan_again', {
      runId: 'r-1',
      subtaskId: 'a',
    });
  });

  it('mapEditError surfaces the cap-exhausted phrasing on tryReplanAgain failure', async () => {
    invokeMock.mockRejectedValueOnce('replan cap exhausted for lineage');
    await expect(state().tryReplanAgain('a')).rejects.toBeDefined();
    expect(state().currentError).toBe('Cannot replan: maximum attempts reached.');
  });

  it('mapEditError surfaces wrong-state phrasing', async () => {
    invokeMock.mockRejectedValueOnce(
      'run expected awaiting-human-fix, got running',
    );
    await expect(state().markSubtaskFixed('a')).rejects.toBeDefined();
    expect(state().currentError).toContain('no longer available');
  });
});
