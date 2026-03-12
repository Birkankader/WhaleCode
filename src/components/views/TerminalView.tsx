import { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { C, STATUS, LOG_COLOR } from '@/lib/theme';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore, type ToolName } from '@/stores/taskStore';
import { commands } from '@/bindings';

/* ── Types ─────────────────────────────────────────────── */

interface TerminalViewProps {
  devMode: boolean;
}

interface MergeQueueItem {
  branch: string;
  agent: ToolName;
  status: 'ready' | 'merging' | 'merged';
}

/* ── Constants ─────────────────────────────────────────── */

const AGENT_ICON: Record<ToolName, { letter: string; gradient: string }> = {
  claude: { letter: 'C', gradient: 'linear-gradient(135deg, #6d5efc 0%, #8b5cf6 100%)' },
  gemini: { letter: 'G', gradient: 'linear-gradient(135deg, #0ea5e9 0%, #38bdf8 100%)' },
  codex: { letter: 'X', gradient: 'linear-gradient(135deg, #22c55e 0%, #4ade80 100%)' },
};

const AGENT_LABEL: Record<ToolName, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
};

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
  const masterAgent = (activePlan?.master_agent as ToolName) || 'claude';

  const agents = new Map<ToolName, { status: string }>();
  for (const [, task] of tasks) {
    const existing = agents.get(task.toolName);
    if (!existing || task.status === 'running') {
      agents.set(task.toolName, { status: task.status });
    }
  }
  // Default agents with orchestration-aware status
  if (!agents.has('claude')) agents.set('claude', { status: isRunning && masterAgent === 'claude' ? 'running' : 'idle' });
  if (!agents.has('gemini')) agents.set('gemini', { status: isRunning && masterAgent === 'gemini' ? 'running' : 'idle' });
  if (!agents.has('codex')) agents.set('codex', { status: isRunning && masterAgent === 'codex' ? 'running' : 'idle' });

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

  const agentStatusLabel = (status: string): string => {
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
              const icon = AGENT_ICON[name];
              const isAgentRunning = info.status === 'running';
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
                        fontSize: 12,
                        fontWeight: 600,
                        color: C.textPrimary,
                        lineHeight: '16px',
                      }}
                    >
                      {AGENT_LABEL[name]}
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
                        /* Thinking animation — three pulsing dots */
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
                            Thinking
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
                            {agentStatusLabel(info.status)}
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
        {/* macOS dots header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 16px',
            borderBottom: `1px solid ${C.border}`,
            background: C.panel,
          }}
        >
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#ef4444' }} />
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#eab308' }} />
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#22c55e' }} />
          <span
            style={{
              marginLeft: 12,
              fontSize: 12,
              fontWeight: 600,
              color: C.textSecondary,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            orchestration-output
          </span>
        </div>

        {/* Log lines */}
        <ScrollArea ref={scrollRef} style={{ flex: 1, padding: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {logs.length === 0 && (
              <div style={{ color: C.textMuted, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', padding: '6px 0' }}>
                Waiting for orchestration events...
              </div>
            )}
            {logs.map((line) => {
              const dotColor = LOG_COLOR[line.level] ?? C.textSecondary;
              const icon = AGENT_ICON[line.agent];
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

                  // Find active process to send to
                  const plan = useTaskStore.getState().activePlan;
                  const processId = plan?.master_process_id;

                  if (!processId) {
                    addLog({ agent: 'claude', level: 'error', message: 'No active process to send command to' });
                    return;
                  }

                  // Echo the command in terminal
                  addLog({ agent: (plan.master_agent as ToolName) || 'claude', level: 'cmd', message: `$ ${input}` });

                  try {
                    const result = await commands.sendToProcess(processId, input);
                    if (result.status === 'error') {
                      addLog({ agent: 'claude', level: 'error', message: `Send failed: ${result.error}` });
                    }
                  } catch (err) {
                    addLog({ agent: 'claude', level: 'error', message: `Send failed: ${err}` });
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
              const icon = AGENT_ICON[item.agent];
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
