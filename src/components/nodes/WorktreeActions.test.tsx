/**
 * Phase 4 Step 4 — WorktreeActions unit tests.
 *
 * Covers:
 *   - trigger + menu render / keyboard dismiss / Escape close;
 *   - each action calls the correct IPC wrapper with runId+subtaskId;
 *   - Copy path writes to `navigator.clipboard` and toasts success;
 *   - Open terminal branches on `clipboard-only` and falls back to
 *     clipboard with an info toast;
 *   - IPC rejection surfaces as an error toast (never-dismiss);
 *   - clipboard failure surfaces an error toast.
 *
 * The component only reads `runId` from the graph store (we seed it
 * directly). All IPC functions come from `../../lib/ipc`, which we
 * mock at module boundary so a click asserts our override was invoked.
 * Render gating by state lives in WorkerNode — tested separately in
 * WorkerNode.test.tsx.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

// `vi.hoisted` moves the mock declaration ahead of the hoisted
// `vi.mock` call so the factory closure can reference it. Without
// this, Vitest errors with "Cannot access 'ipcMocks' before
// initialization" because plain top-level `const` lands *below* the
// hoisted mock.
const ipcMocks = vi.hoisted(() => ({
  getSubtaskWorktreePath: vi.fn(async (): Promise<string> => '/tmp/wt'),
  revealWorktree: vi.fn(async (): Promise<string> => '/tmp/wt'),
  openTerminalAt: vi.fn(
    async (): Promise<{ method: 'spawned' | 'clipboard-only'; path: string }> => ({
      method: 'spawned',
      path: '/tmp/wt',
    }),
  ),
}));

vi.mock('../../lib/ipc', async () => {
  // Re-export the real module and overlay our three mocks. The graph
  // store imports a dozen other symbols (submitTask, approveSubtasks,
  // …) that we don't want to stub out.
  const actual = await vi.importActual<typeof import('../../lib/ipc')>('../../lib/ipc');
  return { ...actual, ...ipcMocks };
});

import { useGraphStore } from '../../state/graphStore';
import { useToastStore } from '../../state/toastStore';

import { WorktreeActions } from './WorktreeActions';

type ClipboardHandles = {
  writeText: ReturnType<typeof vi.fn>;
};

function installClipboard(fn: ClipboardHandles['writeText']): void {
  // jsdom doesn't ship a clipboard by default. Define once and each test
  // swaps `fn.mockImplementation` as needed.
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: fn },
  });
}

beforeEach(() => {
  useGraphStore.setState({ runId: 'r-1' });
  useToastStore.getState().clear();
  for (const fn of Object.values(ipcMocks)) fn.mockClear();
  ipcMocks.openTerminalAt.mockResolvedValue({
    method: 'spawned',
    path: '/tmp/wt',
  });
});

afterEach(() => {
  useGraphStore.getState().reset();
  useToastStore.getState().clear();
});

describe('WorktreeActions — trigger + menu', () => {
  it('renders a folder-icon trigger and opens the menu on click', () => {
    render(<WorktreeActions subtaskId="s-1" />);
    const trigger = screen.getByTestId('worktree-actions-trigger-s-1');
    expect(trigger).toBeInTheDocument();
    expect(screen.queryByTestId('worktree-actions-menu-s-1')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByTestId('worktree-actions-menu-s-1')).toBeInTheDocument();
  });

  it('closes on Escape', () => {
    render(<WorktreeActions subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('worktree-actions-trigger-s-1'));
    const menu = screen.getByTestId('worktree-actions-menu-s-1');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByTestId('worktree-actions-menu-s-1')).toBeNull();
  });
});

describe('WorktreeActions — reveal', () => {
  it('calls revealWorktree and toasts success', async () => {
    render(<WorktreeActions subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('worktree-actions-trigger-s-1'));
    fireEvent.click(screen.getByTestId('worktree-actions-item-reveal-s-1'));
    await waitFor(() => {
      expect(ipcMocks.revealWorktree).toHaveBeenCalledWith('r-1', 's-1');
    });
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].kind).toBe('success');
    });
  });

  it('surfaces reveal rejection as a non-auto-dismiss error toast', async () => {
    ipcMocks.revealWorktree.mockRejectedValueOnce(new Error('no file manager'));
    render(<WorktreeActions subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('worktree-actions-trigger-s-1'));
    fireEvent.click(screen.getByTestId('worktree-actions-item-reveal-s-1'));
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].kind).toBe('error');
      expect(toasts[0].message).toContain('no file manager');
    });
  });
});

describe('WorktreeActions — copy path', () => {
  it('writes the path to the clipboard and toasts success', async () => {
    const writeText = vi.fn(async () => undefined);
    installClipboard(writeText);
    render(<WorktreeActions subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('worktree-actions-trigger-s-1'));
    fireEvent.click(screen.getByTestId('worktree-actions-item-copy-s-1'));
    await waitFor(() => {
      expect(ipcMocks.getSubtaskWorktreePath).toHaveBeenCalledWith('r-1', 's-1');
      expect(writeText).toHaveBeenCalledWith('/tmp/wt');
    });
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts[0]?.kind).toBe('success');
    });
  });

  it('surfaces clipboard.writeText rejection as an error toast', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('clipboard blocked');
    });
    installClipboard(writeText);
    render(<WorktreeActions subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('worktree-actions-trigger-s-1'));
    fireEvent.click(screen.getByTestId('worktree-actions-item-copy-s-1'));
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts[0]?.kind).toBe('error');
      expect(toasts[0]?.message).toContain('clipboard blocked');
    });
  });
});

describe('WorktreeActions — open terminal', () => {
  it('toasts success when the backend reports spawned', async () => {
    render(<WorktreeActions subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('worktree-actions-trigger-s-1'));
    fireEvent.click(screen.getByTestId('worktree-actions-item-terminal-s-1'));
    await waitFor(() => {
      expect(ipcMocks.openTerminalAt).toHaveBeenCalledWith('r-1', 's-1');
    });
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts[0]?.kind).toBe('success');
    });
  });

  it('falls back to clipboard + info toast on clipboard-only', async () => {
    ipcMocks.openTerminalAt.mockResolvedValueOnce({
      method: 'clipboard-only',
      path: '/tmp/wt',
    });
    const writeText = vi.fn(async () => undefined);
    installClipboard(writeText);
    render(<WorktreeActions subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('worktree-actions-trigger-s-1'));
    fireEvent.click(screen.getByTestId('worktree-actions-item-terminal-s-1'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('/tmp/wt');
    });
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts[0]?.kind).toBe('info');
    });
  });

  it('emits a pinned error toast when both terminal and clipboard fail', async () => {
    ipcMocks.openTerminalAt.mockResolvedValueOnce({
      method: 'clipboard-only',
      path: '/tmp/wt',
    });
    const writeText = vi.fn(async () => {
      throw new Error('clipboard blocked');
    });
    installClipboard(writeText);
    render(<WorktreeActions subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('worktree-actions-trigger-s-1'));
    fireEvent.click(screen.getByTestId('worktree-actions-item-terminal-s-1'));
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts[0]?.kind).toBe('error');
    });
  });
});
