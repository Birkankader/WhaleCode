import { useMemo, type ReactNode } from 'react';
import { CheckCircle2, Clock3, GitMerge, Loader2, Play, XCircle } from 'lucide-react';
import type { ToolName } from '../../stores/taskStore';

export type KanbanStatus = 'backlog' | 'in_progress' | 'review' | 'merge_waiting' | 'done' | 'failed';

export interface KanbanTask {
  id: string;
  title: string;
  description: string;
  assignedAgent: ToolName;
  status: KanbanStatus;
  startedAt?: number;
  completedAt?: number;
  outputPreview?: string;
}

interface KanbanColumnDef {
  status: KanbanStatus;
  label: string;
  icon: ReactNode;
  color: string;
  surface: string;
}

const COLUMNS: KanbanColumnDef[] = [
  {
    status: 'backlog',
    label: 'Queued',
    icon: <Clock3 className="size-3.5" />,
    color: 'text-slate-300',
    surface: 'bg-slate-500/10 border-slate-400/14',
  },
  {
    status: 'in_progress',
    label: 'In Progress',
    icon: <Play className="size-3.5" />,
    color: 'text-amber-100',
    surface: 'bg-amber-500/10 border-amber-400/14',
  },
  {
    status: 'review',
    label: 'Review',
    icon: <Loader2 className="size-3.5" />,
    color: 'text-indigo-100',
    surface: 'bg-indigo-500/10 border-indigo-400/14',
  },
  {
    status: 'merge_waiting',
    label: 'Merge Waiting',
    icon: <GitMerge className="size-3.5" />,
    color: 'text-fuchsia-100',
    surface: 'bg-fuchsia-500/10 border-fuchsia-400/14',
  },
  {
    status: 'done',
    label: 'Done',
    icon: <CheckCircle2 className="size-3.5" />,
    color: 'text-emerald-100',
    surface: 'bg-emerald-500/10 border-emerald-400/14',
  },
  {
    status: 'failed',
    label: 'Failed',
    icon: <XCircle className="size-3.5" />,
    color: 'text-rose-100',
    surface: 'bg-rose-500/10 border-rose-400/14',
  },
];

const AGENT_STYLES: Record<ToolName, { dot: string; badge: string }> = {
  claude: {
    dot: 'bg-violet-400',
    badge: 'border-violet-400/20 bg-violet-500/10 text-violet-100',
  },
  gemini: {
    dot: 'bg-sky-400',
    badge: 'border-sky-400/20 bg-sky-500/10 text-sky-100',
  },
  codex: {
    dot: 'bg-emerald-400',
    badge: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100',
  },
};

const AGENT_LABELS: Record<ToolName, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
};

