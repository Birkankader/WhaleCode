import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

// `<Handle>` needs a React Flow provider; we only care about the body rendering,
// so stub it to a passthrough element.
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));

import { useGraphStore } from '../../state/graphStore';

import { FinalNode, type FinalNodeData } from './FinalNode';

function renderNode(data: FinalNodeData) {
  // React Flow passes nodes with `data` via `NodeProps`; the component only
  // reads `data`, so we cast the test surface to match.
  const props = { data } as unknown as React.ComponentProps<typeof FinalNode>;
  return render(<FinalNode {...props} />);
}

beforeEach(() => {
  useGraphStore.getState().reset();
});

afterEach(() => {
  useGraphStore.getState().reset();
});

describe('FinalNode — default variant', () => {
  it('renders the label + file count when no conflict is present', () => {
    renderNode({
      state: 'done',
      label: 'Merge',
      files: ['a.ts', 'b.ts'],
      conflictFiles: null,
    });
    expect(screen.getByText('Merge')).toBeInTheDocument();
    expect(screen.getByText('2 files')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apply to branch/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /discard all/i })).toBeInTheDocument();
  });

  it('enables the apply/discard buttons when state is activated', () => {
    renderNode({
      state: 'running',
      label: 'Merge',
      files: ['a.ts'],
      conflictFiles: null,
    });
    expect(screen.getByRole('button', { name: /apply to branch/i })).toBeEnabled();
  });

  it('treats an empty conflictFiles array as "no conflict"', () => {
    renderNode({
      state: 'done',
      label: 'Merge',
      files: ['a.ts'],
      conflictFiles: [],
    });
    // Default variant still renders — apply button visible.
    expect(screen.getByRole('button', { name: /apply to branch/i })).toBeInTheDocument();
    expect(screen.queryByText(/merge conflict/i)).toBeNull();
  });
});

describe('FinalNode — conflict variant', () => {
  it('renders "Merge conflict" title when conflictFiles is non-empty', () => {
    renderNode({
      state: 'running',
      label: 'Merge',
      files: ['a.ts'],
      conflictFiles: ['src/auth.ts'],
    });
    expect(screen.getByText(/merge conflict/i)).toBeInTheDocument();
    expect(screen.getByText('src/auth.ts')).toBeInTheDocument();
    expect(screen.getByText('1 file')).toBeInTheDocument();
  });

  it('shows the first 5 files and a "+N more" line for >5', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    renderNode({
      state: 'running',
      label: 'Merge',
      files: [],
      conflictFiles: files,
    });
    for (const f of files.slice(0, 5)) {
      expect(screen.getByText(f)).toBeInTheDocument();
    }
    expect(screen.queryByText('f.ts')).toBeNull();
    expect(screen.queryByText('g.ts')).toBeNull();
    expect(screen.getByText('+2 more conflicts')).toBeInTheDocument();
  });

  it('does not render the "+N more" line when there are exactly 5 files', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    renderNode({
      state: 'running',
      label: 'Merge',
      files: [],
      conflictFiles: files,
    });
    expect(screen.queryByText(/\+.*more conflicts/)).toBeNull();
  });

  it('hides the Apply button in the conflict variant', () => {
    renderNode({
      state: 'running',
      label: 'Merge',
      files: [],
      conflictFiles: ['src/auth.ts'],
    });
    expect(screen.queryByRole('button', { name: /apply to branch/i })).toBeNull();
    expect(screen.getByRole('button', { name: /discard all/i })).toBeInTheDocument();
  });

  it('Discard button in conflict variant calls discardRun', () => {
    const discardRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    useGraphStore.setState({ discardRun });
    renderNode({
      state: 'running',
      label: 'Merge',
      files: [],
      conflictFiles: ['src/auth.ts'],
    });
    fireEvent.click(screen.getByRole('button', { name: /discard all/i }));
    expect(discardRun).toHaveBeenCalled();
  });
});

describe('FinalNode — applied state (Phase 7 polish)', () => {
  // Post-Apply: ApplySummaryOverlay shows the success summary; the
  // MERGE node previously left "Apply to branch" live which read as
  // "click did nothing". Now the buttons collapse into an "Applied"
  // line with the branch + short SHA.
  it('replaces buttons with an Applied line when applySummary lands', () => {
    useGraphStore.setState({
      status: 'applied',
      applySummary: {
        runId: 'r-1',
        commitSha: '2fa47ae0123456789',
        branch: 'main',
        filesChanged: 3,
        perWorker: [],
      },
    });
    renderNode({
      state: 'done',
      label: 'Merge',
      files: ['a.ts'],
      conflictFiles: null,
    });
    expect(screen.queryByRole('button', { name: /apply to branch/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /discard all/i })).toBeNull();
    const applied = screen.getByTestId('final-node-applied');
    expect(applied).toHaveTextContent('main');
    expect(applied).toHaveTextContent('2fa47ae');
  });

  it('header label flips to "Applied" once applySummary is present', () => {
    useGraphStore.setState({
      status: 'applied',
      applySummary: {
        runId: 'r-1',
        commitSha: 'deadbeef0',
        branch: 'feat/x',
        filesChanged: 1,
        perWorker: [],
      },
    });
    renderNode({
      state: 'done',
      label: 'Merge',
      files: [],
      conflictFiles: null,
    });
    expect(screen.getByTestId('final-node-label')).toHaveTextContent(/Applied/i);
  });

  it('shows "Applying…" only after user clicks Apply (applyInFlight true), NOT during pre-done backend merging', () => {
    // Pre-done `status=merging` is the backend stitching workers
    // together before the MERGE card is even ready. The user has
    // not clicked Apply yet — the button must NOT show "Applying…".
    useGraphStore.setState({ status: 'merging', applyInFlight: false });
    renderNode({
      state: 'done',
      label: 'Merge',
      files: ['a.ts'],
      conflictFiles: null,
    });
    expect(screen.getByTestId('final-node-label')).toHaveTextContent('Merge');
    expect(screen.getByTestId('final-node-apply')).toHaveTextContent(/Apply to branch/i);
  });

  it('shows "Applying…" + disables buttons when applyInFlight flag is set', () => {
    useGraphStore.setState({ status: 'done', applyInFlight: true });
    renderNode({
      state: 'done',
      label: 'Merge',
      files: ['a.ts'],
      conflictFiles: null,
    });
    expect(screen.getByTestId('final-node-label')).toHaveTextContent(/Applying/i);
    const applyBtn = screen.getByTestId('final-node-apply');
    expect(applyBtn).toBeDisabled();
    expect(applyBtn).toHaveTextContent(/Applying/i);
  });

  it('default state shows "Apply to branch" + Discard buttons (no applySummary)', () => {
    renderNode({
      state: 'done',
      label: 'Merge',
      files: ['a.ts'],
      conflictFiles: null,
    });
    expect(screen.getByRole('button', { name: /apply to branch/i })).toBeInTheDocument();
    expect(screen.queryByTestId('final-node-applied')).toBeNull();
  });
});
