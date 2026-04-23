/**
 * Phase 5 Step 3 — ConflictResolverPopover unit tests.
 *
 * Covers:
 *   - visibility gated on mergeConflict + conflictResolverOpen;
 *   - conflicted-file list rendering;
 *   - per-worker attribution joined from subtaskDiffs;
 *   - Reveal-in-Finder button calls `revealWorktree` for the right
 *     subtask;
 *   - Retry apply button fires `retryApply` store action;
 *   - Retry-attempt counter in the title on subsequent conflicts;
 *   - Dismiss / Escape close the popover without clearing the
 *     store's mergeConflict state (banner "Open resolver" reopens
 *     via store flag).
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
  revealWorktree: vi.fn(async (): Promise<string> => '/tmp/wt'),
}));

vi.mock('../../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../../lib/ipc')>('../../lib/ipc');
  return { ...actual, ...ipcMocks };
});

import { useGraphStore } from '../../state/graphStore';
import { useToastStore } from '../../state/toastStore';

import { ConflictResolverPopover } from './ConflictResolverPopover';

beforeEach(() => {
  useGraphStore.setState({
    runId: 'r-1',
    mergeConflict: null,
    conflictResolverOpen: false,
  });
  useToastStore.getState().clear();
  ipcMocks.revealWorktree.mockReset();
  ipcMocks.revealWorktree.mockResolvedValue('/tmp/wt');
});

afterEach(() => {
  useGraphStore.getState().reset();
  useToastStore.getState().clear();
});

describe('ConflictResolverPopover — visibility', () => {
  it('does not render when mergeConflict is null', () => {
    render(<ConflictResolverPopover />);
    expect(screen.queryByTestId('conflict-resolver-popover')).toBeNull();
  });

  it('does not render when mergeConflict is set but conflictResolverOpen is false', () => {
    useGraphStore.setState({
      mergeConflict: { files: ['a.txt'], retryAttempt: 0 },
      conflictResolverOpen: false,
    });
    render(<ConflictResolverPopover />);
    expect(screen.queryByTestId('conflict-resolver-popover')).toBeNull();
  });

  it('renders when mergeConflict is set and conflictResolverOpen is true', () => {
    useGraphStore.setState({
      mergeConflict: { files: ['a.txt', 'b.rs'], retryAttempt: 0 },
      conflictResolverOpen: true,
    });
    render(<ConflictResolverPopover />);
    expect(screen.getByTestId('conflict-resolver-popover')).toBeInTheDocument();
    const rows = screen.getAllByTestId('conflict-resolver-file-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('a.txt');
    expect(rows[1].textContent).toContain('b.rs');
  });
});

describe('ConflictResolverPopover — per-worker attribution', () => {
  it('joins conflicted files with subtaskDiffs to show which workers touched them', () => {
    useGraphStore.setState({
      mergeConflict: { files: ['shared.txt'], retryAttempt: 0 },
      conflictResolverOpen: true,
      subtaskDiffs: new Map([
        [
          'sub-a',
          Object.freeze([
            {
              path: 'shared.txt',
              status: { kind: 'modified' },
              additions: 1,
              deletions: 1,
              unifiedDiff: '',
            },
          ]),
        ],
        [
          'sub-b',
          Object.freeze([
            {
              path: 'shared.txt',
              status: { kind: 'modified' },
              additions: 0,
              deletions: 1,
              unifiedDiff: '',
            },
          ]),
        ],
      ]),
      subtasks: [
        {
          id: 'sub-a',
          title: 'Worker A',
          why: null,
          agent: 'claude',
          dependsOn: [],
          replaces: [],
        },
        {
          id: 'sub-b',
          title: 'Worker B',
          why: null,
          agent: 'codex',
          dependsOn: [],
          replaces: [],
        },
      ],
    });
    render(<ConflictResolverPopover />);
    expect(
      screen.getByTestId('conflict-resolver-reveal-sub-a'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('conflict-resolver-reveal-sub-b'),
    ).toBeInTheDocument();
  });
});

describe('ConflictResolverPopover — reveal', () => {
  it('calls revealWorktree with the right subtaskId on click', async () => {
    useGraphStore.setState({
      mergeConflict: { files: ['shared.txt'], retryAttempt: 0 },
      conflictResolverOpen: true,
      subtaskDiffs: new Map([
        [
          'sub-a',
          Object.freeze([
            {
              path: 'shared.txt',
              status: { kind: 'modified' },
              additions: 1,
              deletions: 1,
              unifiedDiff: '',
            },
          ]),
        ],
      ]),
      subtasks: [
        {
          id: 'sub-a',
          title: 'Worker A',
          why: null,
          agent: 'claude',
          dependsOn: [],
          replaces: [],
        },
      ],
    });
    render(<ConflictResolverPopover />);
    fireEvent.click(screen.getByTestId('conflict-resolver-reveal-sub-a'));
    await waitFor(() => {
      expect(ipcMocks.revealWorktree).toHaveBeenCalledWith('r-1', 'sub-a');
    });
    await waitFor(() => {
      expect(useToastStore.getState().toasts[0]?.kind).toBe('success');
    });
  });

  it('surfaces reveal failure as a pinned error toast', async () => {
    ipcMocks.revealWorktree.mockRejectedValueOnce(new Error('no file manager'));
    useGraphStore.setState({
      mergeConflict: { files: ['x.txt'], retryAttempt: 0 },
      conflictResolverOpen: true,
      subtaskDiffs: new Map([
        [
          'sub-a',
          Object.freeze([
            {
              path: 'x.txt',
              status: { kind: 'modified' },
              additions: 0,
              deletions: 0,
              unifiedDiff: '',
            },
          ]),
        ],
      ]),
      subtasks: [
        {
          id: 'sub-a',
          title: 'Worker A',
          why: null,
          agent: 'claude',
          dependsOn: [],
          replaces: [],
        },
      ],
    });
    render(<ConflictResolverPopover />);
    fireEvent.click(screen.getByTestId('conflict-resolver-reveal-sub-a'));
    await waitFor(() => {
      expect(useToastStore.getState().toasts[0]?.kind).toBe('error');
    });
  });
});

describe('ConflictResolverPopover — retry apply', () => {
  it('calls retryApply on click', async () => {
    const retryApply = vi.fn(async () => undefined);
    useGraphStore.setState({
      mergeConflict: { files: ['x.txt'], retryAttempt: 0 },
      conflictResolverOpen: true,
      retryApply,
    });
    render(<ConflictResolverPopover />);
    fireEvent.click(screen.getByTestId('conflict-resolver-retry'));
    await waitFor(() => {
      expect(retryApply).toHaveBeenCalled();
    });
  });

  it('shows "Retrying…" and disables the button while retryApplyInFlight is true', () => {
    useGraphStore.setState({
      mergeConflict: { files: ['x.txt'], retryAttempt: 0 },
      conflictResolverOpen: true,
      retryApplyInFlight: true,
    });
    render(<ConflictResolverPopover />);
    const btn = screen.getByTestId('conflict-resolver-retry');
    expect(btn).toBeDisabled();
    expect(btn.textContent).toMatch(/retrying/i);
  });
});

describe('ConflictResolverPopover — retry attempt counter', () => {
  it('renders "Merge conflict" on the initial conflict (retryAttempt 0)', () => {
    useGraphStore.setState({
      mergeConflict: { files: ['x.txt'], retryAttempt: 0 },
      conflictResolverOpen: true,
    });
    render(<ConflictResolverPopover />);
    expect(
      screen.getByText('Merge conflict'),
    ).toBeInTheDocument();
  });

  it('renders "Still conflicted (attempt N)" when retryAttempt > 0', () => {
    useGraphStore.setState({
      mergeConflict: { files: ['x.txt'], retryAttempt: 2 },
      conflictResolverOpen: true,
    });
    render(<ConflictResolverPopover />);
    expect(
      screen.getByText(/still conflicted \(attempt 2\)/i),
    ).toBeInTheDocument();
  });
});

describe('ConflictResolverPopover — dismiss', () => {
  it('Close button toggles conflictResolverOpen off without clearing mergeConflict', () => {
    useGraphStore.setState({
      mergeConflict: { files: ['x.txt'], retryAttempt: 0 },
      conflictResolverOpen: true,
    });
    render(<ConflictResolverPopover />);
    fireEvent.click(screen.getByTestId('conflict-resolver-dismiss'));
    expect(useGraphStore.getState().conflictResolverOpen).toBe(false);
    expect(useGraphStore.getState().mergeConflict).not.toBeNull();
  });
});
