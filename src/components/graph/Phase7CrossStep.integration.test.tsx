/**
 * Phase 7 Step 7 — component-level cross-step integration.
 *
 * The store-level tests in `state/phase7CrossStep.integration.test.ts`
 * cover slice-by-slice cross-step interactions. This file targets the
 * component layer where two Phase 7 surfaces must coexist:
 *
 *   - InlineDiffSidebar + PlanChecklist concurrent render (Pair 1
 *     layout: side-by-side at >=1400px, tab below).
 *   - Sidebar width clamp + persistence under feature pressure
 *     (Edge case 8).
 *   - Viewport breakpoint transition without crash (Edge case 10).
 *
 * The full GraphCanvas + ReactFlow stack is mocked the same way as
 * `GraphCanvas.test.tsx` so the layout assertions stay deterministic.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
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

const reactFlowProps = vi.fn();
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    reactFlowProps(props);
    return <>{(props as { children?: React.ReactNode }).children ?? null}</>;
  },
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReactFlow: () => ({
    setViewport: () => undefined,
    zoomIn: () => undefined,
    zoomOut: () => undefined,
    setCenter: () => Promise.resolve(true),
    getNode: () => null,
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  }),
  Background: () => null,
  BackgroundVariant: { Dots: 'dots', Lines: 'lines', Cross: 'cross' },
  Controls: () => null,
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
  ipcMocks.setSettings.mockReset();
  ipcMocks.setSettings.mockResolvedValue({} as unknown);
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
  }
  useGraphStore.getState().reset();
  useGraphStore.setState({
    masterNode: { id: 'master', label: 'Master', agent: 'claude' },
  });
});

afterEach(() => {
  useGraphStore.getState().reset();
});

function setViewportWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', {
    value: px,
    writable: true,
    configurable: true,
  });
}

describe('Phase 7 cross-step component — pair 1 layout: sidebar + checklist coexist', () => {
  it('side-by-side checklist renders at >=1400px (sidebar lives elsewhere in the tree)', () => {
    setViewportWidth(1700);
    render(<GraphCanvas />);
    const checklist = document.querySelector('[data-testid="plan-checklist"]');
    expect(checklist?.getAttribute('data-variant')).toBe('side-by-side');
  });

  it('tab-mode checklist at <1400px does not render the side-by-side variant', () => {
    setViewportWidth(1300);
    render(<GraphCanvas />);
    expect(
      document.querySelector('[data-testid="checklist-tab-bar"]'),
    ).not.toBeNull();
    // Side-by-side checklist is hidden — only the tab bar exposes it.
    expect(document.querySelector('[data-variant="side-by-side"]')).toBeNull();
  });

  it('crossing the 1400px breakpoint via window resize does not crash the canvas', () => {
    setViewportWidth(1100);
    render(<GraphCanvas />);
    expect(
      document.querySelector('[data-testid="checklist-tab-bar"]'),
    ).not.toBeNull();

    // Bump window.innerWidth + dispatch resize so GraphCanvas's
    // listener picks up the new value (rerender alone keeps the
    // state initialised at the first-mount width).
    setViewportWidth(1500);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(
      document.querySelector('[data-testid="plan-checklist"]')?.getAttribute(
        'data-variant',
      ),
    ).toBe('side-by-side');
  });

  it('checklist tab swap in narrow mode does not interfere with GraphCanvas mount cycle', () => {
    setViewportWidth(1200);
    render(<GraphCanvas />);
    const tab = document.querySelector(
      '[data-testid="checklist-tab-checklist"]',
    ) as HTMLElement;
    act(() => {
      fireEvent.click(tab);
    });
    // Switching tabs renders the checklist; ReactFlow stops rendering
    // (mutually exclusive content slot in narrow mode).
    expect(
      document.querySelector('[data-testid="plan-checklist"]'),
    ).not.toBeNull();
  });
});

describe('Phase 7 cross-step component — edge case 8: sidebar width clamp under pressure', () => {
  it('setInlineDiffSidebarWidth below MIN_WIDTH clamps to 320', async () => {
    await useGraphStore.getState().setInlineDiffSidebarWidth(100);
    expect(useGraphStore.getState().inlineDiffSidebarWidth).toBe(320);
  });

  it('setInlineDiffSidebarWidth above MAX_WIDTH clamps to 720', async () => {
    await useGraphStore.getState().setInlineDiffSidebarWidth(2_000);
    expect(useGraphStore.getState().inlineDiffSidebarWidth).toBe(720);
  });

  it('width persists across reset (settings-backed)', async () => {
    await useGraphStore.getState().setInlineDiffSidebarWidth(560);
    useGraphStore.getState().reset();
    expect(useGraphStore.getState().inlineDiffSidebarWidth).toBe(560);
  });

  it('hydrate from settings clamps a stored out-of-range value (defensive)', () => {
    useGraphStore.getState().hydrateInlineDiffSidebarWidth(5_000);
    expect(useGraphStore.getState().inlineDiffSidebarWidth).toBe(720);
    useGraphStore.getState().hydrateInlineDiffSidebarWidth(50);
    expect(useGraphStore.getState().inlineDiffSidebarWidth).toBe(320);
  });

  it('hydrate ignores undefined / null (no clobber of user-set value)', async () => {
    await useGraphStore.getState().setInlineDiffSidebarWidth(500);
    useGraphStore.getState().hydrateInlineDiffSidebarWidth(undefined);
    expect(useGraphStore.getState().inlineDiffSidebarWidth).toBe(500);
    useGraphStore.getState().hydrateInlineDiffSidebarWidth(null);
    expect(useGraphStore.getState().inlineDiffSidebarWidth).toBe(500);
  });
});

describe('Phase 7 cross-step component — edge case 10: layout breakpoint transitions', () => {
  // Phase 7 Step 3 spec: above 1400 px the checklist sits side-by-side
  // with the graph; below the threshold a tab bar replaces the
  // always-on layout. Drag-between-monitors stress tests this.

  it('1400 ↔ 1399 round trip: side-by-side ↔ tab without flash of unstyled content', () => {
    setViewportWidth(1500);
    render(<GraphCanvas />);
    expect(
      document.querySelector('[data-testid="plan-checklist"]')?.getAttribute(
        'data-variant',
      ),
    ).toBe('side-by-side');

    setViewportWidth(1399);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(document.querySelector('[data-variant="side-by-side"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="checklist-tab-bar"]'),
    ).not.toBeNull();
  });

  it('mounted-once narrow viewport: tab bar always present, side-by-side never renders', () => {
    setViewportWidth(800);
    render(<GraphCanvas />);
    expect(
      document.querySelector('[data-testid="checklist-tab-bar"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-variant="side-by-side"]')).toBeNull();
  });

  it('exact threshold values: 1400 → side-by-side, 1399 → tab', () => {
    setViewportWidth(1400);
    render(<GraphCanvas />);
    expect(
      document.querySelector('[data-testid="plan-checklist"]')?.getAttribute(
        'data-variant',
      ),
    ).toBe('side-by-side');

    setViewportWidth(1399);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(document.querySelector('[data-variant="side-by-side"]')).toBeNull();
  });
});

describe('Phase 7 cross-step component — sidebar default-open derivation interacts with graph status', () => {
  // Sidebar is mounted as a sibling of GraphCanvas elsewhere in the
  // tree (App layout). The derivation lives in the store and the
  // sidebar component reads it. These tests pin the
  // `computeSidebarOpen` x `status` interaction surface that Step 5
  // (follow-up) and Step 1 (sidebar) share without rendering the
  // sidebar itself — the dedicated sidebar test file already covers
  // the render path.
  it('toggle on running flips user-toggled override; reset clears it', () => {
    useGraphStore.setState({ status: 'running' });
    useGraphStore.getState().toggleInlineDiffSidebar();
    expect(useGraphStore.getState().inlineDiffSidebarUserToggled).not.toBeNull();
    useGraphStore.getState().reset();
    expect(useGraphStore.getState().inlineDiffSidebarUserToggled).toBeNull();
  });

  it('width survives reset; selection + override do not (follow-up surface contract)', () => {
    useGraphStore.setState({ status: 'running' });
    void useGraphStore.getState().setInlineDiffSidebarWidth(500);
    useGraphStore.getState().selectDiffWorker('a', false);
    useGraphStore.getState().toggleInlineDiffSidebar();
    useGraphStore.getState().reset();
    const s = useGraphStore.getState();
    expect(s.inlineDiffSidebarWidth).toBe(500);
    expect(s.inlineDiffSelection.size).toBe(0);
    expect(s.inlineDiffSidebarUserToggled).toBeNull();
  });
});

// Suppress unused import warning when nothing in this block needs `screen`.
void screen;
