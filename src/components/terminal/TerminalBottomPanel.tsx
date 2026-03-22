import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import { C, LOG_COLOR } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { useTaskStore } from '@/stores/taskStore';

/**
 * VS Code-style collapsible bottom panel showing orchestration logs.
 * Replaces the separate TerminalView — always available at the bottom of any view.
 */
interface TerminalBottomPanelProps {
  open: boolean;
  onToggle: () => void;
  devMode?: boolean;
}

export function TerminalBottomPanel({ open, onToggle }: TerminalBottomPanelProps) {
  const orchestrationLogs = useTaskStore((s) => s.orchestrationLogs);
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  const [height, setHeight] = useState(220);
  const logRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const isActive = orchestrationPhase !== 'idle';

  // Auto-scroll on new logs
  useEffect(() => {
    if (open && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [orchestrationLogs.length, open]);

  // Resize drag
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeRef.current = { startY: e.clientY, startHeight: height };
    const onMove = (me: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.startY - me.clientY;
      setHeight(Math.max(100, Math.min(600, resizeRef.current.startHeight + delta)));
    };
    const onUp = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [height]);

  const logCount = orchestrationLogs.length;
  const errorCount = useMemo(() => orchestrationLogs.filter(l => l.level === 'error').length, [orchestrationLogs]);
  const visibleLogs = orchestrationLogs.slice(-200);

  return (
    <div style={{ flexShrink: 0, borderTop: `1px solid ${C.border}` }}>
      {/* Toggle bar — always visible */}
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 12px',
          background: C.panel,
          border: 'none',
          color: C.textMuted,
          fontSize: 11,
          fontFamily: 'Inter, sans-serif',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <Terminal size={12} />
        <span style={{ fontWeight: 600 }}>Output</span>
        {logCount > 0 && (
          <span style={{
            padding: '0 6px',
            borderRadius: 999,
            background: C.surface,
            fontSize: 10,
            color: C.textSecondary,
          }}>
            {logCount}
          </span>
        )}
        {errorCount > 0 && (
          <span style={{
            padding: '0 6px',
            borderRadius: 999,
            background: C.redBg,
            fontSize: 10,
            color: C.red,
            fontWeight: 600,
          }}>
            {errorCount} error{errorCount !== 1 ? 's' : ''}
          </span>
        )}
        {isActive && (
          <span
            className="heartbeat-pulse"
            style={{
              width: 6, height: 6, borderRadius: '50%',
              background: C.green, display: 'inline-block',
            }}
          />
        )}
        <span style={{ flex: 1 }} />
        {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
      </button>

      {/* Panel content */}
      <div style={{ height: open ? height : 0, overflow: 'hidden', transition: 'height 200ms cubic-bezier(0.4, 0, 0.2, 1)', display: 'flex', flexDirection: 'column', background: '#07070f', willChange: open ? 'height' : 'auto' }}>
          {/* Resize handle */}
          <div
            onMouseDown={handleResizeStart}
            style={{
              height: 3,
              cursor: 'row-resize',
              background: 'transparent',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.accent; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          />

          {/* Log content */}
          <div
            ref={logRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '8px 12px',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              lineHeight: '18px',
            }}
          >
            {visibleLogs.length === 0 ? (
              <div style={{ color: C.textMuted, padding: '20px 0', textAlign: 'center' }}>
                No output yet. Start an orchestration to see logs here.
              </div>
            ) : (
              visibleLogs.map((log) => (
                <div key={log.id} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
                  <span style={{ color: C.textMuted, flexShrink: 0, width: 60 }}>{log.timestamp}</span>
                  <span style={{
                    width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                    background: AGENTS[log.agent]?.gradient ?? C.surface,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 8, fontWeight: 700, color: '#fff',
                  }}>
                    {AGENTS[log.agent]?.letter ?? '?'}
                  </span>
                  <span style={{
                    color: LOG_COLOR[log.level] ?? C.textSecondary,
                    wordBreak: 'break-word',
                  }}>
                    {log.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
    </div>
  );
}
