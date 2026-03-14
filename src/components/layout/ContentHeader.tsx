import { useMemo } from 'react';
import { C } from '@/lib/theme';
import { useUIStore, type AppView } from '@/stores/uiStore';
import { useTaskStore } from '@/stores/taskStore';
import { QuickTaskPopover } from './QuickTaskPopover';

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
    <div
      className="flex items-center gap-0 border-b flex-shrink-0 pl-1 pr-4"
      style={{ borderColor: C.border, background: C.panel, height: 44 }}
    >
      {/* Session name + status */}
      <div
        className="flex items-center gap-2.5 px-4 border-r mr-2"
        style={{ borderColor: C.border, minWidth: 180 }}
      >
        <span className="relative inline-flex">
          <span
            className="w-2 h-2 rounded-full block"
            style={{ background: sessionStatus === 'running' ? C.amber : C.textMuted }}
          />
          {sessionStatus === 'running' && (
            <span
              className="absolute inset-0 rounded-full animate-ping"
              style={{ background: C.amber, opacity: 0.4 }}
            />
          )}
        </span>
        <span className="text-sm font-semibold" style={{ color: C.textPrimary }}>
          {sessionName}
        </span>
      </div>

      {/* Tabs */}
      <div className="flex items-center h-full">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveView(tab.key)}
            className="flex items-center gap-1.5 h-full px-4 text-xs font-medium border-b-2 transition-colors"
            style={{
              borderColor: activeView === tab.key ? C.accent : 'transparent',
              color: activeView === tab.key ? C.accentText : C.textMuted,
            }}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Quick task button */}
      <QuickTaskPopover />

      <div className="flex-1" />

      {/* Review notification */}
      {hasReviewReady && activeView !== 'review' && activeView !== 'done' && (
        <button
          onClick={() => setActiveView('review')}
          className="mr-3 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
          style={{
            background: C.accentSoft,
            color: C.accentText,
            border: `1px solid ${C.accent}40`,
          }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: C.accent }} />
          Review
        </button>
      )}

      {/* Dev mode toggle */}
      <div className="flex items-center gap-2">
        <span className="text-xs" style={{ color: C.textMuted }}>
          Dev
        </span>
        <button
          onClick={() => setDeveloperMode(!developerMode)}
          className="w-8 h-4 rounded-full flex items-center px-0.5 transition-all flex-shrink-0"
          style={{ background: developerMode ? C.accent : C.borderStrong }}
        >
          <div
            className="w-3 h-3 rounded-full bg-white transition-all"
            style={{ marginLeft: developerMode ? 'auto' : '0' }}
          />
        </button>
      </div>
    </div>
  );
}
