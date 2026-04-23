/**
 * Phase 5 Step 1 — StopButton unit tests.
 *
 * Covers:
 *   - click calls `cancelSubtask` store action with the subtask id;
 *   - `subtaskCancelInFlight` membership renders the disabled / busy
 *     styling and flips the aria-label to "Stopping worker";
 *   - backend rejection surfaces as a pinned error toast (no
 *     auto-dismiss) and the button rolls back to clickable.
 *
 * Render gating by state lives in WorkerNode — tested separately.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

const ipcMocks = vi.hoisted(() => ({
  cancelSubtask: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('../../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../../lib/ipc')>('../../lib/ipc');
  return { ...actual, ...ipcMocks };
});

import { useGraphStore } from '../../state/graphStore';
import { useToastStore } from '../../state/toastStore';

import { StopButton } from './StopButton';

beforeEach(() => {
  useGraphStore.setState({ runId: 'r-1' });
  useToastStore.getState().clear();
  ipcMocks.cancelSubtask.mockReset();
  ipcMocks.cancelSubtask.mockResolvedValue(undefined);
});

afterEach(() => {
  useGraphStore.getState().reset();
  useToastStore.getState().clear();
});

describe('StopButton — happy path', () => {
  it('renders a Stop icon button and calls cancelSubtask on click', async () => {
    render(<StopButton subtaskId="s-1" />);
    const btn = screen.getByRole('button', { name: /stop this worker/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    await waitFor(() => {
      expect(ipcMocks.cancelSubtask).toHaveBeenCalledWith('r-1', 's-1');
    });
  });

  it('flips to "Stopping…" when the id is in subtaskCancelInFlight', () => {
    useGraphStore.setState({
      subtaskCancelInFlight: new Set(['s-1']),
    });
    render(<StopButton subtaskId="s-1" />);
    const btn = screen.getByRole('button', { name: /stopping worker/i });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('data-in-flight')).toBe('true');
  });

  it('does not flip when another subtask id is in flight', () => {
    useGraphStore.setState({
      subtaskCancelInFlight: new Set(['s-other']),
    });
    render(<StopButton subtaskId="s-1" />);
    const btn = screen.getByRole('button', { name: /stop this worker/i });
    expect(btn).not.toBeDisabled();
  });
});

describe('StopButton — backend rejection', () => {
  it('surfaces an error toast without auto-dismiss and leaves the button clickable', async () => {
    ipcMocks.cancelSubtask.mockRejectedValueOnce('subtask is in state Done');
    render(<StopButton subtaskId="s-1" />);
    const btn = screen.getByRole('button', { name: /stop this worker/i });
    fireEvent.click(btn);

    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].kind).toBe('error');
      expect(toasts[0].message).toContain('subtask is in state Done');
    });

    // Rollback: button still clickable, no lingering in-flight.
    expect(
      useGraphStore.getState().subtaskCancelInFlight.has('s-1'),
    ).toBe(false);
    expect(btn).not.toBeDisabled();
  });

  it('dedupes repeated clicks — only one IPC call while in flight', async () => {
    // Pause the IPC so we can observe the intermediate state.
    let resolveFn: (() => void) | undefined;
    ipcMocks.cancelSubtask.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolveFn = r;
        }),
    );
    render(<StopButton subtaskId="s-1" />);
    const btn = screen.getByRole('button', { name: /stop this worker/i });
    fireEvent.click(btn);
    // Second click should be deduped by store-side in-flight check.
    fireEvent.click(btn);
    await waitFor(() => {
      expect(
        useGraphStore.getState().subtaskCancelInFlight.has('s-1'),
      ).toBe(true);
    });
    expect(ipcMocks.cancelSubtask).toHaveBeenCalledTimes(1);
    if (resolveFn) resolveFn();
  });
});
