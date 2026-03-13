import { useMemo, useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { C, STATUS } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import { useTaskStore, type TaskEntry, type ToolName } from '@/stores/taskStore';
import { useUIStore } from '@/stores/uiStore';
import { useTaskDispatch } from '@/hooks/useTaskDispatch';
import { EmptyState } from '@/components/shared/EmptyState';

/* ── Types ─────────────────────────────────────────────── */

interface KanbanViewProps {
  selectedTask: string | null;
  setSelectedTask: (id: string) => void;
}

type ColumnKey = 'queued' | 'running' | 'done';

interface ColumnDef {
  key: ColumnKey;
  label: string;
  statusKey: keyof typeof STATUS;
}

interface MappedTask {
  id: string;
  title: string;
  agent: ToolName;
  column: ColumnKey;
  startedAt: number | null;
  duration: string | null;
  progress: number | null;
  status: TaskEntry['status'];
  role?: 'master' | 'worker';
  resultSummary?: string;
}

/* ── Constants ─────────────────────────────────────────── */

const COLUMNS: ColumnDef[] = [
  { key: 'queued', label: 'Queued', statusKey: 'queued' },
  { key: 'running', label: 'In Progress', statusKey: 'running' },
  { key: 'done', label: 'Done', statusKey: 'done' },
];

/* ── Helpers ───────────────────────────────────────────── */

function mapColumn(status: TaskEntry['status']): ColumnKey {
  switch (status) {
    case 'pending':
    case 'routing':
    case 'waiting':
    case 'blocked':
      return 'queued';
    case 'running':
    case 'retrying':
    case 'falling_back':
    case 'failed':           // Failed stays in In Progress — user can retry
      return 'running';
    case 'completed':
    case 'review':
      return 'done';
    default:
      return 'queued';
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/* ── Sub-components ────────────────────────────────────── */

function StatusDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        display: 'inline-block',
        flexShrink: 0,
      }}
    />
  );
}

function Pill({ children, bg, color }: { children: React.ReactNode; bg: string; color: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 999,
        background: bg,
        color,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: 'Inter, sans-serif',
        lineHeight: '18px',
      }}
    >
      {children}
    </span>
  );
}

function PulsingDot({ color }: { color: string }) {
  const [opacity, setOpacity] = useState(1);
  useEffect(() => {
    const interval = setInterval(() => {
      setOpacity((prev) => (prev === 1 ? 0.3 : 1));
    }, 800);
    return () => clearInterval(interval);
  }, []);
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        display: 'inline-block',
        flexShrink: 0,
        opacity,
        transition: 'opacity 600ms ease',
      }}
    />
  );
}

function RoleBadge({ role }: { role: 'master' | 'worker' }) {
  const isMaster = role === 'master';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '1px 6px',
        borderRadius: 6,
        fontSize: 9,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        background: isMaster ? 'rgba(245,158,11,0.15)' : 'rgba(109,94,252,0.12)',
        color: isMaster ? '#f59e0b' : '#8b5cf6',
        flexShrink: 0,
      }}
    >
      {isMaster ? '\u2605' : '\u25CB'} {role}
    </span>
  );
}

