import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

// `<Handle>` needs a React Flow provider; we only care about the body rendering,
// so stub it to a passthrough element. `useReactFlow` is also stubbed — the
// dependency click-to-pan tests override it via `reactFlowMock` below.
const reactFlowMock = {
  getNode: vi.fn<(id: string) => { position: { x: number; y: number }; width?: number; height?: number } | undefined>(),
  setCenter: vi.fn().mockResolvedValue(true),
  getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
};
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  useReactFlow: () => reactFlowMock,
}));

import { useAgentStore } from '../../state/agentStore';
import { useGraphStore } from '../../state/graphStore';

import { WorkerNode, type WorkerNodeData } from './WorkerNode';

function renderNode(id: string, data: WorkerNodeData) {
  const props = { id, data } as unknown as React.ComponentProps<typeof WorkerNode>;
  return render(<WorkerNode {...props} />);
}

/** Populate detection so the worker dropdown has options. */
function seedAgentDetection() {
  useAgentStore.setState({
    detection: {
      claude: { status: 'available', version: '1.0.0', binaryPath: '/c' },
      codex: { status: 'available', version: '1.0.0', binaryPath: '/co' },
      gemini: { status: 'not-installed' },
      recommendedMaster: 'claude',
    },
    checking: false,
    error: null,
  });
}

beforeEach(() => {
  useGraphStore.getState().reset();
  useAgentStore.setState({ detection: null, checking: false, error: null });
  reactFlowMock.getNode.mockReset();
  reactFlowMock.setCenter.mockClear();
  reactFlowMock.getViewport.mockClear();
  reactFlowMock.getViewport.mockReturnValue({ x: 0, y: 0, zoom: 1 });
});

afterEach(() => {
  useGraphStore.getState().reset();
  useAgentStore.setState({ detection: null, checking: false, error: null });
});

describe('WorkerNode — card-click selection in proposed state', () => {
  it('clicking the checkbox toggles subtask selection', () => {
    const toggle = vi.fn();
    useGraphStore.setState({ toggleSubtaskSelection: toggle });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'Write ThemeProvider',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });

    fireEvent.click(screen.getByRole('checkbox'));
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
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });

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
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });

    fireEvent.click(screen.getByText('Running subtask'));
    expect(toggle).not.toHaveBeenCalled();
  });
});

describe('WorkerNode — proposed-state dim on deselection', () => {
  // Commit 5 (Phase 3.5 Item 5): unticked proposed subtasks dim to 50%
  // opacity with a neutral gray border so the surviving selection reads
  // as the focus. Only applies while proposed — running/done/failed
  // cards never belong to the approval set and must ignore selection.

  /** Find the outermost NodeContainer div rendered by WorkerNode. */
  function rootContainer(container: HTMLElement): HTMLElement {
    const el = container.querySelector('[style*="width"]');
    if (!el) throw new Error('NodeContainer root not found');
    return el as HTMLElement;
  }

  it('proposed + unselected renders at 50% opacity with a neutral gray border', () => {
    // Reset is enough: selectedSubtaskIds defaults to an empty Set so
    // any id is treated as unticked.
    const { container } = renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'Unticked',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    const root = rootContainer(container);
    expect(root.style.opacity).toBe('0.5');
    // Dim preserves the 1px dashed width/style from the `proposed`
    // state (via the `border` shorthand) and swaps only the color
    // via the `borderColor` longhand so the 100ms transition can
    // interpolate it. JSDOM drops the style tag from the shorthand
    // roundtrip when a longhand override is present, so assert on
    // the longhands directly.
    expect(root.style.borderStyle).toBe('dashed');
    expect(root.style.borderWidth).toBe('1px');
    expect(root.style.borderColor).toBe('var(--color-border-default)');
  });

  it('proposed + selected renders at full opacity with the pending-yellow border', () => {
    useGraphStore.setState({ selectedSubtaskIds: new Set(['auth']) });
    const { container } = renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'Ticked',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    const root = rootContainer(container);
    // Empty string means the dim's inline opacity override didn't fire.
    expect(root.style.opacity).toBe('');
    expect(root.style.border).toContain('var(--color-status-pending)');
  });

  it('non-proposed states never dim even when absent from selection', () => {
    // Running subtask with an empty selection set: must not dim.
    useGraphStore.setState({ selectedSubtaskIds: new Set() });
    const { container } = renderNode('auth', {
      state: 'running',
      agent: 'claude',
      title: 'Running subtask',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    const root = rootContainer(container);
    expect(root.style.opacity).toBe('');
  });

  it('declares the 100ms opacity transition so tick/untick feels like a fade, not a jump', () => {
    const { container } = renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'Unticked',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    const root = rootContainer(container);
    expect(root.style.transition).toContain('opacity 100ms');
  });
});

describe('WorkerNode — inline edit surfaces (proposed only)', () => {
  it('proposed renders editable title + why triggers', () => {
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'Write ThemeProvider',
      why: 'We need tokens before components.',
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    expect(screen.getByRole('button', { name: /Edit Subtask title/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Edit Subtask rationale/i })).toBeDefined();
  });

  // Regression: in proposed state the card is a fixed 140px and the why
  // field can wrap to multiple lines. Without `shrink-0`, flex's default
  // shrink + the `truncate` class's `overflow: hidden` squeezed the title
  // to zero height and the text disappeared on multi-line rationales —
  // the exact bug observed in Phase 3 Step 9 verification.
  it('proposed title carries shrink-0 so a long wrapping why cannot squeeze it invisible', () => {
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'Write the ThemeProvider module and wire it into the shell',
      why: 'We need the dark-mode tokens declared before any component can render; this unblocks the approval flow and is the first piece that touches shared styles.',
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    const titleButton = screen.getByRole('button', { name: /Edit Subtask title/i });
    expect(titleButton.className).toMatch(/shrink-0/);
  });

  it('non-proposed renders read-only title, no inline editors', () => {
    renderNode('auth', {
      state: 'running',
      agent: 'claude',
      title: 'Running subtask',
      why: 'body',
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    expect(screen.queryByRole('button', { name: /Edit Subtask title/i })).toBeNull();
    expect(screen.getByText('Running subtask')).toBeDefined();
  });

  it('saving a new title calls updateSubtask with trimmed title', async () => {
    const updateSubtask = vi.fn().mockResolvedValue(undefined);
    useGraphStore.setState({ updateSubtask });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'Old',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: /Edit Subtask title/i }));
    const input = screen.getByLabelText('Subtask title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  New title  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(updateSubtask).toHaveBeenCalledWith('auth', { title: 'New title' }),
    );
  });

  it('empty title is rejected by inline validate, updateSubtask not called', () => {
    const updateSubtask = vi.fn();
    useGraphStore.setState({ updateSubtask });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'Old',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: /Edit Subtask title/i }));
    const input = screen.getByLabelText('Subtask title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateSubtask).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Title is required.');
  });

  it('clearing why saves null (backend-clear sentinel)', async () => {
    const updateSubtask = vi.fn().mockResolvedValue(undefined);
    useGraphStore.setState({ updateSubtask });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 't',
      why: 'some rationale',
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: /Edit Subtask rationale/i }));
    const ta = screen.getByLabelText('Subtask rationale') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '   ' } });
    // Multiline uses Cmd+Enter.
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
    await waitFor(() =>
      expect(updateSubtask).toHaveBeenCalledWith('auth', { why: null }),
    );
  });
});

