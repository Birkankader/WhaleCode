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

  // Step 2 inline-edit guard: RF's default `deleteKeyCode="Backspace"` would
  // let Backspace inside an input fall through to a graph-level delete if
  // `elementsSelectable` ever flipped back on. Setting it to null removes
  // that footgun permanently.
  it('disables RF deleteKeyCode so Backspace/Delete inside inputs can never delete graph elements', () => {
    render(<GraphCanvas />);
    const props = reactFlowProps.mock.calls[0]?.[0] ?? {};
    expect(props.deleteKeyCode).toBeNull();
  });
});

describe('GraphCanvas — per-state worker height', () => {
  // States that render a LogBlock grow the worker card to 180px so the
  // title + why + LogBlock stack doesn't overflow the default 140px —
  // the visual bug that hid `why` behind the LogBlock's opaque dark
  // background during Phase 3 Step 9 verification.
  function seedTwoWorkerDag(
    aState: string,
    bState: string,
  ): Array<{ id: string; data: { height?: number } }> {
    useGraphStore.setState({
      subtasks: [
        { id: 'a', title: 'A', why: null, agent: 'claude', dependsOn: [], replaces: [] },
        { id: 'b', title: 'B', why: null, agent: 'claude', dependsOn: [], replaces: [] },
      ],
      nodeSnapshots: new Map([
        ['a', { value: aState as never }],
        ['b', { value: bState as never }],
      ]),
    });
    render(<GraphCanvas />);
    const props = reactFlowProps.mock.calls[0]?.[0] ?? {};
    return (props.nodes as Array<{ id: string; data: { height?: number } }>) ?? [];
  }

  it('running worker gets the 180px height override', () => {
    const nodes = seedTwoWorkerDag('running', 'proposed');
    const a = nodes.find((n) => n.id === 'a');
    expect(a?.data.height).toBe(180);
  });

  it('row-max alignment: proposed neighbour in a running row also renders at 180px', () => {
    // Same row (layout is one-row default). The row-max lifts `b` to
    // match `a`'s expanded height so the grid stays visually even.
    const nodes = seedTwoWorkerDag('running', 'proposed');
    const b = nodes.find((n) => n.id === 'b');
    expect(b?.data.height).toBe(180);
  });

  it('done, retrying, and failed also get 180px (each has a LogBlock)', () => {
    for (const state of ['done', 'retrying', 'failed']) {
      reactFlowProps.mockClear();
      const nodes = seedTwoWorkerDag(state, state);
      const a = nodes.find((n) => n.id === 'a');
      expect(a?.data.height, `height for ${state}`).toBe(180);
    }
  });

  it('human_escalation still wins at 280px (bigger override takes precedence)', () => {
    const nodes = seedTwoWorkerDag('human_escalation', 'running');
    const a = nodes.find((n) => n.id === 'a');
    const b = nodes.find((n) => n.id === 'b');
    expect(a?.data.height).toBe(280);
    // Row-max lifts the running neighbour to 280 too, not 180.
    expect(b?.data.height).toBe(280);
  });

  it('states without LogBlock stay at default 140px', () => {
    for (const state of ['proposed', 'approved', 'waiting', 'skipped']) {
      reactFlowProps.mockClear();
      const nodes = seedTwoWorkerDag(state, state);
      const a = nodes.find((n) => n.id === 'a');
      expect(a?.data.height, `height for ${state}`).toBe(140);
    }
  });
});
