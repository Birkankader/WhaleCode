import { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { C, STATUS, LOG_COLOR } from '@/lib/theme';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore, type ToolName } from '@/stores/taskStore';

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
  const [devInput, setDevInput] = useState('');

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

  // Gather agents from tasks
  const agents = new Map<ToolName, { status: string }>();
  for (const [, task] of tasks) {
    const existing = agents.get(task.toolName);
    if (!existing || task.status === 'running') {
      agents.set(task.toolName, { status: task.status });
    }
  }
  // Ensure at least the default agents appear
  if (agents.size === 0) {
    agents.set('claude', { status: 'idle' });
    agents.set('gemini', { status: 'idle' });
    agents.set('codex', { status: 'idle' });
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
              return (
                <div
                  key={name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 12,
                    background: C.surface,
                    border: `1px solid ${C.border}`,
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
        <ScrollArea style={{ flex: 1, padding: 16 }}>
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
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setDevInput('');
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
