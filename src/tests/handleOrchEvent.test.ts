import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { useTaskStore } from '../stores/taskStore';
import { handleOrchEvent, type OrchEvent } from '../hooks/orchestration/handleOrchEvent';
import type { ToolName } from '../stores/taskStore';

// Mock the notification store to prevent side effects
vi.mock('../stores/notificationStore', () => ({
  emitOrchestrationNotification: vi.fn(),
}));

// Polyfill crypto.randomUUID for deterministic task IDs in jsdom.
// Must be in beforeAll so it runs after setup.ts which sets window.crypto.
let uuidCounter = 0;
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (crypto as any).randomUUID = () => `test-uuid-${++uuidCounter}`;
});

const masterAgent: ToolName = 'claude';

function freshContext() {
  return {
    dagToFrontendId: new Map<string, string>(),
    dagCounter: 0,
  };
}

function dispatch(ev: OrchEvent, ctx = freshContext()) {
  handleOrchEvent(ev, masterAgent, ctx.dagToFrontendId, ctx.dagCounter);
  return ctx;
}

describe('handleOrchEvent', () => {
  beforeEach(() => {
    useTaskStore.getState().clearSession();
    uuidCounter = 0;
  });

  // ── phase_changed events ──────────────────────────────────

  describe('phase_changed', () => {
    it('decomposing phase sets orchestrationPhase and adds log', () => {
      dispatch({ type: 'phase_changed', phase: 'decomposing', detail: 'Breaking down task' });

      expect(useTaskStore.getState().orchestrationPhase).toBe('decomposing');
      const logs = useTaskStore.getState().orchestrationLogs;
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[logs.length - 1].level).toBe('cmd');
    });

    it('decomposing phase sets activePlan when plan_id is provided', () => {
      dispatch({
        type: 'phase_changed',
        phase: 'decomposing',
        plan_id: 'plan-123',
        master_agent: 'gemini',
      });

      const plan = useTaskStore.getState().activePlan;
      expect(plan).not.toBeNull();
      expect(plan!.task_id).toBe('plan-123');
      expect(plan!.master_agent).toBe('gemini');
    });

    it('awaiting_approval phase is set correctly', () => {
      dispatch({ type: 'phase_changed', phase: 'awaiting_approval', task_count: 5 });

      expect(useTaskStore.getState().orchestrationPhase).toBe('awaiting_approval');
    });

    it('executing phase moves pending workers to running', () => {
      // First add a pending worker task
      useTaskStore.getState().addTask({
        taskId: 'worker-1',
        prompt: 'Do something',
        toolName: 'gemini',
        status: 'pending',
        description: 'Worker task',
        startedAt: null,
        dependsOn: null,
        role: 'worker',
      });

      dispatch({ type: 'phase_changed', phase: 'executing', task_count: 1, wave_count: 1 });

      expect(useTaskStore.getState().orchestrationPhase).toBe('executing');
      expect(useTaskStore.getState().tasks.get('worker-1')!.status).toBe('waiting');
    });

    it('executing phase does not affect non-worker tasks', () => {
      useTaskStore.getState().addTask({
        taskId: 'master-1',
        prompt: 'Master prompt',
        toolName: 'claude',
        status: 'pending',
        description: 'Master task',
        startedAt: null,
        dependsOn: null,
        role: 'master',
      });

      dispatch({ type: 'phase_changed', phase: 'executing', task_count: 0, wave_count: 1 });

      // Master task should remain pending (not a worker)
      expect(useTaskStore.getState().tasks.get('master-1')!.status).toBe('pending');
    });

    it('reviewing phase is set correctly', () => {
      dispatch({ type: 'phase_changed', phase: 'reviewing', detail: 'Code review' });

      expect(useTaskStore.getState().orchestrationPhase).toBe('reviewing');
    });
  });

  // ── task_assigned events ──────────────────────────────────

  describe('task_assigned', () => {
    it('creates a task in the store', () => {
      const ctx = freshContext();
      dispatch(
        { type: 'task_assigned', agent: 'gemini', description: 'Fix the bug', dag_id: 'dag-1' },
        ctx,
      );

      const tasks = useTaskStore.getState().tasks;
      expect(tasks.size).toBe(1);

      const task = tasks.get('test-uuid-1')!;
      expect(task.toolName).toBe('gemini');
      expect(task.role).toBe('worker');
      expect(task.prompt).toBe('Fix the bug');
    });

    it('maps dag_id to frontend task id', () => {
      const ctx = freshContext();
      dispatch(
        { type: 'task_assigned', agent: 'claude', description: 'Write tests', dag_id: 'dag-A' },
        ctx,
      );

      expect(ctx.dagToFrontendId.get('dag-A')).toBe('test-uuid-1');
      expect(useTaskStore.getState().tasks.has('test-uuid-1')).toBe(true);
    });

    it('sets status to running if phase is already executing', () => {
      useTaskStore.getState().setOrchestrationPhase('executing');
      const ctx = freshContext();
      dispatch(
        { type: 'task_assigned', agent: 'codex', description: 'Refactor module', dag_id: 'dag-B' },
        ctx,
      );

      const task = useTaskStore.getState().tasks.get('test-uuid-1')!;
      expect(task.status).toBe('running');
      expect(task.startedAt).not.toBeNull();
    });

    it('sets status to pending if phase is not executing', () => {
      useTaskStore.getState().setOrchestrationPhase('decomposing');
      const ctx = freshContext();
      dispatch(
        { type: 'task_assigned', agent: 'codex', description: 'Build feature', dag_id: 'dag-C' },
        ctx,
      );

      const task = useTaskStore.getState().tasks.get('test-uuid-1')!;
      expect(task.status).toBe('pending');
      expect(task.startedAt).toBeNull();
    });

    it('truncates long descriptions', () => {
      const ctx = freshContext();
      const longDesc = 'A'.repeat(80);
      dispatch(
        { type: 'task_assigned', agent: 'claude', description: longDesc, dag_id: 'dag-D' },
        ctx,
      );

      const task = useTaskStore.getState().tasks.get('test-uuid-1')!;
      expect(task.description.length).toBeLessThanOrEqual(60);
      expect(task.description.endsWith('...')).toBe(true);
    });
  });

  // ── task_completed / task_failed events ───────────────────

  describe('task_completed', () => {
    it('updates task status to completed', () => {
      const ctx = freshContext();
      dispatch(
        { type: 'task_assigned', agent: 'gemini', description: 'Task A', dag_id: 'dag-1' },
        ctx,
      );
      dispatch(
        { type: 'task_completed', dag_id: 'dag-1', summary: 'Done', exit_code: 0 },
        ctx,
      );

      const task = useTaskStore.getState().tasks.get('test-uuid-1')!;
      expect(task.status).toBe('completed');
    });

    it('logs success message', () => {
      const ctx = freshContext();
      dispatch(
        { type: 'task_assigned', agent: 'gemini', description: 'Task B', dag_id: 'dag-2' },
        ctx,
      );
      dispatch(
        { type: 'task_completed', dag_id: 'dag-2', summary: 'All good', exit_code: 0 },
        ctx,
      );

      const logs = useTaskStore.getState().orchestrationLogs;
      const completionLog = logs.find(l => l.message.includes('Completed'));
      expect(completionLog).toBeDefined();
      expect(completionLog!.level).toBe('success');
    });
  });

  describe('task_failed', () => {
    it('updates task status to failed', () => {
      const ctx = freshContext();
      dispatch(
        { type: 'task_assigned', agent: 'codex', description: 'Task C', dag_id: 'dag-3' },
        ctx,
      );
      dispatch(
        { type: 'task_failed', dag_id: 'dag-3', summary: 'Timeout', exit_code: 1 },
        ctx,
      );

      const task = useTaskStore.getState().tasks.get('test-uuid-1')!;
      expect(task.status).toBe('failed');
    });

    it('logs error message', () => {
      const ctx = freshContext();
      dispatch(
        { type: 'task_assigned', agent: 'codex', description: 'Task D', dag_id: 'dag-4' },
        ctx,
      );
      dispatch(
        { type: 'task_failed', dag_id: 'dag-4', summary: 'Build error', exit_code: 1 },
        ctx,
      );

      const logs = useTaskStore.getState().orchestrationLogs;
      const failLog = logs.find(l => l.message.includes('Failed'));
      expect(failLog).toBeDefined();
      expect(failLog!.level).toBe('error');
    });

    it('handles missing dag_id gracefully', () => {
      // Should not throw
      dispatch({ type: 'task_failed', summary: 'Unknown failure', exit_code: 1 });

      const logs = useTaskStore.getState().orchestrationLogs;
      expect(logs.find(l => l.message.includes('Failed'))).toBeDefined();
    });
  });

  // ── Other event types ─────────────────────────────────────

  describe('diffs_ready', () => {
    it('sets worktree entries in the store', () => {
      dispatch({
        type: 'diffs_ready',
        diffs: [
          { dag_id: 'dag-1', branch_name: 'feature/a', file_count: 5, additions: 20, deletions: 3 },
          { dag_id: 'dag-2', branch_name: 'feature/b', file_count: 2, additions: 8, deletions: 1 },
        ],
      });

      const entries = useTaskStore.getState().worktreeEntries;
      expect(entries.size).toBe(2);
      expect(entries.get('dag-1')!.branchName).toBe('feature/a');
      expect(entries.get('dag-2')!.additions).toBe(8);
    });
  });

  describe('decomposition_failed', () => {
    it('logs error and sets resultSummary on master task', () => {
      useTaskStore.getState().addTask({
        taskId: 'master-1',
        prompt: 'Orchestrate',
        toolName: 'claude',
        status: 'running',
        description: 'Master',
        startedAt: Date.now(),
        dependsOn: null,
        role: 'master',
      });

      dispatch({ type: 'decomposition_failed', error: 'JSON parse error' });

      const logs = useTaskStore.getState().orchestrationLogs;
      expect(logs.find(l => l.message === 'JSON parse error')).toBeDefined();

      const masterTask = useTaskStore.getState().tasks.get('master-1')!;
      expect(masterTask.resultSummary).toBe('JSON parse error');
    });
  });

  describe('info', () => {
    it('adds an info log entry', () => {
      dispatch({ type: 'info', message: 'Starting merge' });

      const logs = useTaskStore.getState().orchestrationLogs;
      expect(logs.length).toBe(1);
      expect(logs[0].level).toBe('info');
      expect(logs[0].message).toBe('Starting merge');
    });
  });

  describe('wave_progress', () => {
    it('logs wave progress', () => {
      dispatch({ type: 'wave_progress', current: 2, total: 3 });

      const logs = useTaskStore.getState().orchestrationLogs;
      expect(logs.find(l => l.message.includes('Wave 2/3'))).toBeDefined();
    });
  });

  describe('question', () => {
    it('sets pending question when plan_id is provided', () => {
      dispatch({
        type: 'question',
        agent: 'gemini',
        content: 'Which database?',
        plan_id: 'plan-1',
      });

      const q = useTaskStore.getState().pendingQuestion;
      expect(q).not.toBeNull();
      expect(q!.sourceAgent).toBe('gemini');
      expect(q!.content).toBe('Which database?');
    });
  });

  describe('question_answered', () => {
    it('clears pending question', () => {
      useTaskStore.getState().setPendingQuestion({
        questionId: 'q1',
        sourceAgent: 'gemini',
        content: 'Which DB?',
        planId: 'plan-1',
      });

      dispatch({ type: 'question_answered', agent: 'gemini' });

      expect(useTaskStore.getState().pendingQuestion).toBeNull();
    });
  });
});
