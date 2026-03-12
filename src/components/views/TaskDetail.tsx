import { useMemo, useState } from 'react';
import { C, STATUS } from '@/lib/theme';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore, type ToolName } from '@/stores/taskStore';

/* ── Types ─────────────────────────────────────────────── */

interface TaskDetailProps {
  taskId: string;
  onClose: () => void;
}

/* ── Constants ─────────────────────────────────────────── */

const AGENT_ICON: Record<ToolName, { letter: string; gradient: string }> = {
  claude: { letter: 'C', gradient: 'linear-gradient(135deg, #6d5efc 0%, #8b5cf6 100%)' },
  gemini: { letter: 'G', gradient: 'linear-gradient(135deg, #0ea5e9 0%, #38bdf8 100%)' },
  codex: { letter: 'X', gradient: 'linear-gradient(135deg, #22c55e 0%, #4ade80 100%)' },
};

const AGENT_LABEL: Record<ToolName, string> = {
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  codex: 'Codex CLI',
};

const REASSIGN_OPTIONS: ToolName[] = ['claude', 'gemini', 'codex'];

/* ── Helpers ───────────────────────────────────────────── */

function resolveStatusKey(status: string): string {
  if (status === 'pending' || status === 'routing') return 'queued';
  if (status === 'running') return 'running';
  if (status === 'completed') return 'done';
  if (status === 'review') return 'review';
  return 'idle';
}

