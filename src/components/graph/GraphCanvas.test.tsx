import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the props `<ReactFlow>` receives so we can assert which event
// handlers are wired. `@xyflow/react` ships a heavy DOM/canvas stack that
// we don't want to exercise here — we only care about the handler wiring.
const reactFlowProps = vi.fn();
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    reactFlowProps(props);
    return null;
  },
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReactFlow: () => ({ setViewport: () => undefined }),
}));

vi.mock('../../hooks/useRecenterShortcut', () => ({
  useRecenterShortcut: () => undefined,
}));

import { useGraphStore } from '../../state/graphStore';

import { GraphCanvas } from './GraphCanvas';

beforeEach(() => {
  reactFlowProps.mockClear();
  // jsdom doesn't ship ResizeObserver — the canvas uses it to track the
  // container for compact-mode layout. Stub it so the layout effect can run.
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
  }
  const s = useGraphStore.getState();
  s.reset();
  // GraphCanvas early-returns unless it has a master node to render.
  useGraphStore.setState({
    masterNode: { id: 'master', label: 'Master', agent: 'claude' },
  });
});

afterEach(() => {
  useGraphStore.getState().reset();
});

describe('GraphCanvas — pointer-events unblock', () => {
  // Regression: @xyflow/react NodeWrapper sets inline `pointer-events: none`
  // whenever a node is non-draggable, non-selectable, and has no node-level
  // mouse handlers — which matches our config exactly. That inline style
  // beats our CSS, so inner card onClicks silently stop firing. Passing any
  // `onNodeClick` (even a noop) flips the wrapper back to pointer-events:all
  // without enabling RF's built-in selection UI. Losing this prop broke the
  // entire approval flow in the live app once, so lock it down.
  it('passes an onNodeClick handler to ReactFlow so node pointer-events stay enabled', () => {
    render(<GraphCanvas />);
    expect(reactFlowProps).toHaveBeenCalled();
    const props = reactFlowProps.mock.calls[0]?.[0] ?? {};
    expect(typeof props.onNodeClick).toBe('function');
  });
});
