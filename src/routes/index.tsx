import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { AppShell } from '../components/layout/AppShell';
import { WorkingView } from '../components/views/WorkingView';
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
    const interval = setInterval(async () => {
      commands.cleanupCompletedProcesses().catch(() => {});

      // Heartbeat: ask backend which processes are actually running
      // and reconcile frontend task state
      try {
        const result = await commands.getRunningProcesses();
        if (result.status === 'ok') {
          const backendRunning = new Set(result.data);
          const taskState = useTaskStore.getState();
          const newTasks = new Map(taskState.tasks);
          let changed = false;
          for (const [id, task] of newTasks) {
            if ((task.status === 'running' || task.status === 'retrying') && !backendRunning.has(id)) {
              // Frontend thinks it's running, backend says it's not → mark failed
              newTasks.set(id, { ...task, status: 'failed' });
              changed = true;
            }
          }
          if (changed) useTaskStore.setState({ tasks: newTasks });
        }
      } catch { /* backend may not have this command yet */ }
    }, 5_000); // Every 5 seconds
    return () => clearInterval(interval);
  }, []);

  // Auto-navigate to review when orchestration completes
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  useEffect(() => {
    if (orchestrationPhase === 'reviewing' || orchestrationPhase === 'completed') {
      setActiveView('review');
    }
  }, [orchestrationPhase, setActiveView]);

  // Terminal panel state
  const [terminalOpen, setTerminalOpen] = useState(false);
  useEffect(() => {
    if (orchestrationPhase === 'decomposing' || orchestrationPhase === 'executing') {
      setTerminalOpen(true);
    }
  }, [orchestrationPhase]);

  // Primary view is 'kanban' internally but shows WorkingView
  const isWorkingView = activeView === 'kanban' || activeView === 'terminal';

  return (
    <>
      <Toaster
        position="bottom-right"
        toastOptions={{ style: { background: '#13131f', border: '1px solid #252538', color: '#e2e8f0', fontSize: 12 } }}
        theme="dark"
      />
      <TaskApprovalView />
      <AppShell>
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex flex-1 overflow-hidden min-h-0">
            <div className="flex-1 overflow-hidden">
              {isWorkingView && (
                <ErrorBoundary fallbackLabel="Working view failed to load">
                  <WorkingView selectedTask={selectedTaskId} setSelectedTask={setSelectedTaskId} />
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
                  <DoneView onNew={() => { setShowSetup(true); setActiveView('kanban'); }} />
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

            {isWorkingView && selectedTaskId && (
              <ErrorBoundary fallbackLabel="Task detail failed to load">
                <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
              </ErrorBoundary>
            )}
          </div>

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
