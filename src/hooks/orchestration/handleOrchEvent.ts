import { useTaskStore, type ToolName, type TaskStatus, type WorktreeReviewEntry } from '../../stores/taskStore';
import { emitOrchestrationNotification } from '../../stores/notificationStore';
import { asToolName } from '../../lib/agents';

/* ── Structured orchestrator event handler ───────────────── */

export type OrchEvent =
  | { type: 'phase_changed'; phase: string; detail?: string; task_count?: number; wave_count?: number; plan_id?: string; master_agent?: string }
  | { type: 'task_assigned'; agent: string; description: string; prompt?: string; dag_id?: string }
  | { type: 'task_completed'; dag_id?: string; summary?: string; exit_code?: number }
  | { type: 'task_failed'; dag_id?: string; summary?: string; exit_code?: number; agent?: string; failure_reason?: string }
  | { type: 'decomposition_failed'; error: string }
  | { type: 'wave_progress'; current: number; total: number }
  | { type: 'task_skipped'; dag_id: string; reason: string }
  | { type: 'task_retrying'; dag_id: string; attempt: number; max_retries: number }
  | { type: 'task_fallback'; dag_id: string; from_agent: string; to_agent: string }
  | { type: 'rate_limited'; dag_id: string; wait_seconds: number }
  | { type: 'rate_limit_action_needed'; agent: string; remaining_tasks: Array<{ dag_id: string; description: string; prompt: string }>; available_agents: string[]; plan_id: string; resets_at?: string }
  | { type: 'master_timeout'; timeout_minutes: number }
  | { type: 'worker_timeout'; timeout_minutes: number }
  | { type: 'review_timeout'; timeout_minutes: number }
  | { type: 'question'; agent: string; content: string; plan_id?: string }
  | { type: 'question_answered'; agent: string }
  | { type: 'dispatch_error'; dag_id: string; error: string }
  | { type: 'worker_output'; dag_id: string; line: string }
  | { type: 'worker_started'; dag_id: string; process_id: string }
  | { type: 'diffs_ready'; diffs: Array<{ dag_id: string; branch_name: string; file_count: number; additions: number; deletions: number }> }
  | { type: 'info'; message: string };

const lastOutputUpdateByDag = new Map<string, number>();

