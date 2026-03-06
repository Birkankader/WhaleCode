import { useState, useEffect } from 'react';
import { useTaskStore, type ToolName, type TaskEntry } from '../../stores/taskStore';

function formatElapsed(startedAt: number | null): string {
  if (!startedAt) return '';
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function statusDotColor(status: TaskEntry['status']): string {
  switch (status) {
    case 'running':
      return 'bg-green-500';
    case 'pending':
    case 'routing':
    case 'waiting':
      return 'bg-yellow-500';
    case 'completed':
      return 'bg-zinc-500';
    case 'failed':
      return 'bg-red-500';
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
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          latestTask ? statusDotColor(latestTask.status) : 'bg-zinc-600'
        }`}
      />
      <span className="text-zinc-400 w-20 shrink-0">{displayName}</span>
      {latestTask && isActive ? (
        <>
          <span className="text-zinc-300 truncate flex-1">
            {latestTask.description}
          </span>
          {latestTask.status === 'running' && latestTask.startedAt && (
            <span className="text-zinc-500 shrink-0">
              {formatElapsed(latestTask.startedAt)}
            </span>
          )}
          {latestTask.status === 'waiting' && (
            <span className="text-yellow-500 shrink-0">waiting</span>
          )}
          {latestTask.status === 'pending' && (
            <span className="text-yellow-500 shrink-0">pending</span>
          )}
        </>
      ) : latestTask && (latestTask.status === 'completed' || latestTask.status === 'failed') ? (
        <>
          <span className="text-zinc-500 truncate flex-1">
            {latestTask.description}
          </span>
          <span className={`shrink-0 ${latestTask.status === 'completed' ? 'text-zinc-500' : 'text-red-400'}`}>
            {latestTask.status}
          </span>
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
      </div>
    </div>
  );
}
