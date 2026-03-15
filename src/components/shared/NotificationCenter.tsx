import { useState, useRef, useEffect } from 'react';
import { Bell, Check, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useNotificationStore, type AppNotification } from '@/stores/notificationStore';
import { useUIStore, type AppView } from '@/stores/uiStore';

/* ── Helpers ───────────────────────────────────────────── */

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const TYPE_STYLES: Record<AppNotification['type'], { dot: string; bg: string }> = {
  info: { dot: 'bg-wc-accent-text', bg: 'bg-wc-accent-soft/50' },
  success: { dot: 'bg-wc-green', bg: 'bg-wc-green-bg' },
  warning: { dot: 'bg-wc-amber', bg: 'bg-wc-amber-bg' },
  error: { dot: 'bg-wc-red', bg: 'bg-wc-red-bg' },
};

/* ── Component ─────────────────────────────────────────── */

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const notifications = useNotificationStore((s) => s.notifications);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const clearAll = useNotificationStore((s) => s.clearAll);
  const restoreNotifications = useNotificationStore((s) => s.restoreNotifications);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setSelectedTaskId = useUIStore((s) => s.setSelectedTaskId);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleAction = (n: AppNotification) => {
    markRead(n.id);
    if (n.action?.view) {
      setActiveView(n.action.view as AppView);
    }
    if (n.action?.taskId) {
      setSelectedTaskId(n.action.taskId);
      setActiveView('kanban');
    }
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className="relative flex items-center justify-center size-8 rounded-lg transition-colors hover:bg-wc-surface-hover"
        aria-label="Notifications"
      >
        <Bell size={15} className="text-wc-text-muted" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-wc-red text-[9px] font-bold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute top-full right-0 mt-2 z-50 w-[360px] max-h-[480px] flex flex-col rounded-xl border border-wc-border-strong bg-wc-panel shadow-[0_16px_48px_rgba(0,0,0,0.6)]"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-wc-border">
            <h3 className="text-sm font-semibold text-wc-text-primary m-0">Notifications</h3>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-wc-text-muted hover:text-wc-text-secondary hover:bg-wc-surface transition-colors"
                  title="Mark all read"
                >
                  <Check size={10} />
                  Read all
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  onClick={() => {
                    const saved = [...notifications];
                    clearAll();
                    toast('Notifications cleared', {
                      action: {
                        label: 'Undo',
                        onClick: () => restoreNotifications(saved),
                      },
                      duration: 5000,
                    });
                  }}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-wc-text-muted hover:text-wc-red hover:bg-wc-red-bg transition-colors"
                  title="Clear all"
                >
                  <Trash2 size={10} />
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="flex items-center justify-center size-6 rounded text-wc-text-muted hover:text-wc-text-secondary hover:bg-wc-surface transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-wc-text-muted">
                No notifications yet
              </div>
            ) : (
              notifications.map((n) => {
                const style = TYPE_STYLES[n.type];
                return (
                  <button
                    key={n.id}
                    onClick={() => handleAction(n)}
                    className={`w-full flex items-start gap-3 px-4 py-3 text-left border-b border-wc-border transition-colors hover:bg-wc-surface-hover ${
                      !n.read ? style.bg : ''
                    }`}
                  >
                    <span className={`size-2 rounded-full mt-1.5 shrink-0 ${style.dot}`} />
                    <div className="flex-1 min-w-0">
                      <div className={`text-xs font-medium truncate ${n.read ? 'text-wc-text-secondary' : 'text-wc-text-primary'}`}>
                        {n.title}
                      </div>
                      {n.description && (
                        <div className="text-[11px] text-wc-text-muted mt-0.5 line-clamp-2">
                          {n.description}
                        </div>
                      )}
                      <div className="text-[10px] text-wc-text-muted mt-1">
                        {timeAgo(n.timestamp)}
                      </div>
                    </div>
                    {n.action && (
                      <span className="text-[10px] text-wc-accent-text shrink-0 mt-0.5">
                        {n.action.label}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
