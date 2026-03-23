import { useState, useEffect, useRef } from 'react';
import { History, Clock, CheckCircle, XCircle, Users } from 'lucide-react';
import { commands } from '@/bindings';
import type { OrchestrationRecord } from '@/bindings';

/* ── Helpers ───────────────────────────────────────────── */

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const min = Math.floor(secs / 60);
  const sec = secs % 60;
  return `${min}m ${sec}s`;
}

function timeAgo(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  const days = Math.floor(diff / 86400);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/* ── Component ─────────────────────────────────────────── */

interface SessionHistoryProps {
  onClose: () => void;
}

export function SessionHistory({ onClose }: SessionHistoryProps) {
  const [records, setRecords] = useState<OrchestrationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    commands.getOrchestrationHistory(20)
      .then((result) => {
        if (result.status === 'ok') setRecords(result.data);
      })
      .catch((err) => console.warn('Failed to load orchestration history:', err))
      .finally(() => setLoading(false));
  }, []);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className="absolute left-[64px] top-0 z-50 w-[320px] max-h-[500px] flex flex-col rounded-xl border border-wc-border-strong bg-wc-panel shadow-[0_16px_48px_rgba(0,0,0,0.6)]"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-wc-border shrink-0">
        <History size={14} className="text-wc-accent-text" />
        <h3 className="text-sm font-semibold text-wc-text-primary m-0">Session History</h3>
        <span className="ml-auto text-[10px] text-wc-text-muted">
          {records.length} session{records.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="px-4 py-8 text-center text-sm text-wc-text-muted">Loading...</div>
        ) : records.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-wc-text-muted">
            No previous sessions found.
            <br />
            <span className="text-[11px]">Complete an orchestration to see it here.</span>
          </div>
        ) : (
          records.map((record) => (
            <div
              key={record.id}
              className="flex items-start gap-3 px-4 py-3 border-b border-wc-border hover:bg-wc-surface-hover transition-colors"
            >
              {/* Status icon */}
              <div className={`mt-0.5 shrink-0 ${record.success ? 'text-wc-green' : 'text-wc-red'}`}>
                {record.success ? <CheckCircle size={14} /> : <XCircle size={14} />}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-wc-text-primary truncate">
                    Session #{record.task_id.slice(0, 8)}
                  </span>
                  <span className={`text-[9px] font-bold uppercase px-1.5 py-px rounded ${
                    record.success
                      ? 'bg-wc-green-bg text-wc-green'
                      : 'bg-wc-red-bg text-wc-red'
                  }`}>
                    {record.success ? 'Success' : 'Failed'}
                  </span>
                </div>

                <div className="flex items-center gap-3 mt-1.5 text-[10px] text-wc-text-muted">
                  <span className="flex items-center gap-1">
                    <Clock size={9} />
                    {formatDuration(record.duration_secs)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Users size={9} />
                    {record.agent_count} agent{record.agent_count !== 1 ? 's' : ''}
                  </span>
                  <span>{timeAgo(record.created_at)}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
