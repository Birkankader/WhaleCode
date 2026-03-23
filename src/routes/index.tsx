import { useEffect, useState, lazy, Suspense } from 'react';
import { Toaster } from 'sonner';
import { AppShell } from '../components/layout/AppShell';
import { WorkingView } from '../components/views/WorkingView';
import { ErrorBoundary } from '../components/shared/ErrorBoundary';
import { initMessengerListener, cleanupMessengerListener } from '../stores/messengerStore';
import { useUIStore } from '../stores/uiStore';

// Lazy-loaded views — only parsed when the user navigates to them
const UsageView = lazy(() => import('../components/views/UsageView').then(m => ({ default: m.UsageView })));
const CodeReviewView = lazy(() => import('../components/views/CodeReviewView').then(m => ({ default: m.CodeReviewView })));
const DoneView = lazy(() => import('../components/views/DoneView').then(m => ({ default: m.DoneView })));
const TaskDetail = lazy(() => import('../components/views/TaskDetail').then(m => ({ default: m.TaskDetail })));
const ApiKeySettings = lazy(() => import('../components/settings/ApiKeySettings').then(m => ({ default: m.ApiKeySettings })));
const GitView = lazy(() => import('../components/views/GitView').then(m => ({ default: m.GitView })));
const CodeView = lazy(() => import('../components/views/CodeView').then(m => ({ default: m.CodeView })));
const TaskApprovalView = lazy(() => import('../components/views/TaskApprovalView').then(m => ({ default: m.TaskApprovalView })));
const TerminalBottomPanel = lazy(() => import('../components/terminal/TerminalBottomPanel').then(m => ({ default: m.TerminalBottomPanel })));
import { useTaskStore } from '../stores/taskStore';
import { commands } from '../bindings';

const TOAST_STYLE = { background: '#13131f', border: '1px solid #252538', color: '#e2e8f0', fontSize: 12 } as const;

export function App() {
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setShowSetup = useUIStore((s) => s.setShowSetup);
  const developerMode = useUIStore((s) => s.developerMode);
  const selectedTaskId = useUIStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useUIStore((s) => s.setSelectedTaskId);
  const projectDir = useUIStore((s) => s.projectDir);

  useEffect(() => {
    void initMessengerListener();
    return () => cleanupMessengerListener();
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      commands.cleanupCompletedProcesses().catch(() => { /* fire-and-forget cleanup */ });

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
            // Skip orchestration tasks — their lifecycle is managed by handleOrchEvent,
            // not by process heartbeat. The master process gets killed after decomposition
            // but the task should stay 'running' until the orchestration completes.
            if (task.role === 'master' || task.role === 'worker') continue;
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

  // Auto-navigate to review when the review phase starts (diffs are ready, review agent active)
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  useEffect(() => {
    if (orchestrationPhase === 'reviewing') {
      setActiveView('review');
    }
  }, [orchestrationPhase, setActiveView]);

  // Startup cleanup: prune stale worktrees from previous crashed sessions (fire-and-forget)
  useEffect(() => {
    if (projectDir) {
      commands.cleanupWorktrees(projectDir).catch(() => { /* best-effort cleanup */ });
    }
  }, [projectDir]);

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
        toastOptions={{ style: TOAST_STYLE }}
        theme="dark"
      />
      <Suspense fallback={null}>
        <TaskApprovalView />
      </Suspense>
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
                  <Suspense fallback={null}><UsageView /></Suspense>
                </ErrorBoundary>
              )}
              {activeView === 'review' && (
                <ErrorBoundary fallbackLabel="Review failed to load">
                  <Suspense fallback={null}><CodeReviewView onDone={() => setActiveView('done')} /></Suspense>
                </ErrorBoundary>
              )}
              {activeView === 'done' && (
                <ErrorBoundary fallbackLabel="Done view failed to load">
                  <Suspense fallback={null}><DoneView onNew={() => { setShowSetup(true); setActiveView('kanban'); }} /></Suspense>
                </ErrorBoundary>
              )}
              {activeView === 'settings' && (
                <ErrorBoundary fallbackLabel="Settings failed to load">
                  <Suspense fallback={null}><ApiKeySettings /></Suspense>
                </ErrorBoundary>
              )}
              {activeView === 'git' && (
                <ErrorBoundary fallbackLabel="Git view failed to load">
                  <Suspense fallback={null}><GitView /></Suspense>
                </ErrorBoundary>
              )}
              {activeView === 'code' && (
                <ErrorBoundary fallbackLabel="Code view failed to load">
                  <Suspense fallback={null}><CodeView /></Suspense>
                </ErrorBoundary>
              )}
            </div>

            {isWorkingView && selectedTaskId && (
              <ErrorBoundary fallbackLabel="Task detail failed to load">
                <Suspense fallback={null}><TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} /></Suspense>
              </ErrorBoundary>
            )}
          </div>

          <Suspense fallback={null}>
            <TerminalBottomPanel
              open={terminalOpen}
              onToggle={() => setTerminalOpen(!terminalOpen)}
              devMode={developerMode}
            />
          </Suspense>
        </div>
      </AppShell>
    </>
  );
}
