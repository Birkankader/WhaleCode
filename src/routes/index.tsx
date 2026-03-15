import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { AppShell } from '../components/layout/AppShell';
import { KanbanView } from '../components/views/KanbanView';
import { UsageView } from '../components/views/UsageView';
import { CodeReviewView } from '../components/views/CodeReviewView';
import { DoneView } from '../components/views/DoneView';
import { TaskDetail } from '../components/views/TaskDetail';
import { ApiKeySettings } from '../components/settings/ApiKeySettings';
import { GitView } from '../components/views/GitView';
import { CodeView } from '../components/views/CodeView';
import { TaskApprovalView } from '../components/views/TaskApprovalView';
import { ErrorBoundary } from '../components/shared/ErrorBoundary';
import { initMessengerListener, cleanupMessengerListener } from '../stores/messengerStore';
import { useUIStore } from '../stores/uiStore';
import { useTaskStore } from '../stores/taskStore';
import { commands } from '../bindings';
import { TerminalBottomPanel } from '../components/terminal/TerminalBottomPanel';

export function App() {
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setShowSetup = useUIStore((s) => s.setShowSetup);
  const developerMode = useUIStore((s) => s.developerMode);
  const selectedTaskId = useUIStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useUIStore((s) => s.setSelectedTaskId);

  useEffect(() => {
    void initMessengerListener();
    return () => cleanupMessengerListener();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      commands.cleanupCompletedProcesses().catch(() => {});
    }, 30 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Auto-navigate to review when orchestration completes
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  useEffect(() => {
    if (orchestrationPhase === 'reviewing' || orchestrationPhase === 'completed') {
      setActiveView('review');
    }
  }, [orchestrationPhase, setActiveView]);

  // If dev mode turned off while on terminal-only view, go to working
  useEffect(() => {
    if (!developerMode && activeView === 'terminal') {
      setActiveView('kanban');
    }
  }, [developerMode, activeView, setActiveView]);

  // Terminal panel state (VS Code-style bottom panel)
  const [terminalOpen, setTerminalOpen] = useState(false);

  // Auto-open terminal when orchestration starts
  useEffect(() => {
    if (orchestrationPhase === 'decomposing' || orchestrationPhase === 'executing') {
      setTerminalOpen(true);
    }
  }, [orchestrationPhase]);

  return (
    <>
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: '#13131f',
            border: '1px solid #252538',
            color: '#e2e8f0',
            fontSize: 12,
          },
        }}
        theme="dark"
      />
      <TaskApprovalView />
      <AppShell>
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Main content area */}
          <div className="flex flex-1 overflow-hidden min-h-0">
            <div className="flex-1 overflow-hidden">
              {/* Working view — Kanban board (primary view) */}
              {(activeView === 'kanban' || activeView === 'terminal') && (
                <ErrorBoundary fallbackLabel="Board failed to load">
                  <KanbanView selectedTask={selectedTaskId} setSelectedTask={setSelectedTaskId} />
                </ErrorBoundary>
              )}

              {/* Usage — token/cost tracking */}
              {activeView === 'usage' && (
                <ErrorBoundary fallbackLabel="Usage view failed to load">
                  <UsageView />
                </ErrorBoundary>
              )}

              {/* Review — shown automatically when orchestration completes */}
              {activeView === 'review' && (
                <ErrorBoundary fallbackLabel="Review failed to load">
                  <CodeReviewView onDone={() => setActiveView('done')} />
                </ErrorBoundary>
              )}

              {/* Done — completion summary */}
              {activeView === 'done' && (
                <ErrorBoundary fallbackLabel="Done view failed to load">
                  <DoneView
                    onNew={() => {
                      setShowSetup(true);
                      setActiveView('kanban');
                    }}
                  />
                </ErrorBoundary>
              )}

              {/* Settings */}
              {activeView === 'settings' && (
                <ErrorBoundary fallbackLabel="Settings failed to load">
                  <ApiKeySettings />
                </ErrorBoundary>
              )}

              {/* Git */}
              {activeView === 'git' && (
                <ErrorBoundary fallbackLabel="Git view failed to load">
                  <GitView />
                </ErrorBoundary>
              )}

              {/* Code browser */}
              {activeView === 'code' && (
                <ErrorBoundary fallbackLabel="Code view failed to load">
                  <CodeView />
                </ErrorBoundary>
              )}
            </div>

            {/* Task detail side panel */}
            {activeView === 'kanban' && selectedTaskId && (
              <ErrorBoundary fallbackLabel="Task detail failed to load">
                <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
              </ErrorBoundary>
            )}
          </div>

          {/* Terminal bottom panel — VS Code style, always available */}
          <TerminalBottomPanel
            open={terminalOpen}
            onToggle={() => setTerminalOpen(!terminalOpen)}
            devMode={developerMode}
          />
        </div>
      </AppShell>
    </>
  );
}
