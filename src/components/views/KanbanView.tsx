import { useMemo, useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { ChevronUp, ChevronDown, AlertTriangle, RefreshCw, ArrowRightLeft, Trash2 } from 'lucide-react';
import { C, STATUS, LOG_COLOR } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import { useTaskStore, type TaskEntry, type ToolName } from '@/stores/taskStore';
import { useUIStore } from '@/stores/uiStore';
import { useTaskDispatch } from '@/hooks/useTaskDispatch';
import { removeTaskWithUndo } from '@/lib/undoableActions';
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
      className="inline-block rounded-full shrink-0"
      style={{ width: size, height: size, background: color }}
    />
  );
}

function Pill({ children, bg, color }: { children: React.ReactNode; bg: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold font-[Inter,sans-serif] leading-[18px]"
      style={{ background: bg, color }}
    >
      {children}
    </span>
  );
}

function PulsingDot({ color }: { color: string }) {
  return (
    <span
      className="animate-pulse inline-block w-2 h-2 rounded-full shrink-0"
      style={{ background: color }}
    />
  );
}

function RoleBadge({ role }: { role: 'master' | 'worker' }) {
  const isMaster = role === 'master';
  return (
    <span
      className={`inline-flex items-center gap-[3px] px-1.5 py-px rounded-md text-[9px] font-bold uppercase tracking-[0.04em] shrink-0 ${
        isMaster ? 'bg-amber-500/15 text-amber-500' : 'bg-violet-500/[0.12] text-violet-500'
      }`}
    >
      {isMaster ? '\u2605' : '\u25CB'} {role}
    </span>
  );
}

