import { useState, useEffect } from 'react';
import { useTaskStore, type ToolName, type TaskEntry } from '../../stores/taskStore';
import { Badge } from '../ui/badge';

function formatElapsed(startedAt: number | null): string {
  if (!startedAt) return '';
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function statusBadgeProps(status: TaskEntry['status']): { variant: 'default' | 'secondary' | 'destructive' | 'outline'; className?: string } {
  switch (status) {
    case 'running':
      return { variant: 'default', className: 'bg-green-600/30 text-green-400 border-green-600/30' };
    case 'pending':
    case 'routing':
    case 'waiting':
      return { variant: 'outline', className: 'text-yellow-400 border-yellow-600/30' };
    case 'completed':
      return { variant: 'secondary' };
    case 'review':
      return { variant: 'outline', className: 'text-amber-400 border-amber-600/30' };
    case 'failed':
      return { variant: 'destructive' };
  }
}

function ToolStatusRow({
  toolName,
  displayName,
}: {
  toolName: ToolName;
  displayName: string;
}) {
  const tasks = useTaskStore((s) => s.tasks);
  const [, setTick] = useState(0);

  // Find the latest task for this tool (most recent by startedAt, or last added)
  let latestTask: TaskEntry | undefined;
  for (const task of tasks.values()) {
    if (task.toolName === toolName) {
      if (
        !latestTask ||
        (task.startedAt ?? 0) > (latestTask.startedAt ?? 0)
      ) {
        latestTask = task;
      }
    }
  }

  const isActive = latestTask && (latestTask.status === 'running' || latestTask.status === 'pending' || latestTask.status === 'waiting');

  // Tick timer for elapsed time display
  useEffect(() => {
    if (!latestTask || latestTask.status !== 'running' || !latestTask.startedAt) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [latestTask?.taskId, latestTask?.status, latestTask?.startedAt]);

  return (
    <div className="flex items-center gap-2 text-xs font-mono">
      <span className="text-zinc-400 w-20 shrink-0">{displayName}</span>
      {latestTask && isActive ? (
        <>
          <span className="text-zinc-300 truncate flex-1">
            {latestTask.description}
          </span>
          <Badge {...statusBadgeProps(latestTask.status)}>
            {latestTask.status === 'running' && latestTask.startedAt
              ? formatElapsed(latestTask.startedAt)
              : latestTask.status}
          </Badge>
        </>
      ) : latestTask && (latestTask.status === 'completed' || latestTask.status === 'failed' || latestTask.status === 'review') ? (
        <>
          <span className="text-zinc-500 truncate flex-1">
            {latestTask.description}
          </span>
          <Badge {...statusBadgeProps(latestTask.status)}>
            {latestTask.status}
          </Badge>
        </>
      ) : (
        <span className="text-zinc-600 italic">Idle</span>
      )}
    </div>
  );
}

export function StatusPanel({ className }: { className?: string }) {
  const tasks = useTaskStore((s) => s.tasks);

  // Only show when at least one task exists
  if (tasks.size === 0) return null;

  return (
    <div className={className}>
      <div className="text-xs font-semibold text-zinc-400 mb-2">Tool Status</div>
      <div className="space-y-1.5">
        <ToolStatusRow toolName="claude" displayName="Claude Code" />
        <ToolStatusRow toolName="gemini" displayName="Gemini CLI" />
        <ToolStatusRow toolName="codex" displayName="Codex CLI" />
      </div>
    </div>
  );
}
