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
