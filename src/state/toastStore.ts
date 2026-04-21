import { create } from 'zustand';

/**
 * Minimal transient-toast store. Phase 4 Step 4 introduces this surface
 * for WorktreeActions: reveal/copy/terminal feedback. Kept deliberately
 * small so it's easy to retrofit onto other flows (e.g. Phase 5's
 * settings-save confirmation) without a library dependency.
 *
 * Toasts auto-dismiss after `DEFAULT_AUTO_DISMISS_MS`; the caller can
 * override per-toast or pass `autoDismissMs: null` to require manual
 * dismissal (for hard errors the user must read). `dismiss(id)` is
 * idempotent — firing after auto-dismiss is a no-op. Ids are coined
 * here so callers don't have to think about uniqueness; the store
 * monotonically increments a counter across the session.
 */
export type ToastKind = 'success' | 'error' | 'info';

export type Toast = {
  id: string;
  kind: ToastKind;
  message: string;
};

type ShowInput = {
  kind: ToastKind;
  message: string;
  /**
   * Milliseconds until auto-dismiss. `null` pins the toast until the
   * user clicks Dismiss — reserved for errors where silently vanishing
   * text would cost the user context.
   */
  autoDismissMs?: number | null;
};

type ToastStore = {
  toasts: Toast[];
  show: (input: ShowInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
};

export const DEFAULT_AUTO_DISMISS_MS = 3500;

let nextId = 0;
function coinId(): string {
  nextId += 1;
  return `t${nextId}`;
}

// Module-scoped timer registry — parallel to the store so handles
// survive re-renders. Cleared on dismiss/clear so dev-mode HMR doesn't
// leak callbacks that mutate a freshly re-mounted store.
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelTimer(id: string): void {
  const h = timers.get(id);
  if (h !== undefined) {
    clearTimeout(h);
    timers.delete(id);
  }
}

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  show: ({ kind, message, autoDismissMs }) => {
    const id = coinId();
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    const ms = autoDismissMs === undefined ? DEFAULT_AUTO_DISMISS_MS : autoDismissMs;
    if (ms !== null) {
      const handle = setTimeout(() => {
        // Re-read state on fire: the user may have already dismissed.
        get().dismiss(id);
      }, ms);
      timers.set(id, handle);
    }
    return id;
  },
  dismiss: (id) => {
    cancelTimer(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  clear: () => {
    for (const id of timers.keys()) cancelTimer(id);
    set({ toasts: [] });
  },
}));
