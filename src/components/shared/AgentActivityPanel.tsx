import { useState, useEffect, useMemo } from 'react';
import { C } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { useTaskStore, type ToolName } from '@/stores/taskStore';
import { useProcessStore } from '@/hooks/useProcess';

/* ── Types ─────────────────────────────────────────────── */

interface ActivityItem {
  type: 'tool' | 'file' | 'thinking' | 'message';
  label: string;
  detail?: string;
  timestamp: number;
}

/* ── Helpers ─────────────────────────────────────────────── */

function parseActivityFromOutput(line: string): ActivityItem | null {
  if (!line.startsWith('{')) return null;
  try {
    const ev = JSON.parse(line);
    if (ev.type === 'tool_use' || ev.type === 'tool_call') {
      return {
        type: 'tool',
        label: ev.name || ev.tool || 'tool',
        detail: typeof ev.input === 'string' ? ev.input.slice(0, 80) : JSON.stringify(ev.input ?? ev.params ?? '').slice(0, 80),
        timestamp: Date.now(),
      };
    }
    if (ev.type === 'tool_result') {
      const output = ev.output || ev.result || '';
      return {
        type: 'file',
        label: 'Result',
        detail: typeof output === 'string' ? output.slice(0, 80) : '',
        timestamp: Date.now(),
      };
    }
    if (ev.type === 'assistant' || ev.type === 'message') {
      let text = '';
      if (typeof ev.content === 'string') text = ev.content;
      else if (Array.isArray(ev.content)) {
        text = ev.content
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text)
          .join(' ');
      }
      if (text.length > 5) {
        return {
          type: 'thinking',
          label: 'Thinking',
          detail: text.slice(0, 100),
          timestamp: Date.now(),
        };
      }
    }
  } catch { /* not JSON */ }
  return null;
}

/* ── Component ─────────────────────────────────────────── */

interface AgentActivityPanelProps {
  taskId: string;
}

export function AgentActivityPanel({ taskId }: AgentActivityPanelProps) {
  const task = useTaskStore((s) => s.tasks.get(taskId));
  const [activities, setActivities] = useState<ActivityItem[]>([]);

  // Subscribe to process output to build activity stream
  useEffect(() => {
    const handler = (data: { taskId: string; event: { event: string; data: string } }) => {
      if (data.taskId !== taskId || data.event.event !== 'stdout') return;
      const item = parseActivityFromOutput(data.event.data);
      if (item) {
        setActivities((prev) => [...prev.slice(-19), item]); // Keep last 20
      }
    };

    const unsub = useProcessStore.subscribe((state, prev) => {
      const proc = state.processes.get(taskId);
      const prevProc = prev.processes.get(taskId);
      if (proc && prevProc && proc.lastEventAt !== prevProc.lastEventAt && proc.lastOutputPreview) {
        const item = parseActivityFromOutput(proc.lastOutputPreview);
        if (item) {
          setActivities((prev) => [...prev.slice(-19), item]);
        }
      }
    });

    return unsub;
  }, [taskId]);

  if (!task || task.status !== 'running') return null;

  const agentInfo = AGENTS[task.toolName];
  const lastLine = task.lastOutputLine;

  const ICON_MAP: Record<ActivityItem['type'], { icon: string; color: string }> = {
    tool: { icon: '⚡', color: C.amber },
    file: { icon: '📄', color: C.green },
    thinking: { icon: '💭', color: C.accentText },
    message: { icon: '💬', color: C.textSecondary },
  };

  return (
    <div style={{
      padding: 12,
      borderRadius: 14,
      background: C.surface,
      border: `1px solid ${C.border}`,
      fontFamily: 'Inter, sans-serif',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div
          style={{
            width: 20, height: 20, borderRadius: 6,
            background: agentInfo.gradient,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 9, fontWeight: 700, color: '#fff',
          }}
        >
          {agentInfo.letter}
        </div>
        <span style={{ fontSize: 11, fontWeight: 600, color: C.textPrimary }}>
          {agentInfo.label} Activity
        </span>
        <span className="heartbeat-pulse" style={{
          width: 6, height: 6, borderRadius: '50%', background: C.green, marginLeft: 'auto',
        }} />
      </div>

      {/* Current action */}
      {lastLine && (
        <div style={{
          padding: '6px 10px',
          borderRadius: 8,
          background: C.panel,
          border: `1px solid ${C.border}`,
          fontSize: 10,
          color: C.textSecondary,
          fontFamily: 'ui-monospace, monospace',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          marginBottom: activities.length > 0 ? 8 : 0,
        }}>
          {lastLine}
        </div>
      )}

      {/* Activity stream */}
      {activities.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {activities.slice(-5).map((item, i) => {
            const { icon, color } = ICON_MAP[item.type];
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 10, width: 16, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
                <span style={{ fontSize: 10, fontWeight: 600, color, flexShrink: 0 }}>{item.label}</span>
                {item.detail && (
                  <span style={{
                    fontSize: 10, color: C.textMuted, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                  }}>
                    {item.detail}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
