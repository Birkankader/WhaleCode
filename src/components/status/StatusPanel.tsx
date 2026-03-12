import { useMemo } from 'react';
import { CheckCircle2, Clock3, Sparkles, XCircle } from 'lucide-react';
import { useTaskStore, type ToolName, type TaskEntry } from '../../stores/taskStore';

const TOOL_TONE: Record<ToolName, string> = {
  claude: 'text-violet-200 border-violet-400/20 bg-violet-500/10',
  gemini: 'text-sky-200 border-sky-400/20 bg-sky-500/10',
  codex: 'text-emerald-200 border-emerald-400/20 bg-emerald-500/10',
};

const TOOL_LABEL: Record<ToolName, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
};

function latestTaskForTool(tasks: TaskEntry[], toolName: ToolName): TaskEntry | undefined {
  return tasks
    .filter((task) => task.toolName === toolName)
    .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))[0];
}

export function StatusPanel({ className }: { className?: string }) {
  const taskMap = useTaskStore((s) => s.tasks);

  const { tasks, total, completed, failed, active, progress } = useMemo(() => {
    const entries = Array.from(taskMap.values());
    const completedCount = entries.filter((task) => task.status === 'completed').length;
    const failedCount = entries.filter((task) => task.status === 'failed').length;
    const activeCount = entries.filter((task) => ['running', 'pending', 'waiting', 'routing'].includes(task.status)).length;
    const totalCount = entries.length;

    return {
      tasks: entries,
      total: totalCount,
      completed: completedCount,
      failed: failedCount,
      active: activeCount,
      progress: totalCount === 0 ? 0 : Math.round((completedCount / totalCount) * 100),
    };
  }, [taskMap]);

  if (tasks.length === 0) return null;

  return (
    <div className={className}>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
        <div className="flex min-w-0 items-center gap-4">
          <div className="rounded-2xl border border-emerald-400/16 bg-emerald-500/10 px-3 py-2">
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-100">
              <CheckCircle2 className="size-4" />
              {completed}/{total} tasks done
            </div>
          </div>
          <div className="rounded-2xl border border-amber-400/16 bg-amber-500/10 px-3 py-2">
            <div className="flex items-center gap-2 text-xs font-medium text-amber-100">
              <Clock3 className="size-4" />
              {active} active
            </div>
          </div>
          <div className="rounded-2xl border border-rose-400/16 bg-rose-500/10 px-3 py-2">
            <div className="flex items-center gap-2 text-xs font-medium text-rose-100">
              <XCircle className="size-4" />
              {failed} failed
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-slate-400">
              <span>Session progress</span>
              <span>{progress}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/[0.05]">
              <div
                className="h-full rounded-full bg-[linear-gradient(90deg,#6366f1_0%,#8b5cf6_38%,#22c55e_100%)] transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(['claude', 'gemini', 'codex'] as ToolName[]).map((toolName) => {
              const latestTask = latestTaskForTool(tasks, toolName);
              return (
                <div
                  key={toolName}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${TOOL_TONE[toolName]}`}
                >
                  <Sparkles className="size-3.5" />
                  <span className="font-semibold">{TOOL_LABEL[toolName]}</span>
                  <span className="text-slate-300/70">
                    {latestTask ? latestTask.status : 'idle'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
