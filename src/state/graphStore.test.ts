import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FINAL_ID, MASTER_ID, useGraphStore } from './graphStore';

function state() {
  return useGraphStore.getState();
}

function snap(id: string) {
  return state().nodeSnapshots.get(id);
}

const SUBTASKS = [
  { id: 'a', title: 'Scaffold auth', agent: 'claude' as const, dependsOn: [] },
  { id: 'b', title: 'Write tests', agent: 'gemini' as const, dependsOn: ['a'] },
  { id: 'c', title: 'Docs', agent: 'codex' as const, dependsOn: [] },
];

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
  });
});

describe('graphStore — submitTask', () => {
  it('creates a master actor in thinking + status=planning', () => {
    state().submitTask('Build a TODO app', 'claude');
    const s = state();
    expect(s.runId).toMatch(/^run_/);
    expect(s.taskInput).toBe('Build a TODO app');
    expect(s.status).toBe('planning');
    expect(s.masterNode).toEqual({
      id: MASTER_ID,
      agent: 'claude',
      label: 'Master',
    });
    expect(snap(MASTER_ID)?.value).toBe('thinking');
  });

  it('defaults masterAgent to "master"', () => {
    state().submitTask('x');
    expect(state().masterNode?.agent).toBe('master');
  });
});

describe('graphStore — proposeSubtasks', () => {
  it('creates actors per subtask, moves master + subtasks to proposed, selects all', () => {
    state().submitTask('x');
    state().proposeSubtasks(SUBTASKS);
    const s = state();
    expect(s.status).toBe('awaiting_approval');
    expect(s.subtasks).toHaveLength(3);
    expect(s.selectedSubtaskIds).toEqual(new Set(['a', 'b', 'c']));
    expect(snap('a')?.value).toBe('proposed');
    expect(snap('b')?.value).toBe('proposed');
    expect(snap('c')?.value).toBe('proposed');
    expect(snap(MASTER_ID)?.value).toBe('proposed');
  });
});

describe('graphStore — selection actions', () => {
  beforeEach(() => {
    state().submitTask('x');
    state().proposeSubtasks(SUBTASKS);
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

describe('graphStore — approveSubtasks', () => {
  beforeEach(() => {
    state().submitTask('x');
    state().proposeSubtasks(SUBTASKS);
  });

  it('approves selected, skips the rest, spawns final node', () => {
    state().approveSubtasks(['a', 'b']);
    const s = state();
    expect(s.status).toBe('running');
    expect(snap('a')?.value).toBe('approved');
    expect(snap('b')?.value).toBe('approved');
    expect(snap('c')?.value).toBe('skipped');
    expect(snap(MASTER_ID)?.value).toBe('approved');
    expect(s.finalNode).toEqual({ id: FINAL_ID, label: 'Merge', files: [] });
    expect(snap(FINAL_ID)?.value).toBe('idle');
  });
});

describe('graphStore — rejectAll', () => {
  it('skips every subtask and returns status to idle', () => {
    state().submitTask('x');
    state().proposeSubtasks(SUBTASKS);
    state().rejectAll();
    const s = state();
    expect(s.status).toBe('idle');
    expect(snap('a')?.value).toBe('skipped');
    expect(snap('b')?.value).toBe('skipped');
    expect(snap('c')?.value).toBe('skipped');
    expect(snap(MASTER_ID)?.value).toBe('skipped');
  });
});

describe('graphStore — updateSubtaskState', () => {
  it('forwards events to the right actor', () => {
    state().submitTask('x');
    state().proposeSubtasks(SUBTASKS);
    state().approveSubtasks(['a', 'b', 'c']);
    state().updateSubtaskState('a', { type: 'START' });
    state().updateSubtaskState('a', { type: 'COMPLETE' });
    expect(snap('a')?.value).toBe('done');
    expect(snap('b')?.value).toBe('approved');
  });

  it('drops events to unknown ids silently', () => {
    state().submitTask('x');
    expect(() => state().updateSubtaskState('ghost', { type: 'START' })).not.toThrow();
  });

  it('full retry path via updateSubtaskState', () => {
    state().submitTask('x');
    state().proposeSubtasks(SUBTASKS);
    state().approveSubtasks(['a']);
    state().updateSubtaskState('a', { type: 'START' });
    state().updateSubtaskState('a', { type: 'FAIL' });
    expect(snap('a')?.value).toBe('retrying');
    expect(snap('a')?.retries).toBe(1);
    state().updateSubtaskState('a', { type: 'RETRY_SUCCESS' });
    state().updateSubtaskState('a', { type: 'COMPLETE' });
    expect(snap('a')?.value).toBe('done');
  });
});

describe('graphStore — appendLogToNode', () => {
  beforeEach(() => {
    state().submitTask('x');
    state().proposeSubtasks(SUBTASKS);
    state().approveSubtasks(['a', 'b', 'c']);
  });

  it('appends to master logs', () => {
    state().appendLogToNode(MASTER_ID, 'hello');
    expect(state().nodeLogs.get(MASTER_ID)).toEqual(['hello']);
  });

  it('appends to subtask logs', () => {
    state().appendLogToNode('a', 'line 1');
    state().appendLogToNode('a', 'line 2');
    expect(state().nodeLogs.get('a')).toEqual(['line 1', 'line 2']);
  });

  it('appends to final node logs', () => {
    state().appendLogToNode(FINAL_ID, 'merged');
    expect(state().nodeLogs.get(FINAL_ID)).toEqual(['merged']);
  });

  it('is a no-op for unknown id', () => {
    const before = state();
    state().appendLogToNode('ghost', 'x');
    expect(state().nodeLogs).toBe(before.nodeLogs);
  });

  it('log appends do not change structural references (subtasks array, masterNode)', () => {
    const before = state();
    state().appendLogToNode('a', 'line 1');
    state().appendLogToNode(MASTER_ID, 'line 1');
    const after = state();
    expect(after.subtasks).toBe(before.subtasks);
    expect(after.masterNode).toBe(before.masterNode);
    expect(after.finalNode).toBe(before.finalNode);
  });
});

describe('graphStore — reset', () => {
  it('stops all actors and returns to initial state', () => {
    state().submitTask('x');
    state().proposeSubtasks(SUBTASKS);
    expect(state().nodeActors.size).toBeGreaterThan(0);
    const actors = [...state().nodeActors.values()];
    state().reset();
    const s = state();
    expect(s.runId).toBeNull();
    expect(s.taskInput).toBe('');
    expect(s.status).toBe('idle');
    expect(s.subtasks).toEqual([]);
    expect(s.masterNode).toBeNull();
    expect(s.finalNode).toBeNull();
    expect(s.nodeActors.size).toBe(0);
    expect(s.nodeSnapshots.size).toBe(0);
    expect(s.nodeLogs.size).toBe(0);
    expect(s.selectedSubtaskIds.size).toBe(0);
    // Stopped actors keep their final snapshot but no longer accept events.
    for (const a of actors) {
      expect(a.getSnapshot().status).toBe('stopped');
    }
  });

  it('second run starts clean — no zombie actors from prior run', () => {
    state().submitTask('run 1');
    state().proposeSubtasks(SUBTASKS);
    state().submitTask('run 2');
    const s = state();
    expect(s.taskInput).toBe('run 2');
    expect(s.subtasks).toEqual([]);
    expect(s.nodeActors.size).toBe(1); // master only
    expect(snap(MASTER_ID)?.value).toBe('thinking');
  });
});
