import { useState } from 'react';
import { Routes, Route } from 'react-router';
import { AppShell } from '../components/layout/AppShell';
import { ProcessPanel } from '../components/terminal/ProcessPanel';
import { WorktreeStatus } from '../components/WorktreeStatus';

export function AppRoutes() {
  const [projectDir, setProjectDir] = useState('');

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
              </div>

              {/* Main process panel */}
              <div className="flex-1 min-h-0">
                <ProcessPanel />
              </div>

              {/* Worktree status panel */}
              {projectDir && (
                <div className="shrink-0 border-t border-zinc-800 p-3">
                  <WorktreeStatus projectDir={projectDir} />
                </div>
              )}
            </div>
          </AppShell>
        }
      />
    </Routes>
  );
}
