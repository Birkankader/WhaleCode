import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        },
      ],
    });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'New',
      why: null,
      dependsOn: [],
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
        },
      ],
    });
    renderNode('auth', {
      state: 'proposed',
      agent: 'claude',
      title: 'Different',
      why: null,
      dependsOn: [],
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
      retries: 0,
    });
    expect(screen.queryByText('added')).toBeNull();
  });
});

describe('WorkerNode — dependencies footer', () => {
  it('renders 1-indexed dependency list while proposed', () => {
    useGraphStore.setState({
      subtasks: [
        { id: 'a', title: '1', why: null, agent: 'claude', dependsOn: [] },
        { id: 'b', title: '2', why: null, agent: 'claude', dependsOn: [] },
        { id: 'c', title: '3', why: null, agent: 'claude', dependsOn: ['a', 'b'] },
      ],
    });
    renderNode('c', {
      state: 'proposed',
      agent: 'claude',
      title: '3',
      why: null,
      dependsOn: ['a', 'b'],
      retries: 0,
    });
    expect(screen.getByText('#1')).toBeDefined();
    expect(screen.getByText('#2')).toBeDefined();
  });

  it('silently drops unknown dependency ids', () => {
    useGraphStore.setState({
      subtasks: [
        { id: 'a', title: '1', why: null, agent: 'claude', dependsOn: [] },
      ],
    });
    renderNode('c', {
      state: 'proposed',
      agent: 'claude',
      title: '3',
      why: null,
      dependsOn: ['a', 'ghost'],
      retries: 0,
    });
    expect(screen.getByText('#1')).toBeDefined();
    expect(screen.queryByText(/ghost/)).toBeNull();
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
      retries: 0,
    });
    // Display mode renders a button, not the input.
    expect(screen.getByRole('button', { name: /Edit Subtask title/i })).toBeDefined();
    expect(screen.queryByLabelText('Subtask title')).toBeNull();
  });
});