export function handleOrchEvent(
  ev: OrchEvent,
  masterAgent: ToolName,
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
        lastOutputUpdateByDag.clear();
        store.setOrchestrationPhase('decomposing');
        // Set activePlan early from enriched event so it's available before awaiting_approval
        if (ev.plan_id) {
          store.setActivePlan({
            task_id: ev.plan_id,
            master_agent: ev.master_agent ? asToolName(ev.master_agent) : masterAgent,
            master_process_id: null,
          });
        }
        log('cmd', `Phase 1: ${ev.detail || 'Decomposing'}`);
      } else if (phase === 'awaiting_approval') {
        store.setOrchestrationPhase('awaiting_approval');
        log('info', `${ev.task_count} sub-tasks ready for approval`);
      } else if (phase === 'executing') {
        store.setOrchestrationPhase('executing');
        // Move pending worker tasks to 'waiting' (queued) — they'll transition
        // to 'running' when their worker_started event arrives from the backend
        for (const [id, task] of store.tasks) {
          if (task.status === 'pending' && task.role === 'worker') {
            store.updateTaskStatus(id, 'waiting');
          }
        }
        log('cmd', `Phase 2: Executing ${ev.task_count ?? ''} sub-tasks in ${ev.wave_count ?? ''} wave(s)`);
      } else if (phase === 'reviewing') {
        store.setOrchestrationPhase('reviewing');
        log('cmd', `Phase 3: ${ev.detail || 'Reviewing'}`);
      } else if (phase === 'completed') {
        store.setOrchestrationPhase('completed');
        // Mark master task as completed
        const currentTasks = useTaskStore.getState().tasks;
        for (const [id, t] of currentTasks) {
          if (t.role === 'master' && t.status !== 'completed') {
            store.updateTaskStatus(id, 'completed');
            break;
          }
        }
        log('success', 'Orchestration completed');
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
        toolName: asToolName(agent),
        status: phase2Already ? 'running' : 'pending',
        description: desc.length > 60 ? desc.slice(0, 57) + '...' : desc,
        startedAt: phase2Already ? Date.now() : null,
        dependsOn: null,
        role: 'worker',
      });
      dagToFrontendId.set(ev.dag_id ?? `t${dagCounter + 1}`, subId);
      log('info', `Assigned to ${agent}: ${desc}`);
      break;
    }

    case 'task_completed':
    case 'task_failed': {
      if (!ev.dag_id) {
        console.warn(`${ev.type} received without dag_id — cannot match to frontend task`);
      }
      const status: TaskStatus = ev.type === 'task_completed' ? 'completed' : 'failed';
      const targetId = ev.dag_id ? dagToFrontendId.get(ev.dag_id) : undefined;
      if (!targetId && ev.dag_id) {
        console.warn(`Unmatched dag_id in ${ev.type}: ${ev.dag_id}`);
      }
      if (targetId) {
        store.updateTaskStatus(targetId, status);
      }
      const summary = ev.summary || '';
      // Store failure detail on the task for inspection in TaskDetail
      if (ev.type === 'task_failed' && targetId && summary) {
        store.updateTaskResult(targetId, summary.slice(0, 500));
      }
      if (ev.type === 'task_failed') {
        // Log detailed failure info — agent, exit code, failure reason, and full summary
        const agent = (ev as { agent?: string }).agent || 'unknown';
        const reason = (ev as { failure_reason?: string }).failure_reason || '';
        log('error', `[${agent}] Failed (exit ${ev.exit_code})`);
        if (reason) log('error', `Failure reason: ${reason}`);
        if (summary) log('error', `Output:\n${summary.slice(0, 500)}`);
      } else {
        log('success', `Completed (exit ${ev.exit_code}): ${summary}`);
      }
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
      }
      log('warn', `Skipping ${dagId}: ${ev.reason}`);
      break;
    }

    case 'task_retrying': {
      const dagId = ev.dag_id;
      const frontendId = dagToFrontendId.get(dagId);
      if (frontendId) {
        store.updateTaskStatus(frontendId, 'retrying');
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
          newTasks.set(frontendId, { ...task, toolName: asToolName(newAgent), status: 'falling_back' });
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

    case 'rate_limit_action_needed': {
      const agent = asToolName(ev.agent);
      log('error', `${ev.agent} rate limit reached! ${ev.remaining_tasks.length} tasks remaining.`);
      store.setRateLimitAlert({
        agent,
        remainingTasks: ev.remaining_tasks.map(t => ({ dagId: t.dag_id, description: t.description, prompt: t.prompt })),
        availableAgents: ev.available_agents.map(a => asToolName(a)),
        planId: ev.plan_id,
        resetsAt: ev.resets_at,
      });
      emitOrchestrationNotification(
        'warning',
        `${ev.agent} Rate Limit Reached`,
        `${ev.remaining_tasks.length} tasks need reassignment`,
        { label: 'Review' },
      );
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

    case 'worker_output': {
      const frontendId = dagToFrontendId.get(ev.dag_id);
      if (frontendId) {
        const now = Date.now();
        const lastUpdate = lastOutputUpdateByDag.get(ev.dag_id) ?? 0;
        if (now - lastUpdate > 500) {
          lastOutputUpdateByDag.set(ev.dag_id, now);
          store.updateTaskOutputLine(frontendId, ev.line);
        }
      }
      break;
    }

    case 'worker_started': {
      const frontendId = dagToFrontendId.get(ev.dag_id);
      if (frontendId) {
        store.updateTaskStatus(frontendId, 'running');
      }
      break;
    }

    case 'diffs_ready': {
      const entries = new Map<string, WorktreeReviewEntry>();
      for (const d of ev.diffs) {
        entries.set(d.dag_id, {
          dagId: d.dag_id,
          branchName: d.branch_name,
          fileCount: d.file_count,
          additions: d.additions,
          deletions: d.deletions,
        });
      }
      store.setWorktreeEntries(entries);
      log('info', `Diffs ready: ${ev.diffs.length} worktrees`);
      break;
    }

    case 'decomposition_failed': {
      log('error', ev.error);
      // Use fresh state to find the master task
      const currentTasks = useTaskStore.getState().tasks;
      for (const [id, t] of currentTasks) {
        if (t.role === 'master') {
          store.updateTaskResult(id, ev.error);
          break;
        }
      }
      // Notify user about the fallback
      emitOrchestrationNotification(
        'warning',
        'Decomposition Failed',
        ev.error.slice(0, 120),
      );
      break;
    }
  }
}
