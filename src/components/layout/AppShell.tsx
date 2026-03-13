import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { C } from '@/lib/theme';
import { Sidebar } from './Sidebar';
import { useUIStore } from '@/stores/uiStore';
import { useTaskStore, type ToolName, type OrchestratorConfig } from '@/stores/taskStore';
import { SetupPanel } from './SetupPanel';
import { useTaskDispatch } from '@/hooks/useTaskDispatch';
import { useHotkeys } from '@/hooks/useHotkeys';
import type { AppView } from '@/stores/uiStore';

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
  const setProjectDir = useUIStore((s) => s.setProjectDir);
  const storedSessionName = useUIStore((s) => s.sessionName);
  const setSessionName = useUIStore((s) => s.setSessionName);
  const activePlan = useTaskStore((s) => s.activePlan);
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  const tasks = useTaskStore((s) => s.tasks);
  const pendingQuestion = useTaskStore((s) => s.pendingQuestion);
  const { dispatchTask, dispatchOrchestratedTask } = useTaskDispatch();
  const projectDir = useUIStore((s) => s.projectDir);
  const orchestrationPlan = useTaskStore((s) => s.orchestrationPlan);
  const showQuickTask = useUIStore((s) => s.showQuickTask);
  const setShowQuickTask = useUIStore((s) => s.setShowQuickTask);
  const [quickPrompt, setQuickPrompt] = useState('');
  const [quickAgent, setQuickAgent] = useState<ToolName>('claude');
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const selectedTaskId = useUIStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useUIStore((s) => s.setSelectedTaskId);

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
    [showQuickTask, selectedTaskId, setShowQuickTask, setActiveView, setSelectedTaskId],
  );

  useHotkeys(hotkeys);

  // Session restore notification on mount
  useEffect(() => {
    const uiProjectDir = useUIStore.getState().projectDir;
    const taskCount = useTaskStore.getState().tasks.size;
    if (uiProjectDir && taskCount > 0) {
      toast.info('Session restored', {
        description: `${taskCount} task${taskCount === 1 ? '' : 's'} from previous session`,
      });
    }
  }, []);

  // Sync quickAgent default when orchestrationPlan becomes available
  useEffect(() => {
    if (orchestrationPlan?.masterAgent) {
      setQuickAgent(orchestrationPlan.masterAgent);
    }
  }, [orchestrationPlan?.masterAgent]);

  const handleQuickTask = useCallback(async () => {
    if (!quickPrompt.trim() || !projectDir || quickSubmitting) return;
    setQuickSubmitting(true);
    try {
      const taskId = await dispatchTask(quickPrompt.trim(), projectDir, quickAgent);
      // Mark quick tasks as workers to distinguish from orchestration master
      if (taskId) {
        const taskState = useTaskStore.getState();
        const task = taskState.tasks.get(taskId) ?? Array.from(taskState.tasks.values()).find(t => t.prompt === quickPrompt.trim());
        if (task) {
          const newTasks = new Map(taskState.tasks);
          newTasks.set(task.taskId, { ...task, role: 'worker' });
          useTaskStore.setState({ tasks: newTasks });
        }
      }
      setQuickPrompt('');
      setShowQuickTask(false);
      toast.success('Task dispatched', { description: quickPrompt.trim().slice(0, 80) });
      useTaskStore.getState().addOrchestrationLog({
        agent: quickAgent,
        level: 'cmd',
        message: `New task dispatched: ${quickPrompt.trim().slice(0, 80)}`,
      });
    } catch (e) {
      console.error('Quick task failed:', e);
      toast.error('Task failed', { description: String(e) });
      useTaskStore.getState().addOrchestrationLog({
        agent: quickAgent,
        level: 'error',
        message: `Task failed: ${e}`,
      });
    } finally {
      setQuickSubmitting(false);
    }
  }, [quickPrompt, projectDir, quickAgent, quickSubmitting, dispatchTask, setShowQuickTask]);

  const sessionName = storedSessionName || (activePlan ? 'Active Session' : 'No Session');
  const sessionStatus = orchestrationPhase === 'idle' ? 'idle' : 'running';
  const hasReviewReady = orchestrationPhase === 'reviewing' || orchestrationPhase === 'completed';

  const doneTasks = Array.from(tasks.values()).filter((t) => t.status === 'completed').length;
  const totalTasks = tasks.size;

  const tabs: { key: typeof activeView; label: string; icon: string }[] = [
    { key: 'kanban', label: 'Board', icon: '⊞' },
    ...(developerMode ? [{ key: 'terminal' as const, label: 'Terminal', icon: '⌨' }] : []),
    { key: 'usage', label: 'Usage', icon: '◎' },
    { key: 'git', label: 'Git', icon: '⎇' },
    { key: 'code', label: 'Code', icon: '◈' },
  ];

  const handleLaunch = useCallback(
    (config: { sessionName: string; projectDir: string; master: { cli: string; name: string } | null; workers: { agent: { cli: string; name: string }; count: number }[]; taskDescription: string }) => {
      if (!config.master || !config.taskDescription.trim() || !config.projectDir.trim()) return;

      const masterToolName = config.master.cli as ToolName;
      const agents: OrchestratorConfig['agents'] = [
        { toolName: masterToolName, subAgentCount: 1, isMaster: true },
        ...config.workers.map((w) => ({
          toolName: w.agent.cli as ToolName,
          subAgentCount: w.count,
          isMaster: false,
        })),
      ];
      const orchestratorConfig: OrchestratorConfig = { agents, masterAgent: masterToolName };

      // Store project dir, session name, and update UI
      setProjectDir(config.projectDir);
      setSessionName(config.sessionName);
      setShowSetup(false);
      setActiveView('kanban');

      // Store orchestrator config so sidebar can read master/worker roles immediately
      const store = useTaskStore.getState();
      store.setOrchestrationPlan(orchestratorConfig);
      store.setOrchestrationPhase('decomposing');
      store.clearOrchestrationLogs();

      // Add an orchestration task immediately so the Kanban board shows progress
      const orchTaskId = crypto.randomUUID();
      store.addTask({
        taskId: orchTaskId,
        prompt: config.taskDescription,
        toolName: masterToolName,
        status: 'running',
        description: config.taskDescription.length > 60 ? config.taskDescription.slice(0, 57) + '...' : config.taskDescription,
        startedAt: Date.now(),
        dependsOn: null,
        role: 'master',
      });

      // Immediate feedback in logs
      store.addOrchestrationLog({ agent: masterToolName, level: 'cmd', message: `Session "${config.sessionName}" starting...` });
      store.addOrchestrationLog({ agent: masterToolName, level: 'info', message: `Master: ${config.master.name} | Project: ${config.projectDir}` });
      store.addOrchestrationLog({ agent: masterToolName, level: 'info', message: config.taskDescription });

      // Fire orchestration (async, errors logged to terminal)
      dispatchOrchestratedTask(config.taskDescription, config.projectDir, orchestratorConfig)
        .catch((e) => {
          console.error('Launch failed:', e);
          toast.error('Orchestration failed', { description: String(e) });
          store.addOrchestrationLog({ agent: masterToolName, level: 'error', message: `Launch failed: ${e}` });
          store.setOrchestrationPhase('failed');
        });
    },
    [dispatchOrchestratedTask, setProjectDir, setSessionName, setShowSetup, setActiveView],
  );

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

            {/* Quick task button — show whenever a session is active (projectDir set) */}
            {projectDir && (
              <div className="relative ml-2">
                <button
                  onClick={() => setShowQuickTask(!showQuickTask)}
                  className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-semibold transition-all"
                  style={{
                    background: showQuickTask ? C.accent : C.surface,
                    color: showQuickTask ? '#fff' : C.textSecondary,
                    border: `1px solid ${showQuickTask ? C.accent : C.borderStrong}`,
                  }}
                >
                  <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
                  <span>New Task</span>
                </button>

                {showQuickTask && (
                  <div
                    className="absolute top-full left-0 mt-2 z-50 flex flex-col gap-2.5 p-3.5 rounded-xl"
                    style={{
                      width: 380,
                      background: C.panel,
                      border: `1px solid ${C.borderStrong}`,
                      boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
                    }}
                  >
                    <div className="text-xs font-bold" style={{ color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Quick Task
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={quickAgent}
                        onChange={(e) => setQuickAgent(e.target.value as ToolName)}
                        className="text-xs rounded-lg px-2 py-1.5"
                        style={{
                          background: C.surface,
                          color: C.textPrimary,
                          border: `1px solid ${C.border}`,
                          outline: 'none',
                        }}
                      >
                        <option value="claude">Claude</option>
                        <option value="gemini">Gemini</option>
                        <option value="codex">Codex</option>
                      </select>
                      <input
                        autoFocus
                        type="text"
                        value={quickPrompt}
                        onChange={(e) => setQuickPrompt(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleQuickTask(); if (e.key === 'Escape') setShowQuickTask(false); }}
                        placeholder="Describe the task..."
                        className="flex-1 text-xs rounded-lg px-2.5 py-1.5"
                        style={{
                          background: C.surface,
                          color: C.textPrimary,
                          border: `1px solid ${C.border}`,
                          outline: 'none',
                        }}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs" style={{ color: C.textMuted }}>
                        {projectDir.split('/').pop()}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs" style={{ color: C.textMuted }}>
                          Enter to send
                        </span>
                        <button
                          onClick={handleQuickTask}
                          disabled={!quickPrompt.trim() || quickSubmitting}
                          className="text-xs font-semibold px-4 py-1.5 rounded-lg transition-all"
                          style={{
                            background: quickPrompt.trim() ? C.accent : C.borderStrong,
                            color: quickPrompt.trim() ? '#fff' : C.textMuted,
                            opacity: quickSubmitting ? 0.5 : 1,
                          }}
                        >
                          {quickSubmitting ? 'Sending...' : 'Run'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex-1" />

            {/* Review notification — only show when review is actually pending */}
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

          {/* Pending question banner */}
          {pendingQuestion && activeView !== 'review' && (
            <div
              className="flex items-center gap-3 px-5 py-2.5 border-b flex-shrink-0"
              style={{ background: '#0e0e20', borderColor: C.amber + '50' }}
            >
              <span
                className="text-xs px-2 py-0.5 rounded-full font-bold"
                style={{ background: C.amberBg, color: C.amber }}
              >
                QUESTION
              </span>
              <span className="text-xs flex-1" style={{ color: C.textSecondary }}>
                {pendingQuestion.sourceAgent}: {pendingQuestion.content.slice(0, 120)}
              </span>
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
        {showSetup && <SetupPanel onLaunch={handleLaunch} />}
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
