import { useState } from 'react';
import { C } from '@/lib/theme';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore } from '@/stores/taskStore';
import { commands } from '@/bindings';

/* ── Types ─────────────────────────────────────────────── */

interface CodeReviewViewProps {
  onDone: () => void;
}

interface FileReview {
  path: string;
  status: 'pass' | 'warning';
  note: string;
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
  const [response, setResponse] = useState('');
  const [accepted, setAccepted] = useState(false);
  const activePlan = useTaskStore((s) => s.activePlan);
  const tasks = useTaskStore((s) => s.tasks);
  const decomposedTasks = useTaskStore((s) => s.decomposedTasks);

  // Derive stats from tasks
  const tasksDone = Array.from(tasks.values()).filter(t => t.status === 'completed').length;
  const warnings = Array.from(tasks.values()).filter(t => t.status === 'failed').length;
  const prsReady = Array.from(tasks.values()).filter(t => t.status === 'completed' || t.status === 'review').length;

  // Derive file review list from decomposed tasks
  const files: FileReview[] = decomposedTasks.map(st => ({
    path: st.prompt.slice(0, 60),
    status: st.status === 'failed' ? 'warning' as const : 'pass' as const,
    note: `${st.assignedAgent} — ${st.status}`,
  }));

  const handleAccept = async () => {
    if (!activePlan?.task_id) return;
    try {
      await commands.approveDecomposition(activePlan.task_id, decomposedTasks.map(t => ({
        agent: t.assignedAgent,
        prompt: t.prompt,
        description: t.prompt.slice(0, 60),
      })));
      setAccepted(true);
    } catch (e) {
      console.error('Failed to approve:', e);
    }
  };

  const handleSkip = async () => {
    if (!activePlan?.task_id) return;
    try {
      await commands.rejectDecomposition(activePlan.task_id, response || 'Skipped by user');
      onDone();
    } catch (e) {
      console.error('Failed to reject:', e);
    }
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
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: 'linear-gradient(135deg, #6d5efc 0%, #8b5cf6 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 15,
              fontWeight: 700,
              color: '#fff',
              flexShrink: 0,
            }}
          >
            C
          </div>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: C.textPrimary, margin: 0 }}>
              Code Review
            </h2>
            <p style={{ fontSize: 12, color: C.textSecondary, marginTop: 2, marginBottom: 0 }}>
              Master agent has reviewed all completed work
            </p>
          </div>
        </div>

        {/* Stats grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
          <StatCard label="Tasks Done" value={tasksDone} color={C.green} />
          <StatCard label="PRs Ready" value={prsReady} color={C.accentText} />
          <StatCard label="Warnings" value={warnings} color={C.amber} />
        </div>

        {/* File review table */}
        {files.length > 0 && (
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
              <span>Notes</span>
            </div>
            {files.map((file) => (
              <div
                key={file.path}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '28px 1fr 1fr',
                  gap: 12,
                  padding: '12px 16px',
                  borderBottom: `1px solid ${C.border}`,
                  alignItems: 'center',
                }}
              >
                {file.status === 'pass' ? <CheckIcon /> : <WarningIcon />}
                <span
                  style={{
                    fontSize: 12,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    color: C.textPrimary,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {file.path}
                </span>
                <span style={{ fontSize: 12, color: C.textSecondary, lineHeight: '18px' }}>
                  {file.note}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Response section */}
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
              Review accepted. Proceeding to merge phase.
            </span>
          </div>
        ) : (
          <div
            style={{
              padding: 18,
              borderRadius: 16,
              background: C.surface,
              border: `1px solid ${C.border}`,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: C.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: 10,
              }}
            >
              Your Response (optional)
            </div>
            <textarea
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              placeholder="Add feedback or instructions before accepting..."
              rows={3}
              style={{
                width: '100%',
                padding: 12,
                borderRadius: 12,
                background: C.panel,
                border: `1px solid ${C.border}`,
                color: C.textPrimary,
                fontSize: 13,
                fontFamily: 'Inter, sans-serif',
                lineHeight: '22px',
                resize: 'vertical',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 10,
                marginTop: 14,
              }}
            >
              <button
                type="button"
                onClick={handleSkip}
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
                Skip
              </button>
              <button
                type="button"
                onClick={handleAccept}
                style={{
                  padding: '8px 20px',
                  borderRadius: 12,
                  background: 'linear-gradient(90deg, #6d5efc 0%, #8b5cf6 100%)',
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
                Accept
              </button>
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
