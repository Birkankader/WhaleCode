/**
 * Phase 7 Step 1 — InlineDiffSidebar unit tests.
 *
 * Covers:
 *   - default open / closed derivation per status (`computeSidebarOpen`);
 *   - user-toggle override + persistence semantics;
 *   - width hydration / clamping / persistence to settings;
 *   - drag-resize handle round-trip;
 *   - single + multi-worker selection rendering;
 *   - empty state, per-worker section headers, file rows + variant chips;
 *   - WorkerNode FileCountChip click integration (single + modifier);
 *   - reset semantics: selection + user toggle clear, width survives.
 *
 * Shiki + DiffBody lazy chunks are mocked so jsdom doesn't trip on the
 * real WebAssembly + dynamic import path. Tests for DiffBody itself
 * live in `DiffPopover.test.tsx` (still functional through Step 8).
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
  setSettings: vi.fn(async () => ({}) as unknown),
}));

vi.mock('../../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../../lib/ipc')>('../../lib/ipc');
  return { ...actual, ...ipcMocks };
});

vi.mock('./DiffBody', () => ({
  default: ({ id }: { id: string }) => (
    <div data-testid="mock-diff-body" id={id}>
      mock diff body
    </div>
  ),
}));

import type { FileDiff } from '../../lib/ipc';
import { computeSidebarOpen, useGraphStore } from '../../state/graphStore';

import { InlineDiffSidebar } from './InlineDiffSidebar';

function fd(partial: Partial<FileDiff> & Pick<FileDiff, 'path'>): FileDiff {
  return {
    additions: 0,
    deletions: 0,
    ...partial,
  };
}

beforeEach(() => {
  useGraphStore.getState().reset();
  ipcMocks.setSettings.mockReset();
  ipcMocks.setSettings.mockResolvedValue({} as unknown);
});

afterEach(() => {
  useGraphStore.getState().reset();
});

// ---------------------------------------------------------------------
// computeSidebarOpen derivation
// ---------------------------------------------------------------------

describe('computeSidebarOpen — status-driven default', () => {
  it('returns true while status=running', () => {
    useGraphStore.setState({ status: 'running', inlineDiffSidebarUserToggled: null });
    expect(computeSidebarOpen(useGraphStore.getState())).toBe(true);
  });

  it('returns true while status=merging', () => {
    useGraphStore.setState({ status: 'merging', inlineDiffSidebarUserToggled: null });
    expect(computeSidebarOpen(useGraphStore.getState())).toBe(true);
  });

  it('returns true while status=planning', () => {
    useGraphStore.setState({ status: 'planning', inlineDiffSidebarUserToggled: null });
    expect(computeSidebarOpen(useGraphStore.getState())).toBe(true);
  });

  it('returns true while status=awaiting_approval', () => {
    useGraphStore.setState({ status: 'awaiting_approval', inlineDiffSidebarUserToggled: null });
    expect(computeSidebarOpen(useGraphStore.getState())).toBe(true);
  });

  it('returns false while status=idle', () => {
    useGraphStore.setState({ status: 'idle', inlineDiffSidebarUserToggled: null });
    expect(computeSidebarOpen(useGraphStore.getState())).toBe(false);
  });

  it('returns false while status=applied', () => {
    useGraphStore.setState({ status: 'applied', inlineDiffSidebarUserToggled: null });
    expect(computeSidebarOpen(useGraphStore.getState())).toBe(false);
  });

  it('returns false while status=rejected', () => {
    useGraphStore.setState({ status: 'rejected', inlineDiffSidebarUserToggled: null });
    expect(computeSidebarOpen(useGraphStore.getState())).toBe(false);
  });

  it('user true override wins over status=applied', () => {
    useGraphStore.setState({ status: 'applied', inlineDiffSidebarUserToggled: true });
    expect(computeSidebarOpen(useGraphStore.getState())).toBe(true);
  });

  it('user false override wins over status=running', () => {
    useGraphStore.setState({ status: 'running', inlineDiffSidebarUserToggled: false });
    expect(computeSidebarOpen(useGraphStore.getState())).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Render: collapsed vs open
// ---------------------------------------------------------------------

describe('InlineDiffSidebar — collapsed/open render', () => {
  it('renders the collapsed spine when status=idle', () => {
    useGraphStore.setState({ status: 'idle', inlineDiffSidebarUserToggled: null });
    render(<InlineDiffSidebar />);
    expect(screen.getByTestId('inline-diff-sidebar-collapsed')).toBeInTheDocument();
    expect(screen.queryByTestId('inline-diff-sidebar')).not.toBeInTheDocument();
  });

  it('renders the open sidebar when status=running', () => {
    useGraphStore.setState({ status: 'running', inlineDiffSidebarUserToggled: null });
    render(<InlineDiffSidebar />);
    expect(screen.getByTestId('inline-diff-sidebar')).toBeInTheDocument();
    expect(screen.queryByTestId('inline-diff-sidebar-collapsed')).not.toBeInTheDocument();
  });

  it('collapsed spine open button toggles user override', () => {
    useGraphStore.setState({ status: 'idle', inlineDiffSidebarUserToggled: null });
    render(<InlineDiffSidebar />);
    const btn = screen.getByTestId('inline-diff-sidebar-open-button');
    fireEvent.click(btn);
    expect(useGraphStore.getState().inlineDiffSidebarUserToggled).toBe(true);
  });

  it('open close button toggles user override to false', () => {
    useGraphStore.setState({ status: 'running', inlineDiffSidebarUserToggled: null });
    render(<InlineDiffSidebar />);
    const close = screen.getByTestId('inline-diff-sidebar-close');
    fireEvent.click(close);
    expect(useGraphStore.getState().inlineDiffSidebarUserToggled).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------

describe('InlineDiffSidebar — empty state', () => {
  it('renders empty placeholder when selection is empty', () => {
    useGraphStore.setState({ status: 'running' });
    render(<InlineDiffSidebar />);
    expect(screen.getByTestId('inline-diff-sidebar-empty')).toBeInTheDocument();
    expect(screen.getByTestId('inline-diff-sidebar-empty')).toHaveTextContent(
      /click .* to view changes/i,
    );
  });

  it('does NOT render worker headers when selection is empty', () => {
    useGraphStore.setState({ status: 'running' });
    render(<InlineDiffSidebar />);
    expect(screen.queryByTestId('inline-diff-sidebar-worker-header')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------
// Width handling
// ---------------------------------------------------------------------

describe('InlineDiffSidebar — width', () => {
  it('applies inlineDiffSidebarWidth to aside style', () => {
    useGraphStore.setState({ status: 'running', inlineDiffSidebarWidth: 600 });
    render(<InlineDiffSidebar />);
    const aside = screen.getByTestId('inline-diff-sidebar');
    expect(aside.getAttribute('data-width')).toBe('600');
  });

  it('hydrate clamps below MIN to MIN', () => {
    useGraphStore.getState().hydrateInlineDiffSidebarWidth(100);
    expect(useGraphStore.getState().inlineDiffSidebarWidth).toBe(320);
  });

  it('hydrate clamps above MAX to MAX', () => {
    useGraphStore.getState().hydrateInlineDiffSidebarWidth(1000);
    expect(useGraphStore.getState().inlineDiffSidebarWidth).toBe(720);
  });

  it('hydrate ignores undefined', () => {
    useGraphStore.setState({ inlineDiffSidebarWidth: 480 });
    useGraphStore.getState().hydrateInlineDiffSidebarWidth(undefined);
    expect(useGraphStore.getState().inlineDiffSidebarWidth).toBe(480);
  });

  it('hydrate ignores null', () => {
    useGraphStore.setState({ inlineDiffSidebarWidth: 480 });
    useGraphStore.getState().hydrateInlineDiffSidebarWidth(null);
    expect(useGraphStore.getState().inlineDiffSidebarWidth).toBe(480);
  });

  it('setInlineDiffSidebarWidth clamps below MIN', async () => {
    await useGraphStore.getState().setInlineDiffSidebarWidth(100);
    expect(useGraphStore.getState().inlineDiffSidebarWidth).toBe(320);
  });

  it('setInlineDiffSidebarWidth clamps above MAX', async () => {
    await useGraphStore.getState().setInlineDiffSidebarWidth(1000);
    expect(useGraphStore.getState().inlineDiffSidebarWidth).toBe(720);
  });

  it('setInlineDiffSidebarWidth persists via setSettings', async () => {
    await useGraphStore.getState().setInlineDiffSidebarWidth(560);
    expect(ipcMocks.setSettings).toHaveBeenCalledWith({ inlineDiffSidebarWidth: 560 });
  });

  it('renders the resize handle inside the open sidebar', () => {
    useGraphStore.setState({ status: 'running' });
    render(<InlineDiffSidebar />);
    expect(screen.getByTestId('inline-diff-sidebar-resize-handle')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------
// Selection rendering
// ---------------------------------------------------------------------

describe('InlineDiffSidebar — selection rendering', () => {
  function seedSubtasks() {
    useGraphStore.setState({
      status: 'running',
      subtasks: [
        {
          id: 's-1',
          title: 'Worker A title',
          why: null,
          dependsOn: [],
          replaces: [],
          replanCount: 0,
          agent: 'claude',
        },
        {
          id: 's-2',
          title: 'Worker B title',
          why: null,
          dependsOn: [],
          replaces: [],
          replanCount: 0,
          agent: 'codex',
        },
      ],
      subtaskDiffs: new Map([
        [
          's-1',
          [
            fd({ path: 'src/auth.ts', additions: 4, deletions: 2 }),
            fd({ path: 'src/util.ts', additions: 1, deletions: 0 }),
          ] as readonly FileDiff[],
        ],
        [
          's-2',
          [fd({ path: 'src/login.tsx', additions: 8, deletions: 1 })] as readonly FileDiff[],
        ],
      ]),
    });
  }

  it('renders single-worker file list with no section header when only one selected', () => {
    seedSubtasks();
    useGraphStore.setState({ inlineDiffSelection: new Set(['s-1']) });
    render(<InlineDiffSidebar />);
    expect(screen.queryByTestId('inline-diff-sidebar-worker-header')).not.toBeInTheDocument();
    const headers = screen.getAllByTestId('inline-diff-sidebar-file-header');
    expect(headers).toHaveLength(2);
    expect(headers[0].getAttribute('data-path')).toBe('src/auth.ts');
  });

  it('renders multi-worker section headers with file counts when 2+ selected', () => {
    seedSubtasks();
    useGraphStore.setState({ inlineDiffSelection: new Set(['s-1', 's-2']) });
    render(<InlineDiffSidebar />);
    const headers = screen.getAllByTestId('inline-diff-sidebar-worker-header');
    expect(headers).toHaveLength(2);
    expect(headers[0]).toHaveTextContent('Worker A title');
    expect(headers[0]).toHaveTextContent('2 files');
    expect(headers[1]).toHaveTextContent('Worker B title');
    expect(headers[1]).toHaveTextContent('1 file');
  });

  it('union view shows all files from all selected workers', () => {
    seedSubtasks();
    useGraphStore.setState({ inlineDiffSelection: new Set(['s-1', 's-2']) });
    render(<InlineDiffSidebar />);
    const headers = screen.getAllByTestId('inline-diff-sidebar-file-header');
    expect(headers).toHaveLength(3);
  });

  it('header shows worker count copy', () => {
    seedSubtasks();
    useGraphStore.setState({ inlineDiffSelection: new Set(['s-1']) });
    render(<InlineDiffSidebar />);
    expect(screen.getByText('1 worker selected')).toBeInTheDocument();
  });

  it('header copy goes plural for 2+ workers', () => {
    seedSubtasks();
    useGraphStore.setState({ inlineDiffSelection: new Set(['s-1', 's-2']) });
    render(<InlineDiffSidebar />);
    expect(screen.getByText('2 workers selected')).toBeInTheDocument();
  });

  it('clear button resets selection', () => {
    seedSubtasks();
    useGraphStore.setState({ inlineDiffSelection: new Set(['s-1', 's-2']) });
    render(<InlineDiffSidebar />);
    const clear = screen.getByTestId('inline-diff-sidebar-clear');
    fireEvent.click(clear);
    expect(useGraphStore.getState().inlineDiffSelection.size).toBe(0);
  });

  it('clear button hidden when selection is empty', () => {
    useGraphStore.setState({ status: 'running' });
    render(<InlineDiffSidebar />);
    expect(screen.queryByTestId('inline-diff-sidebar-clear')).not.toBeInTheDocument();
  });

  it('renders zero-files empty subsection when worker touched no files', () => {
    useGraphStore.setState({
      status: 'running',
      subtasks: [
        {
          id: 's-empty',
          title: 'No-op worker',
          why: null,
          dependsOn: [],
          replaces: [],
          replanCount: 0,
          agent: 'claude',
        },
      ],
      subtaskDiffs: new Map([['s-empty', [] as readonly FileDiff[]]]),
      inlineDiffSelection: new Set(['s-empty']),
    });
    render(<InlineDiffSidebar />);
    expect(screen.getByText(/touched no files/i)).toBeInTheDocument();
  });

  it('skips selected workers without diff payloads (still loading)', () => {
    useGraphStore.setState({
      status: 'running',
      subtasks: [
        {
          id: 's-pending',
          title: 'Loading worker',
          why: null,
          dependsOn: [],
          replaces: [],
          replanCount: 0,
          agent: 'claude',
        },
      ],
      subtaskDiffs: new Map(),
      inlineDiffSelection: new Set(['s-pending']),
    });
    render(<InlineDiffSidebar />);
    expect(screen.getByTestId('inline-diff-sidebar-empty')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------
// File row expand
// ---------------------------------------------------------------------

describe('InlineDiffSidebar — file row expand', () => {
  it('clicking a file header expands the lazy DiffBody', async () => {
    useGraphStore.setState({
      status: 'running',
      subtasks: [
        {
          id: 's-1',
          title: 'Worker A',
          why: null,
          dependsOn: [],
          replaces: [],
          replanCount: 0,
          agent: 'claude',
        },
      ],
      subtaskDiffs: new Map([
        [
          's-1',
          [fd({ path: 'src/a.ts', additions: 3, deletions: 1, unifiedDiff: '@@ ... @@' })] as readonly FileDiff[],
        ],
      ]),
      inlineDiffSelection: new Set(['s-1']),
    });
    render(<InlineDiffSidebar />);
    const header = screen.getByTestId('inline-diff-sidebar-file-header');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => {
      expect(screen.getByTestId('mock-diff-body')).toBeInTheDocument();
    });
  });

  it('renders +/- counts on the file header', () => {
    useGraphStore.setState({
      status: 'running',
      subtasks: [
        {
          id: 's-1',
          title: 'Worker',
          why: null,
          dependsOn: [],
          replaces: [],
          replanCount: 0,
          agent: 'claude',
        },
      ],
      subtaskDiffs: new Map([
        ['s-1', [fd({ path: 'src/a.ts', additions: 7, deletions: 3 })] as readonly FileDiff[]],
      ]),
      inlineDiffSelection: new Set(['s-1']),
    });
    render(<InlineDiffSidebar />);
    expect(screen.getByText('+7')).toBeInTheDocument();
    expect(screen.getByText('−3')).toBeInTheDocument();
  });

  it('renders variant suffix for added file', () => {
    useGraphStore.setState({
      status: 'running',
      subtasks: [
        {
          id: 's-1',
          title: 'Worker',
          why: null,
          dependsOn: [],
          replaces: [],
          replanCount: 0,
          agent: 'claude',
        },
      ],
      subtaskDiffs: new Map([
        [
          's-1',
          [fd({ path: 'src/new.ts', additions: 5, deletions: 0, status: { kind: 'added' } })] as readonly FileDiff[],
        ],
      ]),
      inlineDiffSelection: new Set(['s-1']),
    });
    render(<InlineDiffSidebar />);
    expect(screen.getByText('new')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------
// graphStore selection actions
// ---------------------------------------------------------------------

describe('graphStore — selectDiffWorker / clearDiffSelection', () => {
  it('plain click resets to a single-id selection', () => {
    useGraphStore.setState({ inlineDiffSelection: new Set(['s-old']) });
    useGraphStore.getState().selectDiffWorker('s-1', false);
    expect(Array.from(useGraphStore.getState().inlineDiffSelection)).toEqual(['s-1']);
  });

  it('modifier-click on new id adds to selection', () => {
    useGraphStore.setState({ inlineDiffSelection: new Set(['s-1']) });
    useGraphStore.getState().selectDiffWorker('s-2', true);
    const sel = useGraphStore.getState().inlineDiffSelection;
    expect(sel.has('s-1')).toBe(true);
    expect(sel.has('s-2')).toBe(true);
  });

  it('modifier-click on existing id removes from selection', () => {
    useGraphStore.setState({ inlineDiffSelection: new Set(['s-1', 's-2']) });
    useGraphStore.getState().selectDiffWorker('s-1', true);
    const sel = useGraphStore.getState().inlineDiffSelection;
    expect(sel.has('s-1')).toBe(false);
    expect(sel.has('s-2')).toBe(true);
  });

  it('clearDiffSelection empties the set', () => {
    useGraphStore.setState({ inlineDiffSelection: new Set(['s-1', 's-2']) });
    useGraphStore.getState().clearDiffSelection();
    expect(useGraphStore.getState().inlineDiffSelection.size).toBe(0);
  });

  it('reset clears selection but persists width', () => {
    useGraphStore.setState({
      inlineDiffSelection: new Set(['s-1']),
      inlineDiffSidebarUserToggled: true,
      inlineDiffSidebarWidth: 600,
    });
    useGraphStore.getState().reset();
    const s = useGraphStore.getState();
    expect(s.inlineDiffSelection.size).toBe(0);
    expect(s.inlineDiffSidebarUserToggled).toBe(null);
    expect(s.inlineDiffSidebarWidth).toBe(600);
  });

  it('toggleInlineDiffSidebar flips computed open state', () => {
    useGraphStore.setState({ status: 'running', inlineDiffSidebarUserToggled: null });
    expect(computeSidebarOpen(useGraphStore.getState())).toBe(true);
    useGraphStore.getState().toggleInlineDiffSidebar();
    expect(useGraphStore.getState().inlineDiffSidebarUserToggled).toBe(false);
    expect(computeSidebarOpen(useGraphStore.getState())).toBe(false);
  });

  it('toggleInlineDiffSidebar from idle closed flips to user-open', () => {
    useGraphStore.setState({ status: 'idle', inlineDiffSidebarUserToggled: null });
    expect(computeSidebarOpen(useGraphStore.getState())).toBe(false);
    useGraphStore.getState().toggleInlineDiffSidebar();
    expect(useGraphStore.getState().inlineDiffSidebarUserToggled).toBe(true);
    expect(computeSidebarOpen(useGraphStore.getState())).toBe(true);
  });
});
