import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { AppShell } from '../components/layout/AppShell';
import { KanbanView } from '../components/views/KanbanView';
import { TerminalView } from '../components/views/TerminalView';
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
    }, 60 * 1000); // Every 60 seconds
    return () => clearInterval(interval);
  }, []);

  // If dev mode is turned off while on terminal view, fall back to kanban
  useEffect(() => {
    if (!developerMode && activeView === 'terminal') {
      setActiveView('kanban');
    }
  }, [developerMode, activeView, setActiveView]);

  // Auto-navigate to review when orchestration enters reviewing/completed phase
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  useEffect(() => {
    if (orchestrationPhase === 'reviewing' || orchestrationPhase === 'completed') {
      setActiveView('review');
    } else if (activeView === 'review' || activeView === 'done') {
      setActiveView('kanban');
    }
  }, [orchestrationPhase, activeView, setActiveView]);

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
        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-hidden">
            {activeView === 'kanban' && (
              <ErrorBoundary fallbackLabel="Board failed to load">
                <KanbanView selectedTask={selectedTaskId} setSelectedTask={setSelectedTaskId} />
              </ErrorBoundary>
            )}
            {activeView === 'terminal' && (
              <ErrorBoundary fallbackLabel="Terminal failed to load">
                <TerminalView devMode={developerMode} />
              </ErrorBoundary>
            )}
            {activeView === 'usage' && (
              <ErrorBoundary fallbackLabel="Usage view failed to load">
                <UsageView />
              </ErrorBoundary>
            )}
            {activeView === 'review' && (
              <ErrorBoundary fallbackLabel="Review failed to load">
                <CodeReviewView onDone={() => setActiveView('done')} />
              </ErrorBoundary>
            )}
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
            {activeView === 'settings' && (
              <ErrorBoundary fallbackLabel="Settings failed to load">
                <ApiKeySettings />
              </ErrorBoundary>
            )}
            {activeView === 'git' && (
              <ErrorBoundary fallbackLabel="Git view failed to load">
                <GitView />
              </ErrorBoundary>
            )}
            {activeView === 'code' && (
              <ErrorBoundary fallbackLabel="Code view failed to load">
                <CodeView />
              </ErrorBoundary>
            )}
          </div>

          {/* Task detail panel (only on kanban) */}
          {activeView === 'kanban' && selectedTaskId && (
            <ErrorBoundary fallbackLabel="Task detail failed to load">
              <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
            </ErrorBoundary>
          )}
        </div>
      </AppShell>
    </>
  );
}
