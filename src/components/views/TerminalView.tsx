import { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { C, STATUS, LOG_COLOR } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore, type ToolName } from '@/stores/taskStore';
import { useProcessStore, registerProcessOutput, unregisterProcessOutput } from '@/hooks/useProcess';
import type { OutputEvent } from '@/bindings';
import { commands } from '@/bindings';
import { EmptyState } from '@/components/shared/EmptyState';

/* ── Types ─────────────────────────────────────────────── */

type TerminalMode = 'orchestration' | 'standalone';

interface TerminalViewProps {
  devMode: boolean;
}

interface MergeQueueItem {
  branch: string;
  agent: ToolName;
  status: 'ready' | 'merging' | 'merged';
}

interface StandaloneOutput {
  id: string;
  text: string;
  stream: 'stdout' | 'stderr' | 'system';
}

/* ── Constants ─────────────────────────────────────────── */

/* ── Helpers ───────────────────────────────────────────── */

function mergeStatusStyle(status: MergeQueueItem['status']): { bg: string; text: string; label: string } {
  switch (status) {
    case 'ready':
      return { bg: C.amberBg, text: C.amber, label: 'Ready' };
    case 'merging':
      return { bg: C.accentSoft, text: C.accentText, label: 'Merging' };
    case 'merged':
      return { bg: C.greenBg, text: C.green, label: 'Merged' };
  }
}

/* ── Main Component ────────────────────────────────────── */

