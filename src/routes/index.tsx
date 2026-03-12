import { useState, useCallback, useEffect, useMemo } from 'react';
import { Routes, Route } from 'react-router';
import { open } from '@tauri-apps/plugin-dialog';
import { AppShell } from '../components/layout/AppShell';
import { ProcessPanel } from '../components/terminal/ProcessPanel';
import { StatusPanel } from '../components/status/StatusPanel';
import { WorktreeStatus } from '../components/WorktreeStatus';
import { DiffReview } from '../components/review/DiffReview';
import { KanbanBoard, type KanbanTask } from '../components/orchestration/KanbanBoard';
import { UsagePanel } from '../components/usage/UsagePanel';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { initMessengerListener, cleanupMessengerListener } from '../stores/messengerStore';
import { useTaskStore } from '../stores/taskStore';
import type { ToolName } from '../stores/taskStore';
import { commands } from '../bindings';

function ProjectDirBar({ projectDir, setProjectDir, onBrowse }: {
  projectDir: string;
  setProjectDir: (dir: string) => void;
  onBrowse: () => void;
}) {
  return (
    <div className="shrink-0 flex items-center gap-3 px-6 py-3 border-b border-white/5 bg-black/20 backdrop-blur-md">
      <label
        htmlFor="project-dir-input"
        className="text-xs font-medium text-zinc-400 whitespace-nowrap"
      >
        Project:
      </label>
      <Input
        id="project-dir-input"
        type="text"
        value={projectDir}
        onChange={(e) => setProjectDir(e.target.value)}
        placeholder="/path/to/project"
        className="flex-1 h-8 font-mono text-xs bg-black/40 border-white/10 text-zinc-200 focus-visible:ring-violet-500/50"
      />
      <Button variant="outline" size="sm" onClick={onBrowse} className="bg-white/5 border-white/10 hover:bg-white/10 text-zinc-200 transition-colors">
        Browse
      </Button>
    </div>
  );
}

// Map task store entries to Kanban tasks
function useKanbanTasks(): KanbanTask[] {
  const tasks = useTaskStore((s) => s.tasks);
  return useMemo(() => {
    const kanbanTasks: KanbanTask[] = [];
    for (const [, task] of tasks) {
      let kanbanStatus: KanbanTask['status'];
      switch (task.status) {
        case 'pending':
        case 'routing':
          kanbanStatus = 'backlog';
          break;
        case 'running':
          kanbanStatus = 'in_progress';
          break;
        case 'review':
          kanbanStatus = 'review';
          break;
        case 'waiting':
          kanbanStatus = 'merge_waiting';
          break;
        case 'completed':
          kanbanStatus = 'done';
          break;
        case 'failed':
          kanbanStatus = 'failed';
          break;
        default:
          kanbanStatus = 'backlog';
      }
      kanbanTasks.push({
        id: task.taskId,
        title: task.description || task.prompt.slice(0, 60),
        description: task.prompt,
        assignedAgent: task.toolName,
        status: kanbanStatus,
        startedAt: task.startedAt ?? undefined,
      });
    }
    return kanbanTasks;
  }, [tasks]);
}

export function AppRoutes() {
  const [projectDir, setProjectDir] = useState('');
  const [reviewBranchName, setReviewBranchName] = useState<string | null>(null);

  useEffect(() => {
    initMessengerListener();
    return () => cleanupMessengerListener();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      commands.cleanupCompletedProcesses().catch(() => {});
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const handleBrowse = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      setProjectDir(selected);
    }
  }, []);

  const handleReviewClose = () => {
    setReviewBranchName(null);
  };

  const kanbanTasks = useKanbanTasks();
  const orchestrationPlan = useTaskStore((s) => s.orchestrationPlan);
  const availableAgents = useMemo(
    () => orchestrationPlan?.agents.map((a) => a.toolName) ?? (['claude'] as ToolName[]),
    [orchestrationPlan],
  );

  return (
    <Routes>
      <Route
        path="/"
        element={
          <AppShell>
            <div className="flex flex-col h-full">
              <ProjectDirBar projectDir={projectDir} setProjectDir={setProjectDir} onBrowse={handleBrowse} />
              <StatusPanel className="shrink-0 px-4 py-2 border-b border-white/5 bg-black/20" />
              <div className="flex-1 min-h-0">
                {reviewBranchName ? (
                  <DiffReview
                    projectDir={projectDir}
                    branchName={reviewBranchName}
                    taskId=""
                    onClose={handleReviewClose}
                  />
                ) : (
                  <ProcessPanel projectDir={projectDir} />
                )}
              </div>
            </div>
          </AppShell>
        }
      />
      <Route
        path="/kanban"
        element={
          <AppShell>
            <div className="flex flex-col h-full">
              <ProjectDirBar projectDir={projectDir} setProjectDir={setProjectDir} onBrowse={handleBrowse} />
              <StatusPanel className="shrink-0 px-4 py-2 border-b border-white/5 bg-black/20" />
              <div className="flex-1 min-h-0">
                <KanbanBoard
                  tasks={kanbanTasks}
                  availableAgents={availableAgents}
                />
              </div>
            </div>
          </AppShell>
        }
      />
      <Route
        path="/usage"
        element={
          <AppShell>
            <UsagePanel />
          </AppShell>
        }
      />
      <Route
        path="/worktrees"
        element={
          <AppShell>
            <div className="flex flex-col h-full">
              <ProjectDirBar projectDir={projectDir} setProjectDir={setProjectDir} onBrowse={handleBrowse} />
              <div className="flex-1 min-h-0 p-6 overflow-y-auto">
                <WorktreeStatus projectDir={projectDir} onReview={setReviewBranchName} />
              </div>
            </div>
          </AppShell>
        }
      />
    </Routes>
  );
}
