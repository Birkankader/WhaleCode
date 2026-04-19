/**
 * Unit tests for pure store actions that don't go through IPC.
 * Full event-driven lifecycle is covered by `graphStore.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Both mocks are required — graphStore pulls in `runSubscription`, which
// transitively imports `@tauri-apps/api/event`, and IPC wrappers import
// `@tauri-apps/api/core`. Tests that don't exercise these paths still need
// the mocks in place at module-resolution time.
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

import { useGraphStore } from './graphStore';

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
        { id: 'a', title: 'A', why: null, agent: 'claude', dependsOn: [] },
        { id: 'b', title: 'B', why: null, agent: 'gemini', dependsOn: [] },
        { id: 'c', title: 'C', why: null, agent: 'codex', dependsOn: [] },
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
