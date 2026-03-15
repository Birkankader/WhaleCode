import { useEffect, useRef, useState } from 'react';
import { C } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore, type ToolName } from '@/stores/taskStore';

/* ── Types ─────────────────────────────────────────────── */

interface CodeReviewViewProps {
  onDone: () => void;
}

/* ── Sub-components ────────────────────────────────────── */

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div
      style={{
        flex: 1,
        padding: '16px 14px',
        borderRadius: 14,
        background: C.surface,
        border: `1px solid ${C.border}`,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 24, fontWeight: 700, color, lineHeight: '32px' }}>{value}</div>
      <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 4 }}>{label}</div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="8" cy="8" r="7" stroke={C.green} strokeWidth="1.5" />
      <path d="M5 8l2 2 4-4" stroke={C.green} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path d="M8 2L14.93 14H1.07L8 2z" stroke={C.amber} strokeWidth="1.3" fill="none" />
      <line x1="8" y1="6.5" x2="8" y2="10" stroke={C.amber} strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="12" r="0.6" fill={C.amber} />
    </svg>
  );
}

/* ── Main Component ────────────────────────────────────── */

export function CodeReviewView({ onDone }: CodeReviewViewProps) {
  const [accepted, setAccepted] = useState(false);
  const activePlan = useTaskStore((s) => s.activePlan);
  const orchestrationPlan = useTaskStore((s) => s.orchestrationPlan);
  const tasks = useTaskStore((s) => s.tasks);
  const orchestrationLogs = useTaskStore((s) => s.orchestrationLogs);
  const setOrchestrationPhase = useTaskStore((s) => s.setOrchestrationPhase);

  // Determine master agent from config (available at launch) or plan (available after completion)
  const masterAgent: ToolName = (orchestrationPlan?.masterAgent as ToolName)
    || (activePlan?.master_agent as ToolName)
    || 'claude';
  const icon = AGENTS[masterAgent];

  // Derive stats from tasks
  const taskArray = Array.from(tasks.values());
  const tasksDone = taskArray.filter(t => t.status === 'completed').length;
  const warnings = taskArray.filter(t => t.status === 'failed').length;
  const totalTasks = taskArray.length;

  // Extract review text from orchestration logs (Phase 3 review results)
  const reviewLogs = orchestrationLogs.filter(
    l => l.level === 'success' || (l.level === 'info' && l.message.includes('Review complete'))
  );
  const reviewText = reviewLogs.length > 0
    ? reviewLogs.map(l => l.message).join('\n')
    : null;

  // Build task summary rows
  const taskRows = taskArray.map(t => ({
    id: t.taskId,
    description: t.description,
    agent: t.toolName,
    status: t.status,
    isOk: t.status === 'completed',
  }));

  const acceptTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Cleanup timer on unmount to prevent stale callbacks
  useEffect(() => () => {
    if (acceptTimerRef.current) clearTimeout(acceptTimerRef.current);
  }, []);

  const handleAccept = () => {
    setAccepted(true);
    setOrchestrationPhase('completed');
    // After a short delay, transition to done view
    acceptTimerRef.current = setTimeout(() => onDone(), 1500);
  };

  const handleReject = () => {
    setOrchestrationPhase('failed');
    onDone();
  };

  return (
    <ScrollArea style={{ height: '100%' }}>
      <div
        style={{
          maxWidth: 720,
          padding: '32px 28px',
          fontFamily: 'Inter, sans-serif',
        }}
      >
        {/* Header — dynamic master agent */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: icon.gradient,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 15,
              fontWeight: 700,
              color: '#fff',
              flexShrink: 0,
            }}
          >
            {icon.letter}
          </div>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: C.textPrimary, margin: 0 }}>
              Code Review
            </h2>
            <p style={{ fontSize: 12, color: C.textSecondary, marginTop: 2, marginBottom: 0 }}>
              {AGENTS[masterAgent].label} has reviewed all completed work
            </p>
          </div>
        </div>

        {/* Stats grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
          <StatCard label="Completed" value={tasksDone} color={C.green} />
          <StatCard label="Total Tasks" value={totalTasks} color={C.accentText} />
          <StatCard label="Warnings" value={warnings} color={C.amber} />
        </div>

        {/* Review summary from master agent */}
        {reviewText && (
          <div
            style={{
              padding: 16,
              borderRadius: 16,
              background: C.surface,
              border: `1px solid ${C.border}`,
              marginBottom: 24,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12,
                fontSize: 11,
                fontWeight: 700,
                color: C.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  background: icon.gradient,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 9,
                  fontWeight: 700,
                  color: '#fff',
                }}
              >
                {icon.letter}
              </div>
              {AGENTS[masterAgent].label}'s Review
            </div>
            <div
              style={{
                fontSize: 13,
                color: C.textPrimary,
                lineHeight: '22px',
                whiteSpace: 'pre-wrap',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {reviewText}
            </div>
          </div>
        )}

        {/* Task results table */}
        {taskRows.length > 0 && (
          <div
            style={{
              borderRadius: 16,
              border: `1px solid ${C.border}`,
              overflow: 'hidden',
              marginBottom: 24,
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '28px 1fr 1fr',
                gap: 12,
                padding: '10px 16px',
                background: C.surface,
                borderBottom: `1px solid ${C.border}`,
                fontSize: 11,
                fontWeight: 600,
                color: C.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              <span />
              <span>Task</span>
              <span>Agent / Status</span>
            </div>
            {taskRows.map((row) => {
              const agentIcon = AGENTS[row.agent];
              return (
                <div
                  key={row.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '28px 1fr 1fr',
                    gap: 12,
                    padding: '12px 16px',
                    borderBottom: `1px solid ${C.border}`,
                    alignItems: 'center',
                  }}
                >
                  {row.isOk ? <CheckIcon /> : <WarningIcon />}
                  <span
                    style={{
                      fontSize: 12,
                      fontFamily: 'var(--font-mono)',
                      color: C.textPrimary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row.description}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        background: agentIcon.gradient,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 8,
                        fontWeight: 700,
                        color: '#fff',
                        flexShrink: 0,
                      }}
                    >
                      {agentIcon.letter}
                    </div>
                    <span style={{ fontSize: 12, color: C.textSecondary, lineHeight: '18px' }}>
                      {AGENTS[row.agent].label} — {row.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Accept / Reject */}
        {accepted ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: 18,
              borderRadius: 16,
              background: C.greenBg,
              border: `1px solid ${C.greenBorder}`,
            }}
          >
            <CheckIcon />
            <span style={{ fontSize: 14, fontWeight: 600, color: C.green }}>
              Review accepted. Proceeding to completion.
            </span>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 10,
            }}
          >
            <button
              type="button"
              onClick={handleReject}
              style={{
                padding: '8px 20px',
                borderRadius: 12,
                background: 'transparent',
                border: `1px solid ${C.border}`,
                color: C.textSecondary,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
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
              Reject
            </button>
            <button
              type="button"
              onClick={handleAccept}
              style={{
                padding: '8px 20px',
                borderRadius: 12,
                background: icon.gradient,
                border: 'none',
                color: '#fff',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'Inter, sans-serif',
                boxShadow: '0 8px 24px rgba(109,94,252,0.28)',
                transition: 'all 150ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.filter = 'brightness(1.1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.filter = 'brightness(1)';
              }}
            >
              Accept & Complete
            </button>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
