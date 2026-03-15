import { useMemo, useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { RefreshCw, Trash2 } from 'lucide-react';
import { C } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { useTaskStore, type TaskEntry } from '@/stores/taskStore';
import { useUIStore } from '@/stores/uiStore';
import { useTaskDispatch } from '@/hooks/useTaskDispatch';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import { EmptyState } from '@/components/shared/EmptyState';
import { removeTaskWithUndo } from '@/lib/undoableActions';
import { DecompositionErrorCard } from '@/components/orchestration/DecompositionErrorCard';

/* ── Types ─────────────────────────────────────────────── */

interface WorkingViewProps {
  selectedTask: string | null;
  setSelectedTask: (id: string) => void;
}

/* ── Helpers ───────────────────────────────────────────── */

function statusInfo(status: TaskEntry['status']) {
  switch (status) {
    case 'running':
    case 'retrying':
    case 'falling_back':
      return { dot: C.amber, label: 'Running', bg: C.amberBg };
    case 'completed':
    case 'review':
      return { dot: C.green, label: 'Done', bg: C.greenBg };
    case 'failed':
      return { dot: C.red, label: 'Failed', bg: C.redBg };
    case 'blocked':
      return { dot: C.red, label: 'Blocked', bg: C.redBg };
    default:
      return { dot: C.textMuted, label: 'Queued', bg: C.surface };
  }
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/* ── Main Component ────────────────────────────────────── */

export function WorkingView({ selectedTask, setSelectedTask }: WorkingViewProps) {
  const tasks = useTaskStore((s) => s.tasks);
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  const projectDir = useUIStore((s) => s.projectDir);
  const { dispatchTask } = useTaskDispatch();
  const { confirm, ConfirmDialogElement } = useConfirmDialog();

  // Search
  const [searchQuery, setSearchQuery] = useState('');

  // Force re-render every second for elapsed timers
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Build task list
  const taskList = useMemo(() => {
    const result: TaskEntry[] = [];
    for (const [, task] of tasks) {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!task.description.toLowerCase().includes(q) && !task.prompt.toLowerCase().includes(q)) continue;
      }
      result.push(task);
    }
    // Sort: running first, then pending, then completed, then failed
    const order: Record<string, number> = { running: 0, retrying: 0, falling_back: 0, pending: 1, routing: 1, waiting: 1, blocked: 2, review: 3, completed: 4, failed: 5 };
    result.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    return result;
  }, [tasks, searchQuery]);

  const runningCount = taskList.filter(t => t.status === 'running' || t.status === 'retrying').length;
  const completedCount = taskList.filter(t => t.status === 'completed').length;
  const failedCount = taskList.filter(t => t.status === 'failed').length;

  // Retry handler
  const handleRetry = useCallback(async (task: TaskEntry) => {
    if (!projectDir) return;
    const ok = await confirm({
      title: 'Retry Task',
      description: `Retry "${task.description}" with ${AGENTS[task.toolName].label}?`,
      confirmLabel: 'Retry',
    });
    if (!ok) return;
    useTaskStore.getState().addOrchestrationLog({ agent: task.toolName, level: 'info', message: `Retrying: ${task.description}` });
    const newTaskId = await dispatchTask(task.prompt, projectDir, task.toolName);
    if (newTaskId) {
      removeTaskWithUndo(task.taskId, task.description);
      toast.success('Task retried');
    } else {
      toast.error('Retry failed');
    }
  }, [projectDir, dispatchTask, confirm]);

  // Decomposition failure check
  const hasWorkerTasks = taskList.some((t) => t.role === 'worker');
  const isDecompositionFailure = orchestrationPhase === 'failed' && !hasWorkerTasks;

  if (tasks.size === 0 && orchestrationPhase === 'idle') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <EmptyState
          icon={'🐋'}
          title="Ready to orchestrate"
          description="Launch an orchestration to get started"
          action={{ label: 'New Orchestration', onClick: () => useUIStore.getState().setShowSetup(true) }}
        />
      </div>
    );
  }

  if (isDecompositionFailure) {
    return (
      <>
        {ConfirmDialogElement}
        <DecompositionErrorCard />
      </>
    );
  }

  return (
    <>
      {ConfirmDialogElement}
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'Inter, sans-serif' }}>
        {/* Header bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 20px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
          {/* Stats */}
          <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
            {runningCount > 0 && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: C.amber }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.amber }} />
                {runningCount} running
              </span>
            )}
            <span style={{ color: C.textMuted }}>{completedCount}/{taskList.length} done</span>
            {failedCount > 0 && (
              <span style={{ color: C.red }}>{failedCount} failed</span>
            )}
          </div>

          <div style={{ flex: 1 }} />

          {/* Search */}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter tasks..."
            style={{
              width: 200, padding: '5px 10px', borderRadius: 8,
              background: C.surface, border: `1px solid ${C.border}`,
              color: C.textPrimary, fontSize: 11, outline: 'none',
            }}
          />
        </div>

        {/* Task list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {taskList.map((task) => {
              const si = statusInfo(task.status);
              const isRunning = task.status === 'running' || task.status === 'retrying';
              const isFailed = task.status === 'failed';
              const isDone = task.status === 'completed';
              const isSelected = selectedTask === task.taskId;
              const elapsed = task.startedAt ? Date.now() - task.startedAt : 0;
              const agent = AGENTS[task.toolName];

              return (
                <button
                  key={task.taskId}
                  type="button"
                  onClick={() => setSelectedTask(task.taskId)}
                  style={{
                    width: '100%', textAlign: 'left',
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '12px 14px', borderRadius: 12,
                    background: isSelected ? C.accentSoft : isFailed ? C.redBg : C.surface,
                    border: `1px solid ${isSelected ? C.accent : isFailed ? 'rgba(239,68,68,0.3)' : C.border}`,
                    cursor: 'pointer', transition: 'all 120ms ease',
                    fontFamily: 'Inter, sans-serif',
                  }}
                >
                  {/* Status dot */}
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: si.dot, flexShrink: 0,
                    animation: isRunning ? 'heartbeatPulse 1.5s ease-in-out infinite' : 'none',
                  }} />

                  {/* Agent icon */}
                  <div style={{
                    width: 24, height: 24, borderRadius: 7,
                    background: agent.gradient,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 700, color: '#fff', flexShrink: 0,
                  }}>
                    {agent.letter}
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        fontSize: 13, fontWeight: 600, color: C.textPrimary,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {task.description || task.prompt.slice(0, 60)}
                      </span>
                      {task.role && (
                        <span style={{
                          fontSize: 8, fontWeight: 700, textTransform: 'uppercase', padding: '1px 5px',
                          borderRadius: 4, flexShrink: 0,
                          background: task.role === 'master' ? 'rgba(245,158,11,0.15)' : 'rgba(109,94,252,0.12)',
                          color: task.role === 'master' ? '#f59e0b' : '#8b5cf6',
                        }}>
                          {task.role}
                        </span>
                      )}
                    </div>
                    {/* Live output preview */}
                    {isRunning && task.lastOutputLine && (
                      <div style={{
                        fontSize: 10, color: C.textMuted, marginTop: 3,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        fontFamily: 'ui-monospace, monospace',
                      }}>
                        {task.lastOutputLine}
                      </div>
                    )}
                    {/* Result preview */}
                    {isDone && task.resultSummary && (
                      <div style={{
                        fontSize: 10, color: C.textSecondary, marginTop: 3,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {task.resultSummary.slice(0, 100)}
                      </div>
                    )}
                  </div>

                  {/* Right side — status + elapsed + actions */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {task.startedAt && (
                      <span style={{ fontSize: 10, color: C.textMuted, fontFamily: 'ui-monospace, monospace' }}>
                        {formatElapsed(elapsed)}
                      </span>
                    )}

                    {isFailed && (
                      <>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleRetry(task); }}
                          style={{
                            padding: '4px 8px', borderRadius: 6,
                            background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
                            color: '#f87171', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 3,
                          }}
                        >
                          <RefreshCw size={10} /> Retry
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); removeTaskWithUndo(task.taskId, task.description); }}
                          style={{
                            padding: '4px 6px', borderRadius: 6,
                            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                            color: '#f87171', fontSize: 10, cursor: 'pointer',
                            display: 'flex', alignItems: 'center',
                          }}
                        >
                          <Trash2 size={10} />
                        </button>
                      </>
                    )}

                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '2px 8px',
                      borderRadius: 999, background: si.bg, color: si.dot,
                    }}>
                      {si.label}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
