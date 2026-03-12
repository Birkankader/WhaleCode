import { useMemo } from 'react';
import { Clock, CheckCircle, AlertCircle, GitMerge, Loader2, Play } from 'lucide-react';
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
  icon: React.ReactNode;
  color: string;
  bgColor: string;
}

const COLUMNS: KanbanColumnDef[] = [
  { status: 'backlog', label: 'Backlog', icon: <Clock className="w-3.5 h-3.5" />, color: 'text-zinc-400', bgColor: 'bg-zinc-800/50' },
  { status: 'in_progress', label: 'In Progress', icon: <Play className="w-3.5 h-3.5" />, color: 'text-blue-400', bgColor: 'bg-blue-900/20' },
  { status: 'review', label: 'Review', icon: <Loader2 className="w-3.5 h-3.5" />, color: 'text-amber-400', bgColor: 'bg-amber-900/20' },
  { status: 'merge_waiting', label: 'Merge Waiting', icon: <GitMerge className="w-3.5 h-3.5" />, color: 'text-purple-400', bgColor: 'bg-purple-900/20' },
  { status: 'done', label: 'Done', icon: <CheckCircle className="w-3.5 h-3.5" />, color: 'text-green-400', bgColor: 'bg-green-900/20' },
  { status: 'failed', label: 'Failed', icon: <AlertCircle className="w-3.5 h-3.5" />, color: 'text-red-400', bgColor: 'bg-red-900/20' },
];

const AGENT_COLORS: Record<ToolName, { bg: string; border: string; text: string; dot: string }> = {
  claude: { bg: 'bg-violet-500/10', border: 'border-violet-500/30', text: 'text-violet-400', dot: 'bg-violet-500' },
  gemini: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-400', dot: 'bg-blue-500' },
  codex: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400', dot: 'bg-emerald-500' },
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
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

interface KanbanCardProps {
  task: KanbanTask;
  onTaskClick?: (task: KanbanTask) => void;
  editable?: boolean;
  availableAgents?: ToolName[];
  onAgentChange?: (taskId: string, newAgent: ToolName) => void;
}

function KanbanCard({ task, onTaskClick, editable, availableAgents, onAgentChange }: KanbanCardProps) {
  const colors = AGENT_COLORS[task.assignedAgent];

  return (
    <div
      onClick={() => onTaskClick?.(task)}
      className={`group p-3 rounded-lg border ${colors.border} ${colors.bg} hover:brightness-110 transition-all cursor-pointer`}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <h4 className="text-xs font-medium text-zinc-200 leading-snug line-clamp-2">
          {task.title}
        </h4>
        {task.startedAt && (
          <span className="text-[10px] text-zinc-500 whitespace-nowrap shrink-0">
            {formatElapsed(task.startedAt, task.completedAt)}
          </span>
        )}
      </div>

      {task.description && task.description !== task.title && (
        <p className="text-[10px] text-zinc-500 line-clamp-2 mb-2 leading-relaxed">
          {task.description}
        </p>
      )}

      <div className="flex items-center justify-between">
        {editable && availableAgents && onAgentChange ? (
          <select
            value={task.assignedAgent}
            onChange={(e) => onAgentChange(task.id, e.target.value as ToolName)}
            onClick={(e) => e.stopPropagation()}
            className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${colors.bg} ${colors.text} border ${colors.border} bg-black/40 cursor-pointer`}
          >
            {availableAgents.map((agent) => (
              <option key={agent} value={agent}>
                {AGENT_LABELS[agent]}
              </option>
            ))}
          </select>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
            <span className={`text-[10px] font-medium ${colors.text}`}>
              {AGENT_LABELS[task.assignedAgent]}
            </span>
          </div>
        )}

        <span className="text-[10px] text-zinc-600 font-mono">
          #{task.id.slice(0, 6)}
        </span>
      </div>

      {task.outputPreview && (
        <div className="mt-2 p-1.5 rounded bg-black/30 border border-white/5 max-h-12 overflow-hidden">
          <p className="text-[9px] font-mono text-zinc-500 line-clamp-2">
            {task.outputPreview}
          </p>
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
    for (const col of COLUMNS) {
      map.set(col.status, []);
    }
    for (const task of tasks) {
      const list = map.get(task.status);
      if (list) list.push(task);
    }
    return map;
  }, [tasks]);

  // Only show columns that have tasks or are core columns
  const visibleColumns = COLUMNS.filter(
    (col) =>
      col.status === 'backlog' ||
      col.status === 'in_progress' ||
      col.status === 'done' ||
      (tasksByColumn.get(col.status)?.length ?? 0) > 0,
  );

  if (tasks.length === 0) {
    return (
      <div className={`flex items-center justify-center h-full text-zinc-600 text-sm ${className}`}>
        No tasks to display. Submit a prompt to begin orchestration.
      </div>
    );
  }

  return (
    <div className={`flex gap-3 h-full overflow-x-auto p-4 ${className}`}>
      {visibleColumns.map((col) => {
        const columnTasks = tasksByColumn.get(col.status) ?? [];

        return (
          <div
            key={col.status}
            className="flex flex-col min-w-[220px] max-w-[280px] flex-1 shrink-0"
          >
            {/* Column header */}
            <div className={`flex items-center gap-2 px-3 py-2 rounded-t-lg ${col.bgColor} border border-b-0 border-white/5`}>
              <span className={col.color}>{col.icon}</span>
              <span className={`text-xs font-semibold ${col.color}`}>{col.label}</span>
              <span className="ml-auto text-[10px] text-zinc-600 bg-black/30 px-1.5 py-0.5 rounded-full">
                {columnTasks.length}
              </span>
            </div>

            {/* Column body */}
            <div className="flex-1 overflow-y-auto space-y-2 p-2 rounded-b-lg border border-t-0 border-white/5 bg-black/20">
              {columnTasks.length === 0 ? (
                <div className="text-[10px] text-zinc-700 text-center py-4">
                  No tasks
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
