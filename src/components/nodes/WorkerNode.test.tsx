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
