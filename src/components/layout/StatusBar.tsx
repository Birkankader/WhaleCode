import { useMemo, useEffect, useState } from 'react';
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
    <div className="flex items-center gap-4 px-4 border-t border-wc-border bg-[#07070f] text-[11px] h-[26px] shrink-0">
      <div className="flex items-center gap-1.5 text-wc-text-muted">
        {activityStatus === 'active' ? (
          <>
            <span className="heartbeat-pulse size-1.5 rounded-full bg-wc-green inline-block shrink-0" />
            <span className="text-wc-green">Processing...</span>
          </>
        ) : activityStatus === 'waiting' ? (
          <>
            <span className="size-1.5 rounded-full bg-wc-amber inline-block shrink-0" />
            <span className="text-wc-amber">Waiting for response...</span>
          </>
        ) : (
          <>
            <span className="size-1.5 rounded-full bg-wc-green" />
            Agents ready
          </>
        )}
      </div>
      {activityStatus !== 'idle' && secondsAgo !== null && (
        <>
          <span className="text-wc-border-strong">|</span>
          <div className="text-wc-text-muted">
            Last activity:{' '}
            <span className={activityStatus === 'active' ? 'text-wc-green' : 'text-wc-amber'}>
              {secondsAgo}s ago
            </span>
          </div>
        </>
      )}
      <span className="text-wc-border-strong">|</span>
      <div className="text-wc-text-muted">
        Session: <span className="text-wc-text-secondary">{sessionName}</span>
      </div>
      <span className="text-wc-border-strong">|</span>
      <div className="text-wc-text-muted">
        Progress:{' '}
        <span className="text-wc-amber">
          {totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0}%
        </span>
      </div>
      <div className="flex-1" />
      {developerMode && (
        <div className="flex items-center gap-1 text-wc-accent-text">
          <span className="size-1.5 rounded-full bg-wc-accent-text" />
          Developer Mode
        </div>
      )}
      <span className="text-wc-border-strong">|</span>
      <span className="text-wc-text-muted">WhaleCode v0.1.0</span>
    </div>
  );
}
