import { useState, useCallback } from 'react';
import { Routes, Route } from 'react-router';
import { open } from '@tauri-apps/plugin-dialog';
import { AppShell } from '../components/layout/AppShell';
import { ProcessPanel } from '../components/terminal/ProcessPanel';
import { StatusPanel } from '../components/status/StatusPanel';
import { WorktreeStatus } from '../components/WorktreeStatus';
import { DiffReview } from '../components/review/DiffReview';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';

export function AppRoutes() {
  const [projectDir, setProjectDir] = useState('');
  const [reviewBranchName, setReviewBranchName] = useState<string | null>(null);

  const handleBrowse = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      setProjectDir(selected);
    }
  }, []);

  const handleReviewClose = () => {
    setReviewBranchName(null);
  };

  return (
    <Routes>
      <Route
        path="/"
        element={
          <AppShell>
            <div className="flex flex-col h-full">
              {/* Project directory bar */}
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
                <Button variant="outline" size="sm" onClick={handleBrowse} className="bg-white/5 border-white/10 hover:bg-white/10 text-zinc-200 transition-colors">
                  Browse
                </Button>
              </div>

              {/* Status panel - shows when any task exists */}
              <StatusPanel className="shrink-0 px-4 py-2 border-b border-white/5 bg-black/20" />

              {/* Main content */}
              {projectDir ? (
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
              ) : (
                <div className="flex-1 min-h-0">
                  <ProcessPanel projectDir={projectDir} />
                </div>
              )}
            </div>
          </AppShell>
        }
      />
      <Route
        path="/worktrees"
        element={
          <AppShell>
            <div className="flex flex-col h-full">
              {/* Project directory bar */}
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
                <Button variant="outline" size="sm" onClick={handleBrowse} className="bg-white/5 border-white/10 hover:bg-white/10 text-zinc-200 transition-colors">
                  Browse
                </Button>
              </div>

              {/* Full height Worktree Status */}
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
