import { useState } from 'react';
import { C } from '@/lib/theme';
import { useUIStore } from '@/stores/uiStore';
import { useTaskStore } from '@/stores/taskStore';
import { SessionHistory } from '@/components/shared/SessionHistory';

/* ── Tooltip ─────────────────────────────────────────────── */

function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <div
          className="absolute left-full ml-2.5 top-1/2 -translate-y-1/2 z-50 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap pointer-events-none"
          style={{
            background: '#1e1e30',
            color: C.textPrimary,
            border: `1px solid ${C.borderStrong}`,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}
        >
          {label}
          <div
            className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent"
            style={{ borderRightColor: '#1e1e30' }}
          />
        </div>
      )}
    </div>
  );
}

/* ── Icon Button ─────────────────────────────────────────── */

function IconButton({
  active,
  onClick,
  children,
  'aria-label': ariaLabel,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  'aria-label'?: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      style={{
        width: 36,
        height: 36,
        borderRadius: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active ? C.accentSoft : 'transparent',
        color: active ? C.accentText : C.textMuted,
        border: 'none',
        cursor: 'pointer',
        transition: 'all 150ms ease',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = C.surfaceHover;
          e.currentTarget.style.color = C.textSecondary;
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = C.textMuted;
        }
      }}
    >
      {children}
    </button>
  );
}

/* ── Session Button ──────────────────────────────────────── */

function SessionButton({
  label,
  statusColor,
  active,
  onClick,
}: {
  label: string;
  statusColor: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label}>
      <button
        onClick={onClick}
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          background: active ? C.accentSoft : C.surface,
          color: active ? C.accentText : C.textSecondary,
          border: `1px solid ${active ? C.accent : C.border}`,
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 600,
          transition: 'all 150ms ease',
        }}
        onMouseEnter={(e) => {
          if (!active) {
            e.currentTarget.style.borderColor = C.borderStrong;
            e.currentTarget.style.background = C.surfaceHover;
          }
        }}
        onMouseLeave={(e) => {
          if (!active) {
            e.currentTarget.style.borderColor = C.border;
            e.currentTarget.style.background = C.surface;
          }
        }}
      >
        {label.charAt(0).toUpperCase()}
        <span
          style={{
            position: 'absolute',
            bottom: -2,
            right: -2,
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: statusColor,
            border: `2px solid ${C.sidebar}`,
          }}
        />
      </button>
    </Tooltip>
  );
}

/* ── Sidebar ─────────────────────────────────────────────── */

export function Sidebar() {
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setShowSetup = useUIStore((s) => s.setShowSetup);
  const activePlan = useTaskStore((s) => s.activePlan);
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  const tasks = useTaskStore((s) => s.tasks);
  const sessionName = useUIStore((s) => s.sessionName);
  const projectDir = useUIStore((s) => s.projectDir);
  const [showHistory, setShowHistory] = useState(false);

  // Session is visible if there's an active plan OR if there are persisted tasks with a project
  const hasSession = activePlan != null || (tasks.size > 0 && projectDir);
  const displayLabel = sessionName || (activePlan ? `Session ${activePlan.task_id.slice(0, 6)}` : 'Session');

  const phaseToColor = (phase: string): string => {
    switch (phase) {
      case 'executing':
      case 'decomposing':
        return C.amber;
      case 'completed':
        return C.green;
      case 'failed':
        return C.red;
      case 'reviewing':
      case 'awaiting_approval':
        return C.accentText;
      default:
        return C.textMuted;
    }
  };

  return (
    <nav
      data-testid="sidebar"
      role="navigation"
      aria-label="Main navigation"
      style={{
        width: 56,
        minWidth: 56,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 12,
        paddingBottom: 12,
        background: C.sidebar,
        borderRight: `1px solid ${C.border}`,
      }}
    >
      {/* Logo */}
      <Tooltip label="WhaleCode">
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 12,
            background: 'linear-gradient(135deg, #6d5efc 0%, #8b5cf6 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            color: '#fff',
            boxShadow: '0 8px 24px rgba(109,94,252,0.35)',
            cursor: 'default',
            flexShrink: 0,
          }}
        >
          &#9670;
        </div>
      </Tooltip>

      {/* Divider */}
      <div
        style={{
          width: 24,
          height: 1,
          background: C.border,
          marginTop: 12,
          marginBottom: 12,
          flexShrink: 0,
        }}
      />

      {/* Sessions */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
        }}
      >
        {hasSession && (
          <SessionButton
            label={displayLabel}
            statusColor={phaseToColor(orchestrationPhase)}
            active={activeView === 'kanban' || activeView === 'terminal'}
            onClick={() => setActiveView('kanban')}
          />
        )}

        {/* New orchestration button */}
        <Tooltip label="New orchestration">
          <button
            aria-label="New orchestration"
            onClick={() => setShowSetup(true)}
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              color: C.textMuted,
              border: `1.5px dashed ${C.borderStrong}`,
              cursor: 'pointer',
              fontSize: 18,
              fontWeight: 300,
              lineHeight: 1,
              transition: 'all 150ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = C.accent;
              e.currentTarget.style.color = C.accentText;
              e.currentTarget.style.background = C.accentSoft;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = C.borderStrong;
              e.currentTarget.style.color = C.textMuted;
              e.currentTarget.style.background = 'transparent';
            }}
          >
            +
          </button>
        </Tooltip>
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Bottom icons */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
          flexShrink: 0,
        }}
      >
        <Tooltip label="History">
          <IconButton active={showHistory} onClick={() => setShowHistory(!showHistory)} aria-label="Session history">
            <span style={{ fontSize: 16, lineHeight: 1 }}>&#9776;</span>
          </IconButton>
        </Tooltip>

        <Tooltip label="Settings">
          <IconButton active={activeView === 'settings'} onClick={() => setActiveView('settings')} aria-label="Settings">
            <span style={{ fontSize: 16, lineHeight: 1 }}>&#9881;</span>
          </IconButton>
        </Tooltip>
      </div>

      {/* Session History panel */}
      {showHistory && <SessionHistory onClose={() => setShowHistory(false)} />}
    </nav>
  );
}
