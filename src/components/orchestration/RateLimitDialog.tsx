import { useState, useCallback } from 'react';
import { C } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { useTaskStore, type ToolName } from '@/stores/taskStore';

/**
 * Modal dialog shown when an agent hits its rate limit during orchestration.
 * Lists remaining tasks and lets the user reassign each to a different agent,
 * wait for the rate limit to reset, or cancel the remaining tasks.
 */
export function RateLimitDialog() {
  const alert = useTaskStore((s) => s.rateLimitAlert);
  const setAlert = useTaskStore((s) => s.setRateLimitAlert);
  const [assignments, setAssignments] = useState<Map<string, ToolName>>(new Map());
  const [submitting, setSubmitting] = useState(false);

  if (!alert) return null;

  const agent = AGENTS[alert.agent];
  const otherAgents = alert.availableAgents.filter(a => a !== alert.agent);

  const getAssignment = (dagId: string) => assignments.get(dagId) ?? (otherAgents[0] || alert.agent);

  const handleAssignmentChange = (dagId: string, newAgent: ToolName) => {
    setAssignments(prev => {
      const next = new Map(prev);
      next.set(dagId, newAgent);
      return next;
    });
  };

  const handleReassignAll = (targetAgent: ToolName) => {
    const next = new Map<string, ToolName>();
    for (const task of alert.remainingTasks) {
      next.set(task.dagId, targetAgent);
    }
    setAssignments(next);
  };

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    try {
      // TODO: Backend command — reassign_tasks(plan_id, reassignments)
      // For now, log the reassignment and dismiss
      const reassignments = alert.remainingTasks.map(task => ({
        dag_id: task.dagId,
        new_agent: getAssignment(task.dagId),
      }));
      const store = useTaskStore.getState();
      store.addOrchestrationLog({
        agent: alert.agent,
        level: 'info',
        message: `Tasks reassigned: ${reassignments.map(r => `${r.dag_id} → ${r.new_agent}`).join(', ')}`,
      });
      setAlert(null);
    } catch (e) {
      console.error('Failed to reassign tasks:', e);
    } finally {
      setSubmitting(false);
    }
  }, [alert, assignments, setAlert]);

  const handleWait = useCallback(() => {
    // Dismiss dialog — backend will continue waiting for rate limit reset
    setAlert(null);
  }, [setAlert]);

  const handleCancel = useCallback(async () => {
    setSubmitting(true);
    try {
      // TODO: Backend command — cancel_orchestration(plan_id)
      const store = useTaskStore.getState();
      store.addOrchestrationLog({
        agent: alert.agent,
        level: 'warn',
        message: `Remaining tasks cancelled due to rate limit`,
      });
      setAlert(null);
    } catch (e) {
      console.error('Failed to cancel:', e);
    } finally {
      setSubmitting(false);
    }
  }, [alert, setAlert]);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
    >
      <div
        className="w-full max-w-lg rounded-2xl p-6 flex flex-col gap-4"
        style={{ background: C.panel, border: `1px solid ${C.border}` }}
      >
        {/* Header */}
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold text-white"
            style={{ background: agent?.gradient ?? C.surface }}
          >
            {agent?.letter ?? '?'}
          </div>
          <div>
            <h2 className="text-base font-semibold" style={{ color: C.textPrimary }}>
              Rate Limit Reached
            </h2>
            <p className="text-xs" style={{ color: C.textMuted }}>
              {agent?.label ?? alert.agent} has hit its rate limit.
              {alert.resetsAt && ` Resets at ${new Date(alert.resetsAt).toLocaleTimeString()}.`}
            </p>
          </div>
        </div>

        {/* Task list */}
        <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
          <div className="flex items-center justify-between px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.textMuted }}>
              {alert.remainingTasks.length} task{alert.remainingTasks.length > 1 ? 's' : ''} to reassign
            </span>
            {otherAgents.length > 0 && (
              <div className="flex gap-1">
                {otherAgents.map(a => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => handleReassignAll(a)}
                    className="text-[10px] px-2 py-0.5 rounded-md transition-colors"
                    style={{ background: C.surface, color: C.accent, border: `1px solid ${C.border}` }}
                  >
                    All → {AGENTS[a]?.label ?? a}
                  </button>
                ))}
              </div>
            )}
          </div>

          {alert.remainingTasks.map(task => (
            <div
              key={task.dagId}
              className="flex items-center gap-3 p-2.5 rounded-xl"
              style={{ background: C.surface, border: `1px solid ${C.border}` }}
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs truncate" style={{ color: C.textPrimary }}>
                  {task.description}
                </p>
              </div>
              <select
                value={getAssignment(task.dagId)}
                onChange={(e) => handleAssignmentChange(task.dagId, e.target.value as ToolName)}
                className="text-xs rounded-lg px-2 py-1 outline-none"
                style={{
                  background: C.panel,
                  color: C.textPrimary,
                  border: `1px solid ${C.border}`,
                }}
              >
                {alert.availableAgents.map(a => (
                  <option key={a} value={a} disabled={a === alert.agent}>
                    {AGENTS[a]?.label ?? a}{a === alert.agent ? ' (rate limited)' : ''}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between pt-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleWait}
              className="text-xs px-3 py-1.5 rounded-lg transition-colors"
              style={{ background: C.surface, color: C.textSecondary, border: `1px solid ${C.border}` }}
            >
              Wait for Reset
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={submitting}
              className="text-xs px-3 py-1.5 rounded-lg transition-colors"
              style={{ background: 'rgba(248,113,113,0.1)', color: C.red, border: `1px solid rgba(248,113,113,0.2)` }}
            >
              Cancel Tasks
            </button>
          </div>
          {otherAgents.length > 0 && (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="text-xs px-4 py-1.5 rounded-lg font-medium transition-colors"
              style={{ background: C.accent, color: '#fff' }}
            >
              {submitting ? 'Reassigning...' : 'Reassign & Continue'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
