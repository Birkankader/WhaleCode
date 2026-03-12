import { useEffect } from 'react';
import { AppShell } from '../components/layout/AppShell';
import { KanbanView } from '../components/views/KanbanView';
import { TerminalView } from '../components/views/TerminalView';
import { UsageView } from '../components/views/UsageView';
import { CodeReviewView } from '../components/views/CodeReviewView';
import { DoneView } from '../components/views/DoneView';
import { TaskDetail } from '../components/views/TaskDetail';
import { ApiKeySettings } from '../components/settings/ApiKeySettings';
import { initMessengerListener, cleanupMessengerListener } from '../stores/messengerStore';
import { useUIStore } from '../stores/uiStore';
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
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <AppShell>
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden">
          {activeView === 'kanban' && (
            <KanbanView selectedTask={selectedTaskId} setSelectedTask={setSelectedTaskId} />
          )}
          {activeView === 'terminal' && <TerminalView devMode={developerMode} />}
          {activeView === 'usage' && <UsageView />}
          {activeView === 'review' && <CodeReviewView onDone={() => setActiveView('done')} />}
          {activeView === 'done' && (
            <DoneView
              onNew={() => {
                setShowSetup(true);
                setActiveView('kanban');
              }}
            />
          )}
          {activeView === 'settings' && <ApiKeySettings />}
        </div>

        {/* Task detail panel (only on kanban) */}
        {activeView === 'kanban' && selectedTaskId && (
          <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
        )}
      </div>
    </AppShell>
  );
}
