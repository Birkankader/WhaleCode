import type { ReactNode } from 'react';
import { C } from '@/lib/theme';
import { Sidebar } from './Sidebar';
import { useUIStore } from '@/stores/uiStore';
import { useTaskStore } from '@/stores/taskStore';
import { SetupPanel } from './SetupPanel';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const developerMode = useUIStore((s) => s.developerMode);
  const setDeveloperMode = useUIStore((s) => s.setDeveloperMode);
  const showSetup = useUIStore((s) => s.showSetup);
  const setShowSetup = useUIStore((s) => s.setShowSetup);
  const showReviewBanner = useUIStore((s) => s.showReviewBanner);
  const setShowReviewBanner = useUIStore((s) => s.setShowReviewBanner);
  const activePlan = useTaskStore((s) => s.activePlan);
  const tasks = useTaskStore((s) => s.tasks);

  const sessionName = activePlan ? 'Active Session' : 'No Session';
  const sessionStatus = activePlan ? 'running' : 'idle';

  const doneTasks = Array.from(tasks.values()).filter((t) => t.status === 'completed').length;
  const totalTasks = tasks.size;

  const tabs: { key: typeof activeView; label: string; icon: string }[] = [
    { key: 'kanban', label: 'Board', icon: '⊞' },
    { key: 'terminal', label: 'Terminal', icon: '⌨' },
    { key: 'usage', label: 'Usage', icon: '◎' },
  ];

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ background: C.bg, color: C.textPrimary, fontFamily: "'Inter', system-ui, sans-serif" }}
    >
      <div className="flex flex-1 overflow-hidden relative">
        <Sidebar />

        {/* Content area */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Content header */}
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

            <div className="flex-1" />

            {/* Review notification */}
            {activeView !== 'review' && activeView !== 'done' && (
              <button
                onClick={() => setShowReviewBanner(!showReviewBanner)}
                className="relative mr-3 w-8 h-8 rounded-lg flex items-center justify-center text-sm transition-all"
                style={{
                  background: showReviewBanner ? C.accentSoft : 'transparent',
                  color: showReviewBanner ? C.accentText : C.textMuted,
                }}
              >
                🔔
                <span
                  className="absolute top-1 right-1 w-2 h-2 rounded-full"
                  style={{ background: C.amber }}
                />
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

          {/* Notification banner */}
          {showReviewBanner && activeView !== 'review' && activeView !== 'done' && (
            <div
              className="flex items-center gap-3 px-5 py-2.5 border-b flex-shrink-0"
              style={{ background: '#0e0e20', borderColor: C.accent + '50' }}
            >
              <span
                className="text-xs px-2 py-0.5 rounded-full font-bold"
                style={{ background: C.accentSoft, color: C.accentText }}
              >
                NEW
              </span>
              <span className="text-xs flex-1" style={{ color: C.textSecondary }}>
                🟣 Master agent has completed code review. Ready for your approval.
              </span>
              <button
                onClick={() => {
                  setActiveView('review');
                  setShowReviewBanner(false);
                }}
                className="text-xs px-3 py-1 rounded-lg font-medium"
                style={{
                  background: C.accentSoft,
                  color: C.accentText,
                  border: `1px solid ${C.accent}50`,
                }}
              >
                Open Review
              </button>
              <button onClick={() => setShowReviewBanner(false)} style={{ color: C.textMuted, fontSize: 12 }}>
                ×
              </button>
            </div>
          )}

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
        {showSetup && <SetupPanel onLaunch={() => setShowSetup(false)} />}
      </div>

      {/* Status bar */}
      <div
        className="flex items-center gap-4 px-4 border-t flex-shrink-0"
        style={{ height: 26, borderColor: C.border, background: '#07070f', fontSize: 11 }}
      >
        <div className="flex items-center gap-1.5" style={{ color: C.textMuted }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: C.green }} />
          Agents ready
        </div>
        <span style={{ color: C.borderStrong }}>|</span>
        <div style={{ color: C.textMuted }}>
          Session: <span style={{ color: C.textSecondary }}>{sessionName}</span>
        </div>
        <span style={{ color: C.borderStrong }}>|</span>
        <div style={{ color: C.textMuted }}>
          Progress:{' '}
          <span style={{ color: C.amber }}>
            {totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0}%
          </span>
        </div>
        <div className="flex-1" />
        {developerMode && (
          <div className="flex items-center gap-1" style={{ color: C.accentText }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: C.accentText }} />
            Developer Mode
          </div>
        )}
        <span style={{ color: C.borderStrong }}>|</span>
        <span style={{ color: C.textMuted }}>OrchestAI v0.9.1</span>
      </div>
    </div>
  );
}
