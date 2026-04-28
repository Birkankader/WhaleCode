import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the props `<ReactFlow>` receives so we can assert which event
// handlers are wired. `@xyflow/react` ships a heavy DOM/canvas stack that
// we don't want to exercise here — we only care about the handler wiring.
const reactFlowProps = vi.fn();
const controlsProps = vi.fn();
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    reactFlowProps(props);
    // Render children so child mocks (Controls, Background) mount and
    // their props can be captured.
    return <>{(props as { children?: React.ReactNode }).children ?? null}</>;
  },
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReactFlow: () => ({
    setViewport: () => undefined,
    zoomIn: () => undefined,
    zoomOut: () => undefined,
  }),
  // Background / Controls are rendered as ReactFlow's children in v12.
  // Background renders nothing; Controls captures its props so tests can
  // assert the lift modifier class without pulling in the real stack.
  Background: () => null,
  BackgroundVariant: { Dots: 'dots', Lines: 'lines', Cross: 'cross' },
  Controls: (props: Record<string, unknown>) => {
    controlsProps(props);
    return null;
  },
  useStore: () => 1,
}));

vi.mock('../../hooks/useRecenterShortcut', () => ({
  useRecenterShortcut: () => undefined,
}));

vi.mock('../../hooks/useZoomShortcuts', () => ({
  useZoomShortcuts: () => undefined,
}));

import { useGraphStore } from '../../state/graphStore';

import { GraphCanvas } from './GraphCanvas';

