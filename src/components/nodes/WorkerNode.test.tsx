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

import { WorkerNode, type WorkerNodeData } from './WorkerNode';

function renderNode(id: string, data: WorkerNodeData) {
  const props = { id, data } as unknown as React.ComponentProps<typeof WorkerNode>;
  return render(<WorkerNode {...props} />);
}

beforeEach(() => {
  useGraphStore.getState().reset();
});

afterEach(() => {
  useGraphStore.getState().reset();
});

describe('WorkerNode — card-click selection in proposed state', () => {
  it('clicking anywhere on a proposed card toggles subtask selection', () => {
    const toggle = vi.fn();
    useGraphStore.setState({ toggleSubtaskSelection: toggle });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'Write ThemeProvider',
      retries: 0,
    });

    // Click the title element (anywhere inside the card except the checkbox).
    fireEvent.click(screen.getByText('Write ThemeProvider'));
    expect(toggle).toHaveBeenCalledWith('auth');
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('clicking the checkbox itself does not double-toggle via card onClick', () => {
    const toggle = vi.fn();
    useGraphStore.setState({ toggleSubtaskSelection: toggle });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'x',
      retries: 0,
    });

    // Checkbox click triggers onChange → toggle once. The outer card
    // onClick must not also fire; that would double-count the selection.
    fireEvent.click(screen.getByRole('checkbox'));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('does not attach a click handler when the subtask is not in the proposed state', () => {
    const toggle = vi.fn();
    useGraphStore.setState({ toggleSubtaskSelection: toggle });
    renderNode('auth', {
      state: 'running',
      agent: 'claude',
      title: 'Running subtask',
      retries: 0,
    });

    fireEvent.click(screen.getByText('Running subtask'));
    expect(toggle).not.toHaveBeenCalled();
  });
});
