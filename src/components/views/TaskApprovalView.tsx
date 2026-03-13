import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { C } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { useTaskStore, type ToolName } from '@/stores/taskStore';
import { commands } from '@/bindings';

const AGENT_OPTIONS: ToolName[] = ['claude', 'gemini', 'codex'];

export function TaskApprovalView() {
  const tasks = useTaskStore((s) => s.tasks);
  const activePlan = useTaskStore((s) => s.activePlan);
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  const [approving, setApproving] = useState(false);

  // Get worker tasks that are pending approval
  const workerTasks = useMemo(() => {
    const workers: Array<{ id: string; description: string; agent: ToolName; removed: boolean }> = [];
    for (const [id, task] of tasks) {
      if (task.role === 'worker' && task.status === 'pending') {
        workers.push({ id, description: task.prompt, agent: task.toolName, removed: false });
      }
    }
    return workers;
  }, [tasks]);

  const [editedTasks, setEditedTasks] = useState<typeof workerTasks | null>(null);
  const displayTasks = editedTasks ?? workerTasks;

  // Sync when workerTasks change (initial load)
  if (editedTasks === null && workerTasks.length > 0) {
    setEditedTasks([...workerTasks]);
  }

  const handleAgentChange = useCallback((idx: number, newAgent: ToolName) => {
    setEditedTasks(prev => {
      if (!prev) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], agent: newAgent };
      // Also update in task store
      useTaskStore.getState().updateTaskAgent(next[idx].id, newAgent);
      return next;
    });
  }, []);

  const handleToggleRemove = useCallback((idx: number) => {
    setEditedTasks(prev => {
      if (!prev) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], removed: !next[idx].removed };
      return next;
    });
  }, []);

  const handleApprove = useCallback(async () => {
    if (!activePlan || approving) return;
    setApproving(true);
    try {
      // Remove tasks that were marked for removal
      const removedIds = displayTasks.filter(t => t.removed).map(t => t.id);
      for (const id of removedIds) {
        useTaskStore.getState().removeTask(id);
      }

      // Build modified task list for backend
      const modifiedTasks = displayTasks
        .filter(t => !t.removed)
        .map(t => ({
          agent: t.agent,
          prompt: t.description,
          description: t.description.length > 60 ? t.description.slice(0, 57) + '...' : t.description,
          depends_on: [] as string[],
        }));

      // Command auto-generated at runtime by tauri-specta
      await (commands as Record<string, Function>).approveOrchestration(activePlan.task_id, modifiedTasks);
      toast.success('Tasks approved — execution starting');
    } catch (e) {
      console.error('Approval failed:', e);
      toast.error('Approval failed');
    } finally {
      setApproving(false);
    }
  }, [activePlan, approving, displayTasks]);

  if (orchestrationPhase !== 'awaiting_approval' || displayTasks.length === 0) {
    return null;
  }

  const activeCount = displayTasks.filter(t => !t.removed).length;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        style={{
          width: 520,
          maxHeight: '80vh',
          borderRadius: 20,
          background: C.panel,
          border: `1px solid ${C.borderStrong}`,
          boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: `1px solid ${C.border}` }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: C.textPrimary }}>
            Review Sub-Tasks
          </h2>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: C.textSecondary, lineHeight: '18px' }}>
            The master agent decomposed your task into {displayTasks.length} sub-tasks.
            Review, reassign agents, or remove tasks before starting execution.
          </p>
        </div>

        {/* Task list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 24px' }}>
          {displayTasks.map((task, idx) => {
            const agent = AGENTS[task.agent];
            return (
              <div
                key={task.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 14px',
                  borderRadius: 12,
                  background: task.removed ? 'rgba(248,113,113,0.06)' : C.surface,
                  border: `1px solid ${task.removed ? 'rgba(248,113,113,0.2)' : C.border}`,
                  marginBottom: 8,
                  opacity: task.removed ? 0.5 : 1,
                  transition: 'all 150ms ease',
                }}
              >
                {/* Agent badge */}
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: agent.gradient,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    fontWeight: 700,
                    color: '#fff',
                    flexShrink: 0,
                  }}
                >
                  {agent.letter}
                </div>

                {/* Description */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12,
                      color: task.removed ? C.textMuted : C.textPrimary,
                      lineHeight: '18px',
                      textDecoration: task.removed ? 'line-through' : 'none',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {task.description}
                  </div>
                </div>

                {/* Agent selector */}
                {!task.removed && (
                  <select
                    value={task.agent}
                    onChange={(e) => handleAgentChange(idx, e.target.value as ToolName)}
                    style={{
                      padding: '4px 8px',
                      borderRadius: 8,
                      background: C.surfaceHover,
                      border: `1px solid ${C.border}`,
                      color: C.textSecondary,
                      fontSize: 11,
                      fontFamily: 'Inter, sans-serif',
                      cursor: 'pointer',
                      outline: 'none',
                      flexShrink: 0,
                    }}
                  >
                    {AGENT_OPTIONS.map(a => (
                      <option key={a} value={a}>{AGENTS[a].label}</option>
                    ))}
                  </select>
                )}

                {/* Remove toggle */}
                <button
                  type="button"
                  onClick={() => handleToggleRemove(idx)}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: task.removed ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)',
                    border: 'none',
                    color: task.removed ? C.green : C.red,
                    fontSize: 14,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    fontFamily: 'Inter, sans-serif',
                    transition: 'all 150ms ease',
                  }}
                  title={task.removed ? 'Restore task' : 'Remove task'}
                >
                  {task.removed ? '\u21B6' : '\u2715'}
                </button>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: `1px solid ${C.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: 12, color: C.textMuted }}>
            {activeCount} task{activeCount !== 1 ? 's' : ''} will execute
          </span>
          <button
            type="button"
            disabled={approving || activeCount === 0}
            onClick={handleApprove}
            style={{
              padding: '10px 28px',
              borderRadius: 12,
              background: approving || activeCount === 0 ? C.borderStrong : C.accent,
              border: 'none',
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              fontFamily: 'Inter, sans-serif',
              cursor: approving || activeCount === 0 ? 'not-allowed' : 'pointer',
              transition: 'all 150ms ease',
            }}
          >
            {approving ? 'Approving...' : `Approve & Start (${activeCount})`}
          </button>
        </div>
      </div>
    </div>
  );
}
