import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AUTO_DISMISS_MS, useToastStore } from './toastStore';

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.getState().clear();
});

afterEach(() => {
  useToastStore.getState().clear();
  vi.useRealTimers();
});

describe('toastStore', () => {
  it('appends toasts with unique ids in insertion order', () => {
    const s = useToastStore.getState();
    s.show({ kind: 'success', message: 'one' });
    s.show({ kind: 'error', message: 'two' });
    const toasts = useToastStore.getState().toasts;
    expect(toasts.map((t) => t.message)).toEqual(['one', 'two']);
    expect(new Set(toasts.map((t) => t.id)).size).toBe(2);
  });

  it('auto-dismisses after DEFAULT_AUTO_DISMISS_MS', () => {
    useToastStore.getState().show({ kind: 'info', message: 'hi' });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(DEFAULT_AUTO_DISMISS_MS - 1);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('respects autoDismissMs: null — toast pinned until manual dismiss', () => {
    const id = useToastStore
      .getState()
      .show({ kind: 'error', message: 'stuck', autoDismissMs: null });
    vi.advanceTimersByTime(60_000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    useToastStore.getState().dismiss(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('dismiss cancels the auto-timer so no double-fire', () => {
    const id = useToastStore.getState().show({ kind: 'info', message: 'once' });
    useToastStore.getState().dismiss(id);
    // Second dismiss after the auto-timer would fire is a no-op.
    vi.advanceTimersByTime(DEFAULT_AUTO_DISMISS_MS * 2);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('clear removes every toast and cancels pending timers', () => {
    useToastStore.getState().show({ kind: 'info', message: 'a' });
    useToastStore.getState().show({ kind: 'info', message: 'b' });
    useToastStore.getState().clear();
    expect(useToastStore.getState().toasts).toHaveLength(0);
    vi.advanceTimersByTime(DEFAULT_AUTO_DISMISS_MS * 2);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