function formatElapsed(startedAt?: number, completedAt?: number): string {
  if (!startedAt) return '';
  const end = completedAt ?? Date.now();
  const seconds = Math.floor((end - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

interface KanbanCardProps {
  task: KanbanTask;
  onTaskClick?: (task: KanbanTask) => void;
  editable?: boolean;
  availableAgents?: ToolName[];
  onAgentChange?: (taskId: string, newAgent: ToolName) => void;
}

function KanbanCard({ task, onTaskClick, editable, availableAgents, onAgentChange }: KanbanCardProps) {
  const agentStyle = AGENT_STYLES[task.assignedAgent];

  return (
    <div
      onClick={() => onTaskClick?.(task)}
      className="rounded-[24px] border border-white/8 bg-[#0b0d16]/82 p-4 transition-all hover:-translate-y-0.5 hover:bg-[#101423] hover:shadow-[0_18px_40px_rgba(3,6,20,0.35)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium leading-6 text-slate-100">
            {task.title}
          </div>
          {task.description && task.description !== task.title && (
            <p className="mt-2 text-xs leading-6 text-slate-400">
              {task.description}
            </p>
          )}
        </div>
        {task.startedAt && (
          <div className="shrink-0 rounded-full border border-white/8 bg-white/[0.03] px-2 py-1 text-[11px] text-slate-400">
            {formatElapsed(task.startedAt, task.completedAt)}
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        {editable && availableAgents && onAgentChange ? (
          <select
            value={task.assignedAgent}
            onChange={(event) => onAgentChange(task.id, event.target.value as ToolName)}
            onClick={(event) => event.stopPropagation()}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${agentStyle.badge} bg-transparent`}
          >
            {availableAgents.map((agent) => (
              <option key={agent} value={agent}>
                {AGENT_LABELS[agent]}
              </option>
            ))}
          </select>
        ) : (
          <div className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] ${agentStyle.badge}`}>
            <span className={`size-2 rounded-full ${agentStyle.dot}`} />
            <span>{AGENT_LABELS[task.assignedAgent]}</span>
          </div>
        )}

        <span className="text-[11px] font-mono text-slate-500">
          #{task.id.slice(0, 6)}
        </span>
      </div>

      {task.outputPreview && (
        <div className="mt-4 rounded-[18px] border border-white/8 bg-white/[0.03] px-3 py-2 text-[11px] leading-5 text-slate-400">
          {task.outputPreview}
        </div>
      )}
    </div>
  );
}

interface KanbanBoardProps {
  tasks: KanbanTask[];
  onTaskClick?: (task: KanbanTask) => void;
  editable?: boolean;
  availableAgents?: ToolName[];
  onAgentChange?: (taskId: string, newAgent: ToolName) => void;
  className?: string;
}

export function KanbanBoard({
  tasks,
  onTaskClick,
  editable = false,
  availableAgents,
  onAgentChange,
  className = '',
}: KanbanBoardProps) {
  const tasksByColumn = useMemo(() => {
    const map = new Map<KanbanStatus, KanbanTask[]>();
    for (const column of COLUMNS) {
      map.set(column.status, []);
    }
    for (const task of tasks) {
      map.get(task.status)?.push(task);
    }
    return map;
  }, [tasks]);

  const visibleColumns = COLUMNS.filter(
    (column) =>
      column.status === 'backlog' ||
      column.status === 'in_progress' ||
      column.status === 'done' ||
      (tasksByColumn.get(column.status)?.length ?? 0) > 0,
  );

  if (tasks.length === 0) {
    return (
      <div className={`flex h-full items-center justify-center ${className}`}>
        <div className="rounded-[28px] border border-dashed border-white/10 bg-white/[0.02] px-6 py-8 text-center text-slate-400">
          Submit a prompt to generate the orchestration board.
        </div>
      </div>
    );
  }

  return (
    <div className={`flex h-full gap-4 overflow-x-auto p-5 ${className}`}>
      {visibleColumns.map((column) => {
        const columnTasks = tasksByColumn.get(column.status) ?? [];

        return (
          <div
            key={column.status}
            className="flex min-w-[260px] max-w-[320px] flex-1 shrink-0 flex-col"
          >
            <div className={`rounded-t-[28px] border px-4 py-4 ${column.surface}`}>
              <div className="flex items-center gap-2">
                <span className={column.color}>{column.icon}</span>
                <span className={`text-sm font-semibold ${column.color}`}>
                  {column.label}
                </span>
                <span className="ml-auto rounded-full border border-white/8 bg-white/[0.03] px-2 py-0.5 text-[11px] text-slate-400">
                  {columnTasks.length}
                </span>
              </div>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto rounded-b-[28px] border border-t-0 border-white/8 bg-[#10131d]/82 p-3">
              {columnTasks.length === 0 ? (
                <div className="rounded-[22px] border border-dashed border-white/8 px-4 py-6 text-center text-xs text-slate-500">
                  No tasks here yet.
                </div>
              ) : (
                columnTasks.map((task) => (
                  <KanbanCard
                    key={task.id}
                    task={task}
                    onTaskClick={onTaskClick}
                    editable={editable}
                    availableAgents={availableAgents}
                    onAgentChange={onAgentChange}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
