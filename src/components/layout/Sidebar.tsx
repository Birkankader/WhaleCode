import { useState, useRef } from 'react';
import { History, Settings } from 'lucide-react';
import { C } from '@/lib/theme';
import { useUIStore } from '@/stores/uiStore';
import { useShallow } from 'zustand/react/shallow';
import { useTaskStore } from '@/stores/taskStore';
import { SessionHistory } from '@/components/shared/SessionHistory';

/* ── Tooltip ─────────────────────────────────────────────── */

function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  return (
    <div
      className="relative"
      onMouseEnter={() => { timerRef.current = setTimeout(() => setShow(true), 150); }}
      onMouseLeave={() => { if (timerRef.current) clearTimeout(timerRef.current); setShow(false); }}
    >
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
      className={`w-9 h-9 rounded-[10px] flex items-center justify-center border-none cursor-pointer transition-all duration-150 ease-out ${
        active
          ? 'bg-wc-accent-soft text-wc-accent-text'
          : 'bg-transparent text-wc-text-muted hover:bg-wc-surface-hover hover:text-wc-text-secondary'
      }`}
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
        className={`w-9 h-9 rounded-[10px] flex items-center justify-center relative text-[13px] font-semibold cursor-pointer transition-all duration-150 ease-out ${
          active
            ? 'bg-wc-accent-soft text-wc-accent-text border border-wc-accent'
            : 'bg-wc-surface text-wc-text-secondary border border-wc-border hover:border-wc-border-strong hover:bg-wc-surface-hover'
        }`}
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
  const { orchestrationPhase, tasks } = useTaskStore(
    useShallow((s) => ({ orchestrationPhase: s.orchestrationPhase, tasks: s.tasks })),
  );
  const sessionName = useUIStore((s) => s.sessionName);
  const [showHistory, setShowHistory] = useState(false);

  // Session is visible when there are tasks in the current runtime session
  const hasSession = tasks.size > 0 || orchestrationPhase !== 'idle';
  const displayLabel = sessionName || 'Session';

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
            className="w-9 h-9 rounded-[10px] flex items-center justify-center bg-transparent text-wc-text-muted border-[1.5px] border-dashed border-wc-border-strong cursor-pointer text-lg font-light leading-none transition-all duration-150 ease-out hover:border-wc-accent hover:text-wc-accent-text hover:bg-wc-accent-soft"
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
          <div className="flex flex-col items-center">
            <IconButton active={showHistory} onClick={() => setShowHistory(!showHistory)} aria-label="Session history">
              <History size={16} />
            </IconButton>
            <span className="text-[8px] text-wc-text-muted mt-0.5">History</span>
          </div>
        </Tooltip>

        <Tooltip label="Settings">
          <div className="flex flex-col items-center">
            <IconButton active={activeView === 'settings'} onClick={() => setActiveView('settings')} aria-label="Settings">
              <Settings size={16} />
            </IconButton>
            <span className="text-[8px] text-wc-text-muted mt-0.5">Settings</span>
          </div>
        </Tooltip>
      </div>

      {/* Session History panel */}
      {showHistory && <SessionHistory onClose={() => setShowHistory(false)} />}
    </nav>
  );
}