/** Indeterminate shimmer progress bar */
function IndeterminateProgress() {
  return (
    <div
      className="w-full h-1 rounded-sm overflow-hidden relative"
      style={{ background: C.border }}
    >
      <div
        className="shimmer-bar w-2/5 h-full rounded-sm absolute top-0 left-0"
        style={{ background: `linear-gradient(90deg, transparent, ${C.amber}, transparent)` }}
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
    <span className="text-[11px] font-[family-name:var(--font-mono)]" style={{ color: C.textMuted }}>
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
    <div ref={ref} className="relative flex-1">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="w-full py-1.5 px-2.5 rounded-lg bg-indigo-500/[0.08] border border-indigo-500/20 text-[11px] font-semibold font-[Inter,sans-serif] cursor-pointer flex items-center justify-center gap-[5px] transition-all duration-150 ease-in-out"
        style={{ color: C.accentText }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.15)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.08)'; }}
      >
        <ArrowRightLeft size={11} />
        Switch
      </button>

      {open && (
        <div
          className="absolute bottom-[calc(100%+4px)] left-0 right-0 rounded-[10px] overflow-hidden z-20 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
          style={{ background: C.panel, border: `1px solid ${C.borderStrong}` }}
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
                className="w-full flex items-center gap-2 py-2 px-2.5 bg-transparent border-none text-[11px] font-medium font-[Inter,sans-serif] cursor-pointer transition-[background] duration-150 ease-in-out"
                style={{ borderBottom: `1px solid ${C.border}`, color: C.textPrimary }}
                onMouseEnter={(e) => { e.currentTarget.style.background = C.surfaceHover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <div
                  className="w-[18px] h-[18px] rounded-[5px] flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                  style={{ background: info.gradient }}
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
  onDragStart,
  onDelete,
}: {
  task: MappedTask;
  selected: boolean;
  onClick: () => void;
  onRetry?: (task: MappedTask) => void;
  onSwitchAgent?: (task: MappedTask, newAgent: ToolName) => void;
  onDragStart?: (e: React.DragEvent, task: MappedTask) => void;
  onDelete?: (task: MappedTask) => void;
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
      draggable={!!onDragStart}
      onDragStart={(e) => onDragStart?.(e, task)}
      className={`kanban-card-slide${isFailed ? ' failed-card-shake' : ''} w-full text-left p-3.5 rounded-2xl cursor-pointer transition-all duration-150 ease-in-out flex flex-col gap-2.5 font-[Inter,sans-serif]`}
      style={{
        background: isFailed ? C.redBg : C.surface,
        border: `1.5px solid ${selected ? C.accent : isFailed ? '#ef4444' + '60' : isRunning ? C.amber + '60' : C.border}`,
        opacity: task.status === 'blocked' ? 0.6 : 1,
      }}
    >
      {/* Title row with status indicator */}
      <div className="flex items-center gap-2">
        {isRunning && <PulsingDot color={C.amber} />}
        {isDone && (
          <span className="text-xs shrink-0">{'\u2713'}</span>
        )}
        {isFailed && (
          <AlertTriangle size={14} color="#ef4444" className="shrink-0" />
        )}
        <span
          className="text-[13px] font-semibold leading-5 overflow-hidden text-ellipsis whitespace-nowrap flex-1"
          style={{ color: C.textPrimary }}
        >
          {task.title}
        </span>
      </div>

      {/* Agent row with role badge */}
      <div className="flex items-center gap-2">
        <div
          className="w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold text-white shrink-0"
          style={{ background: agent.gradient }}
        >
          {agent.letter}
        </div>
        <span className="text-xs" style={{ color: C.textSecondary }}>{AGENTS[task.agent].label}</span>
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
          <div className="flex gap-1.5">
            {onRetry && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRetry(task); }}
                className="flex-1 py-1.5 px-2.5 rounded-lg bg-red-500/[0.12] border border-red-500/30 text-red-400 text-[11px] font-semibold font-[Inter,sans-serif] cursor-pointer flex items-center justify-center gap-[5px] transition-all duration-150 ease-in-out"
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

            {onDelete && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(task); }}
                className="py-1.5 px-2.5 rounded-lg bg-red-500/[0.08] border border-red-500/20 text-red-400 text-[11px] font-semibold font-[Inter,sans-serif] cursor-pointer flex items-center justify-center gap-1 transition-all duration-150 ease-in-out"
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(239,68,68,0.18)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(239,68,68,0.08)';
                }}
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
        </>
      )}

      {/* Indeterminate progress bar + elapsed timer (running) */}
      {isRunning && (
        <div className="flex flex-col gap-1.5">
          <IndeterminateProgress />
          {task.startedAt && (
            <div className="flex items-center justify-between">
              <span className="text-[10px]" style={{ color: C.textMuted }}>Running</span>
              <ElapsedTimer startedAt={task.startedAt} />
            </div>
          )}
        </div>
      )}

      {/* Live output preview (running tasks only) */}
      {isRunning && task.lastOutputLine && (
        <div
          className="text-[10px] leading-[15px] font-[family-name:var(--font-mono)] py-1.5 px-2 rounded-lg overflow-hidden text-ellipsis whitespace-nowrap max-h-8 opacity-80"
          style={{ color: C.textMuted, background: C.bg, border: `1px solid ${C.border}` }}
        >
          {task.lastOutputLine}
        </div>
      )}

      {/* Result summary (done cards) */}
      {isDone && truncatedResult && (
        <div
          className="text-[11px] leading-4 py-2 px-2.5 rounded-[10px] whitespace-pre-wrap break-words max-h-16 overflow-hidden"
          style={{
            color: C.textSecondary,
            background: C.panel,
            border: `1px solid ${C.border}`,
          }}
        >
          {truncatedResult}
        </div>
      )}

      {/* Duration (done) */}
      {task.duration && (
        <span className="text-[11px]" style={{ color: C.textMuted }}>{task.duration}</span>
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

  // Drag & drop state
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<ColumnKey | null>(null);

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

  // Force re-render every second for elapsed timers (only when running tasks exist)
  const hasRunningTasks = useMemo(() => {
    for (const [, task] of tasks) {
      if (task.status === 'running') return true;
    }
    return false;
  }, [tasks]);

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasRunningTasks) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [hasRunningTasks]);

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

  // Delete a failed task (with undo)
  const handleDelete = useCallback((task: MappedTask) => {
    removeTaskWithUndo(task.id, task.title);
  }, []);

  // Drag & Drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, task: MappedTask) => {
    setDragTaskId(task.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, col: ColumnKey) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(col);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetCol: ColumnKey) => {
    e.preventDefault();
    setDropTarget(null);
    const taskId = dragTaskId || e.dataTransfer.getData('text/plain');
    setDragTaskId(null);
    if (!taskId) return;

    // Map column to task status
    const statusMap: Record<ColumnKey, string> = {
      queued: 'pending',
      running: 'running',
      done: 'completed',
    };
    const newStatus = statusMap[targetCol];
    if (!newStatus) return;

    const store = useTaskStore.getState();
    const task = store.tasks.get(taskId);
    if (!task) return;

    const currentCol = mapColumn(task.status);
    if (currentCol === targetCol) return;

    // Only allow valid transitions:
    // - completed/failed → queued (re-queue)
    // - pending → done (manually mark complete)
    const validTransitions: Record<string, string[]> = {
      queued: ['done', 'running'],   // from queued: can go to done
      running: [],                    // from running: cannot drag
      done: ['queued'],              // from done: can go back to queued
    };
    const allowedTargets = validTransitions[currentCol] ?? [];
    if (!allowedTargets.includes(targetCol)) {
      toast.error(`Cannot move ${currentCol} tasks to ${targetCol}`);
      return;
    }

    store.updateTaskStatus(taskId, newStatus as any);
    store.addOrchestrationLog({
      agent: task.toolName,
      level: 'info',
      message: `Task "${task.description}" moved to ${targetCol}`,
    });
  }, [dragTaskId]);

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
      <div className="flex items-center justify-center h-full">
        <EmptyState
          icon={'\uD83D\uDCCB'}
          title="No tasks yet"
          description="Launch an orchestration to get started"
          action={{ label: 'New Orchestration', onClick: () => useUIStore.getState().setShowSetup(true) }}
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
    <div className="flex flex-col h-full font-[Inter,sans-serif]">
      {/* Search & Filter bar */}
      <div
        className="flex items-center gap-2 py-2 px-5 shrink-0"
        style={{ borderBottom: `1px solid ${C.border}` }}
      >
        <div className="relative flex-1 max-w-[280px]">
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
      <div className="flex gap-4 flex-1 min-h-0 p-5">
        {COLUMNS.map((col) => {
          const items = filteredByColumn[col.key];
          const st = STATUS[col.statusKey];

          return (
            <div
              key={col.key}
              onDragOver={(e) => handleDragOver(e, col.key)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, col.key)}
              className="flex-1 min-w-[220px] flex flex-col rounded-[20px] overflow-hidden transition-[border-color,background] duration-150"
              style={{
                border: `1px solid ${dropTarget === col.key ? C.accent : C.border}`,
                background: dropTarget === col.key ? C.accentSoft : C.panel,
              }}
            >
              {/* Column header */}
              <div
                className="flex items-center gap-2 py-3.5 px-4"
                style={{ borderBottom: `1px solid ${C.border}` }}
              >
                <StatusDot color={st.dot} />
                <span style={{ fontSize: 13, fontWeight: 600, color: st.text }}>{col.label}</span>
                <Pill bg={st.bg} color={st.text}>
                  {items.length}
                </Pill>
              </div>

              {/* Cards */}
              <ScrollArea style={{ flex: 1, padding: 12 }}>
                <div className="flex flex-col gap-2.5">
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
                        onDelete={task.status === 'failed' ? handleDelete : undefined}
                        onDragStart={handleDragStart}
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
      <div className="shrink-0">
        {/* Toggle bar */}
        <button
          type="button"
          onClick={() => setLogPanelOpen((prev) => !prev)}
          className="w-full flex items-center gap-2 py-1.5 px-5 cursor-pointer font-[Inter,sans-serif]"
          style={{
            background: C.panel,
            borderTop: `1px solid ${C.border}`,
            borderBottom: logPanelOpen ? `1px solid ${C.border}` : 'none',
          }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: orchestrationPhase !== 'idle' ? C.amber : C.textMuted }}
          />
          <span className="text-[11px] font-semibold tracking-[0.02em]" style={{ color: C.textSecondary }}>
            Activity Log
          </span>
          {orchestrationLogs.length > 0 && (
            <span
              className="text-[10px] font-semibold px-1.5 py-px rounded-full"
              style={{ background: C.surface, color: C.textMuted }}
            >
              {orchestrationLogs.length}
            </span>
          )}
          <div className="flex-1" />
          {logPanelOpen ? (
            <ChevronDown size={14} style={{ color: C.textMuted }} />
          ) : (
            <ChevronUp size={14} style={{ color: C.textMuted }} />
          )}
        </button>

        {/* Expandable log content */}
        {logPanelOpen && (
          <div className="relative">
            {/* Resize handle */}
            <div
              onMouseDown={handleResizeMouseDown}
              className="absolute top-0 left-0 right-0 h-1 cursor-ns-resize z-10"
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
                      className="flex items-start gap-2 py-[3px] font-[family-name:var(--font-mono)] text-[11px] leading-[18px]"
                    >
                      <span className="shrink-0 w-14 text-[10px]" style={{ color: C.textMuted }}>
                        {log.timestamp}
                      </span>
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5"
                        style={{ background: dotColor }}
                      />
                      <span
                        className="w-4 h-4 rounded inline-flex items-center justify-center text-[8px] font-bold text-white shrink-0 mt-px"
                        style={{ background: agentInfo.gradient }}
                      >
                        {agentInfo.letter}
                      </span>
                      <span className="break-words" style={{ color: LOG_COLOR[log.level] ?? C.textPrimary }}>
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