export function TerminalView({ devMode }: TerminalViewProps) {
  const tasks = useTaskStore((s) => s.tasks);
  const logs = useTaskStore((s) => s.orchestrationLogs);
  const addLog = useTaskStore((s) => s.addOrchestrationLog);
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  const activePlan = useTaskStore((s) => s.activePlan);
  const [devInput, setDevInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const standaloneScrollRef = useRef<HTMLDivElement>(null);

  // Terminal mode: orchestration (log view) or standalone (process output)
  const [mode, setMode] = useState<TerminalMode>('orchestration');
  const [standaloneLines, setStandaloneLines] = useState<StandaloneOutput[]>([]);
  const prevPhaseRef = useRef(orchestrationPhase);

  // Auto-switch to standalone when orchestration completes/fails
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = orchestrationPhase;
    if (
      (prev === 'executing' || prev === 'reviewing') &&
      (orchestrationPhase === 'completed' || orchestrationPhase === 'failed')
    ) {
      setMode('standalone');
    }
    // Auto-switch to orchestration when a new orchestration starts
    if (prev === 'idle' && orchestrationPhase === 'decomposing') {
      setMode('orchestration');
    }
  }, [orchestrationPhase]);

  // Subscribe to active process output for standalone mode
  const activeProcessId = useProcessStore((s) => s.activeProcessId);
  useEffect(() => {
    if (mode !== 'standalone' || !activeProcessId) return;
    setStandaloneLines([]);
    const handler = (event: OutputEvent) => {
      let text = '';
      let stream: StandaloneOutput['stream'] = 'stdout';
      if (event.event === 'stdout') {
        text = event.data;
        stream = 'stdout';
      } else if (event.event === 'stderr') {
        text = event.data;
        stream = 'stderr';
      } else if (event.event === 'error') {
        text = `Error: ${event.data}`;
        stream = 'stderr';
      } else if (event.event === 'exit') {
        text = `Process exited with code ${event.data}`;
        stream = 'system';
      }
      if (!text) return;
      setStandaloneLines((prev) => [
        ...prev.slice(-999),
        { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, stream },
      ]);
    };
    registerProcessOutput(activeProcessId, handler);
    return () => unregisterProcessOutput(activeProcessId);
  }, [mode, activeProcessId]);

  // Auto-scroll standalone output
  useEffect(() => {
    if (standaloneScrollRef.current) {
      standaloneScrollRef.current.scrollTop = standaloneScrollRef.current.scrollHeight;
    }
  }, [standaloneLines.length]);

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length]);

  // Subscribe to orchestration output events
  useEffect(() => {
    const unlisten = listen<string>('messenger-event', (event) => {
      try {
        const msg = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
        if (msg.agent && msg.content) {
          const level = msg.message_type?.includes('Failed') ? 'error' as const
            : msg.message_type?.includes('Completed') ? 'success' as const
            : msg.message_type?.includes('Started') || msg.message_type?.includes('Assigned') ? 'cmd' as const
            : 'info' as const;
          addLog({ agent: (msg.agent as ToolName) || 'claude', level, message: msg.content });
        }
      } catch { /* ignore non-JSON */ }
    });
    return () => { unlisten.then(fn => fn()); };
  }, [addLog]);

  // Derive agent statuses from orchestration phase + tasks
  const isRunning = orchestrationPhase !== 'idle' && orchestrationPhase !== 'failed';
  const orchestrationPlan = useTaskStore((s) => s.orchestrationPlan);

  // Master agent: prefer orchestrationPlan (set at launch) over activePlan (set after completion)
  const masterAgent: ToolName = (orchestrationPlan?.masterAgent as ToolName)
    || (activePlan?.master_agent as ToolName)
    || 'claude';

  // Build role-aware agent status from orchestration config + task state
  const configuredAgents = new Set<ToolName>();
  if (orchestrationPlan) {
    for (const a of orchestrationPlan.agents) {
      configuredAgents.add(a.toolName);
    }
  }

  const agents = new Map<ToolName, { status: string; role: string }>();
  for (const [, task] of tasks) {
    const existing = agents.get(task.toolName);
    if (!existing || task.status === 'running') {
      const role = task.toolName === masterAgent ? 'master' : 'worker';
      agents.set(task.toolName, { status: task.status, role });
    }
  }
  // Default agents with orchestration-aware status and roles
  const allAgents: ToolName[] = ['claude', 'gemini', 'codex'];
  for (const name of allAgents) {
    if (!agents.has(name)) {
      const isMaster = name === masterAgent;
      const isInSession = configuredAgents.has(name) || !isRunning;
      const role = isMaster ? 'master' : isInSession ? 'worker' : '';
      const status = isRunning && isMaster ? 'running'
        : isRunning && isInSession ? 'waiting'
        : 'idle';
      agents.set(name, { status, role });
    }
  }

  // Build merge queue from completed tasks
  const mergeQueue: MergeQueueItem[] = [];
  for (const [, task] of tasks) {
    if (task.status === 'completed' || task.status === 'review') {
      mergeQueue.push({
        branch: `wc/${task.toolName}-${task.taskId.slice(0, 6)}`,
        agent: task.toolName,
        status: task.status === 'completed' ? 'merged' : 'ready',
      });
    } else if (task.status === 'running') {
      mergeQueue.push({
        branch: `wc/${task.toolName}-${task.taskId.slice(0, 6)}`,
        agent: task.toolName,
        status: 'merging',
      });
    }
  }

  const agentStatusColor = (status: string): string => {
    if (status === 'running') return C.amber;
    if (status === 'completed') return C.green;
    if (status === 'failed') return C.red;
    return C.textMuted;
  };

  const agentStatusLabel = (status: string, role: string): string => {
    if (status === 'running' && role === 'master') return 'Thinking';
    if (status === 'running' && role === 'worker') return 'Working';
    if (status === 'waiting' && role === 'worker') {
      // Show phase-aware standby message for workers
      if (orchestrationPhase === 'decomposing') return 'Waiting for plan';
      if (orchestrationPhase === 'executing') return 'Queued';
      return 'Standby';
    }
    if (status === 'waiting') return 'Standby';
    const s = STATUS[status];
    return s ? s.label : 'Idle';
  };

  return (
    <div
      style={{
        display: 'flex',
        height: '100%',
        fontFamily: 'Inter, sans-serif',
      }}
    >
      {/* Thinking animation keyframes */}
      <style>{`
        @keyframes thinkPulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1.2); }
        }
      `}</style>
      {/* ── Left: Agent list ──────────────────────────── */}
      <div
        style={{
          width: 176,
          minWidth: 176,
          borderRight: `1px solid ${C.border}`,
          display: 'flex',
          flexDirection: 'column',
          background: C.sidebar,
        }}
      >
        <div
          style={{
            padding: '14px 16px',
            borderBottom: `1px solid ${C.border}`,
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: C.textMuted,
          }}
        >
          Agents
        </div>
        <ScrollArea style={{ flex: 1 }}>
          <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Array.from(agents.entries()).map(([name, info]) => {
              const icon = AGENTS[name];
              const isAgentRunning = info.status === 'running';
              const isWaiting = info.status === 'waiting';
              const notInSession = isRunning && !info.role;
              return (
                <div
                  key={name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 12,
                    background: isAgentRunning ? C.accentSoft : C.surface,
                    border: `1px solid ${isAgentRunning ? C.accent + '60' : C.border}`,
                    transition: 'all 0.3s',
                    opacity: notInSession ? 0.4 : 1,
                  }}
                >
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 7,
                      background: icon.gradient,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 700,
                      color: '#fff',
                      flexShrink: 0,
                    }}
                  >
                    {icon.letter}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        lineHeight: '16px',
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 600, color: C.textPrimary }}>
                        {AGENTS[name].label}
                      </span>
                      {info.role && isRunning && (
                        <span style={{
                          fontSize: 8,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          padding: '1px 5px',
                          borderRadius: 4,
                          background: info.role === 'master' ? C.accent + '30' : C.borderStrong,
                          color: info.role === 'master' ? C.accentText : C.textMuted,
                        }}>
                          {info.role}
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        marginTop: 3,
                      }}
                    >
                      {isAgentRunning ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                          {[0, 1, 2].map((i) => (
                            <span
                              key={i}
                              className="thinking-dot"
                              style={{
                                width: 4,
                                height: 4,
                                borderRadius: '50%',
                                background: C.accent,
                                animation: `thinkPulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                              }}
                            />
                          ))}
                          <span style={{ fontSize: 10, color: C.accentText, marginLeft: 3, fontWeight: 500 }}>
                            {agentStatusLabel(info.status, info.role)}
                          </span>
                        </div>
                      ) : isWaiting ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.amber, flexShrink: 0, opacity: 0.6 }} />
                          <span style={{ fontSize: 10, color: C.amber, opacity: 0.8 }}>
                            {agentStatusLabel(info.status, info.role)}
                          </span>
                        </div>
                      ) : (
                        <>
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              background: agentStatusColor(info.status),
                              flexShrink: 0,
                            }}
                          />
                          <span style={{ fontSize: 10, color: C.textSecondary }}>
                            {agentStatusLabel(info.status, info.role)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </div>

      {/* ── Center: Terminal output ────────────────────── */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          background: '#08080f',
        }}
      >
        {/* Header with mode tabs */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 16px',
            borderBottom: `1px solid ${C.border}`,
            background: C.panel,
          }}
        >
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#ef4444' }} />
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#eab308' }} />
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#22c55e' }} />
          <div style={{ marginLeft: 12, display: 'flex', gap: 2, background: C.surface, borderRadius: 8, padding: 2 }}>
            {(['orchestration', 'standalone'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  padding: '4px 12px',
                  borderRadius: 6,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  background: mode === m ? C.accent + '30' : 'transparent',
                  color: mode === m ? C.accentText : C.textMuted,
                  transition: 'all 0.15s',
                }}
              >
                {m === 'orchestration' ? 'Orchestration' : 'Standalone'}
              </button>
            ))}
          </div>
          {mode === 'standalone' && activeProcessId && (
            <span style={{ fontSize: 10, color: C.textMuted, marginLeft: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
              pid:{activeProcessId.slice(0, 8)}
            </span>
          )}
        </div>

        {/* Orchestration mode: log lines */}
        {mode === 'orchestration' && (
          <ScrollArea ref={scrollRef} style={{ flex: 1, padding: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {logs.length === 0 && (
                <EmptyState
                  icon={'\uD83D\uDCBB'}
                  title="No output yet"
                  description="Terminal output will appear when a task starts"
                />
              )}
              {logs.map((line) => {
                const dotColor = LOG_COLOR[line.level] ?? C.textSecondary;
                const icon = AGENTS[line.agent];
                return (
                  <div
                    key={line.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      padding: '6px 0',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: 12,
                      lineHeight: '20px',
                    }}
                  >
                    <span style={{ color: C.textMuted, flexShrink: 0, width: 62 }}>
                      {line.timestamp}
                    </span>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: dotColor,
                        flexShrink: 0,
                        marginTop: 6,
                      }}
                    />
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 5,
                        background: icon.gradient,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 9,
                        fontWeight: 700,
                        color: '#fff',
                        flexShrink: 0,
                      }}
                    >
                      {icon.letter}
                    </span>
                    <span style={{ color: C.textPrimary }}>{line.message}</span>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}

        {/* Standalone mode: raw process output */}
        {mode === 'standalone' && (
          <ScrollArea ref={standaloneScrollRef} style={{ flex: 1, padding: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {standaloneLines.length === 0 && !activeProcessId && (
                <EmptyState
                  icon={'\u2328\uFE0F'}
                  title="No active process"
                  description="Start a task to see its output here"
                />
              )}
              {standaloneLines.length === 0 && activeProcessId && (
                <EmptyState
                  icon={'\u23F3'}
                  title="Waiting for output"
                  description="Process is running, output will appear shortly"
                />
              )}
              {standaloneLines.map((line) => (
                <div
                  key={line.id}
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 12,
                    lineHeight: '20px',
                    padding: '1px 0',
                    color: line.stream === 'stderr' ? C.red
                      : line.stream === 'system' ? C.textMuted
                      : C.textPrimary,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {line.text}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}

        {/* Dev mode input bar */}
        {devMode && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 16px',
              borderTop: `1px solid ${C.border}`,
              background: C.panel,
            }}
          >
            <span style={{ color: C.accent, fontSize: 14, fontWeight: 700 }}>$</span>
            <input
              type="text"
              value={devInput}
              onChange={(e) => setDevInput(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && devInput.trim()) {
                  const input = devInput.trim();
                  setDevInput('');

                  // Find an active running process to send to.
                  // Priority: 1) master process (if still alive), 2) any running process
                  const plan = useTaskStore.getState().activePlan;
                  let processId = plan?.master_process_id ?? null;
                  let agentName: ToolName = (plan?.master_agent as ToolName) || 'claude';

                  // Check if the master process is still running, if not find another
                  const processes = useProcessStore.getState().processes;
                  if (processId && (!processes.has(processId) || processes.get(processId)?.status !== 'running')) {
                    processId = null; // Master is dead, look for alternatives
                  }

                  // Find the most recent running process if master is unavailable
                  if (!processId) {
                    let latestStart = 0;
                    for (const [id, proc] of processes) {
                      if (proc.status === 'running' && proc.startedAt > latestStart) {
                        processId = id;
                        latestStart = proc.startedAt;
                        // Extract agent name from cmd prefix (e.g., "claude: ...")
                        const cmdAgent = proc.cmd.split(':')[0] as ToolName;
                        if (['claude', 'gemini', 'codex'].includes(cmdAgent)) {
                          agentName = cmdAgent;
                        }
                      }
                    }
                  }

                  if (!processId) {
                    addLog({ agent: agentName, level: 'warn', message: 'No running process. All tasks have completed. Use "+ New Task" to start a new one.' });
                    return;
                  }

                  // Echo the command in terminal
                  addLog({ agent: agentName, level: 'cmd', message: `$ ${input}` });

                  try {
                    const result = await commands.sendToProcess(processId, input);
                    if (result.status === 'error') {
                      addLog({ agent: agentName, level: 'error', message: `Send failed: ${result.error}` });
                    }
                  } catch (err) {
                    addLog({ agent: agentName, level: 'error', message: `Send failed: ${err}` });
                  }
                }
              }}
              placeholder="Type a command..."
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: C.textPrimary,
                fontSize: 13,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              }}
            />
          </div>
        )}
      </div>

      {/* ── Right: Merge queue ────────────────────────── */}
      <div
        style={{
          width: 240,
          minWidth: 240,
          borderLeft: `1px solid ${C.border}`,
          display: 'flex',
          flexDirection: 'column',
          background: C.sidebar,
        }}
      >
        <div
          style={{
            padding: '14px 16px',
            borderBottom: `1px solid ${C.border}`,
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: C.textMuted,
          }}
        >
          Merge Queue
        </div>
        <ScrollArea style={{ flex: 1 }}>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {mergeQueue.length === 0 && (
              <div style={{ padding: 12, fontSize: 12, color: C.textMuted, textAlign: 'center' }}>
                No branches in queue
              </div>
            )}
            {mergeQueue.map((item) => {
              const ms = mergeStatusStyle(item.status);
              const icon = AGENTS[item.agent];
              return (
                <div
                  key={item.branch}
                  style={{
                    padding: 12,
                    borderRadius: 14,
                    background: C.surface,
                    border: `1px solid ${C.border}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 6,
                        background: icon.gradient,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 10,
                        fontWeight: 700,
                        color: '#fff',
                        flexShrink: 0,
                      }}
                    >
                      {icon.letter}
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        color: C.textPrimary,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.branch}
                    </span>
                  </div>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignSelf: 'flex-start',
                      alignItems: 'center',
                      gap: 5,
                      padding: '2px 10px',
                      borderRadius: 999,
                      background: ms.bg,
                      color: ms.text,
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: ms.text,
                      }}
                    />
                    {ms.label}
                  </span>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
