/**
 * Phase 7 Step 3 — PlanChecklist unit tests.
 *
 * Covers:
 *   - master plan top row with italic + agent label;
 *   - one row per subtask, in plan order;
 *   - state icons (running spinner / done check / failed X /
 *     cancelled X / awaiting_input pause / human_escalation alert);
 *   - cancelled + revert_intent flips icon testid + appends
 *     "Reverted" to the secondary line;
 *   - row click pans graph via `setCenter` with preserved zoom;
 *   - cancelled run freezes the rendered states (no jump back to
 *     proposed);
 *   - merge row visibility on Applied / Merging.
 *
 * `useReactFlow` is mocked to capture `setCenter` calls; the rest
 * of the React Flow surface is irrelevant here.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reactFlowMock = vi.hoisted(() => ({
  setCenter: vi.fn().mockResolvedValue(true),
  getNode: vi.fn(),
  getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
}));

vi.mock('@xyflow/react', () => ({
  useReactFlow: () => reactFlowMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

import { useGraphStore } from '../../state/graphStore';
import type { NodeState } from '../../state/nodeMachine';

import { PlanChecklist } from './PlanChecklist';

beforeEach(() => {
  reactFlowMock.setCenter.mockClear();
  reactFlowMock.getNode.mockReset();
  useGraphStore.getState().reset();
});

afterEach(() => {
  useGraphStore.getState().reset();
});

function seed(opts: {
  status?: ReturnType<typeof useGraphStore.getState>['status'];
  master?: boolean;
  subtasks?: Array<{
    id: string;
    title: string;
    state: NodeState;
    agent?: 'claude' | 'codex' | 'gemini';
  }>;
  reverted?: string[];
  finalNode?: boolean;
}) {
  const subtasks = (opts.subtasks ?? []).map((s) => ({
    id: s.id,
    title: s.title,
    why: null,
    agent: (s.agent ?? 'claude') as 'claude' | 'codex' | 'gemini',
    dependsOn: [],
    replaces: [],
    replanCount: 0,
  }));
  const snaps = new Map<string, { value: NodeState }>();
  for (const s of opts.subtasks ?? []) {
    snaps.set(s.id, { value: s.state });
  }
  useGraphStore.setState({
    status: opts.status ?? 'running',
    masterNode:
      (opts.master ?? true)
        ? { id: 'master', label: 'Master', agent: 'claude' }
        : null,
    subtasks,
    nodeSnapshots: snaps,
    subtaskRevertIntent: new Set(opts.reverted ?? []),
    finalNode:
      opts.finalNode === false
        ? null
        : { id: 'final', label: 'Merge', files: [], conflictFiles: null },
  });
}

describe('PlanChecklist — render', () => {
  it('renders master plan as italic top row with agent label', () => {
    seed({
      master: true,
      subtasks: [{ id: 's1', title: 'first', state: 'proposed' }],
    });
    render(<PlanChecklist />);
    const master = screen.getByTestId('plan-checklist-row-master');
    expect(master).toBeInTheDocument();
    expect(master.textContent).toContain('Master plan');
    expect(master.textContent).toContain('Claude');
    expect(master.querySelector('.italic')).not.toBeNull();
  });

  it('renders one row per subtask in plan order', () => {
    seed({
      subtasks: [
        { id: 'a', title: 'first', state: 'done' },
        { id: 'b', title: 'second', state: 'running' },
        { id: 'c', title: 'third', state: 'proposed' },
      ],
    });
    render(<PlanChecklist />);
    expect(screen.getByTestId('plan-checklist-row-a')).toBeInTheDocument();
    expect(screen.getByTestId('plan-checklist-row-b')).toBeInTheDocument();
    expect(screen.getByTestId('plan-checklist-row-c')).toBeInTheDocument();
  });

  it('renders Merge row when finalNode + non-idle status', () => {
    seed({
      status: 'merging',
      subtasks: [{ id: 'a', title: 't', state: 'done' }],
    });
    render(<PlanChecklist />);
    expect(screen.getByTestId('plan-checklist-row-final')).toBeInTheDocument();
  });

  it('hides Merge row when status=idle', () => {
    seed({
      status: 'idle',
      subtasks: [],
    });
    render(<PlanChecklist />);
    expect(screen.queryByTestId('plan-checklist-row-final')).toBeNull();
  });

  it('hides master row when masterNode is null', () => {
    seed({
      master: false,
      subtasks: [{ id: 'a', title: 't', state: 'proposed' }],
    });
    render(<PlanChecklist />);
    expect(screen.queryByTestId('plan-checklist-row-master')).toBeNull();
  });
});

describe('PlanChecklist — state icons', () => {
  it('uses running spinner for running + retrying states', () => {
    seed({
      subtasks: [
        { id: 'r', title: 'running', state: 'running' },
        { id: 'rt', title: 'retrying', state: 'retrying' },
      ],
    });
    render(<PlanChecklist />);
    const icons = screen.getAllByTestId('plan-checklist-icon-running');
    expect(icons).toHaveLength(2);
  });

  it('uses check for done', () => {
    seed({ subtasks: [{ id: 'd', title: 'done', state: 'done' }] });
    render(<PlanChecklist />);
    const row = screen.getByTestId('plan-checklist-row-d');
    expect(
      within(row).getByTestId('plan-checklist-icon-done'),
    ).toBeInTheDocument();
  });

  it('uses X for failed', () => {
    seed({ subtasks: [{ id: 'f', title: 'failed', state: 'failed' }] });
    render(<PlanChecklist />);
    const row = screen.getByTestId('plan-checklist-row-f');
    expect(
      within(row).getByTestId('plan-checklist-icon-failed'),
    ).toBeInTheDocument();
  });

  it('uses cancelled icon when state=cancelled (no revert_intent)', () => {
    seed({ subtasks: [{ id: 'c', title: 'cancelled', state: 'cancelled' }] });
    render(<PlanChecklist />);
    const row = screen.getByTestId('plan-checklist-row-c');
    expect(
      within(row).getByTestId('plan-checklist-icon-cancelled'),
    ).toBeInTheDocument();
  });

  it('flips icon to reverted variant when revert_intent set', () => {
    seed({
      subtasks: [{ id: 'c', title: 'cancelled', state: 'cancelled' }],
      reverted: ['c'],
    });
    render(<PlanChecklist />);
    const row = screen.getByTestId('plan-checklist-row-c');
    expect(
      within(row).getByTestId('plan-checklist-icon-reverted'),
    ).toBeInTheDocument();
  });

  it('appends "Reverted" to the secondary label of reverted rows', () => {
    seed({
      subtasks: [{ id: 'c', title: 'cancelled', state: 'cancelled' }],
      reverted: ['c'],
    });
    render(<PlanChecklist />);
    const row = screen.getByTestId('plan-checklist-row-c');
    expect(row.textContent).toMatch(/Reverted/i);
  });

  it('uses pause icon for awaiting_input', () => {
    seed({
      subtasks: [{ id: 'q', title: 'q', state: 'awaiting_input' }],
    });
    render(<PlanChecklist />);
    expect(
      screen.getByTestId('plan-checklist-icon-awaiting-input'),
    ).toBeInTheDocument();
  });

  it('uses alert icon for human_escalation', () => {
    seed({
      subtasks: [{ id: 'h', title: 'h', state: 'human_escalation' }],
    });
    render(<PlanChecklist />);
    expect(
      screen.getByTestId('plan-checklist-icon-escalation'),
    ).toBeInTheDocument();
  });

  it('uses empty circle for proposed / waiting / idle', () => {
    seed({
      subtasks: [
        { id: 'p', title: 'p', state: 'proposed' },
        { id: 'w', title: 'w', state: 'waiting' },
      ],
    });
    render(<PlanChecklist />);
    const empties = screen.getAllByTestId('plan-checklist-icon-empty');
    expect(empties.length).toBeGreaterThanOrEqual(2);
  });
});

describe('PlanChecklist — click → setCenter', () => {
  it('clicking a worker row pans graph to that node, preserving zoom', () => {
    reactFlowMock.getNode.mockImplementation((id: string) => {
      if (id === 'a') {
        return {
          id,
          width: 280,
          height: 200,
          position: { x: 100, y: 200 },
        };
      }
      return null;
    });
    reactFlowMock.getViewport.mockReturnValue({ x: 0, y: 0, zoom: 1.5 });
    seed({
      subtasks: [{ id: 'a', title: 'first', state: 'running' }],
    });
    render(<PlanChecklist />);
    fireEvent.click(screen.getByTestId('plan-checklist-row-a'));
    expect(reactFlowMock.setCenter).toHaveBeenCalledWith(
      // (100 + 280/2, 200 + 200/2)
      240,
      300,
      { zoom: 1.5, duration: 300 },
    );
  });

  it('clicking the master row pans graph to MASTER_ID', () => {
    reactFlowMock.getNode.mockImplementation((id: string) =>
      id === 'master'
        ? { id, width: 280, height: 80, position: { x: 0, y: 0 } }
        : null,
    );
    seed({ subtasks: [] });
    render(<PlanChecklist />);
    fireEvent.click(screen.getByTestId('plan-checklist-row-master'));
    expect(reactFlowMock.getNode).toHaveBeenCalledWith('master');
    expect(reactFlowMock.setCenter).toHaveBeenCalled();
  });

  it('clicking a row with no node entry no-ops gracefully', () => {
    reactFlowMock.getNode.mockReturnValue(null);
    seed({
      subtasks: [{ id: 'ghost', title: 'ghost', state: 'proposed' }],
    });
    render(<PlanChecklist />);
    fireEvent.click(screen.getByTestId('plan-checklist-row-ghost'));
    expect(reactFlowMock.setCenter).not.toHaveBeenCalled();
  });
});

describe('PlanChecklist — freeze on cancelled run', () => {
  it('renders existing rows in their last-known states when status=cancelled', () => {
    seed({
      status: 'cancelled',
      subtasks: [
        { id: 'a', title: 'first', state: 'done' },
        { id: 'b', title: 'second', state: 'cancelled' },
      ],
    });
    render(<PlanChecklist />);
    expect(
      within(screen.getByTestId('plan-checklist-row-a')).getByTestId(
        'plan-checklist-icon-done',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('plan-checklist-row-b')).getByTestId(
        'plan-checklist-icon-cancelled',
      ),
    ).toBeInTheDocument();
  });
});

describe('PlanChecklist — variant prop', () => {
  it('passes data-variant=tab by default (tabbed mode)', () => {
    seed({ subtasks: [{ id: 'a', title: 't', state: 'proposed' }] });
    render(<PlanChecklist />);
    expect(screen.getByTestId('plan-checklist').getAttribute('data-variant')).toBe(
      'tab',
    );
  });

  it('passes data-variant=side-by-side when parent forwards the suffix', () => {
    seed({ subtasks: [{ id: 'a', title: 't', state: 'proposed' }] });
    render(<PlanChecklist data-testid-suffix="side-by-side" />);
    expect(screen.getByTestId('plan-checklist').getAttribute('data-variant')).toBe(
      'side-by-side',
    );
  });
});
