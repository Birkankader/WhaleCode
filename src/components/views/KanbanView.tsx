import { useMemo, useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { ChevronUp, ChevronDown, AlertTriangle, RefreshCw, ArrowRightLeft } from 'lucide-react';
import { C, STATUS, LOG_COLOR } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import { useTaskStore, type TaskEntry, type ToolName } from '@/stores/taskStore';
import { useUIStore } from '@/stores/uiStore';
import { useTaskDispatch } from '@/hooks/useTaskDispatch';
import { EmptyState } from '@/components/shared/EmptyState';
import { DecompositionErrorCard } from '@/components/orchestration/DecompositionErrorCard';

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
  prompt: string;
  agent: ToolName;
  column: ColumnKey;
  startedAt: number | null;
  duration: string | null;
  elapsedMs: number;
  status: TaskEntry['status'];
  role?: 'master' | 'worker';
  resultSummary?: string;
  lastOutputLine?: string;
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

function formatElapsedTimer(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
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

/** Indeterminate shimmer progress bar */
function IndeterminateProgress() {
  return (
    <div
      style={{
        width: '100%',
        height: 4,
        borderRadius: 2,
        background: C.border,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div
        className="shimmer-bar"
        style={{
          width: '40%',
          height: '100%',
          borderRadius: 2,
          background: `linear-gradient(90deg, transparent, ${C.amber}, transparent)`,
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      />
    </div>
  );
}

/** Elapsed timer that updates every second */
function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    const interval = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  return (
    <span style={{ fontSize: 11, color: C.textMuted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
      {formatElapsedTimer(elapsed)}
    </span>
  );
}

/** Inline agent switcher dropdown for failed card */
function AgentSwitcher({
  currentAgent,
  onSwitch,
}: {
  currentAgent: ToolName;
  onSwitch: (agent: ToolName) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const otherAgents = (Object.keys(AGENTS) as ToolName[]).filter((a) => a !== currentAgent);

  return (
    <div ref={ref} style={{ position: 'relative', flex: 1 }}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        style={{
          width: '100%',
          padding: '6px 10px',
          borderRadius: 8,
          background: 'rgba(99,102,241,0.08)',
          border: '1px solid rgba(99,102,241,0.2)',
          color: C.accentText,
          fontSize: 11,
          fontWeight: 600,
          fontFamily: 'Inter, sans-serif',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 5,
          transition: 'all 150ms ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.15)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.08)'; }}
      >
        <ArrowRightLeft size={11} />
        Switch
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            background: C.panel,
            border: `1px solid ${C.borderStrong}`,
            borderRadius: 10,
            overflow: 'hidden',
            zIndex: 20,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}
        >
          {otherAgents.map((agent) => {
            const info = AGENTS[agent];
            return (
              <button
                key={agent}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  onSwitch(agent);
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: `1px solid ${C.border}`,
                  color: C.textPrimary,
                  fontSize: 11,
                  fontWeight: 500,
                  fontFamily: 'Inter, sans-serif',
                  cursor: 'pointer',
                  transition: 'background 150ms ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = C.surfaceHover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <div
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 5,
                    background: info.gradient,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 9,
                    fontWeight: 700,
                    color: '#fff',
                    flexShrink: 0,
                  }}
                >
                  {info.letter}
                </div>
                {info.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TaskCard({
  task,
  selected,
  onClick,
  onRetry,
  onSwitchAgent,
}: {
  task: MappedTask;
  selected: boolean;
  onClick: () => void;
  onRetry?: (task: MappedTask) => void;
  onSwitchAgent?: (task: MappedTask, newAgent: ToolName) => void;
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
      className={`kanban-card-slide${isFailed ? ' failed-card-shake' : ''}`}
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
          <AlertTriangle size={14} color="#ef4444" style={{ flexShrink: 0 }} />
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

      {/* Failed state — error message + elapsed time + inline actions */}
      {isFailed && (
        <>
          {/* Error preview */}
          {task.resultSummary && (
            <div
              style={{
                fontSize: 11,
                lineHeight: '16px',
                color: '#fca5a5',
                padding: '7px 10px',
                borderRadius: 8,
                background: 'rgba(248,113,113,0.06)',
                border: '1px solid rgba(248,113,113,0.12)',
                wordBreak: 'break-word',
                maxHeight: 48,
                overflow: 'hidden',
              }}
            >
              {task.resultSummary.length > 80 ? task.resultSummary.slice(0, 77) + '...' : task.resultSummary}
            </div>
          )}

          {/* Failure time */}
          {task.startedAt && task.elapsedMs > 0 && (
            <span style={{ fontSize: 11, color: C.textMuted }}>
              Failed after {formatDuration(task.elapsedMs)}
            </span>
          )}

          {/* Inline action buttons */}
          <div style={{ display: 'flex', gap: 6 }}>
            {onRetry && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRetry(task); }}
                style={{
                  flex: 1,
                  padding: '6px 10px',
                  borderRadius: 8,
                  background: 'rgba(239,68,68,0.12)',
                  border: '1px solid rgba(239,68,68,0.3)',
                  color: '#f87171',
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: 'Inter, sans-serif',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 5,
                  transition: 'all 150ms ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(239,68,68,0.2)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(239,68,68,0.12)';
                }}
              >
                <RefreshCw size={11} />
                Retry
              </button>
            )}

            {onSwitchAgent && (
              <AgentSwitcher
                currentAgent={task.agent}
                onSwitch={(newAgent) => onSwitchAgent(task, newAgent)}
              />
            )}
          </div>
        </>
      )}

      {/* Indeterminate progress bar + elapsed timer (running) */}
      {isRunning && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <IndeterminateProgress />
          {task.startedAt && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 10, color: C.textMuted }}>Running</span>
              <ElapsedTimer startedAt={task.startedAt} />
            </div>
          )}
        </div>
      )}

      {/* Live output preview (running tasks only) */}
      {isRunning && task.lastOutputLine && (
        <div
          style={{
            fontSize: 10,
            lineHeight: '15px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: C.textMuted,
            padding: '6px 8px',
            borderRadius: 8,
            background: C.bg,
            border: `1px solid ${C.border}`,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxHeight: 32,
            opacity: 0.8,
          }}
        >
          {task.lastOutputLine}
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
  const orchestrationLogs = useTaskStore((s) => s.orchestrationLogs);
  const projectDir = useUIStore((s) => s.projectDir);
  const { dispatchTask } = useTaskDispatch();
  const { confirm, ConfirmDialogElement } = useConfirmDialog();

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterAgent, setFilterAgent] = useState<ToolName | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<ColumnKey | 'all'>('all');

  // Activity log panel state
  const [logPanelOpen, setLogPanelOpen] = useState(false);
  const [logPanelHeight, setLogPanelHeight] = useState(200);
  const logScrollRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // Auto-scroll log panel to bottom on new entries
  useEffect(() => {
    if (logPanelOpen && logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [orchestrationLogs.length, logPanelOpen]);

  // Resize handler for log panel
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeRef.current = { startY: e.clientY, startHeight: logPanelHeight };
    const handleMouseMove = (me: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.startY - me.clientY;
      setLogPanelHeight(Math.max(100, Math.min(500, resizeRef.current.startHeight + delta)));
    };
    const handleMouseUp = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [logPanelHeight]);

  // Force re-render every second for elapsed timers
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
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

  // Switch agent: dispatch with a different agent, remove old failed task
  const handleSwitchAgent = useCallback(async (failedTask: MappedTask, newAgent: ToolName) => {
    if (!projectDir) return;
    const taskState = useTaskStore.getState();
    const original = taskState.tasks.get(failedTask.id);
    if (!original) return;

    const ok = await confirm({
      title: 'Switch Agent & Retry',
      description: `Retry "${original.description}" with ${AGENTS[newAgent].label}?`,
      confirmLabel: 'Switch & Retry',
    });
    if (!ok) return;

    taskState.addOrchestrationLog({
      agent: newAgent,
      level: 'info',
      message: `Switching to ${AGENTS[newAgent].label} and retrying: ${original.description}`,
    });

    const newTaskId = await dispatchTask(original.prompt, projectDir, newAgent);

    if (newTaskId) {
      useTaskStore.getState().removeTask(failedTask.id);
      const ts = useTaskStore.getState();
      const newTask = ts.tasks.get(newTaskId);
      if (newTask) {
        const newTasks = new Map(ts.tasks);
        newTasks.set(newTask.taskId, { ...newTask, role: 'worker' });
        useTaskStore.setState({ tasks: newTasks });
      }
      toast.success(`Retried with ${AGENTS[newAgent].label}`);
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
      const isDone = col === 'done';

      result.push({
        id: task.taskId,
        title: task.description || task.prompt.slice(0, 60),
        prompt: task.prompt,
        agent: task.toolName,
        column: col,
        startedAt: task.startedAt,
        duration: isDone && task.startedAt ? formatDuration(elapsed) : null,
        elapsedMs: elapsed,
        status: task.status,
        role: task.role,
        resultSummary: task.resultSummary,
        lastOutputLine: task.lastOutputLine,
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

  // Apply search & filter
  const filteredByColumn = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const result: Record<ColumnKey, MappedTask[]> = { queued: [], running: [], done: [] };
    for (const col of ['queued', 'running', 'done'] as ColumnKey[]) {
      // Skip entire column if status filter is active and doesn't match
      if (filterStatus !== 'all' && filterStatus !== col) continue;
      for (const t of byColumn[col]) {
        // Agent filter
        if (filterAgent !== 'all' && t.agent !== filterAgent) continue;
        // Text search
        if (q && !t.title.toLowerCase().includes(q) && !t.prompt.toLowerCase().includes(q)) continue;
        result[col].push(t);
      }
    }
    return result;
  }, [byColumn, searchQuery, filterAgent, filterStatus]);

  const hasActiveFilters = searchQuery.trim() !== '' || filterAgent !== 'all' || filterStatus !== 'all';
  const filteredTotal = filteredByColumn.queued.length + filteredByColumn.running.length + filteredByColumn.done.length;

  // Check if this is a decomposition failure (no worker tasks)
  const hasWorkerTasks = mapped.some((t) => t.role === 'worker');
  const isDecompositionFailure = orchestrationPhase === 'failed' && !hasWorkerTasks;

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

  // Show DecompositionErrorCard instead of kanban when decomposition fails
  if (isDecompositionFailure) {
    return (
      <>
        {ConfirmDialogElement}
        <DecompositionErrorCard />
      </>
    );
  }

  // Visible log entries (last 100 for performance)
  const visibleLogs = useMemo(
    () => orchestrationLogs.slice(-100),
    [orchestrationLogs],
  );

  return (
    <>
    {ConfirmDialogElement}
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        fontFamily: 'Inter, sans-serif',
      }}
    >
      {/* Search & Filter bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 20px',
          borderBottom: `1px solid ${C.border}`,
          flexShrink: 0,
        }}
      >
        <div style={{ position: 'relative', flex: 1, maxWidth: 280 }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tasks..."
            style={{
              width: '100%',
              padding: '6px 10px 6px 28px',
              borderRadius: 8,
              background: C.surface,
              border: `1px solid ${C.border}`,
              color: C.textPrimary,
              fontSize: 12,
              outline: 'none',
            }}
          />
          <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: C.textMuted }}>
            🔍
          </span>
        </div>
        <select
          value={filterAgent}
          onChange={(e) => setFilterAgent(e.target.value as ToolName | 'all')}
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            background: C.surface,
            border: `1px solid ${C.border}`,
            color: filterAgent === 'all' ? C.textMuted : C.textPrimary,
            fontSize: 11,
            outline: 'none',
          }}
        >
          <option value="all">All Agents</option>
          <option value="claude">Claude</option>
          <option value="gemini">Gemini</option>
          <option value="codex">Codex</option>
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as ColumnKey | 'all')}
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            background: C.surface,
            border: `1px solid ${C.border}`,
            color: filterStatus === 'all' ? C.textMuted : C.textPrimary,
            fontSize: 11,
            outline: 'none',
          }}
        >
          <option value="all">All Status</option>
          <option value="queued">Queued</option>
          <option value="running">In Progress</option>
          <option value="done">Done</option>
        </select>
        {hasActiveFilters && (
          <button
            onClick={() => { setSearchQuery(''); setFilterAgent('all'); setFilterStatus('all'); }}
            style={{
              padding: '4px 10px',
              borderRadius: 8,
              background: C.accentSoft,
              color: C.accentText,
              fontSize: 10,
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Clear ({filteredTotal}/{mapped.length})
          </button>
        )}
      </div>

      {/* Kanban columns */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          flex: 1,
          minHeight: 0,
          padding: 20,
        }}
      >
        {COLUMNS.map((col) => {
          const items = filteredByColumn[col.key];
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
                        onSwitchAgent={task.status === 'failed' ? handleSwitchAgent : undefined}
                      />
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>
          );
        })}
      </div>

      {/* Activity Log Panel */}
      <div style={{ flexShrink: 0 }}>
        {/* Toggle bar */}
        <button
          type="button"
          onClick={() => setLogPanelOpen((prev) => !prev)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 20px',
            background: C.panel,
            borderTop: `1px solid ${C.border}`,
            borderBottom: logPanelOpen ? `1px solid ${C.border}` : 'none',
            cursor: 'pointer',
            fontFamily: 'Inter, sans-serif',
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: orchestrationPhase !== 'idle' ? C.amber : C.textMuted,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 11, fontWeight: 600, color: C.textSecondary, letterSpacing: '0.02em' }}>
            Activity Log
          </span>
          {orchestrationLogs.length > 0 && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: '1px 6px',
                borderRadius: 999,
                background: C.surface,
                color: C.textMuted,
              }}
            >
              {orchestrationLogs.length}
            </span>
          )}
          <div style={{ flex: 1 }} />
          {logPanelOpen ? (
            <ChevronDown size={14} style={{ color: C.textMuted }} />
          ) : (
            <ChevronUp size={14} style={{ color: C.textMuted }} />
          )}
        </button>

        {/* Expandable log content */}
        {logPanelOpen && (
          <div style={{ position: 'relative' }}>
            {/* Resize handle */}
            <div
              onMouseDown={handleResizeMouseDown}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: 4,
                cursor: 'ns-resize',
                zIndex: 10,
              }}
            />
            <ScrollArea
              ref={logScrollRef}
              style={{
                height: logPanelHeight,
                background: C.bg,
                padding: '8px 16px',
              }}
            >
              {visibleLogs.length === 0 ? (
                <div
                  style={{
                    padding: '20px 0',
                    textAlign: 'center',
                    fontSize: 12,
                    color: C.textMuted,
                  }}
                >
                  No activity yet. Logs will appear when orchestration starts.
                </div>
              ) : (
                visibleLogs.map((log) => {
                  const dotColor = LOG_COLOR[log.level] ?? C.textSecondary;
                  const agentInfo = AGENTS[log.agent];
                  return (
                    <div
                      key={log.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 8,
                        padding: '3px 0',
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        fontSize: 11,
                        lineHeight: '18px',
                      }}
                    >
                      <span style={{ color: C.textMuted, flexShrink: 0, width: 56, fontSize: 10 }}>
                        {log.timestamp}
                      </span>
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: dotColor,
                          flexShrink: 0,
                          marginTop: 6,
                        }}
                      />
                      <span
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 4,
                          background: agentInfo.gradient,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 8,
                          fontWeight: 700,
                          color: '#fff',
                          flexShrink: 0,
                          marginTop: 1,
                        }}
                      >
                        {agentInfo.letter}
                      </span>
                      <span style={{ color: LOG_COLOR[log.level] ?? C.textPrimary, wordBreak: 'break-word' }}>
                        {log.message}
                      </span>
                    </div>
                  );
                })
              )}
            </ScrollArea>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
