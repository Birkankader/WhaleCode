import { useEffect, useState, useMemo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore } from '@/stores/taskStore';
import { useUIStore } from '@/stores/uiStore';
import { commands } from '@/bindings';
import { EmptyState } from '@/components/shared/EmptyState';

/* ── Types ─────────────────────────────────────────────── */

interface DoneViewProps {
  onNew: () => void;
}

interface CompletedTask {
  number: number;
  title: string;
  agent: string;
  role?: 'master' | 'worker';
  resultSummary?: string;
}

/* ── Helpers ───────────────────────────────────────────── */

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

/* ── Main Component ────────────────────────────────────── */

export function DoneView({ onNew }: DoneViewProps) {
  const tasks = useTaskStore((s) => s.tasks);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const projectDir = useUIStore((s) => s.projectDir);
  const [isGitRepo, setIsGitRepo] = useState(false);

  useEffect(() => {
    if (!projectDir) return;
    commands.gitStatus(projectDir).then((result) => {
      setIsGitRepo(result.status === 'ok');
    }).catch(() => {
      setIsGitRepo(false);
    });
  }, [projectDir]);

  const { allTasks, completedTasks, uniqueAgents, earliestStart } = useMemo(() => {
    const arr = Array.from(tasks.values());
    const completed = arr.filter(t => t.status === 'completed');
    const agents = new Set(arr.map(t => t.toolName));
    let earliest = Infinity;
    for (const t of arr) {
      if (t.startedAt !== null && t.startedAt < earliest) earliest = t.startedAt;
    }
    return { allTasks: arr, completedTasks: completed, uniqueAgents: agents, earliestStart: earliest === Infinity ? null : earliest };
  }, [tasks]);

  const totalDuration = earliestStart !== null
    ? Date.now() - earliestStart
    : 0;

  const stats = [
    { label: 'Tasks', value: String(allTasks.length) },
    { label: 'Completed', value: String(completedTasks.length) },
    { label: 'Total Time', value: formatDuration(totalDuration) },
    { label: 'Agents', value: String(uniqueAgents.size) },
  ];

  const completedList: CompletedTask[] = completedTasks.map((t, i) => ({
    number: i + 1,
    title: t.description || t.prompt.slice(0, 50),
    agent: t.toolName.charAt(0).toUpperCase() + t.toolName.slice(1),
    role: t.role,
    resultSummary: t.resultSummary,
  }));

  const allCompleted = completedTasks.length === allTasks.length && allTasks.length > 0;

  if (completedTasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <EmptyState
          icon={'\u2705'}
          title="No completed tasks"
          description="Completed tasks will appear here"
          action={{ label: 'New Orchestration', onClick: onNew }}
        />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col items-center px-7 py-12 font-[Inter,sans-serif]">
        {/* Checkmark icon */}
        <div className="w-20 h-20 rounded-3xl bg-wc-green-bg border-2 border-wc-green-border flex items-center justify-center mb-6">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
            <path
              d="M12 20l6 6 12-12"
              stroke="#4ade80"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        {/* Title */}
        <h2 className="text-[26px] font-bold text-wc-green m-0 mb-2">
          {allCompleted ? 'Orchestration Complete' : 'Session Summary'}
        </h2>
        <p className="text-sm text-wc-text-secondary m-0 mb-9">
          {allCompleted
            ? `All ${completedTasks.length} task${completedTasks.length !== 1 ? 's' : ''} completed.${isGitRepo ? ' Check the Git tab for any pending changes.' : ''}`
            : `${completedTasks.length} of ${allTasks.length} tasks completed.`}
        </p>

        {/* Stats grid */}
        <div className="grid grid-cols-4 gap-3 w-full max-w-[640px] mb-9">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="px-3 py-4 rounded-2xl bg-wc-surface border border-wc-border text-center"
            >
              <div className="text-[22px] font-bold text-wc-text-primary leading-[30px]">
                {stat.value}
              </div>
              <div className="text-[11px] text-wc-text-secondary mt-1">
                {stat.label}
              </div>
            </div>
          ))}
        </div>

        {/* Completed tasks table */}
        {completedList.length > 0 && (
          <div className="w-full max-w-[640px] rounded-[18px] border border-wc-green-border overflow-hidden mb-9">
            {/* Table header */}
            <div className="grid grid-cols-[48px_1fr_100px] gap-3 px-4 py-2.5 bg-wc-green-bg border-b border-wc-green-border text-[11px] font-semibold text-wc-green uppercase tracking-wide">
              <span>#</span>
              <span>Task</span>
              <span>Agent</span>
            </div>

            {/* Table rows */}
            {completedList.map((task) => (
              <div key={task.number} className="border-b border-wc-border">
                {/* Main row */}
                <div className="grid grid-cols-[48px_1fr_100px] gap-3 px-4 py-3 items-center">
                  <span className="text-xs font-semibold text-wc-green">
                    {task.number}
                  </span>
                  <div className="overflow-hidden">
                    <span className="text-[13px] text-wc-text-primary overflow-hidden text-ellipsis whitespace-nowrap block">
                      {task.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-wc-text-secondary">{task.agent}</span>
                    {task.role && (
                      <span
                        className={`text-[8px] font-bold uppercase px-1.5 py-px rounded tracking-tight ${
                          task.role === 'master'
                            ? 'bg-amber-500/15 text-amber-400'
                            : 'bg-violet-500/12 text-violet-400'
                        }`}
                      >
                        {task.role}
                      </span>
                    )}
                  </div>
                </div>
                {/* Result summary row */}
                {task.resultSummary && (
                  <div className="px-4 pb-3 pl-[60px]">
                    <div className="text-[11px] leading-4 text-wc-text-secondary p-2 px-3 rounded-[10px] bg-wc-surface border border-wc-border whitespace-pre-wrap break-words max-h-20 overflow-hidden">
                      {task.resultSummary.length > 300 ? task.resultSummary.slice(0, 297) + '...' : task.resultSummary}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onNew}
            className="px-6 py-2.5 rounded-[14px] bg-gradient-to-r from-[#6d5efc] to-[#8b5cf6] border-none text-white text-sm font-semibold cursor-pointer font-[Inter,sans-serif] shadow-[0_8px_24px_rgba(109,94,252,0.28)] transition-all duration-150 hover:brightness-110"
          >
            New Orchestration
          </button>
          {isGitRepo && (
            <button
              type="button"
              onClick={() => setActiveView('git')}
              className="px-6 py-2.5 rounded-[14px] bg-transparent border border-wc-border text-wc-text-secondary text-sm font-semibold cursor-pointer font-[Inter,sans-serif] transition-all duration-150 hover:bg-wc-surface-hover hover:border-wc-border-strong"
            >
              View Changes
            </button>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
