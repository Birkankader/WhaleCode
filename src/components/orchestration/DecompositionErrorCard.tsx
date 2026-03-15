import { useState, useCallback, useRef, useEffect } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, RefreshCw, Pencil, ArrowRightLeft } from 'lucide-react';
import { toast } from 'sonner';
import { C } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { useTaskStore, type ToolName, type OrchestratorConfig } from '@/stores/taskStore';
import { useUIStore } from '@/stores/uiStore';
import { useTaskDispatch } from '@/hooks/useTaskDispatch';

/**
 * DecompositionErrorCard — shown when orchestrationPhase === 'failed'
 * and no worker tasks exist (failure happened during decomposition).
 *
 * Provides three recovery actions: Retry, Edit & Retry, Switch Agent.
 */
export function DecompositionErrorCard() {
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  const tasks = useTaskStore((s) => s.tasks);
  const orchestrationLogs = useTaskStore((s) => s.orchestrationLogs);
  const orchestrationPlan = useTaskStore((s) => s.orchestrationPlan);
  const projectDir = useUIStore((s) => s.projectDir);
  const setShowSetup = useUIStore((s) => s.setShowSetup);
  const { dispatchOrchestratedTask } = useTaskDispatch();

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close agent dropdown on outside click
  useEffect(() => {
    if (!agentDropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setAgentDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [agentDropdownOpen]);

  // Determine if this is a decomposition failure
  const hasWorkerTasks = Array.from(tasks.values()).some((t) => t.role === 'worker');
  const isDecompositionFailure = orchestrationPhase === 'failed' && !hasWorkerTasks;

  if (!isDecompositionFailure) return null;

  // Find the master task to get error context
  const masterTask = Array.from(tasks.values()).find((t) => t.role === 'master');
  const masterPrompt = masterTask?.prompt ?? '';

  // Error message: prefer resultSummary, then last error log
  const errorMessage =
    masterTask?.resultSummary ||
    orchestrationLogs.filter((l) => l.level === 'error').pop()?.message ||
    'The master agent failed to decompose the task into sub-tasks.';

  // Last N logs for the details section
  const recentLogs = orchestrationLogs.slice(-10);

  // Retry with the same orchestration config
  const handleRetry = useCallback(async () => {
    if (!projectDir || !orchestrationPlan || !masterPrompt || retrying) return;
    setRetrying(true);

    const store = useTaskStore.getState();

    // Clear failed tasks
    for (const [id, t] of store.tasks) {
      if (t.role === 'master' && t.status === 'failed') {
        store.removeTask(id);
      }
    }

    // Reset phase
    store.setOrchestrationPhase('decomposing');
    store.clearOrchestrationLogs();

    // Re-add master task
    const orchTaskId = crypto.randomUUID();
    store.addTask({
      taskId: orchTaskId,
      prompt: masterPrompt,
      toolName: orchestrationPlan.masterAgent,
      status: 'running',
      description: masterPrompt.length > 60 ? masterPrompt.slice(0, 57) + '...' : masterPrompt,
      startedAt: Date.now(),
      dependsOn: null,
      role: 'master',
    });

    store.addOrchestrationLog({ agent: orchestrationPlan.masterAgent, level: 'cmd', message: 'Retrying orchestration...' });

    try {
      await dispatchOrchestratedTask(masterPrompt, projectDir, orchestrationPlan);
    } catch (e) {
      console.error('Retry failed:', e);
      toast.error('Retry failed', { description: String(e) });
      store.addOrchestrationLog({ agent: orchestrationPlan.masterAgent, level: 'error', message: `Retry failed: ${e}` });
      store.setOrchestrationPhase('failed');
    } finally {
      setRetrying(false);
    }
  }, [projectDir, orchestrationPlan, masterPrompt, retrying, dispatchOrchestratedTask]);

  // Open SetupPanel pre-filled (the SetupPanel reads projectDir from uiStore)
  const handleEditAndRetry = useCallback(() => {
    setShowSetup(true);
  }, [setShowSetup]);

  // Switch agent and retry
  const handleSwitchAgent = useCallback(async (newAgent: ToolName) => {
    setAgentDropdownOpen(false);
    if (!projectDir || !orchestrationPlan || !masterPrompt || retrying) return;
    setRetrying(true);

    const store = useTaskStore.getState();

    // Build new config with different master
    const newConfig: OrchestratorConfig = {
      ...orchestrationPlan,
      masterAgent: newAgent,
      agents: orchestrationPlan.agents.map((a) =>
        a.isMaster ? { ...a, toolName: newAgent } : a,
      ),
    };

    // Clear failed tasks
    for (const [id, t] of store.tasks) {
      if (t.role === 'master' && t.status === 'failed') {
        store.removeTask(id);
      }
    }

    // Reset phase
    store.setOrchestrationPhase('decomposing');
    store.setOrchestrationPlan(newConfig);
    store.clearOrchestrationLogs();

    // Re-add master task
    const orchTaskId = crypto.randomUUID();
    store.addTask({
      taskId: orchTaskId,
      prompt: masterPrompt,
      toolName: newAgent,
      status: 'running',
      description: masterPrompt.length > 60 ? masterPrompt.slice(0, 57) + '...' : masterPrompt,
      startedAt: Date.now(),
      dependsOn: null,
      role: 'master',
    });

    store.addOrchestrationLog({ agent: newAgent, level: 'cmd', message: `Retrying with ${AGENTS[newAgent].label} as master...` });

    try {
      await dispatchOrchestratedTask(masterPrompt, projectDir, newConfig);
    } catch (e) {
      console.error('Retry with new agent failed:', e);
      toast.error('Retry failed', { description: String(e) });
      store.addOrchestrationLog({ agent: newAgent, level: 'error', message: `Retry failed: ${e}` });
      store.setOrchestrationPhase('failed');
    } finally {
      setRetrying(false);
    }
  }, [projectDir, orchestrationPlan, masterPrompt, retrying, dispatchOrchestratedTask]);

  // Dismiss the error and reset to idle
  const handleDismiss = useCallback(() => {
    const store = useTaskStore.getState();
    // Clear failed master tasks
    for (const [id, t] of store.tasks) {
      if (t.role === 'master' && t.status === 'failed') {
        store.removeTask(id);
      }
    }
    store.setOrchestrationPhase('idle');
    store.clearOrchestrationLogs();
  }, []);

  const currentMaster = orchestrationPlan?.masterAgent ?? 'claude';
  const otherAgents = (Object.keys(AGENTS) as ToolName[]).filter((a) => a !== currentMaster);

  return (
    <div
      className="decomposition-error-fade-in"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: 32,
        fontFamily: 'Inter, sans-serif',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 540,
          background: C.surface,
          border: `1.5px solid rgba(248,113,113,0.3)`,
          borderRadius: 24,
          overflow: 'hidden',
        }}
      >
        {/* Header stripe */}
        <div
          style={{
            background: `linear-gradient(135deg, ${C.redBg} 0%, rgba(239,68,68,0.08) 100%)`,
            padding: '28px 32px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          {/* Icon + title row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 14,
                background: 'rgba(248,113,113,0.12)',
                border: '1px solid rgba(248,113,113,0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <AlertTriangle size={22} color={C.red} />
            </div>
            <div>
              <h3 style={{ fontSize: 17, fontWeight: 700, color: C.textPrimary, margin: 0, lineHeight: '24px' }}>
                Decomposition Failed
              </h3>
              <p style={{ fontSize: 12, color: C.textSecondary, margin: 0, marginTop: 2 }}>
                The master agent could not break down the task
              </p>
            </div>
          </div>

          {/* Error message */}
          <div
            style={{
              padding: '12px 16px',
              borderRadius: 12,
              background: 'rgba(248,113,113,0.06)',
              border: '1px solid rgba(248,113,113,0.15)',
              fontSize: 13,
              lineHeight: '20px',
              color: '#fca5a5',
              wordBreak: 'break-word',
              maxHeight: 120,
              overflow: 'auto',
            }}
          >
            {errorMessage}
          </div>
        </div>

        {/* Actions */}
        <div style={{ padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Retry (primary) */}
          <button
            type="button"
            onClick={handleRetry}
            disabled={retrying}
            style={{
              width: '100%',
              padding: '11px 20px',
              borderRadius: 14,
              background: retrying ? C.accentSoft : C.accent,
              border: 'none',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'Inter, sans-serif',
              cursor: retrying ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              transition: 'all 150ms ease',
              opacity: retrying ? 0.7 : 1,
              boxShadow: retrying ? 'none' : '0 0 20px rgba(99,102,241,0.25)',
            }}
          >
            <RefreshCw size={15} className={retrying ? 'animate-spin' : ''} />
            {retrying ? 'Retrying...' : 'Retry'}
          </button>

          {/* Secondary actions row */}
          <div style={{ display: 'flex', gap: 10 }}>
            {/* Edit & Retry */}
            <button
              type="button"
              onClick={handleEditAndRetry}
              style={{
                flex: 1,
                padding: '10px 16px',
                borderRadius: 12,
                background: C.panel,
                border: `1px solid ${C.borderStrong}`,
                color: C.textSecondary,
                fontSize: 12,
                fontWeight: 600,
                fontFamily: 'Inter, sans-serif',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                transition: 'all 150ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = C.surfaceHover;
                e.currentTarget.style.borderColor = C.accent;
                e.currentTarget.style.color = C.textPrimary;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = C.panel;
                e.currentTarget.style.borderColor = C.borderStrong;
                e.currentTarget.style.color = C.textSecondary;
              }}
            >
              <Pencil size={13} />
              Edit Task & Retry
            </button>

            {/* Switch Agent (dropdown) */}
            <div ref={dropdownRef} style={{ position: 'relative', flex: 1 }}>
              <button
                type="button"
                onClick={() => setAgentDropdownOpen(!agentDropdownOpen)}
                style={{
                  width: '100%',
                  padding: '10px 16px',
                  borderRadius: 12,
                  background: C.panel,
                  border: `1px solid ${agentDropdownOpen ? C.accent : C.borderStrong}`,
                  color: agentDropdownOpen ? C.textPrimary : C.textSecondary,
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: 'Inter, sans-serif',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 7,
                  transition: 'all 150ms ease',
                }}
                onMouseEnter={(e) => {
                  if (!agentDropdownOpen) {
                    e.currentTarget.style.background = C.surfaceHover;
                    e.currentTarget.style.borderColor = C.accent;
                    e.currentTarget.style.color = C.textPrimary;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!agentDropdownOpen) {
                    e.currentTarget.style.background = C.panel;
                    e.currentTarget.style.borderColor = C.borderStrong;
                    e.currentTarget.style.color = C.textSecondary;
                  }
                }}
              >
                <ArrowRightLeft size={13} />
                Switch Agent
              </button>

              {agentDropdownOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 6px)',
                    left: 0,
                    right: 0,
                    background: C.panel,
                    border: `1px solid ${C.borderStrong}`,
                    borderRadius: 12,
                    overflow: 'hidden',
                    zIndex: 10,
                    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                  }}
                >
                  {otherAgents.map((agent) => {
                    const info = AGENTS[agent];
                    return (
                      <button
                        key={agent}
                        type="button"
                        onClick={() => handleSwitchAgent(agent)}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '10px 14px',
                          background: 'transparent',
                          border: 'none',
                          borderBottom: `1px solid ${C.border}`,
                          color: C.textPrimary,
                          fontSize: 12,
                          fontWeight: 500,
                          fontFamily: 'Inter, sans-serif',
                          cursor: 'pointer',
                          transition: 'background 150ms ease',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = C.surfaceHover; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <div
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: 7,
                            background: info.gradient,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 10,
                            fontWeight: 700,
                            color: '#fff',
                            flexShrink: 0,
                          }}
                        >
                          {info.letter}
                        </div>
                        {info.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Master agent info */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              borderRadius: 10,
              background: C.panel,
              border: `1px solid ${C.border}`,
              fontSize: 11,
              color: C.textMuted,
            }}
          >
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: 6,
                background: AGENTS[currentMaster].gradient,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 9,
                fontWeight: 700,
                color: '#fff',
                flexShrink: 0,
              }}
            >
              {AGENTS[currentMaster].letter}
            </div>
            <span>
              Failed with <span style={{ color: C.textSecondary, fontWeight: 500 }}>{AGENTS[currentMaster].label}</span> as master
            </span>
          </div>

          {/* Dismiss */}
          <button
            type="button"
            onClick={handleDismiss}
            style={{
              width: '100%',
              padding: '9px 16px',
              borderRadius: 12,
              background: 'transparent',
              border: `1px solid ${C.border}`,
              color: C.textMuted,
              fontSize: 12,
              fontWeight: 500,
              fontFamily: 'Inter, sans-serif',
              cursor: 'pointer',
              transition: 'all 150ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = C.textSecondary;
              e.currentTarget.style.borderColor = C.borderStrong;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = C.textMuted;
              e.currentTarget.style.borderColor = C.border;
            }}
          >
            Dismiss
          </button>
        </div>

        {/* Collapsible details */}
        <div style={{ borderTop: `1px solid ${C.border}` }}>
          <button
            type="button"
            onClick={() => setDetailsOpen(!detailsOpen)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 32px',
              background: 'transparent',
              border: 'none',
              color: C.textMuted,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'Inter, sans-serif',
              cursor: 'pointer',
              transition: 'color 150ms ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = C.textSecondary; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = C.textMuted; }}
          >
            <span>Orchestration Logs ({recentLogs.length})</span>
            {detailsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          {detailsOpen && (
            <div
              style={{
                padding: '0 32px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                maxHeight: 220,
                overflowY: 'auto',
              }}
            >
              {recentLogs.length === 0 ? (
                <div style={{ fontSize: 11, color: C.textMuted, padding: '8px 0' }}>
                  No logs available
                </div>
              ) : (
                recentLogs.map((log) => {
                  const levelColor: Record<string, string> = {
                    info: C.textSecondary,
                    success: C.green,
                    warn: C.amber,
                    cmd: C.accentText,
                    error: C.red,
                  };
                  return (
                    <div
                      key={log.id}
                      style={{
                        display: 'flex',
                        gap: 8,
                        padding: '5px 10px',
                        borderRadius: 8,
                        background: C.panel,
                        fontSize: 11,
                        lineHeight: '16px',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      <span style={{ color: C.textMuted, flexShrink: 0 }}>{log.timestamp}</span>
                      <span style={{ color: levelColor[log.level] ?? C.textSecondary, wordBreak: 'break-word' }}>
                        {log.message}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
