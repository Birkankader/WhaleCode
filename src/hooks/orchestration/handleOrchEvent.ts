import { toast } from 'sonner';
import { useTaskStore, type ToolName, type TaskStatus } from '../../stores/taskStore';
import { useUIStore } from '../../stores/uiStore';
import { emitOrchestrationNotification } from '../../stores/notificationStore';
import { commands } from '../../bindings';

/* ── Structured orchestrator event handler ───────────────── */

export type OrchEvent =
  | { type: 'phase_changed'; phase: string; detail?: string; task_count?: number; wave_count?: number }
  | { type: 'task_assigned'; agent: string; description: string; prompt?: string }
  | { type: 'task_completed'; summary?: string; exit_code?: number }
  | { type: 'task_failed'; summary?: string; exit_code?: number }
  | { type: 'wave_progress'; current: number; total: number }
  | { type: 'task_skipped'; dag_id: string; reason: string }
  | { type: 'task_retrying'; dag_id: string; attempt: number; max_retries: number }
  | { type: 'task_fallback'; dag_id: string; from_agent: string; to_agent: string }
  | { type: 'rate_limited'; dag_id: string; wait_seconds: number }
  | { type: 'master_timeout'; timeout_minutes: number }
  | { type: 'worker_timeout'; timeout_minutes: number }
  | { type: 'review_timeout'; timeout_minutes: number }
  | { type: 'question'; agent: string; content: string; plan_id?: string }
  | { type: 'question_answered'; agent: string }
  | { type: 'dispatch_error'; dag_id: string; error: string }
  | { type: 'info'; message: string };

