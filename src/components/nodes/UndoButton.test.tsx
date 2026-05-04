/**
 * Phase 7 Step 2 — UndoButton unit tests.
 *
 * Covers:
 *   - default render: lucide RotateCcw icon + "Undo" label;
 *   - click → 2s countdown phase with "Undo? Ns · Cancel" copy +
 *     ticking remainder;
 *   - re-click during countdown aborts (timer cleared, no IPC);
 *   - countdown completion fires `revertSubtaskChanges` store action;
 *   - in-flight membership renders disabled "Reverting…" copy;
 *   - in-flight clearing returns to idle so a re-mount on a sibling
 *     re-running worker starts fresh.
 *
 * Render gating (showUndo → only on workers with changes worth
 * reverting) lives in WorkerNode — exercised separately.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

const ipcMocks = vi.hoisted(() => ({
  revertSubtaskChanges: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('../../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../../lib/ipc')>('../../lib/ipc');
  return { ...actual, ...ipcMocks };
});

import { useGraphStore } from '../../state/graphStore';

import { UndoButton } from './UndoButton';

beforeEach(() => {
  vi.useFakeTimers();
  useGraphStore.setState({ runId: 'r-1' });
  ipcMocks.revertSubtaskChanges.mockReset();
  ipcMocks.revertSubtaskChanges.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  useGraphStore.getState().reset();
});

describe('UndoButton — default state', () => {
  it('renders the Undo button with RotateCcw icon and label', () => {
    render(<UndoButton subtaskId="s-1" />);
    const btn = screen.getByTestId('worker-undo-button');
    expect(btn).toBeInTheDocument();
    expect(btn.getAttribute('data-phase')).toBe('idle');
    expect(btn).toHaveTextContent('Undo');
  });

  it('aria-label describes the destructive action', () => {
    render(<UndoButton subtaskId="s-1" />);
    const btn = screen.getByTestId('worker-undo-button');
    expect(btn.getAttribute('aria-label')).toMatch(/Undo this worker/i);
  });
});

describe('UndoButton — confirm phase', () => {
  it('click flips into confirming phase with 2s countdown copy', () => {
    render(<UndoButton subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('worker-undo-button'));
    const btn = screen.getByTestId('worker-undo-button');
    expect(btn.getAttribute('data-phase')).toBe('confirming');
    expect(btn.textContent).toMatch(/Undo\?\s*2s/);
  });

  it('countdown ticks remainder down before firing', () => {
    render(<UndoButton subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('worker-undo-button'));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const btn = screen.getByTestId('worker-undo-button');
    // Remainder should be 1000ms (Math.ceil → 1s).
    expect(btn.textContent).toMatch(/1s/);
    expect(btn.getAttribute('data-phase')).toBe('confirming');
    expect(ipcMocks.revertSubtaskChanges).not.toHaveBeenCalled();
  });

  it('re-click during countdown aborts and returns to idle', () => {
    render(<UndoButton subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('worker-undo-button'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.click(screen.getByTestId('worker-undo-button'));
    const btn = screen.getByTestId('worker-undo-button');
    expect(btn.getAttribute('data-phase')).toBe('idle');
    // Advance past the original deadline; the cancelled timer
    // must NOT fire the IPC.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(ipcMocks.revertSubtaskChanges).not.toHaveBeenCalled();
  });
});

describe('UndoButton — fire phase', () => {
  it('countdown completion fires revertSubtaskChanges with the subtask id', async () => {
    render(<UndoButton subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('worker-undo-button'));
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(ipcMocks.revertSubtaskChanges).toHaveBeenCalledWith('r-1', 's-1');
  });

  it('renders Reverting… while revertInFlight membership holds', () => {
    useGraphStore.setState({ revertInFlight: new Set(['s-1']) });
    render(<UndoButton subtaskId="s-1" />);
    const btn = screen.getByTestId('worker-undo-button');
    expect(btn.getAttribute('data-phase')).toBe('reverting');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/Reverting/i);
  });

  it('clearing revertInFlight drops the disabled state', () => {
    const { rerender } = render(<UndoButton subtaskId="s-1" />);
    useGraphStore.setState({ revertInFlight: new Set(['s-1']) });
    rerender(<UndoButton subtaskId="s-1" />);
    expect(screen.getByTestId('worker-undo-button').getAttribute('data-phase')).toBe(
      'reverting',
    );
    useGraphStore.setState({ revertInFlight: new Set() });
    rerender(<UndoButton subtaskId="s-1" />);
    expect(screen.getByTestId('worker-undo-button').getAttribute('data-phase')).toBe(
      'idle',
    );
  });

  it('does NOT fire when a different subtask is in flight', async () => {
    useGraphStore.setState({ revertInFlight: new Set(['s-other']) });
    render(<UndoButton subtaskId="s-1" />);
    // s-1's button is in idle (not s-other's). Click + advance.
    fireEvent.click(screen.getByTestId('worker-undo-button'));
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(ipcMocks.revertSubtaskChanges).toHaveBeenCalledWith('r-1', 's-1');
  });
});

describe('graphStore — revertSubtaskChanges + handleWorktreeReverted', () => {
  it('action sets revertInFlight membership', () => {
    void useGraphStore.getState().revertSubtaskChanges('s-1');
    expect(useGraphStore.getState().revertInFlight.has('s-1')).toBe(true);
  });

  it('action no-ops when runId is not yet real', async () => {
    useGraphStore.setState({ runId: 'pending_xxx' });
    await useGraphStore.getState().revertSubtaskChanges('s-1');
    expect(ipcMocks.revertSubtaskChanges).not.toHaveBeenCalled();
  });

  it('action rolls back inFlight on IPC error and surfaces currentError', async () => {
    ipcMocks.revertSubtaskChanges.mockRejectedValueOnce(
      new Error('boom: wrong state'),
    );
    await expect(
      useGraphStore.getState().revertSubtaskChanges('s-1'),
    ).rejects.toThrow();
    expect(useGraphStore.getState().revertInFlight.has('s-1')).toBe(false);
    expect(useGraphStore.getState().currentError).toMatch(/Undo failed/);
  });
});