beforeEach(() => {
  reactFlowProps.mockClear();
  controlsProps.mockClear();
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

describe('GraphCanvas — zoom and pan wiring', () => {
  // Phase 3.5 Item 4: zoom out to fit large plans and zoom in to read
  // streaming logs on a small laptop screen. The previous config had
  // scroll/pinch zoom turned off and a 1.0 max — the graph could only
  // shrink, never grow. These asserts lock in the new bounds so a future
  // "simplify the ReactFlow props" refactor can't silently regress.
  it('allows zoom up to 2.5 (reading logs) and down to 0.4 (wide plans)', () => {
    render(<GraphCanvas />);
    const props = reactFlowProps.mock.calls[0]?.[0] ?? {};
    expect(props.minZoom).toBe(0.4);
    expect(props.maxZoom).toBe(2.5);
  });

  it('scroll = pan, pinch = zoom, drag = pan — matches every map/design tool', () => {
    render(<GraphCanvas />);
    const props = reactFlowProps.mock.calls[0]?.[0] ?? {};
    // panOnScroll true so scroll-wheel and two-finger trackpad pan
    // the canvas. Commit 4's scroll-to-zoom flip broke drag-pan on
    // dense graphs (no empty space to grab), so we're back on RF's
    // natural default. Cmd/Ctrl + scroll still zooms via RF's
    // built-in zoomActivationKeyCode (default = Meta).
    expect(props.panOnScroll).toBe(true);
    // zoomOnScroll must be explicitly false — otherwise scroll both
    // pans AND zooms, which is chaos.
    expect(props.zoomOnScroll).toBe(false);
    // panOnDrag stays on for middle-click / space-drag / empty-area
    // drag pans; nodesDraggable is false so node drags fall through
    // to canvas drag when they start inside a node's footprint.
    expect(props.panOnDrag).toBe(true);
    // zoomOnPinch left as RF default (true) so trackpad pinch zooms.
    expect(props.zoomOnPinch).toBeUndefined();
  });

  it('keeps double-click zoom disabled (reserved for future node actions)', () => {
    render(<GraphCanvas />);
    const props = reactFlowProps.mock.calls[0]?.[0] ?? {};
    expect(props.zoomOnDoubleClick).toBe(false);
  });
});

describe('GraphCanvas — proposed-state edge dimming', () => {
  // Commit 5 (Phase 3.5 Item 5): edges incident on an unticked proposed
  // subtask dim to opacity 0.5 to match the node dim. Lock both sides:
  //   - master→subtask AND subtask→final dim when subtask is unticked
  //   - edges whose endpoints are all-selected / non-proposed stay full
  //   - selecting the subtask (while still proposed) lifts the dim
  function seedTwoWorkerDagWithFinal(selected: ReadonlySet<string>) {
    useGraphStore.setState({
      masterNode: { id: 'master', label: 'Master', agent: 'claude' },
      finalNode: { id: 'final', label: 'Final', files: [], conflictFiles: [] },
      subtasks: [
        { id: 'a', title: 'A', why: null, agent: 'claude', dependsOn: [], replaces: [] },
        { id: 'b', title: 'B', why: null, agent: 'claude', dependsOn: [], replaces: [] },
      ],
      nodeSnapshots: new Map([
        ['a', { value: 'proposed' as never }],
        ['b', { value: 'proposed' as never }],
      ]),
      selectedSubtaskIds: new Set(selected),
    });
    render(<GraphCanvas />);
    const props = reactFlowProps.mock.calls[0]?.[0] ?? {};
    return (props.edges as Array<{ id: string; data: { dimmed?: boolean } }>) ?? [];
  }

  it('edges touching an unticked proposed subtask carry dimmed=true (both directions)', () => {
    const edges = seedTwoWorkerDagWithFinal(new Set(['b'])); // a is unticked
    const masterToA = edges.find((e) => e.id === 'master->a');
    const aToFinal = edges.find((e) => e.id === 'a->final');
    expect(masterToA?.data.dimmed).toBe(true);
    expect(aToFinal?.data.dimmed).toBe(true);
  });

  it('edges whose endpoints are all ticked stay full opacity (dimmed=false)', () => {
    const edges = seedTwoWorkerDagWithFinal(new Set(['a', 'b']));
    const masterToB = edges.find((e) => e.id === 'master->b');
    const bToFinal = edges.find((e) => e.id === 'b->final');
    expect(masterToB?.data.dimmed).toBe(false);
    expect(bToFinal?.data.dimmed).toBe(false);
  });

  it('ticking an unticked proposed subtask lifts the edge dim', () => {
    // First render: a unticked → dimmed
    seedTwoWorkerDagWithFinal(new Set(['b']));
    reactFlowProps.mockClear();
    // Now select `a` too; edge data.dimmed should flip back to false.
    useGraphStore.setState({ selectedSubtaskIds: new Set(['a', 'b']) });
    render(<GraphCanvas />);
    const props = reactFlowProps.mock.calls[0]?.[0] ?? {};
    const edges = (props.edges as Array<{ id: string; data: { dimmed?: boolean } }>) ?? [];
    const masterToA = edges.find((e) => e.id === 'master->a');
    expect(masterToA?.data.dimmed).toBe(false);
  });

  it('non-proposed states are never dim-worthy even when "unselected"', () => {
    // Running subtask with an empty selection set: selection is only
    // meaningful while proposed, so a running subtask must not dim
    // just because its id is absent from selectedSubtaskIds.
    useGraphStore.setState({
      masterNode: { id: 'master', label: 'Master', agent: 'claude' },
      finalNode: { id: 'final', label: 'Final', files: [], conflictFiles: [] },
      subtasks: [
        { id: 'a', title: 'A', why: null, agent: 'claude', dependsOn: [], replaces: [] },
      ],
      nodeSnapshots: new Map([['a', { value: 'running' as never }]]),
      selectedSubtaskIds: new Set(),
    });
    render(<GraphCanvas />);
    const props = reactFlowProps.mock.calls[0]?.[0] ?? {};
    const edges = (props.edges as Array<{ id: string; data: { dimmed?: boolean } }>) ?? [];
    const masterToA = edges.find((e) => e.id === 'master->a');
    expect(masterToA?.data.dimmed).toBe(false);
  });
});

describe('GraphCanvas — per-state worker height', () => {
  // States with a streaming surface (chip stack, hint input) grow the
  // worker card to 200px. History: 180 (Phase 4 Step 3) → 240 (Phase 7
  // Step 1 polish) → 200 (Phase 7 polish round 2 after the LogBlock
  // was moved behind the expand toggle and the chip stack tightened
  // to 3 visible chips on a single row).
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

  it('running worker gets the 200px height override', () => {
    const nodes = seedTwoWorkerDag('running', 'proposed');
    const a = nodes.find((n) => n.id === 'a');
    expect(a?.data.height).toBe(200);
  });

  it('row-max alignment: proposed neighbour in a running row also renders at 200px', () => {
    // Same row (layout is one-row default). The row-max lifts `b` to
    // match `a`'s expanded height so the grid stays visually even.
    const nodes = seedTwoWorkerDag('running', 'proposed');
    const b = nodes.find((n) => n.id === 'b');
    expect(b?.data.height).toBe(200);
  });

  it('done, retrying, and failed also get 200px (each has a LogBlock)', () => {
    for (const state of ['done', 'retrying', 'failed']) {
      reactFlowProps.mockClear();
      const nodes = seedTwoWorkerDag(state, state);
      const a = nodes.find((n) => n.id === 'a');
      expect(a?.data.height, `height for ${state}`).toBe(200);
    }
  });

  it('human_escalation still wins at 280px (bigger override takes precedence)', () => {
    const nodes = seedTwoWorkerDag('human_escalation', 'running');
    const a = nodes.find((n) => n.id === 'a');
    const b = nodes.find((n) => n.id === 'b');
    expect(a?.data.height).toBe(280);
    // Row-max lifts the running neighbour to 280 too, not 200.
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

  it('chip detail expansion bumps the running card +80px (200 → 280)', () => {
    // Phase 7 polish: when ActivityChipStack opens an inline detail
    // panel, the card must grow to fit it. Layout reads
    // `subtaskChipExpanded` from the store to decide the bump.
    useGraphStore.setState({
      subtaskChipExpanded: new Map([['a', 'chip-0']]),
    });
    const nodes = seedTwoWorkerDag('running', 'proposed');
    const a = nodes.find((n) => n.id === 'a');
    expect(a?.data.height).toBe(280);
  });

  it('chip detail bump alignment lifts row-mate to the same height', () => {
    useGraphStore.setState({
      subtaskChipExpanded: new Map([['a', 'chip-0']]),
    });
    const nodes = seedTwoWorkerDag('running', 'proposed');
    const b = nodes.find((n) => n.id === 'b');
    expect(b?.data.height).toBe(280);
  });

  it('chip detail bump only fires for log-states (proposed unaffected)', () => {
    useGraphStore.setState({
      subtaskChipExpanded: new Map([['a', 'chip-0']]),
    });
    const nodes = seedTwoWorkerDag('proposed', 'proposed');
    const a = nodes.find((n) => n.id === 'a');
    // Proposed has no LogBlock branch — chip bump does not apply.
    expect(a?.data.height).toBe(140);
  });
});

describe('GraphCanvas — Controls lift', () => {
  // Phase 7 polish: ApprovalBar (status=awaiting_approval) and
  // ApplySummaryOverlay (status=applied) sit at the bottom of the
  // viewport and collide with the bottom-right Controls panel. The
  // canvas applies a `whalecode-controls--lifted` modifier class so
  // CSS bumps the panel's bottom margin.
  it('passes the bare class on running status (no bottom-anchored bar)', () => {
    useGraphStore.setState({ status: 'running' });
    render(<GraphCanvas />);
    const props = controlsProps.mock.calls[0]?.[0] ?? {};
    expect(props.className).toBe('whalecode-controls');
  });

  it('appends --lifted modifier on awaiting_approval (ApprovalBar visible)', () => {
    useGraphStore.setState({ status: 'awaiting_approval' });
    render(<GraphCanvas />);
    const props = controlsProps.mock.calls[0]?.[0] ?? {};
    expect(props.className).toContain('whalecode-controls--lifted');
  });

  it('appends --lifted modifier on applied (ApplySummaryOverlay visible)', () => {
    useGraphStore.setState({ status: 'applied' });
    render(<GraphCanvas />);
    const props = controlsProps.mock.calls[0]?.[0] ?? {};
    expect(props.className).toContain('whalecode-controls--lifted');
  });

  it('does not lift on idle / done / rejected', () => {
    for (const status of ['idle', 'done', 'rejected'] as const) {
      controlsProps.mockClear();
      useGraphStore.setState({ status });
      render(<GraphCanvas />);
      const props = controlsProps.mock.calls[0]?.[0] ?? {};
      expect(props.className, `status=${status}`).not.toContain('--lifted');
    }
  });
});
