import { useMemo } from 'react';
import { LayoutGrid, Target, GitBranch, Code, ClipboardCheck, CheckCircle, Settings } from 'lucide-react';
import { useUIStore, type AppView } from '@/stores/uiStore';
import { useShallow } from 'zustand/react/shallow';
import { useTaskStore } from '@/stores/taskStore';
import { QuickTaskPopover } from './QuickTaskPopover';
import { NotificationCenter } from '@/components/shared/NotificationCenter';

/**
 * Content header bar with session info, view tabs, quick task button,
 * and review notification.
 */
export function ContentHeader() {
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const storedSessionName = useUIStore((s) => s.sessionName);
  const { tasks, orchestrationPhase, activePlan } = useTaskStore(
    useShallow((s) => ({ tasks: s.tasks, orchestrationPhase: s.orchestrationPhase, activePlan: s.activePlan })),
  );

  const sessionName = storedSessionName || (activePlan ? 'Active Session' : 'No Session');
  const sessionStatus = orchestrationPhase === 'idle' ? 'idle' : 'running';
  const hasReviewReady = orchestrationPhase === 'reviewing' || orchestrationPhase === 'completed';
  const hasActivity = tasks.size > 0 || orchestrationPhase !== 'idle';
  const hasCompletedTasks = Array.from(tasks.values()).some((t) => t.status === 'completed');

  const tabs: { key: AppView; label: string; icon: React.ReactNode }[] = useMemo(() => {
    const base: { key: AppView; label: string; icon: React.ReactNode }[] = [
      { key: 'kanban', label: 'Working', icon: <LayoutGrid size={14} /> },
    ];
    if (hasActivity) {
      base.push(
        { key: 'usage', label: 'Usage', icon: <Target size={14} /> },
        { key: 'git', label: 'Git', icon: <GitBranch size={14} /> },
        { key: 'code', label: 'Code', icon: <Code size={14} /> },
      );
    }
    // Dynamic Review tab when orchestration is reviewing or completed
    if (orchestrationPhase === 'reviewing' || orchestrationPhase === 'completed') {
      base.push({ key: 'review', label: 'Review', icon: <ClipboardCheck size={14} /> });
    }
    // Dynamic Done tab when orchestration completed or tasks finished
    if (orchestrationPhase === 'completed' || hasCompletedTasks) {
      base.push({ key: 'done', label: 'Done', icon: <CheckCircle size={14} /> });
    }
    // Settings always last
    base.push({ key: 'settings', label: 'Settings', icon: <Settings size={14} /> });
    return base;
  }, [hasActivity, orchestrationPhase, hasCompletedTasks]);

  return (
    <div className="flex items-center gap-0 border-b border-wc-border bg-wc-panel h-[44px] shrink-0 pl-1 pr-4">
      {/* Session name + status */}
      <div className="flex items-center gap-2.5 px-4 border-r border-wc-border mr-2 min-w-[180px]">
        <span className="relative inline-flex">
          <span
            className="size-2 rounded-full block"
            style={{ background: sessionStatus === 'running' ? 'var(--color-wc-amber)' : 'var(--color-wc-text-muted)' }}
          />
          {sessionStatus === 'running' && (
            <span className="absolute inset-0 rounded-full animate-ping bg-wc-amber opacity-40" />
          )}
        </span>
        <span className="text-sm font-semibold text-wc-text-primary">
          {sessionName}
        </span>
      </div>

      {/* Tabs */}
      <div className="flex items-center h-full" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={activeView === tab.key}
            onClick={() => setActiveView(tab.key)}
            className={`flex items-center gap-1.5 h-full px-4 text-xs font-medium border-b-2 transition-colors ${
              activeView === tab.key
                ? 'border-wc-accent text-wc-accent-text'
                : 'border-transparent text-wc-text-muted'
            }`}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Quick task button */}
      <QuickTaskPopover />

      <div className="flex-1" />

      {/* Notification center */}
      <NotificationCenter />

      {/* Review notification */}
      {hasReviewReady && activeView !== 'review' && activeView !== 'done' && (
        <button
          onClick={() => setActiveView('review')}
          className="mr-3 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all bg-wc-accent-soft text-wc-accent-text border border-wc-accent/25"
        >
          <span className="size-1.5 rounded-full bg-wc-accent" />
          Review
        </button>
      )}
    </div>
  );
}