describe('WorkerNode — non-proposed body', () => {
  // The read-only body covers every state after `proposed`: approved,
  // running, done, failed, escalating, human_escalation, skipped, idle,
  // thinking, waiting, retrying. It must render the title even when
  // empty (fallback placeholder) and surface the master's rationale as
  // single-line context.

  it('renders a falling-back italic "(Untitled subtask)" when title is empty', () => {
    renderNode('auth', {
      state: 'running',
      agent: 'claude',
      title: '',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    const fallback = screen.getByText('(Untitled subtask)');
    expect(fallback).toBeDefined();
    // Visual guard: italic + tertiary classes, no primary color.
    expect(fallback.className).toMatch(/italic/);
    expect(fallback.className).toMatch(/text-fg-tertiary/);
    expect(fallback.className).not.toMatch(/text-fg-primary/);
  });

  it('uses primary color for a non-empty title', () => {
    renderNode('auth', {
      state: 'running',
      agent: 'claude',
      title: 'Apply theme tokens',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    const title = screen.getByText('Apply theme tokens');
    expect(title.className).toMatch(/text-fg-primary/);
    expect(title.className).not.toMatch(/italic/);
  });

  it('renders the why line beneath the title when present', () => {
    renderNode('auth', {
      state: 'running',
      agent: 'claude',
      title: 'Apply theme tokens',
      why: 'Needed before components can render in dark mode.',
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    const why = screen.getByTestId('worker-why');
    expect(why.textContent).toBe('Needed before components can render in dark mode.');
    expect(why.className).toMatch(/italic/);
    expect(why.className).toMatch(/text-fg-tertiary/);
  });

  it('omits the why line entirely when why is null or whitespace', () => {
    const { rerender } = renderNode('auth', {
      state: 'running',
      agent: 'claude',
      title: 't',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    expect(screen.queryByTestId('worker-why')).toBeNull();

    const propsWhitespace = {
      id: 'auth',
      data: {
        state: 'running',
        agent: 'claude',
        title: 't',
        why: '   ',
        dependsOn: [],
        replaces: [],
        retries: 0,
      },
    } as unknown as React.ComponentProps<typeof WorkerNode>;
    rerender(<WorkerNode {...propsWhitespace} />);
    expect(screen.queryByTestId('worker-why')).toBeNull();
  });

  it('applies strike-through style in escalating/skipped states', () => {
    renderNode('auth', {
      state: 'escalating',
      agent: 'claude',
      title: 'Failed subtask',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    const title = screen.getByText('Failed subtask');
    expect(title.getAttribute('style')).toMatch(/line-through/);
  });

  // Regression: the empty LogBlock used to render a pitch-black
  // rectangle (`background: var(--color-bg-primary)`) between when
  // the subtask entered running and the first log line landed —
  // the "black hole" the user flagged during Phase 3 Step 9
  // verification. The fix swaps that for a muted placeholder row
  // with a blinking cursor, kept only while the actor is actively
  // streaming (running/retrying).
  it('empty logs in running state show the "Waiting for output…" placeholder', () => {
    useGraphStore.setState({ nodeLogs: new Map([['auth', []]]) });
    renderNode('auth', {
      state: 'running',
      agent: 'claude',
      title: 'Apply theme tokens',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    const waiting = screen.getByTestId('worker-log-waiting');
    expect(waiting.textContent).toMatch(/Waiting for output/);
    // The wrapper LogBlock renders regardless — the placeholder sits
    // inside it so the card's 180px height stays reserved and the
    // eventual first log line arrives without a layout shift.
    expect(screen.getByTestId('worker-log-block')).toBeDefined();
  });

  it('empty logs in done/failed states do NOT render the LogBlock (no misleading "waiting" hint)', () => {
    for (const state of ['done', 'failed'] as const) {
      useGraphStore.setState({ nodeLogs: new Map([['auth', []]]) });
      const { unmount } = renderNode('auth', {
        state,
        agent: 'claude',
        title: 'Apply theme tokens',
        why: null,
        dependsOn: [],
        replaces: [],
        retries: 0,
      });
      expect(screen.queryByTestId('worker-log-block'), `state=${state}`).toBeNull();
      expect(screen.queryByTestId('worker-log-waiting'), `state=${state}`).toBeNull();
      unmount();
    }
  });

  it('non-empty logs render normal tail and no "Waiting…" placeholder', () => {
    useGraphStore.setState({ nodeLogs: new Map([['auth', ['✓ done step 1', '→ starting step 2']]]) });
    renderNode('auth', {
      state: 'running',
      agent: 'claude',
      title: 'Apply theme tokens',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    expect(screen.getByTestId('worker-log-block')).toBeDefined();
    expect(screen.queryByTestId('worker-log-waiting')).toBeNull();
    expect(screen.getByText(/starting step 2/i)).toBeDefined();
  });

  // Regression: the running-state card packs header + title + why +
  // LogBlock(54px) + chip into a fixed 140px. If the title or why loses
  // `shrink-0`, flex's default shrink + the `truncate` class's
  // `overflow: hidden` squeeze the line to zero height and the text
  // disappears — the exact bug we shipped in Phase 3 Step 9 verification.
  it('title and why carry shrink-0 so flex cannot squeeze them invisible', () => {
    renderNode('auth', {
      state: 'running',
      agent: 'claude',
      title: 'Apply theme tokens across the design system audit',
      why: 'Needed before components can render in dark mode, once more',
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    const title = screen.getByText(/Apply theme tokens/i);
    const why = screen.getByTestId('worker-why');
    expect(title.className).toMatch(/shrink-0/);
    expect(why.className).toMatch(/shrink-0/);
  });
});

describe('WorkerNode — edited/added badges', () => {
  it('added badge shown when isSubtaskAdded is true', () => {
    useGraphStore.setState((state) => ({
      userAddedSubtaskIds: new Set([...state.userAddedSubtaskIds, 'auth']),
    }));
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 't',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    expect(screen.getByText('added')).toBeDefined();
  });

  it('edited badge shown when current title differs from original snapshot', () => {
    useGraphStore.setState({
      originalSubtasks: new Map([
        ['auth', { title: 'Old', why: null, agent: 'claude' }],
      ]),
      subtasks: [
        {
          id: 'auth',
          title: 'New',
          why: null,
          agent: 'claude',
          dependsOn: [],
          replaces: [],
        },
      ],
    });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'New',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    expect(screen.getByText('edited')).toBeDefined();
  });

  it('added + edited are mutually exclusive — user-added never gets edited', () => {
    useGraphStore.setState({
      userAddedSubtaskIds: new Set(['auth']),
      originalSubtasks: new Map([
        ['auth', { title: 'Irrelevant', why: null, agent: 'claude' }],
      ]),
      subtasks: [
        {
          id: 'auth',
          title: 'Different',
          why: null,
          agent: 'claude',
          dependsOn: [],
          replaces: [],
        },
      ],
    });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'Different',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    expect(screen.getByText('added')).toBeDefined();
    expect(screen.queryByText('edited')).toBeNull();
  });

  it('badges are hidden outside proposed state', () => {
    useGraphStore.setState({
      userAddedSubtaskIds: new Set(['auth']),
    });
    renderNode('auth', {
      state: 'running',
      agent: 'claude',
      title: 't',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    expect(screen.queryByText('added')).toBeNull();
  });
});

describe('WorkerNode — replaces badge (Layer-2 replan)', () => {
  // The badge renders "replaces #N" where #N is the 1-indexed position of
  // the replaced subtask in the current plan — so a replacement tagged with
  // `replaces: ['failed1']` reads off the row index of 'failed1'. Failed
  // rows stick around in `subtasks` after replan so the lineage resolves.

  it('renders "replaces #N" when the replacement is tagged', () => {
    useGraphStore.setState({
      subtasks: [
        { id: 'failed1', title: 'Failed one', why: null, agent: 'claude', dependsOn: [], replaces: [] },
        { id: 'repl1', title: 'Repaired', why: null, agent: 'claude', dependsOn: [], replaces: ['failed1'] },
      ],
    });
    renderNode('repl1', {
      state: 'proposed',
      agent: 'claude',
      title: 'Repaired',
      why: null,
      dependsOn: [],
      replaces: ['failed1'],
      retries: 0,
    });
    expect(screen.getByText(/replaces #1/i)).toBeDefined();
  });

  it('renders nothing when the replaced id is no longer in the plan (race guard)', () => {
    // The failed row was evicted from `subtasks` between the event and the
    // render — the badge should silently drop rather than show "#-1" or crash.
    useGraphStore.setState({
      subtasks: [
        { id: 'repl1', title: 'Repaired', why: null, agent: 'claude', dependsOn: [], replaces: ['ghost'] },
      ],
    });
    renderNode('repl1', {
      state: 'proposed',
      agent: 'claude',
      title: 'Repaired',
      why: null,
      dependsOn: [],
      replaces: ['ghost'],
      retries: 0,
    });
    expect(screen.queryByText(/replaces/i)).toBeNull();
  });

  it('shows the badge even outside proposed state (lineage stays visible while running/done)', () => {
    useGraphStore.setState({
      subtasks: [
        { id: 'failed1', title: 'Failed one', why: null, agent: 'claude', dependsOn: [], replaces: [] },
        { id: 'repl1', title: 'Repaired', why: null, agent: 'claude', dependsOn: [], replaces: ['failed1'] },
      ],
    });
    renderNode('repl1', {
      state: 'running',
      agent: 'claude',
      title: 'Repaired',
      why: null,
      dependsOn: [],
      replaces: ['failed1'],
      retries: 0,
    });
    expect(screen.getByText(/replaces #1/i)).toBeDefined();
  });
});

describe('WorkerNode — dependencies footer', () => {
  it('renders 1-indexed dependency list while proposed', () => {
    useGraphStore.setState({
      subtasks: [
        { id: 'a', title: '1', why: null, agent: 'claude', dependsOn: [] , replaces: [] },
        { id: 'b', title: '2', why: null, agent: 'claude', dependsOn: [] , replaces: [] },
        { id: 'c', title: '3', why: null, agent: 'claude', dependsOn: ['a', 'b'] , replaces: [] },
      ],
    });
    renderNode('c', {
      state: 'proposed',
      agent: 'claude',
      title: '3',
      why: null,
      dependsOn: ['a', 'b'],
      replaces: [],
      retries: 0,
    });
    expect(screen.getByText('#1')).toBeDefined();
    expect(screen.getByText('#2')).toBeDefined();
  });

  it('silently drops unknown dependency ids', () => {
    useGraphStore.setState({
      subtasks: [
        { id: 'a', title: '1', why: null, agent: 'claude', dependsOn: [] , replaces: [] },
      ],
    });
    renderNode('c', {
      state: 'proposed',
      agent: 'claude',
      title: '3',
      why: null,
      dependsOn: ['a', 'ghost'],
      replaces: [],
      retries: 0,
    });
    expect(screen.getByText('#1')).toBeDefined();
    expect(screen.queryByText(/ghost/)).toBeNull();
  });
});

describe('WorkerNode — dependency click-to-pan', () => {
  // Render a tiny DAG where subtask `c` depends on `a` and `b`. React Flow's
  // `getNode` returns positions we control via the mock so we can assert on
  // the exact (cx, cy) passed to setCenter.
  function seedDag() {
    useGraphStore.setState({
      subtasks: [
        { id: 'a', title: '1', why: null, agent: 'claude', dependsOn: [] , replaces: [] },
        { id: 'b', title: '2', why: null, agent: 'claude', dependsOn: [] , replaces: [] },
        { id: 'c', title: '3', why: null, agent: 'claude', dependsOn: ['a', 'b'] , replaces: [] },
      ],
    });
    reactFlowMock.getNode.mockImplementation((id: string) => {
      if (id === 'a') return { position: { x: 100, y: 200 }, width: 200, height: 140 };
      if (id === 'b') return { position: { x: 400, y: 200 }, width: 200, height: 140 };
      return undefined;
    });
  }

  it('clicking #N calls setCenter with the dep node center + current zoom', () => {
    seedDag();
    reactFlowMock.getViewport.mockReturnValue({ x: 0, y: 0, zoom: 0.75 });
    renderNode('c', {
      state: 'proposed',
      agent: 'claude',
      title: '3',
      why: null,
      dependsOn: ['a', 'b'],
      replaces: [],
      retries: 0,
    });
    fireEvent.click(screen.getByTestId('depends-on-link-a'));
    // center = (100 + 200/2, 200 + 140/2) = (200, 270), zoom preserved at 0.75
    expect(reactFlowMock.setCenter).toHaveBeenCalledWith(200, 270, {
      zoom: 0.75,
      duration: 300,
    });
  });

  it('keyboard Enter on #N triggers the same pan', () => {
    seedDag();
    renderNode('c', {
      state: 'proposed',
      agent: 'claude',
      title: '3',
      why: null,
      dependsOn: ['a', 'b'],
      replaces: [],
      retries: 0,
    });
    const link = screen.getByTestId('depends-on-link-b');
    // <button> fires click on Enter/Space natively; simulate by focusing
    // then dispatching the browser's default keydown→click path.
    link.focus();
    expect(document.activeElement).toBe(link);
    fireEvent.click(link); // native button activation equivalent
    expect(reactFlowMock.setCenter).toHaveBeenCalledWith(500, 270, {
      zoom: 1,
      duration: 300,
    });
  });

  it('graceful no-op when the dep node has disappeared (mid-replan race)', () => {
    useGraphStore.setState({
      subtasks: [
        { id: 'a', title: '1', why: null, agent: 'claude', dependsOn: [] , replaces: [] },
        { id: 'c', title: '3', why: null, agent: 'claude', dependsOn: ['a'] , replaces: [] },
      ],
    });
    // Mock `getNode` to return undefined even though the store still has the
    // dep — simulates a re-plan removing the node between render and click.
    reactFlowMock.getNode.mockReturnValue(undefined);
    renderNode('c', {
      state: 'proposed',
      agent: 'claude',
      title: '3',
      why: null,
      dependsOn: ['a'],
      replaces: [],
      retries: 0,
    });
    fireEvent.click(screen.getByTestId('depends-on-link-a'));
    expect(reactFlowMock.setCenter).not.toHaveBeenCalled();
  });

  it('falls back to NODE_DIMENSIONS.worker when the node has no measured width/height', () => {
    useGraphStore.setState({
      subtasks: [
        { id: 'a', title: '1', why: null, agent: 'claude', dependsOn: [] , replaces: [] },
        { id: 'c', title: '3', why: null, agent: 'claude', dependsOn: ['a'] , replaces: [] },
      ],
    });
    // Omit width/height to simulate pre-measurement state.
    reactFlowMock.getNode.mockImplementation((id: string) =>
      id === 'a' ? { position: { x: 50, y: 50 } } : undefined,
    );
    renderNode('c', {
      state: 'proposed',
      agent: 'claude',
      title: '3',
      why: null,
      dependsOn: ['a'],
      replaces: [],
      retries: 0,
    });
    fireEvent.click(screen.getByTestId('depends-on-link-a'));
    // Default worker dimensions are 200×140.
    expect(reactFlowMock.setCenter).toHaveBeenCalledWith(150, 120, {
      zoom: 1,
      duration: 300,
    });
  });
});

describe('WorkerNode — remove button', () => {
  it('clicking × arms confirm prompt, confirm triggers removeSubtask', () => {
    const removeSubtask = vi.fn().mockResolvedValue(undefined);
    useGraphStore.setState({ removeSubtask });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 't',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    fireEvent.click(screen.getByTestId('worker-remove-button'));
    const yes = screen.getByRole('button', { name: /Confirm remove/i });
    fireEvent.click(yes);
    expect(removeSubtask).toHaveBeenCalledWith('auth');
  });

  it('cancel button aborts confirm', () => {
    const removeSubtask = vi.fn();
    useGraphStore.setState({ removeSubtask });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 't',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    fireEvent.click(screen.getByTestId('worker-remove-button'));
    fireEvent.click(screen.getByRole('button', { name: /Cancel remove/i }));
    expect(removeSubtask).not.toHaveBeenCalled();
    // Back to the plain × button.
    expect(screen.getByTestId('worker-remove-button')).toBeDefined();
  });

  it('remove button is not rendered outside proposed state', () => {
    renderNode('auth', {
      state: 'running',
      agent: 'claude',
      title: 't',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    expect(screen.queryByTestId('worker-remove-button')).toBeNull();
  });
});

describe('WorkerNode — worker dropdown', () => {
  it('only lists available agents from detection', () => {
    seedAgentDetection();
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 't',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    const trigger = screen.getByRole('button', { name: /Worker for auth/i });
    fireEvent.click(trigger);
    // Listbox is rendered; Gemini ("not-installed") should be absent.
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Claude');
    expect(options).toContain('Codex');
    expect(options).not.toContain('Gemini');
  });

  it('selecting a different agent calls updateSubtask', () => {
    seedAgentDetection();
    const updateSubtask = vi.fn().mockResolvedValue(undefined);
    useGraphStore.setState({ updateSubtask });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 't',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: /Worker for auth/i }));
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }));
    expect(updateSubtask).toHaveBeenCalledWith('auth', { assignedWorker: 'codex' });
  });

  it('selecting the same value does not call updateSubtask', () => {
    seedAgentDetection();
    const updateSubtask = vi.fn();
    useGraphStore.setState({ updateSubtask });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 't',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: /Worker for auth/i }));
    fireEvent.click(screen.getByRole('option', { name: 'Claude' }));
    expect(updateSubtask).not.toHaveBeenCalled();
  });
});

describe('WorkerNode — auto-enter edit for newly-added subtask', () => {
  it('when lastAddedSubtaskId matches this id, the title enters edit mode on mount and the flag clears', () => {
    const clearLastAddedSubtaskId = vi.fn();
    useGraphStore.setState({
      lastAddedSubtaskId: 'auth',
      clearLastAddedSubtaskId,
    });
    act(() => {
      renderNode('auth', {
        state: 'proposed',
        agent: 'claude',
        title: '',
        why: null,
        dependsOn: [],
        replaces: [],
        retries: 0,
      });
    });
    const input = screen.getByLabelText('Subtask title');
    expect(document.activeElement).toBe(input);
    expect(clearLastAddedSubtaskId).toHaveBeenCalled();
  });

  it('when lastAddedSubtaskId does not match, title stays in display mode', () => {
    useGraphStore.setState({ lastAddedSubtaskId: 'other' });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 't',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    // Display mode renders a button, not the input.
    expect(screen.getByRole('button', { name: /Edit Subtask title/i })).toBeDefined();
    expect(screen.queryByLabelText('Subtask title')).toBeNull();
  });
});

describe('WorkerNode — file-count chip + diff popover', () => {
  // Phase 3.5 Item 6: once the backend emits `run:subtask_diff` the
  // store populates `subtaskDiffs` by subtask id. Done/failed/etc.
  // workers render a chip reading "N files" that opens a popover
  // listing each path with +/- counts. The chip is hidden until the
  // diff lands (no chip during `running`/`proposed`) and hidden on
  // proposed cards entirely (they haven't run yet).
  function seedDiff(id: string, files: Array<{ path: string; additions: number; deletions: number }>) {
    useGraphStore.setState({
      subtaskDiffs: new Map([[id, Object.freeze(files.slice())]]),
    });
  }

  it('renders the "N files" chip on a done worker once a diff is recorded', () => {
    seedDiff('auth', [
      { path: 'src/auth.ts', additions: 10, deletions: 2 },
      { path: 'tests/auth.test.ts', additions: 40, deletions: 0 },
    ]);
    renderNode('auth', {
      state: 'done',
      agent: 'claude',
      title: 'Add login',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    expect(screen.getByTestId('worker-file-count-chip').textContent).toMatch(/2 files/);
  });

  it('singular "1 file" when exactly one path changed', () => {
    seedDiff('auth', [{ path: 'src/auth.ts', additions: 5, deletions: 0 }]);
    renderNode('auth', {
      state: 'done',
      agent: 'claude',
      title: 'Tweak',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    expect(screen.getByTestId('worker-file-count-chip').textContent).toMatch(/1 file\b/);
  });

  it('chip is absent while the subtask is still running (no diff yet)', () => {
    // No entry in `subtaskDiffs` — the store map is empty.
    renderNode('auth', {
      state: 'running',
      agent: 'claude',
      title: 'Running',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    expect(screen.queryByTestId('worker-file-count-chip')).toBeNull();
  });

  it('chip is absent on proposed cards even if a diff is somehow present', () => {
    // Defensive: a diff for a proposed subtask shouldn't happen (the
    // backend emits diffs during Apply, long after the subtask left
    // proposed). Chip must still hide because the proposed state has
    // the checkbox + approval UI in the same region.
    seedDiff('auth', [{ path: 'src/x.ts', additions: 1, deletions: 0 }]);
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'Pending',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    expect(screen.queryByTestId('worker-file-count-chip')).toBeNull();
  });

  it('clicking the chip opens the popover with path + +/- counts', () => {
    seedDiff('auth', [
      { path: 'src/auth.ts', additions: 10, deletions: 2 },
      { path: 'tests/auth.test.ts', additions: 40, deletions: 0 },
    ]);
    renderNode('auth', {
      state: 'done',
      agent: 'claude',
      title: 'Add login',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    // Closed on mount.
    expect(screen.queryByTestId('diff-popover')).toBeNull();
    fireEvent.click(screen.getByTestId('worker-file-count-chip'));
    const popover = screen.getByTestId('diff-popover');
    expect(popover).toBeDefined();
    expect(popover.textContent).toMatch(/src\/auth\.ts/);
    expect(popover.textContent).toMatch(/\+10/);
    expect(popover.textContent).toMatch(/−2/);
    expect(popover.textContent).toMatch(/tests\/auth\.test\.ts/);
  });

  it('clicking the chip again closes the popover (toggle)', () => {
    seedDiff('auth', [{ path: 'src/x.ts', additions: 1, deletions: 0 }]);
    renderNode('auth', {
      state: 'done',
      agent: 'claude',
      title: 't',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    const chip = screen.getByTestId('worker-file-count-chip');
    fireEvent.click(chip);
    expect(screen.getByTestId('diff-popover')).toBeDefined();
    fireEvent.click(chip);
    expect(screen.queryByTestId('diff-popover')).toBeNull();
  });

  it('pressing Escape dismisses the popover', () => {
    seedDiff('auth', [{ path: 'src/x.ts', additions: 1, deletions: 0 }]);
    renderNode('auth', {
      state: 'done',
      agent: 'claude',
      title: 't',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    fireEvent.click(screen.getByTestId('worker-file-count-chip'));
    expect(screen.getByTestId('diff-popover')).toBeDefined();
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByTestId('diff-popover')).toBeNull();
  });

  it('"0 files" popover renders the "touched no files" empty state', () => {
    seedDiff('auth', []);
    renderNode('auth', {
      state: 'done',
      agent: 'claude',
      title: 't',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
    });
    expect(screen.getByTestId('worker-file-count-chip').textContent).toMatch(/0 files/);
    fireEvent.click(screen.getByTestId('worker-file-count-chip'));
    const popover = screen.getByTestId('diff-popover');
    expect(popover.textContent).toMatch(/touched no files/i);
    // Empty state replaces the list — assert no list rendered.
    expect(screen.queryByTestId('diff-popover-list')).toBeNull();
  });
});

describe('WorkerNode — expand toggle (Phase 4 Step 3)', () => {
  // The card body toggles expand on non-proposed states. Interactive
  // children (chips, buttons, dropdowns) keep their own handlers; the
  // whole-card onClick gates on `e.target === e.currentTarget` via the
  // browser's natural bubbling + `stopPropagation` on children.

  function baseData(
    overrides: Partial<WorkerNodeData> = {},
  ): WorkerNodeData {
    return {
      state: 'running',
      agent: 'claude',
      title: 'Worker A',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
      ...overrides,
    };
  }

  function cardRoot(id: string): HTMLElement {
    const el = screen.getByTestId(`worker-node-${id}`);
    return el as HTMLElement;
  }

  it('clicking the card body on a running worker toggles expand', () => {
    renderNode('sub-a', baseData());
    const card = cardRoot('sub-a');
    expect(card.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(card);
    expect(useGraphStore.getState().workerExpanded.has('sub-a')).toBe(true);
  });

  it('clicking the card body again collapses', () => {
    useGraphStore.setState({ workerExpanded: new Set(['sub-a']) });
    renderNode('sub-a', baseData({ state: 'done' }));
    const card = cardRoot('sub-a');
    expect(card.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(card);
    expect(useGraphStore.getState().workerExpanded.has('sub-a')).toBe(false);
  });

  it('does not expand while the subtask is in proposed state', () => {
    const toggleSel = vi.fn();
    useGraphStore.setState({ toggleSubtaskSelection: toggleSel });
    renderNode('sub-a', baseData({ state: 'proposed' }));
    // Proposed state: card's aria-expanded is undefined (not an
    // expandable surface) and clicking routes to the selection
    // toggle, not the expand set.
    const card = cardRoot('sub-a');
    expect(card.hasAttribute('aria-expanded')).toBe(false);
    fireEvent.click(card);
    expect(toggleSel).toHaveBeenCalledWith('sub-a');
    expect(useGraphStore.getState().workerExpanded.size).toBe(0);
  });

  it('keyboard Enter toggles expand when the card has focus', () => {
    renderNode('sub-a', baseData({ state: 'done' }));
    const card = cardRoot('sub-a');
    card.focus();
    fireEvent.keyDown(card, { key: 'Enter', target: card });
    expect(useGraphStore.getState().workerExpanded.has('sub-a')).toBe(true);
  });

  it('keyboard Space toggles expand when the card has focus', () => {
    renderNode('sub-a', baseData({ state: 'done' }));
    const card = cardRoot('sub-a');
    card.focus();
    fireEvent.keyDown(card, { key: ' ', target: card });
    expect(useGraphStore.getState().workerExpanded.has('sub-a')).toBe(true);
  });

  it('aria-expanded reflects the store value', () => {
    useGraphStore.setState({ workerExpanded: new Set(['sub-a']) });
    renderNode('sub-a', baseData({ state: 'failed' }));
    expect(cardRoot('sub-a').getAttribute('aria-expanded')).toBe('true');
  });

  it('clicking the file-count chip does not expand (stopPropagation)', () => {
    // A done worker with one diff entry gives us a clickable chip.
    useGraphStore.setState({
      subtaskDiffs: new Map([
        [
          'sub-a',
          [
            {
              path: 'a.ts',
              additions: 1,
              deletions: 0,
            },
          ],
        ],
      ]),
    });
    renderNode('sub-a', baseData({ state: 'done' }));
    const chip = screen.getByTestId('worker-file-count-chip');
    fireEvent.click(chip);
    // Expand was NOT toggled.
    expect(useGraphStore.getState().workerExpanded.has('sub-a')).toBe(false);
  });

  it('two workers can be expanded simultaneously', () => {
    renderNode('sub-a', baseData());
    fireEvent.click(cardRoot('sub-a'));
    // Second render re-uses the same store — render a fresh node with
    // a different id.
    renderNode('sub-b', baseData());
    fireEvent.click(cardRoot('sub-b'));
    const exp = useGraphStore.getState().workerExpanded;
    expect(exp.has('sub-a')).toBe(true);
    expect(exp.has('sub-b')).toBe(true);
    expect(exp.size).toBe(2);
  });

  it('renders the expanded log block when expanded on a log-visible state', () => {
    useGraphStore.setState({
      workerExpanded: new Set(['sub-a']),
      nodeLogs: new Map([['sub-a', ['line 1', 'line 2', 'line 3']]]),
    });
    renderNode('sub-a', baseData({ state: 'running' }));
    const expanded = screen.getByTestId('worker-log-expanded');
    expect(expanded).toBeInTheDocument();
    expect(expanded.textContent).toContain('line 1');
    expect(expanded.textContent).toContain('line 3');
    // Collapsed LogBlock should not be rendered concurrently.
    expect(screen.queryByTestId('worker-log-block')).toBeNull();
  });

  it('chevron rotates to 90deg when expanded', () => {
    useGraphStore.setState({ workerExpanded: new Set(['sub-a']) });
    renderNode('sub-a', baseData({ state: 'done' }));
    const chev = screen.getByTestId('worker-expand-chevron');
    expect(chev.getAttribute('data-expanded')).toBe('true');
    expect(chev.getAttribute('style')).toContain('rotate(90deg)');
  });

  it('shows "load more above" when the log exceeds the render window', () => {
    // 2500 lines → initial window is the last 2000, 500 hidden above.
    const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
    useGraphStore.setState({
      workerExpanded: new Set(['sub-a']),
      nodeLogs: new Map([['sub-a', lines]]),
    });
    renderNode('sub-a', baseData({ state: 'done' }));
    const loadMore = screen.getByTestId('worker-log-load-more');
    expect(loadMore.textContent).toMatch(/500 hidden/);
    fireEvent.click(loadMore);
    // After clicking, all 2500 lines fit in the 4000-cap window, so
    // the button disappears.
    expect(screen.queryByTestId('worker-log-load-more')).toBeNull();
  });
});

describe('WorkerNode — worktree-actions folder icon (Phase 4 Step 4)', () => {
  function baseData(
    overrides: Partial<WorkerNodeData> = {},
  ): WorkerNodeData {
    return {
      state: 'done',
      agent: 'claude',
      title: 'Worker A',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
      ...overrides,
    };
  }

  // Locked decision 1 from the Step 4 directive: the folder icon
  // appears on done/failed/human_escalation/cancelled; never on
  // proposed/running/retrying/waiting/skipped/escalating. These two
  // tests pin both ends of the matrix so regressions — e.g. someone
  // adding `running` to INSPECTABLE_STATES — fail loudly.

  it.each(['done', 'failed', 'human_escalation', 'cancelled'] as const)(
    'renders the trigger on %s state',
    (state) => {
      renderNode('sub-a', baseData({ state }));
      expect(
        screen.getByTestId('worktree-actions-trigger-sub-a'),
      ).toBeInTheDocument();
    },
  );

  it.each([
    'proposed',
    'running',
    'retrying',
    'waiting',
    'skipped',
    'escalating',
  ] as const)('hides the trigger on %s state', (state) => {
    renderNode('sub-a', baseData({ state }));
    expect(screen.queryByTestId('worktree-actions-trigger-sub-a')).toBeNull();
  });
});

describe('WorkerNode — Stop button (Phase 5 Step 1)', () => {
  function baseData(
    overrides: Partial<WorkerNodeData> = {},
  ): WorkerNodeData {
    return {
      state: 'running',
      agent: 'claude',
      title: 'Worker A',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
      ...overrides,
    };
  }

  // Phase 5 Step 1: Stop appears on running / retrying / waiting —
  // disjoint from INSPECTABLE_STATES. Regression guard: these two
  // tests pin both ends of the matrix so a slip (Stop on Done, or no
  // Stop on Waiting) fails loudly.

  it.each(['running', 'retrying', 'waiting'] as const)(
    'renders the Stop button on %s state',
    (state) => {
      renderNode('sub-a', baseData({ state }));
      expect(
        screen.getByRole('button', { name: /stop this worker/i }),
      ).toBeInTheDocument();
    },
  );

  it.each([
    'proposed',
    'done',
    'failed',
    'skipped',
    'escalating',
    'human_escalation',
    'cancelled',
  ] as const)('hides the Stop button on %s state', (state) => {
    renderNode('sub-a', baseData({ state }));
    expect(
      screen.queryByRole('button', { name: /stop this worker/i }),
    ).toBeNull();
  });
});

describe('WorkerNode — AwaitingInput + QuestionInput (Phase 5 Step 4)', () => {
  function baseData(
    overrides: Partial<WorkerNodeData> = {},
  ): WorkerNodeData {
    return {
      state: 'awaiting_input',
      agent: 'claude',
      title: 'Worker A',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
      ...overrides,
    };
  }

  it('renders QuestionInput when state is awaiting_input and a pending question is present', () => {
    useGraphStore.setState({
      pendingQuestions: new Map([
        ['sub-a', { question: 'Should I use A or B?' }],
      ]),
    });
    renderNode('sub-a', baseData());
    expect(screen.getByTestId('question-input-sub-a')).toBeInTheDocument();
    expect(screen.getByTestId('question-text-sub-a').textContent).toBe(
      'Should I use A or B?',
    );
  });

  it('hides QuestionInput when the state is not awaiting_input even if a question is mapped', () => {
    useGraphStore.setState({
      pendingQuestions: new Map([[
        'sub-a',
        { question: 'old question?' },
      ]]),
    });
    renderNode('sub-a', baseData({ state: 'running' }));
    expect(screen.queryByTestId('question-input-sub-a')).toBeNull();
  });

  it('hides QuestionInput when awaiting_input but no question mapped (defensive)', () => {
    useGraphStore.setState({ pendingQuestions: new Map() });
    renderNode('sub-a', baseData());
    expect(screen.queryByTestId('question-input-sub-a')).toBeNull();
  });

  it('renders StopButton on awaiting_input (user can cancel outright)', () => {
    useGraphStore.setState({
      pendingQuestions: new Map([['sub-a', { question: '?' }]]),
    });
    renderNode('sub-a', baseData());
    expect(
      screen.getByRole('button', { name: /stop this worker/i }),
    ).toBeInTheDocument();
  });
});

describe('WorkerNode — inline error-category chip (Phase 4 Step 5)', () => {
  function baseData(
    overrides: Partial<WorkerNodeData> = {},
  ): WorkerNodeData {
    return {
      state: 'failed',
      agent: 'claude',
      title: 'Worker A',
      why: null,
      dependsOn: [],
      replaces: [],
      retries: 0,
      ...overrides,
    };
  }

  it('renders the locked copy next to the Failed label when a category is present', () => {
    useGraphStore.setState({
      subtaskErrorCategories: new Map([['sub-a', { kind: 'process-crashed' }]]),
    });
    renderNode('sub-a', baseData());
    expect(screen.getByTestId('worker-error-category-sub-a')).toHaveTextContent(
      'Subprocess crashed',
    );
  });

  it('formats Timeout duration in whole minutes', () => {
    useGraphStore.setState({
      subtaskErrorCategories: new Map([
        ['sub-a', { kind: 'timeout', afterSecs: 1800 }],
      ]),
    });
    renderNode('sub-a', baseData());
    expect(screen.getByTestId('worker-error-category-sub-a')).toHaveTextContent(
      'Timed out after 30m',
    );
  });

  it('hides the chip on non-failed states even if a category is stashed (stale-store guard)', () => {
    useGraphStore.setState({
      subtaskErrorCategories: new Map([['sub-a', { kind: 'process-crashed' }]]),
    });
    renderNode('sub-a', baseData({ state: 'running' }));
    expect(screen.queryByTestId('worker-error-category-sub-a')).toBeNull();
  });

  it('hides the chip on a failed card when no category is present (pre-Step-5 backward compat)', () => {
    renderNode('sub-a', baseData({ state: 'failed' }));
    expect(screen.queryByTestId('worker-error-category-sub-a')).toBeNull();
  });
});
