import { useState, useMemo, useCallback } from 'react';
import { Routes, Route } from 'react-router';
import { open } from '@tauri-apps/plugin-dialog';
import { AppShell } from '../components/layout/AppShell';
import { ProcessPanel } from '../components/terminal/ProcessPanel';
import { StatusPanel } from '../components/status/StatusPanel';
import { WorktreeStatus } from '../components/WorktreeStatus';
import { DiffReview } from '../components/review/DiffReview';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '../components/ui/resizable';
import { useTaskStore, type TaskEntry } from '../stores/taskStore';

export function AppRoutes() {
  const [projectDir, setProjectDir] = useState('');
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null);

  const handleBrowse = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      setProjectDir(selected);
    }
  }, []);

  // Find any task in 'review' status
  const tasks = useTaskStore((s) => s.tasks);
  const reviewTask: TaskEntry | undefined = useMemo(() => {
    for (const task of tasks.values()) {
      if (task.status === 'review') return task;
    }
    return undefined;
  }, [tasks]);

  // Compute branch name from taskId: whalecode/task/{first 8 chars}
  const reviewBranchName = useMemo(() => {
    if (!reviewTaskId) return null;
    return `whalecode/task/${reviewTaskId.slice(0, 8)}`;
  }, [reviewTaskId]);

  const handleReviewClose = () => {
    // Mark task as completed when review finishes
    if (reviewTaskId) {
      useTaskStore.getState().updateTaskStatus(reviewTaskId, 'completed');
    }
    setReviewTaskId(null);
  };

  return (
    <Routes>
      <Route
        path="/"
        element={
          <AppShell>
            <div className="flex flex-col h-full">
              {/* Project directory bar */}
              <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-zinc-900/60">
                <label
                  htmlFor="project-dir-input"
                  className="text-xs text-zinc-500 whitespace-nowrap"
                >
                  Project:
                </label>
                <input
                  id="project-dir-input"
                  type="text"
                  value={projectDir}
                  onChange={(e) => setProjectDir(e.target.value)}
                  placeholder="/path/to/project"
                  className="flex-1 px-2 py-1 text-xs font-mono rounded bg-zinc-800 text-zinc-300 border border-zinc-700 focus:border-zinc-500 focus:outline-none placeholder-zinc-600"
                />
                <button
                  onClick={handleBrowse}
                  className="px-2 py-1 text-xs rounded bg-zinc-800 text-zinc-400 border border-zinc-700 hover:bg-zinc-700 hover:text-zinc-300 transition-colors whitespace-nowrap"
                >
                  Browse
                </button>
              </div>

              {/* Status panel - shows when any task exists */}
              <StatusPanel className="shrink-0 px-3 py-2 border-b border-zinc-800 bg-zinc-900/40" />

              {/* Review Changes button when a task is in review status */}
              {reviewTask && !reviewTaskId && (
                <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-amber-900/20">
                  <span className="text-xs text-amber-300">
                    Task ready for review: {reviewTask.description}
                  </span>
                  <button
                    onClick={() => setReviewTaskId(reviewTask.taskId)}
                    className="ml-auto px-3 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
                  >
                    Review Changes
                  </button>
                </div>
              )}

              {/* Main content + worktree panel (resizable when project selected) */}
              {projectDir ? (
                <ResizablePanelGroup orientation="vertical" className="flex-1 min-h-0">
                  <ResizablePanel defaultSize={80} minSize={40}>
                    {reviewTaskId && reviewBranchName && projectDir ? (
                      <DiffReview
                        projectDir={projectDir}
                        branchName={reviewBranchName}
                        taskId={reviewTaskId}
                        onClose={handleReviewClose}
                      />
                    ) : (
                      <ProcessPanel projectDir={projectDir} />
                    )}
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel defaultSize={20} minSize={8} maxSize={40} collapsible collapsedSize={0}>
                    <WorktreeStatus projectDir={projectDir} />
                  </ResizablePanel>
                </ResizablePanelGroup>
              ) : (
                <div className="flex-1 min-h-0">
                  <ProcessPanel projectDir={projectDir} />
                </div>
              )}
            </div>
          </AppShell>
        }
      />
    </Routes>
  );
}