export function handleOrchEvent(
  ev: OrchEvent,
  masterAgent: ToolName,
  subTaskQueue: string[],
  dagToFrontendId: Map<string, string>,
  dagCounter: number,
) {
  const store = useTaskStore.getState();
  type LogLevel = 'info' | 'success' | 'warn' | 'cmd' | 'error';
  const log = (level: LogLevel, message: string) =>
    store.addOrchestrationLog({ agent: masterAgent, level, message });

  switch (ev.type) {
    case 'phase_changed': {
      const phase = ev.phase;
      if (phase === 'decomposing') {
        store.setOrchestrationPhase('decomposing');
        log('cmd', `Phase 1: ${ev.detail || 'Decomposing'}`);
      } else if (phase === 'awaiting_approval') {
        store.setOrchestrationPhase('awaiting_approval');
        log('info', `${ev.task_count} sub-tasks ready for approval`);

        // Auto-approve if the setting is enabled
        if (useUIStore.getState().autoApprove) {
          const taskStore = useTaskStore.getState();
          const activePlan = taskStore.activePlan;
          if (activePlan) {
            // Use a short delay to ensure all task_assigned events have been processed
            // before scanning the store. This fixes the race condition where
            // awaiting_approval fires before task_assigned events populate the store.
            setTimeout(() => {
              const currentStore = useTaskStore.getState();
              const pendingWorkers: Array<{ agent: string; prompt: string; description: string; depends_on: string[] }> = [];
              for (const [, task] of currentStore.tasks) {
                if (task.role === 'worker' && task.status === 'pending') {
                  pendingWorkers.push({
                    agent: task.toolName,
                    prompt: task.prompt,
                    description: task.description,
                    depends_on: [],
                  });
                }
              }
              if (pendingWorkers.length > 0) {
                commands.approveOrchestration(activePlan.task_id, pendingWorkers)
                  .then((result) => {
                    if (result.status === 'error') {
                      console.error('Auto-approve failed:', result.error);
                      toast.error('Auto-approve failed');
                    } else {
                      toast.success(`Auto-approved ${pendingWorkers.length} task${pendingWorkers.length !== 1 ? 's' : ''}`);
                    }
                  })
                  .catch((err: unknown) => {
                    console.error('Auto-approve IPC failed:', err);
                    toast.error('Auto-approve failed');
                  });
              } else {
                // Fallback: approve with empty list — backend will use its own decomposition
                commands.approveOrchestration(activePlan.task_id, null)
                  .then((result) => {
                    if (result.status === 'error') {
                      console.error('Auto-approve fallback failed:', result.error);
                    } else {
                      toast.success('Auto-approved (using backend decomposition)');
                    }
                  })
                  .catch((err: unknown) => {
                    console.error('Auto-approve fallback IPC failed:', err);
                  });
              }
            }, 100);
          }
        }
      } else if (phase === 'executing') {
        store.setOrchestrationPhase('executing');
        // Move pending worker tasks to running
        const newTasks = new Map(store.tasks);
        for (const [id, task] of newTasks) {
          if (task.status === 'pending' && task.role === 'worker') {
            newTasks.set(id, { ...task, status: 'running', startedAt: Date.now() });
          }
        }
        useTaskStore.setState({ tasks: newTasks });
        log('cmd', `Phase 2: Executing ${ev.task_count ?? ''} sub-tasks in ${ev.wave_count ?? ''} wave(s)`);
      } else if (phase === 'reviewing') {
        store.setOrchestrationPhase('reviewing');
        log('cmd', `Phase 3: ${ev.detail || 'Reviewing'}`);
      }
      break;
    }

    case 'task_assigned': {
      const agent = ev.agent;
      const desc = ev.description;
      const prompt = ev.prompt || desc; // Full prompt from backend, fallback to description
      const subId = crypto.randomUUID();
      const phase2Already = store.orchestrationPhase === 'executing';
      store.addTask({
        taskId: subId,
        prompt,
        toolName: agent as ToolName,
        status: phase2Already ? 'running' : 'pending',
        description: desc.length > 60 ? desc.slice(0, 57) + '...' : desc,
        startedAt: phase2Already ? Date.now() : null,
        dependsOn: null,
        role: 'worker',
      });
      subTaskQueue.push(subId);
      dagToFrontendId.set(`t${dagCounter + 1}`, subId);
      log('info', `Assigned to ${agent}: ${desc}`);
      break;
    }

    case 'task_completed':
    case 'task_failed': {
      const status: TaskStatus = ev.type === 'task_completed' ? 'completed' : 'failed';
      const targetId = subTaskQueue.shift();
      if (targetId) {
        store.updateTaskStatus(targetId, status);
      }
      const summary = ev.summary || '';
      log(
        ev.type === 'task_completed' ? 'success' : 'error',
        `${ev.type === 'task_completed' ? 'Completed' : 'Failed'} (exit ${ev.exit_code}): ${summary.slice(0, 200)}`,
      );
      // Emit notification for task completion/failure
      emitOrchestrationNotification(
        ev.type === 'task_completed' ? 'success' : 'error',
        ev.type === 'task_completed' ? 'Task Completed' : 'Task Failed',
        summary.slice(0, 100) || undefined,
        targetId ? { label: 'View', taskId: targetId } : undefined,
      );
      break;
    }

    case 'wave_progress': {
      log('info', `\u27D0 Wave ${ev.current}/${ev.total}`);
      break;
    }

    case 'task_skipped': {
      const dagId = ev.dag_id;
      const frontendId = dagToFrontendId.get(dagId);
      if (frontendId) {
        store.updateTaskStatus(frontendId, 'blocked');
        const qIdx = subTaskQueue.indexOf(frontendId);
        if (qIdx !== -1) subTaskQueue.splice(qIdx, 1);
      }
      log('warn', `Skipping ${dagId}: ${ev.reason}`);
      break;
    }

    case 'task_retrying': {
      const dagId = ev.dag_id;
      const frontendId = dagToFrontendId.get(dagId);
      if (frontendId) {
        store.updateTaskStatus(frontendId, 'retrying');
        const qIdx = subTaskQueue.indexOf(frontendId);
        if (qIdx !== -1) subTaskQueue.splice(qIdx, 1);
        subTaskQueue.push(frontendId);
      }
      log('info', `Retrying ${dagId} (attempt ${ev.attempt}/${ev.max_retries})`);
      break;
    }

    case 'task_fallback': {
      const dagId = ev.dag_id;
      const newAgent = ev.to_agent;
      const frontendId = dagToFrontendId.get(dagId);
      if (frontendId) {
        const task = store.tasks.get(frontendId);
        if (task) {
          const newTasks = new Map(store.tasks);
          newTasks.set(frontendId, { ...task, toolName: newAgent as ToolName, status: 'falling_back' });
          useTaskStore.setState({ tasks: newTasks });
        }
      }
      log('info', `Falling back: ${dagId} reassigned from ${ev.from_agent} to ${newAgent}`);
      break;
    }

    case 'rate_limited': {
      log('warn', `Rate limited on ${ev.dag_id} — waiting ${ev.wait_seconds}s`);
      break;
    }

    case 'master_timeout':
    case 'worker_timeout':
    case 'review_timeout': {
      log('error', `${ev.type.replace('_', ' ')} after ${ev.timeout_minutes} minutes`);
      break;
    }

    case 'question': {
      log('info', `${ev.agent} asks: ${ev.content}`);
      // Set pending question so the UI shows the answer prompt
      if (ev.plan_id) {
        store.setPendingQuestion({
          questionId: `q-${Date.now()}`,
          sourceAgent: ev.agent,
          content: ev.content,
          planId: ev.plan_id,
        });
      }
      // Notify user — especially useful when app is in background
      emitOrchestrationNotification(
        'warning',
        `${ev.agent} has a question`,
        String(ev.content).slice(0, 100),
        { label: 'Answer' },
      );
      break;
    }

    case 'question_answered': {
      log('info', `Master answered ${ev.agent}'s question`);
      store.setPendingQuestion(null);
      break;
    }

    case 'dispatch_error': {
      log('error', `Dispatch failed for ${ev.dag_id}: ${ev.error}`);
      break;
    }

    case 'info': {
      log('info', ev.message);
      break;
    }
  }
}
