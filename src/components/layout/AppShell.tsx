import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { C } from '@/lib/theme';
import { Sidebar } from './Sidebar';
import { ContentHeader } from './ContentHeader';
import { QuestionBanner } from './QuestionBanner';
import { StatusBar } from './StatusBar';
import { useUIStore } from '@/stores/uiStore';
import { useTaskStore } from '@/stores/taskStore';
import { SetupPanel } from './SetupPanel';
import { useHotkeys } from '@/hooks/useHotkeys';
import { useOrchestrationLaunch } from '@/hooks/useOrchestrationLaunch';
import { StagePipeline } from '@/components/orchestration/StagePipeline';
import { DecomposingBanner } from '@/components/orchestration/DecomposingBanner';
import { CommandPalette } from '@/components/shared/CommandPalette';
import type { AppView } from '@/stores/uiStore';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const showSetup = useUIStore((s) => s.showSetup);
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  const tasks = useTaskStore((s) => s.tasks);
  const pendingQuestion = useTaskStore((s) => s.pendingQuestion);
  const activePlan = useTaskStore((s) => s.activePlan);
  const showQuickTask = useUIStore((s) => s.showQuickTask);
  const setShowQuickTask = useUIStore((s) => s.setShowQuickTask);
  const selectedTaskId = useUIStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useUIStore((s) => s.setSelectedTaskId);
  const { handleLaunch } = useOrchestrationLaunch();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Global keyboard shortcuts
  const viewShortcuts: [string, AppView][] = [
    ['1', 'kanban'],
    ['2', 'terminal'],
    ['3', 'usage'],
    ['4', 'review'],
    ['5', 'done'],
  ];

  const hotkeys = useMemo(
    () => [
      // Cmd+P — toggle command palette
      {
        key: 'p',
        meta: true,
        handler: (e: KeyboardEvent) => {
          e.preventDefault();
          setCommandPaletteOpen((v) => !v);
        },
      },
      // Cmd+K — toggle quick task modal
      {
        key: 'k',
        meta: true,
        handler: (e: KeyboardEvent) => {
          e.preventDefault();
          setShowQuickTask(!showQuickTask);
        },
      },
      // Cmd+1..5 — switch views
      ...viewShortcuts.map(([digit, view]) => ({
        key: digit,
        meta: true,
        handler: (e: KeyboardEvent) => {
          e.preventDefault();
          setActiveView(view);
        },
      })),
      // Escape — close task detail panel and quick task modal
      {
        key: 'Escape',
        handler: (_e: KeyboardEvent) => {
          if (showQuickTask) {
            setShowQuickTask(false);
          } else if (selectedTaskId) {
            setSelectedTaskId(null);
          }
        },
      },
    ],
    [showQuickTask, selectedTaskId, setShowQuickTask, setActiveView, setSelectedTaskId, commandPaletteOpen],
  );

  useHotkeys(hotkeys);

  // Session restore notification on mount (once only, StrictMode-safe)
  useEffect(() => {
    // Guard against StrictMode double-fire
    let alreadyFired = false;
    const timer = setTimeout(() => {
      if (alreadyFired) return;
      alreadyFired = true;
      const uiProjectDir = useUIStore.getState().projectDir;
      const taskCount = useTaskStore.getState().tasks.size;
      const phase = useTaskStore.getState().orchestrationPhase;
      // Only show restore toast if there are tasks AND orchestration was actually active
      // Don't show for stale sessions that were already completed/idle
      if (uiProjectDir && taskCount > 0 && phase !== 'idle' && phase !== 'completed') {
        toast.info('Session restored', {
          description: `${taskCount} task${taskCount === 1 ? '' : 's'} from previous session`,
          id: 'session-restored', // Prevents duplicate toasts
        });
      }
    }, 100); // Small delay to let persist hydration finish
    return () => clearTimeout(timer);
  }, []);

  // Derived state
  const doneTasks = Array.from(tasks.values()).filter((t) => t.status === 'completed').length;
  const totalTasks = tasks.size;

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ background: C.bg, color: C.textPrimary, fontFamily: "'Inter', system-ui, sans-serif" }}
    >
      <div className="flex flex-1 overflow-hidden relative">
        <Sidebar />

        {/* Content area */}
        <div className="flex flex-col flex-1 overflow-hidden" data-testid="main-content">
          <ContentHeader />

          {/* Pending question banner */}
          {pendingQuestion && activeView !== 'review' && (
            <QuestionBanner pendingQuestion={pendingQuestion} />
          )}

          {/* Stage pipeline (shown when orchestration is active) */}
          {orchestrationPhase !== 'idle' && <StagePipeline />}

          {/* Decomposing banner (shown during decomposing phase) */}
          {orchestrationPhase === 'decomposing' && <DecomposingBanner />}

          {/* Progress strip (only on kanban) */}
          {activeView === 'kanban' && (
            <div
              className="flex items-center gap-3 px-5 py-2 border-b flex-shrink-0 text-xs"
              style={{ borderColor: C.border, background: C.bg }}
            >
              <span style={{ color: C.textMuted }}>
                {doneTasks}/{totalTasks} tasks
              </span>
              <div
                className="flex-1 h-1 rounded-full overflow-hidden"
                style={{ background: C.borderStrong, maxWidth: 160 }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: totalTasks > 0 ? `${(doneTasks / totalTasks) * 100}%` : '0%',
                    background: `linear-gradient(90deg, ${C.accent}, ${C.green})`,
                  }}
                />
              </div>
              <div className="flex-1" />
              {activePlan && (
                <div className="flex items-center gap-1.5 text-xs" style={{ color: C.amber }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: C.amber }} />
                  Active
                </div>
              )}
            </div>
          )}

          {/* Main content */}
          {children}
        </div>

        {/* Setup overlay */}
        {showSetup && <SetupPanel onLaunch={handleLaunch} />}
      </div>

      <StatusBar />

      {/* Command Palette (Cmd+P) */}
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
    </div>
  );
}
