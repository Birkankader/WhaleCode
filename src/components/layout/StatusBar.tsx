import { useMemo, useEffect, useState } from 'react';
import { C } from '@/lib/theme';
import { useUIStore } from '@/stores/uiStore';
import { useTaskStore } from '@/stores/taskStore';

/**
 * Bottom status bar showing activity status, session info, and progress.
 */
export function StatusBar() {
  const developerMode = useUIStore((s) => s.developerMode);
  const storedSessionName = useUIStore((s) => s.sessionName);
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  const tasks = useTaskStore((s) => s.tasks);
  const activePlan = useTaskStore((s) => s.activePlan);

  const isOrchestrating = orchestrationPhase !== 'idle';

  // Activity heartbeat tracking
  const [secondsAgo, setSecondsAgo] = useState<number | null>(null);

  useEffect(() => {
    if (!isOrchestrating) {
      setSecondsAgo(null);
      return;
    }
    const interval = setInterval(() => {
      const logs = useTaskStore.getState().orchestrationLogs;
      if (logs.length === 0) {
        setSecondsAgo(null);
        return;
      }
      const lastLog = logs[logs.length - 1];
      const parts = lastLog.timestamp.split(':');
      if (parts.length === 3) {
        const now = new Date();
        const logDate = new Date();
        logDate.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10));
        const diff = Math.floor((now.getTime() - logDate.getTime()) / 1000);
        setSecondsAgo(Math.max(0, diff));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [isOrchestrating]);

  const activityStatus: 'active' | 'waiting' | 'idle' = useMemo(() => {
    if (!isOrchestrating) return 'idle';
    if (secondsAgo === null) return 'idle';
    if (secondsAgo <= 15) return 'active';
    return 'waiting';
  }, [isOrchestrating, secondsAgo]);

  const sessionName = storedSessionName || (activePlan ? 'Active Session' : 'No Session');
  const doneTasks = Array.from(tasks.values()).filter((t) => t.status === 'completed').length;
  const totalTasks = tasks.size;

  return (
    <div
      className="flex items-center gap-4 px-4 border-t flex-shrink-0"
      style={{ height: 26, borderColor: C.border, background: '#07070f', fontSize: 11 }}
    >
      <div className="flex items-center gap-1.5" style={{ color: C.textMuted }}>
        {activityStatus === 'active' ? (
          <>
            <span
              className="heartbeat-pulse"
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: C.green,
                display: 'inline-block',
                flexShrink: 0,
              }}
            />
            <span style={{ color: C.green }}>Processing...</span>
          </>
        ) : activityStatus === 'waiting' ? (
          <>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: C.amber,
                display: 'inline-block',
                flexShrink: 0,
              }}
            />
            <span style={{ color: C.amber }}>Waiting for response...</span>
          </>
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: C.green }} />
            Agents ready
          </>
        )}
      </div>
      {activityStatus !== 'idle' && secondsAgo !== null && (
        <>
          <span style={{ color: C.borderStrong }}>|</span>
          <div style={{ color: C.textMuted }}>
            Last activity:{' '}
            <span style={{ color: activityStatus === 'active' ? C.green : C.amber }}>
              {secondsAgo}s ago
            </span>
          </div>
        </>
      )}
      <span style={{ color: C.borderStrong }}>|</span>
      <div style={{ color: C.textMuted }}>
        Session: <span style={{ color: C.textSecondary }}>{sessionName}</span>
      </div>
      <span style={{ color: C.borderStrong }}>|</span>
      <div style={{ color: C.textMuted }}>
        Progress:{' '}
        <span style={{ color: C.amber }}>
          {totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0}%
        </span>
      </div>
      <div className="flex-1" />
      {developerMode && (
        <div className="flex items-center gap-1" style={{ color: C.accentText }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: C.accentText }} />
          Developer Mode
        </div>
      )}
      <span style={{ color: C.borderStrong }}>|</span>
      <span style={{ color: C.textMuted }}>WhaleCode v0.1.0</span>
    </div>
  );
}
