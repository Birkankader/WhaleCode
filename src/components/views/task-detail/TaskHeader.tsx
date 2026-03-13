import { C } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import type { ToolName } from '@/stores/taskStore';

/* ── Types ─────────────────────────────────────────────── */

export interface TaskDisplayData {
  title: string;
  id: string;
  agent: ToolName;
  status: string;
  statusLabel: string;
  statusDot: string;
  statusBg: string;
  statusText: string;
  branch: string;
  displayBranch: string;
  startedAt: number | null;
  isRunning: boolean;
  isDone: boolean;
  role?: string;
  resultSummary?: string;
}

/* ── Helpers ───────────────────────────────────────────── */

function formatElapsed(startedAt: number | null): string {
  if (!startedAt) return '--';
  const s = Math.floor((Date.now() - startedAt) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/* ── Header Bar ────────────────────────────────────────── */

/** The top "Task Detail" title bar with close button. Rendered outside ScrollArea. */
export function TaskHeaderBar({ onClose }: { onClose: () => void }) {
  return (
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
  );
}

/* ── Task Identity Section ─────────────────────────────── */

/** Status pill, title, agent card, and result summary. Rendered inside ScrollArea. */
export function TaskIdentity({ display }: { display: TaskDisplayData }) {
  const agentIcon = AGENTS[display.agent];

  return (
    <>
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
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary }}>
              {AGENTS[display.agent].label}
            </span>
            {display.role && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  padding: '1px 7px',
                  borderRadius: 6,
                  fontSize: 9,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  background: display.role === 'master' ? 'rgba(245,158,11,0.15)' : 'rgba(109,94,252,0.12)',
                  color: display.role === 'master' ? '#f59e0b' : '#8b5cf6',
                }}
              >
                {display.role === 'master' ? '\u2605' : '\u25CB'} {display.role}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Assigned agent</div>
        </div>
      </div>

      {/* Agent Result / Response */}
      {display.resultSummary && (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: 14,
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
              marginBottom: 8,
            }}
          >
            Agent Response
          </div>
          <div
            style={{
              fontSize: 12,
              lineHeight: '18px',
              color: C.textSecondary,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 200,
              overflowY: 'auto',
            }}
          >
            {display.resultSummary}
          </div>
        </div>
      )}
    </>
  );
}