function TaskCard({
  task,
  selected,
  onClick,
  onRetry,
}: {
  task: MappedTask;
  selected: boolean;
  onClick: () => void;
  onRetry?: (task: MappedTask) => void;
}) {
  const agent = AGENTS[task.agent];
  const isFailed = task.status === 'failed';
  const isRunning = task.column === 'running' && !isFailed;
  const isDone = task.column === 'done';
  const truncatedResult = task.resultSummary
    ? task.resultSummary.length > 120 ? task.resultSummary.slice(0, 117) + '...' : task.resultSummary
    : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="kanban-card-slide"
      style={{
        width: '100%',
        textAlign: 'left',
        padding: 14,
        borderRadius: 16,
        background: isFailed ? C.redBg : C.surface,
        border: `1.5px solid ${selected ? C.accent : isFailed ? '#ef4444' + '60' : isRunning ? C.amber + '60' : C.border}`,
        cursor: 'pointer',
        transition: 'all 150ms ease',
        opacity: task.status === 'blocked' ? 0.6 : 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        fontFamily: 'Inter, sans-serif',
      }}
    >
      {/* Title row with status indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {isRunning && <PulsingDot color={C.amber} />}
        {isDone && (
          <span style={{ fontSize: 12, flexShrink: 0 }}>{'\u2713'}</span>
        )}
        {isFailed && (
          <span style={{ fontSize: 12, flexShrink: 0, color: '#ef4444' }}>{'\u2717'}</span>
        )}
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: C.textPrimary,
            lineHeight: '20px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {task.title}
        </span>
      </div>

      {/* Agent row with role badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            background: agent.gradient,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            fontWeight: 700,
            color: '#fff',
            flexShrink: 0,
          }}
        >
          {agent.letter}
        </div>
        <span style={{ fontSize: 12, color: C.textSecondary }}>{AGENTS[task.agent].label}</span>
        {task.role && <RoleBadge role={task.role} />}
      </div>

      {/* Status badges for special states */}
      {task.status === 'blocked' && (
        <Pill bg="rgba(239,68,68,0.15)" color="#ef4444">
          <span style={{ fontSize: 10 }}>&#x1F512;</span> Blocked
        </Pill>
      )}
      {task.status === 'retrying' && (
        <Pill bg="rgba(245,158,11,0.15)" color="#f59e0b">
          <span style={{ fontSize: 10 }}>{'\u21BB'}</span> Retrying
        </Pill>
      )}
      {task.status === 'falling_back' && (
        <Pill bg="rgba(168,85,247,0.15)" color="#a855f7">
          <span style={{ fontSize: 10 }}>{'\u21C4'}</span> Reassigning
        </Pill>
      )}

      {/* Failed state — retry button */}
      {isFailed && onRetry && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRetry(task); }}
          style={{
            width: '100%',
            padding: '7px 12px',
            borderRadius: 10,
            background: 'rgba(239,68,68,0.12)',
            border: `1px solid rgba(239,68,68,0.3)`,
            color: '#f87171',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'Inter, sans-serif',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            transition: 'all 150ms ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(239,68,68,0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(239,68,68,0.12)';
          }}
        >
          {'\u21BB'} Retry
        </button>
      )}

      {/* Progress bar (running) */}
      {task.progress !== null && !isFailed && (
        <div
          style={{
            width: '100%',
            height: 4,
            borderRadius: 2,
            background: C.border,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${task.progress}%`,
              height: '100%',
              borderRadius: 2,
              background: C.amber,
              transition: 'width 300ms ease',
            }}
          />
        </div>
      )}

      {/* Result summary (done cards) */}
      {isDone && truncatedResult && (
        <div
          style={{
            fontSize: 11,
            lineHeight: '16px',
            color: C.textSecondary,
            padding: '8px 10px',
            borderRadius: 10,
            background: C.panel,
            border: `1px solid ${C.border}`,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 64,
            overflow: 'hidden',
          }}
        >
          {truncatedResult}
        </div>
      )}

      {/* Duration (done) */}
      {task.duration && (
        <span style={{ fontSize: 11, color: C.textMuted }}>{task.duration}</span>
      )}
    </button>
  );
}

/* ── Animation styles are defined in index.css ─────────── */

/* ── Main Component ────────────────────────────────────── */

export function KanbanView({ selectedTask, setSelectedTask }: KanbanViewProps) {
  const tasks = useTaskStore((s) => s.tasks);
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  const projectDir = useUIStore((s) => s.projectDir);
  const { dispatchTask } = useTaskDispatch();
  const { confirm, ConfirmDialogElement } = useConfirmDialog();

  // Force re-render every 5s so progress bars update
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(interval);
  }, []);

  // Retry: confirm, then dispatch a new task, then remove the old failed one
  const handleRetry = useCallback(async (failedTask: MappedTask) => {
    if (!projectDir) return;
    const taskState = useTaskStore.getState();
    const original = taskState.tasks.get(failedTask.id);
    if (!original) return;

    const ok = await confirm({
      title: 'Retry Task',
      description: `Retry "${original.description}" with ${AGENTS[original.toolName].label}?`,
      confirmLabel: 'Retry',
    });
    if (!ok) return;

    taskState.addOrchestrationLog({
      agent: original.toolName,
      level: 'info',
      message: `Retrying: ${original.description}`,
    });

    const newTaskId = await dispatchTask(original.prompt, projectDir, original.toolName);

    if (newTaskId) {
      useTaskStore.getState().removeTask(failedTask.id);
      const ts = useTaskStore.getState();
      const newTask = ts.tasks.get(newTaskId);
      if (newTask) {
        const newTasks = new Map(ts.tasks);
        newTasks.set(newTask.taskId, { ...newTask, role: 'worker' });
        useTaskStore.setState({ tasks: newTasks });
      }
      toast.success('Task retried');
    } else {
      toast.error('Retry failed');
    }
  }, [projectDir, dispatchTask, confirm]);

  const mapped: MappedTask[] = useMemo(() => {
    const result: MappedTask[] = [];
    for (const [, task] of tasks) {
      const col = mapColumn(task.status);
      const now = Date.now();
      const elapsed = task.startedAt ? now - task.startedAt : 0;
      const isRunning = col === 'running';
      const isDone = col === 'done';

      result.push({
        id: task.taskId,
        title: task.description || task.prompt.slice(0, 60),
        agent: task.toolName,
        column: col,
        startedAt: task.startedAt,
        duration: isDone && task.startedAt ? formatDuration(elapsed) : null,
        progress: isRunning ? Math.min(95, Math.floor((elapsed / 120_000) * 100)) : null,
        status: task.status,
        role: task.role,
        resultSummary: task.resultSummary,
      });
    }
    return result;
  }, [tasks]);

  const byColumn = useMemo(() => {
    const map: Record<ColumnKey, MappedTask[]> = { queued: [], running: [], done: [] };
    for (const t of mapped) {
      map[t.column].push(t);
    }
    return map;
  }, [mapped]);

  if (tasks.size === 0 && orchestrationPhase === 'idle') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <EmptyState
          icon={'\uD83D\uDCCB'}
          title="No tasks yet"
          description="Launch an orchestration to get started"
        />
      </div>
    );
  }

  return (
    <>
    {ConfirmDialogElement}
    <div
      style={{
        display: 'flex',
        gap: 16,
        height: '100%',
        padding: 20,
        fontFamily: 'Inter, sans-serif',
      }}
    >
      {COLUMNS.map((col) => {
        const items = byColumn[col.key];
        const st = STATUS[col.statusKey];

        return (
          <div
            key={col.key}
            style={{
              flex: 1,
              minWidth: 220,
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 20,
              border: `1px solid ${C.border}`,
              background: C.panel,
              overflow: 'hidden',
            }}
          >
            {/* Column header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '14px 16px',
                borderBottom: `1px solid ${C.border}`,
              }}
            >
              <StatusDot color={st.dot} />
              <span style={{ fontSize: 13, fontWeight: 600, color: st.text }}>{col.label}</span>
              <Pill bg={st.bg} color={st.text}>
                {items.length}
              </Pill>
            </div>

            {/* Cards */}
            <ScrollArea style={{ flex: 1, padding: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {items.length === 0 ? (
                  <div
                    style={{
                      padding: '24px 16px',
                      textAlign: 'center',
                      fontSize: 12,
                      color: C.textMuted,
                      border: `1.5px dashed ${C.border}`,
                      borderRadius: 14,
                    }}
                  >
                    {orchestrationPhase === 'idle'
                      ? 'No tasks'
                      : col.key === 'queued'
                        ? 'Waiting for sub-tasks...'
                        : col.key === 'running' && orchestrationPhase === 'decomposing'
                          ? 'Decomposing task...'
                          : 'No tasks'}
                  </div>
                ) : (
                  items.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      selected={selectedTask === task.id}
                      onClick={() => setSelectedTask(task.id)}
                      onRetry={task.status === 'failed' ? handleRetry : undefined}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        );
      })}
    </div>
    </>
  );
}
