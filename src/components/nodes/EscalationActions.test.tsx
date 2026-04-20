/**
 * Tests for the Layer-3 escalation surface. Exercises:
 *   - error summary from `formatAgentError` + details toggle;
 *   - store actions wire through on click;
 *   - skip cascade count in inline confirm;
 *   - "Try replan again" hides past the replan cap;
 *   - abort reuses `cancelRun` through inline confirm.
 *
 * The store's real action implementations call IPC — we override them
 * per-test with `useGraphStore.setState({ ... })` so a click asserts
 * our override was invoked rather than the real Tauri surface.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

import { useGraphStore } from '../../state/graphStore';

import { EscalationActions } from './EscalationActions';

function seedEscalation(opts: {
  subtaskId: string;
  reason?: string;
  subtasks?: Array<{
    id: string;
    title: string;
    agent: 'claude' | 'codex' | 'gemini';
    dependsOn: string[];
  }>;
}) {
  useGraphStore.setState({
    runId: 'r-1',
    status: 'awaiting_human_fix',
    humanEscalation: {
      subtaskId: opts.subtaskId,
      reason: opts.reason ?? 'agent timed out after 120s',
      suggestedAction: null,
    },
    subtasks: (opts.subtasks ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      why: null,
      agent: s.agent,
      dependsOn: s.dependsOn,
      replaces: [],
    })),
  });
}

beforeEach(() => {
  useGraphStore.getState().reset();
});

afterEach(() => {
  useGraphStore.getState().reset();
});

describe('EscalationActions — error summary', () => {
  it('renders the formatted summary from the store', () => {
    seedEscalation({ subtaskId: 'a', reason: 'agent timed out after 120s' });
    render(<EscalationActions subtaskId="a" replanCount={0} />);
    expect(screen.getByText('the agent timed out')).toBeInTheDocument();
  });

  it('hides the details pane by default and toggles it open', () => {
    seedEscalation({ subtaskId: 'a', reason: 'agent timed out after 120s' });
    render(<EscalationActions subtaskId="a" replanCount={0} />);
    expect(screen.queryByTestId('escalation-details-body')).toBeNull();
    fireEvent.click(screen.getByTestId('escalation-details-toggle'));
    expect(screen.getByTestId('escalation-details-body')).toBeInTheDocument();
  });
});

describe('EscalationActions — primary actions', () => {
  it('clicking Open worktree invokes manualFixSubtask', async () => {
    const spy = vi.fn(async () => ({ method: 'configured' as const, path: '/w' }));
    seedEscalation({ subtaskId: 'a' });
    useGraphStore.setState({ manualFixSubtask: spy });
    render(<EscalationActions subtaskId="a" replanCount={0} />);
    fireEvent.click(screen.getByTestId('escalation-open-worktree'));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('a');
    });
  });

  it('clicking "I fixed it, continue" invokes markSubtaskFixed', async () => {
    const spy = vi.fn(async () => undefined);
    seedEscalation({ subtaskId: 'a' });
    useGraphStore.setState({ markSubtaskFixed: spy });
    render(<EscalationActions subtaskId="a" replanCount={0} />);
    fireEvent.click(screen.getByTestId('escalation-mark-fixed'));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('a');
    });
  });
});

describe('EscalationActions — skip', () => {
  it('preview shows cascade count in confirm label', () => {
    seedEscalation({
      subtaskId: 'a',
      subtasks: [
        { id: 'a', title: 'A', agent: 'claude', dependsOn: [] },
        { id: 'b', title: 'B', agent: 'claude', dependsOn: ['a'] },
        { id: 'c', title: 'C', agent: 'claude', dependsOn: ['b'] },
      ],
    });
    render(<EscalationActions subtaskId="a" replanCount={0} />);
    fireEvent.click(screen.getByTestId('escalation-skip-trigger'));
    expect(screen.getByText('Skip this and 2 dependent subtasks?')).toBeInTheDocument();
  });

  it('singular cascade copy for one dependent', () => {
    seedEscalation({
      subtaskId: 'a',
      subtasks: [
        { id: 'a', title: 'A', agent: 'claude', dependsOn: [] },
        { id: 'b', title: 'B', agent: 'claude', dependsOn: ['a'] },
      ],
    });
    render(<EscalationActions subtaskId="a" replanCount={0} />);
    fireEvent.click(screen.getByTestId('escalation-skip-trigger'));
    expect(screen.getByText('Skip this and 1 dependent subtask?')).toBeInTheDocument();
  });

  it('leaf subtask skips show the short copy', () => {
    seedEscalation({
      subtaskId: 'a',
      subtasks: [{ id: 'a', title: 'A', agent: 'claude', dependsOn: [] }],
    });
    render(<EscalationActions subtaskId="a" replanCount={0} />);
    fireEvent.click(screen.getByTestId('escalation-skip-trigger'));
    expect(screen.getByText('Skip this subtask?')).toBeInTheDocument();
  });

  it('confirm-yes invokes skipSubtask', async () => {
    const spy = vi.fn(async () => ({ skippedCount: 1, skippedIds: ['a'] }));
    seedEscalation({
      subtaskId: 'a',
      subtasks: [{ id: 'a', title: 'A', agent: 'claude', dependsOn: [] }],
    });
    useGraphStore.setState({ skipSubtask: spy });
    render(<EscalationActions subtaskId="a" replanCount={0} />);
    fireEvent.click(screen.getByTestId('escalation-skip-trigger'));
    fireEvent.click(screen.getByTestId('escalation-confirm-skip-yes'));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('a');
    });
  });

  it('confirm-no dismisses without calling skip', () => {
    const spy = vi.fn(async () => ({ skippedCount: 1, skippedIds: ['a'] }));
    seedEscalation({
      subtaskId: 'a',
      subtasks: [{ id: 'a', title: 'A', agent: 'claude', dependsOn: [] }],
    });
    useGraphStore.setState({ skipSubtask: spy });
    render(<EscalationActions subtaskId="a" replanCount={0} />);
    fireEvent.click(screen.getByTestId('escalation-skip-trigger'));
    fireEvent.click(screen.getByTestId('escalation-confirm-skip-no'));
    expect(spy).not.toHaveBeenCalled();
    // Trigger should be visible again.
    expect(screen.getByTestId('escalation-skip-trigger')).toBeInTheDocument();
  });
});

describe('EscalationActions — try replan', () => {
  it('hides "Try replan again" when replanCount >= 2', () => {
    seedEscalation({ subtaskId: 'a' });
    render(<EscalationActions subtaskId="a" replanCount={2} />);
    expect(screen.queryByTestId('escalation-try-replan')).toBeNull();
  });

  it('shows the button under the cap and calls tryReplanAgain', async () => {
    const spy = vi.fn(async () => undefined);
    seedEscalation({ subtaskId: 'a' });
    useGraphStore.setState({ tryReplanAgain: spy });
    render(<EscalationActions subtaskId="a" replanCount={1} />);
    fireEvent.click(screen.getByTestId('escalation-try-replan'));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('a');
    });
  });
});

describe('EscalationActions — abort', () => {
  it('confirm-yes calls cancelRun', async () => {
    const spy = vi.fn(async () => undefined);
    seedEscalation({ subtaskId: 'a' });
    useGraphStore.setState({ cancelRun: spy });
    render(<EscalationActions subtaskId="a" replanCount={0} />);
    fireEvent.click(screen.getByTestId('escalation-abort-trigger'));
    fireEvent.click(screen.getByTestId('escalation-confirm-abort-yes'));
    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
  });
});
