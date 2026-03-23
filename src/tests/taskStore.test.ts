import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskStore } from '../stores/taskStore';
import type { TaskEntry, ToolName } from '../stores/taskStore';

function makeTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    taskId: overrides.taskId ?? 'task-1',
    prompt: 'Test prompt',
    toolName: 'claude' as ToolName,
    status: 'pending',
    description: 'Test task',
    startedAt: null,
    dependsOn: null,
    role: 'worker',
    ...overrides,
  };
}

describe('taskStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useTaskStore.getState().clearSession();
  });

  it('addTask creates a task in the store', () => {
    const task = makeTask({ taskId: 'add-1' });
    useTaskStore.getState().addTask(task);

    const stored = useTaskStore.getState().tasks.get('add-1');
    expect(stored).toBeDefined();
    expect(stored!.taskId).toBe('add-1');
    expect(stored!.prompt).toBe('Test prompt');
    expect(stored!.status).toBe('pending');
  });

  it('addTask preserves existing tasks when adding new ones', () => {
    useTaskStore.getState().addTask(makeTask({ taskId: 'first' }));
    useTaskStore.getState().addTask(makeTask({ taskId: 'second' }));

    const { tasks } = useTaskStore.getState();
    expect(tasks.size).toBe(2);
    expect(tasks.has('first')).toBe(true);
    expect(tasks.has('second')).toBe(true);
  });

  it('updateTaskStatus changes status correctly', () => {
    useTaskStore.getState().addTask(makeTask({ taskId: 'status-1' }));
    useTaskStore.getState().updateTaskStatus('status-1', 'running');

    const task = useTaskStore.getState().tasks.get('status-1');
    expect(task!.status).toBe('running');
  });

  it('updateTaskStatus to completed works', () => {
    useTaskStore.getState().addTask(makeTask({ taskId: 'status-2', status: 'running' }));
    useTaskStore.getState().updateTaskStatus('status-2', 'completed');

    expect(useTaskStore.getState().tasks.get('status-2')!.status).toBe('completed');
  });

  it('updateTaskStatus with unknown taskId does not crash', () => {
    useTaskStore.getState().updateTaskStatus('nonexistent', 'failed');
    // Should not throw, tasks map stays empty
    expect(useTaskStore.getState().tasks.size).toBe(0);
  });

  it('updateTaskResult sets resultSummary', () => {
    useTaskStore.getState().addTask(makeTask({ taskId: 'result-1' }));
    useTaskStore.getState().updateTaskResult('result-1', 'All tests passed');

    const task = useTaskStore.getState().tasks.get('result-1');
    expect(task!.resultSummary).toBe('All tests passed');
  });

  it('updateTaskAgent changes the agent', () => {
    useTaskStore.getState().addTask(makeTask({ taskId: 'agent-1', toolName: 'claude' }));
    useTaskStore.getState().updateTaskAgent('agent-1', 'gemini');

    expect(useTaskStore.getState().tasks.get('agent-1')!.toolName).toBe('gemini');
  });

  it('removeTask deletes a task', () => {
    useTaskStore.getState().addTask(makeTask({ taskId: 'rm-1' }));
    expect(useTaskStore.getState().tasks.has('rm-1')).toBe(true);

    useTaskStore.getState().removeTask('rm-1');
    expect(useTaskStore.getState().tasks.has('rm-1')).toBe(false);
  });

  it('getRunningTaskForTool returns the running task for the given tool', () => {
    useTaskStore.getState().addTask(makeTask({ taskId: 'run-1', toolName: 'claude', status: 'running' }));
    useTaskStore.getState().addTask(makeTask({ taskId: 'run-2', toolName: 'gemini', status: 'pending' }));

    const running = useTaskStore.getState().getRunningTaskForTool('claude');
    expect(running).toBeDefined();
    expect(running!.taskId).toBe('run-1');

    const noRunning = useTaskStore.getState().getRunningTaskForTool('gemini');
    expect(noRunning).toBeUndefined();
  });

  it('clearSession resets all state', () => {
    // Populate the store
    useTaskStore.getState().addTask(makeTask({ taskId: 'clear-1' }));
    useTaskStore.getState().setOrchestrationPhase('executing');
    useTaskStore.getState().setActivePlan({ task_id: 'p1', master_agent: 'claude', master_process_id: null });
    useTaskStore.getState().setPendingQuestion({
      questionId: 'q1',
      sourceAgent: 'gemini',
      content: 'What should I do?',
      planId: 'p1',
    });
    useTaskStore.getState().addOrchestrationLog({ agent: 'claude', level: 'info', message: 'test' });

    // Verify populated
    expect(useTaskStore.getState().tasks.size).toBe(1);
    expect(useTaskStore.getState().orchestrationPhase).toBe('executing');
    expect(useTaskStore.getState().activePlan).not.toBeNull();
    expect(useTaskStore.getState().pendingQuestion).not.toBeNull();
    expect(useTaskStore.getState().orchestrationLogs.length).toBe(1);

    // Clear
    useTaskStore.getState().clearSession();

    // Verify cleared
    const state = useTaskStore.getState();
    expect(state.tasks.size).toBe(0);
    expect(state.orchestrationPhase).toBe('idle');
    expect(state.activePlan).toBeNull();
    expect(state.pendingQuestion).toBeNull();
    expect(state.orchestrationLogs).toHaveLength(0);
    expect(state.decomposedTasks).toHaveLength(0);
    expect(state.worktreeEntries.size).toBe(0);
  });

  it('Map-based state updates produce new Map references', () => {
    useTaskStore.getState().addTask(makeTask({ taskId: 'map-1' }));
    const mapBefore = useTaskStore.getState().tasks;

    useTaskStore.getState().addTask(makeTask({ taskId: 'map-2' }));
    const mapAfter = useTaskStore.getState().tasks;

    // Should be different Map instances (immutable updates)
    expect(mapBefore).not.toBe(mapAfter);
    expect(mapBefore.size).toBe(1);
    expect(mapAfter.size).toBe(2);
  });

  it('setOrchestrationPhase to decomposing sets orchestrationStartedAt', () => {
    const before = Date.now();
    useTaskStore.getState().setOrchestrationPhase('decomposing');
    const after = Date.now();

    const startedAt = useTaskStore.getState().orchestrationStartedAt;
    expect(startedAt).not.toBeNull();
    expect(startedAt!).toBeGreaterThanOrEqual(before);
    expect(startedAt!).toBeLessThanOrEqual(after);
  });

  it('setOrchestrationPhase to idle clears orchestrationStartedAt', () => {
    useTaskStore.getState().setOrchestrationPhase('decomposing');
    expect(useTaskStore.getState().orchestrationStartedAt).not.toBeNull();

    useTaskStore.getState().setOrchestrationPhase('idle');
    expect(useTaskStore.getState().orchestrationStartedAt).toBeNull();
  });

  it('updateTaskOutputLine sets lastOutputLine', () => {
    useTaskStore.getState().addTask(makeTask({ taskId: 'output-1' }));
    useTaskStore.getState().updateTaskOutputLine('output-1', 'Processing file.ts...');

    expect(useTaskStore.getState().tasks.get('output-1')!.lastOutputLine).toBe('Processing file.ts...');
  });

  it('setWorktreeEntries stores review entries', () => {
    const entries = new Map([
      ['dag-1', { dagId: 'dag-1', branchName: 'feature/a', fileCount: 3, additions: 10, deletions: 2 }],
    ]);
    useTaskStore.getState().setWorktreeEntries(entries);

    const stored = useTaskStore.getState().worktreeEntries;
    expect(stored.size).toBe(1);
    expect(stored.get('dag-1')!.branchName).toBe('feature/a');
  });
});
