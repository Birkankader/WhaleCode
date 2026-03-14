import { useMemo } from 'react';
import { useUIStore, type AppView } from '@/stores/uiStore';
import { useTaskStore } from '@/stores/taskStore';
import { QuickTaskPopover } from './QuickTaskPopover';
import { NotificationCenter } from '@/components/shared/NotificationCenter';

/**
 * Content header bar with session info, view tabs, quick task button,
 * review notification, and dev mode toggle.
 */
export function ContentHeader() {
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const developerMode = useUIStore((s) => s.developerMode);
  const setDeveloperMode = useUIStore((s) => s.setDeveloperMode);
  const storedSessionName = useUIStore((s) => s.sessionName);
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  const activePlan = useTaskStore((s) => s.activePlan);

  const sessionName = storedSessionName || (activePlan ? 'Active Session' : 'No Session');
  const sessionStatus = orchestrationPhase === 'idle' ? 'idle' : 'running';
  const hasReviewReady = orchestrationPhase === 'reviewing' || orchestrationPhase === 'completed';
  const showTerminalTab = developerMode || orchestrationPhase !== 'idle';

  const tabs: { key: AppView; label: string; icon: string }[] = useMemo(() => [
    { key: 'kanban', label: 'Board', icon: '⊞' },
    ...(showTerminalTab ? [{ key: 'terminal' as const, label: 'Terminal', icon: '⌨' }] : []),
    { key: 'usage', label: 'Usage', icon: '◎' },
    { key: 'git', label: 'Git', icon: '⎇' },
    { key: 'code', label: 'Code', icon: '◈' },
  ], [showTerminalTab]);

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

      {/* Dev mode toggle */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-wc-text-muted">Dev</span>
        <button
          aria-label="Toggle developer mode"
          onClick={() => setDeveloperMode(!developerMode)}
          className={`w-8 h-4 rounded-full flex items-center px-0.5 transition-all shrink-0 ${
            developerMode ? 'bg-wc-accent' : 'bg-wc-border-strong'
          }`}
        >
          <div
            className="size-3 rounded-full bg-white transition-all"
            style={{ marginLeft: developerMode ? 'auto' : '0' }}
          />
        </button>
      </div>
    </div>
  );
}