function formatElapsed(startedAt: number | null): string {
  if (!startedAt) return '--';
  const s = Math.floor((Date.now() - startedAt) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/* ── Main Component ────────────────────────────────────── */

export function TaskDetail({ taskId, onClose }: TaskDetailProps) {
  const task = useTaskStore((s) => s.tasks.get(taskId));
  const [reassignOpen, setReassignOpen] = useState(false);

  // Derive display data (fall back to mock if task not found)
  const display = useMemo(() => {
    if (task) {
      const stKey = resolveStatusKey(task.status);
      const st = STATUS[stKey] ?? STATUS.idle;
      return {
        title: task.description || task.prompt.slice(0, 60),
        id: task.taskId,
        agent: task.toolName,
        status: task.status,
        statusLabel: st.label,
        statusDot: st.dot,
        statusBg: st.bg,
        statusText: st.text,
        branch: `wc/${task.toolName}-${task.taskId.slice(0, 6)}`,
        startedAt: task.startedAt,
        isRunning: task.status === 'running',
        isDone: task.status === 'completed' || task.status === 'waiting',
      };
    }
    // Mock fallback
    const st = STATUS.queued;
    return {
      title: 'Implement authentication middleware',
      id: taskId,
      agent: 'claude' as ToolName,
      status: 'pending',
      statusLabel: st.label,
      statusDot: st.dot,
      statusBg: st.bg,
      statusText: st.text,
      branch: `wc/claude-${taskId.slice(0, 6)}`,
      startedAt: null,
      isRunning: false,
      isDone: false,
    };
  }, [task, taskId]);

  const agentIcon = AGENT_ICON[display.agent];
  const progress = display.isRunning && display.startedAt
    ? Math.min(95, Math.floor(((Date.now() - display.startedAt) / 120_000) * 100))
    : null;

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, sans-serif',
        background: C.panel,
        borderLeft: `1px solid ${C.border}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700, color: C.textPrimary }}>Task Detail</span>
        <button
          type="button"
          onClick={onClose}
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: `1px solid ${C.border}`,
            color: C.textMuted,
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            fontFamily: 'Inter, sans-serif',
            transition: 'all 150ms ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = C.surfaceHover;
            e.currentTarget.style.borderColor = C.borderStrong;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderColor = C.border;
          }}
        >
          &#10005;
        </button>
      </div>

      <ScrollArea style={{ flex: 1 }}>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Status pill */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 12px',
                borderRadius: 999,
                background: display.statusBg,
                color: display.statusText,
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: display.statusDot,
                }}
              />
              {display.statusLabel}
            </span>
            {display.startedAt && (
              <span style={{ fontSize: 11, color: C.textMuted }}>
                {formatElapsed(display.startedAt)}
              </span>
            )}
          </div>

          {/* Title + ID */}
          <div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: C.textPrimary,
                lineHeight: '24px',
                marginBottom: 4,
              }}
            >
              {display.title}
            </div>
            <div
              style={{
                fontSize: 11,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                color: C.textMuted,
              }}
            >
              ID: {display.id}
            </div>
          </div>

          {/* Assigned agent card */}
          <div
            style={{
              padding: 14,
              borderRadius: 14,
              background: C.surface,
              border: `1px solid ${C.border}`,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 10,
                background: agentIcon.gradient,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 700,
                color: '#fff',
                flexShrink: 0,
              }}
            >
              {agentIcon.letter}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary }}>
                {AGENT_LABEL[display.agent]}
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Assigned agent</div>
            </div>
          </div>

          {/* Branch */}
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 12,
              background: C.surface,
              border: `1px solid ${C.border}`,
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: C.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: 6,
              }}
            >
              Branch
            </div>
            <div
              style={{
                fontSize: 12,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                color: C.accentText,
              }}
            >
              {display.branch}
            </div>
          </div>

          {/* Progress bar (if running) */}
          {progress !== null && (
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 11,
                  color: C.textSecondary,
                  marginBottom: 6,
                }}
              >
                <span>Progress</span>
                <span>{progress}%</span>
              </div>
              <div
                style={{
                  width: '100%',
                  height: 6,
                  borderRadius: 3,
                  background: C.border,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${progress}%`,
                    height: '100%',
                    borderRadius: 3,
                    background: C.amber,
                    transition: 'width 300ms ease',
                  }}
                />
              </div>
            </div>
          )}

          {/* Awaiting merge card (if done) */}
          {display.isDone && (
            <div
              style={{
                padding: 16,
                borderRadius: 14,
                background: C.greenBg,
                border: `1px solid ${C.greenBorder}`,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: C.green,
                  marginBottom: 10,
                }}
              >
                Awaiting Merge
              </div>
              <p
                style={{
                  fontSize: 12,
                  color: C.textSecondary,
                  margin: 0,
                  marginBottom: 14,
                  lineHeight: '18px',
                }}
              >
                This task is complete and its branch is ready to be merged into main.
              </p>
              <button
                type="button"
                style={{
                  padding: '8px 20px',
                  borderRadius: 10,
                  background: C.green,
                  border: 'none',
                  color: '#052e16',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'Inter, sans-serif',
                  transition: 'all 150ms ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.filter = 'brightness(1.1)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.filter = 'brightness(1)';
                }}
              >
                Merge Branch
              </button>
            </div>
          )}

          {/* Reassign dropdown */}
          <div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: C.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: 8,
              }}
            >
              Reassign Agent
            </div>
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setReassignOpen(!reassignOpen)}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: 12,
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  color: C.textPrimary,
                  fontSize: 13,
                  fontFamily: 'Inter, sans-serif',
                  textAlign: 'left',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  transition: 'all 150ms ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = C.borderStrong;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = C.border;
                }}
              >
                <span>{AGENT_LABEL[display.agent]}</span>
                <span style={{ fontSize: 10, color: C.textMuted }}>
                  {reassignOpen ? '\u25B2' : '\u25BC'}
                </span>
              </button>

              {reassignOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    right: 0,
                    marginTop: 4,
                    borderRadius: 12,
                    background: C.surface,
                    border: `1px solid ${C.borderStrong}`,
                    boxShadow: '0 12px 36px rgba(0,0,0,0.5)',
                    zIndex: 10,
                    overflow: 'hidden',
                  }}
                >
                  {REASSIGN_OPTIONS.filter((t) => t !== display.agent).map((toolName) => {
                    const icon = AGENT_ICON[toolName];
                    return (
                      <button
                        key={toolName}
                        type="button"
                        onClick={() => {
                          setReassignOpen(false);
                          // Reassign action would go here
                        }}
                        style={{
                          width: '100%',
                          padding: '10px 14px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          background: 'transparent',
                          border: 'none',
                          borderBottom: `1px solid ${C.border}`,
                          color: C.textPrimary,
                          fontSize: 13,
                          fontFamily: 'Inter, sans-serif',
                          cursor: 'pointer',
                          textAlign: 'left',
                          transition: 'background 150ms ease',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = C.surfaceHover;
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent';
                        }}
                      >
                        <div
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: 7,
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
                        {AGENT_LABEL[toolName]}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
