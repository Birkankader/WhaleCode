import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

const reactFlowMock = {
  getNode: vi.fn<
    (id: string) =>
      | { position: { x: number; y: number }; width?: number; height?: number }
      | undefined
  >(),
  setCenter: vi.fn().mockResolvedValue(true),
  getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
};
vi.mock('@xyflow/react', () => ({
  useReactFlow: () => reactFlowMock,
}));

import { useGraphStore } from '../../state/graphStore';
import type { ApplySummary } from '../../lib/ipc';

import { ApplySummaryOverlay } from './ApplySummaryOverlay';

const FULL_SHA = '0123456789abcdef0123456789abcdef01234567';

function sampleSummary(overrides: Partial<ApplySummary> = {}): ApplySummary {
  return {
    runId: 'run-1',
    commitSha: FULL_SHA,
    branch: 'main',
    filesChanged: 3,
    perWorker: [
      { subtaskId: 'sub-a', filesChanged: 2 },
      { subtaskId: 'sub-b', filesChanged: 1 },
    ],
    ...overrides,
  };
}

function seedSubtasks() {
  useGraphStore.setState({
    subtasks: [
      {
        id: 'sub-a',
        title: 'Worker A',
        why: null,
        agent: 'claude',
        dependsOn: [],
        replaces: [],
      },
      {
        id: 'sub-b',
        title: 'Worker B',
        why: null,
        agent: 'codex',
        dependsOn: [],
        replaces: [],
      },
    ],
  });
}

const writeTextMock = vi.fn<(text: string) => Promise<void>>(async () => undefined);

beforeEach(() => {
  useGraphStore.getState().reset();
  reactFlowMock.getNode.mockReset();
  reactFlowMock.setCenter.mockClear();
  reactFlowMock.getViewport.mockClear();
  reactFlowMock.getViewport.mockReturnValue({ x: 0, y: 0, zoom: 1 });
  writeTextMock.mockReset();
  writeTextMock.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    configurable: true,
  });
});

afterEach(() => {
  useGraphStore.getState().reset();
});

describe('ApplySummaryOverlay', () => {
  it('renders nothing when applySummary is null', () => {
    render(<ApplySummaryOverlay />);
    expect(screen.queryByTestId('apply-summary-overlay')).toBeNull();
  });

  it('renders total file count, branch, and short SHA when payload is present', () => {
    seedSubtasks();
    useGraphStore.setState({ applySummary: sampleSummary() });

    render(<ApplySummaryOverlay />);

    const overlay = screen.getByTestId('apply-summary-overlay');
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveTextContent(/3 files changed/i);
    expect(overlay).toHaveTextContent(/main/);
    expect(screen.getByTestId('apply-summary-sha')).toHaveTextContent('0123456');
  });

  it('renders per-worker rows with subtask titles and file-count suffix', () => {
    seedSubtasks();
    useGraphStore.setState({ applySummary: sampleSummary() });

    render(<ApplySummaryOverlay />);

    const rowA = screen.getByTestId('apply-summary-worker-sub-a');
    const rowB = screen.getByTestId('apply-summary-worker-sub-b');
    expect(rowA).toHaveTextContent('Worker A');
    expect(rowA).toHaveTextContent('2 files');
    expect(rowB).toHaveTextContent('Worker B');
    expect(rowB).toHaveTextContent('1 file');
  });

  it('singularises "1 file changed" in the header', () => {
    seedSubtasks();
    useGraphStore.setState({
      applySummary: sampleSummary({ filesChanged: 1, perWorker: [] }),
    });

    render(<ApplySummaryOverlay />);

    expect(screen.getByTestId('apply-summary-overlay')).toHaveTextContent(
      /1 file changed/i,
    );
  });

  it('clicking a worker row pans the graph via setCenter with the current zoom', () => {
    seedSubtasks();
    useGraphStore.setState({ applySummary: sampleSummary() });
    reactFlowMock.getNode.mockImplementation((id: string) => {
      if (id === 'sub-a') {
        return { position: { x: 100, y: 200 }, width: 240, height: 140 };
      }
      return undefined;
    });
    reactFlowMock.getViewport.mockReturnValue({ x: 0, y: 0, zoom: 1.25 });

    render(<ApplySummaryOverlay />);
    fireEvent.click(screen.getByTestId('apply-summary-worker-sub-a'));

    // cx = 100 + 240/2 = 220, cy = 200 + 140/2 = 270
    expect(reactFlowMock.setCenter).toHaveBeenCalledWith(220, 270, {
      zoom: 1.25,
      duration: 300,
    });
  });

  it('clicking a worker row is a no-op when the node is absent (e.g. post-reset)', () => {
    seedSubtasks();
    useGraphStore.setState({ applySummary: sampleSummary() });
    reactFlowMock.getNode.mockReturnValue(undefined);

    render(<ApplySummaryOverlay />);
    fireEvent.click(screen.getByTestId('apply-summary-worker-sub-a'));

    expect(reactFlowMock.setCenter).not.toHaveBeenCalled();
  });

  it('Copy SHA writes the full 40-char SHA to the clipboard', async () => {
    seedSubtasks();
    useGraphStore.setState({ applySummary: sampleSummary() });

    render(<ApplySummaryOverlay />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('apply-summary-copy-sha'));
    });

    expect(writeTextMock).toHaveBeenCalledWith(FULL_SHA);
  });

  it('Copy SHA failure is silent (no throw, no banner)', async () => {
    seedSubtasks();
    useGraphStore.setState({ applySummary: sampleSummary() });
    writeTextMock.mockRejectedValueOnce(new Error('denied'));

    render(<ApplySummaryOverlay />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('apply-summary-copy-sha'));
    });

    // currentError stays null — the SHA remains on-screen for manual copy.
    expect(useGraphStore.getState().currentError).toBeNull();
  });

  it('Dismiss clears applySummary and returns the store to idle', async () => {
    seedSubtasks();
    useGraphStore.setState({
      applySummary: sampleSummary(),
      status: 'applied',
      runId: 'run-1',
    });

    render(<ApplySummaryOverlay />);

    await waitFor(() => {
      expect(screen.getByTestId('apply-summary-dismiss')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('apply-summary-dismiss'));

    const s = useGraphStore.getState();
    expect(s.applySummary).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.runId).toBeNull();
  });

  it('falls back to subtask id when the title is not in the store', () => {
    // A replan-race edge case: the backend included a subtask in
    // per_worker that the frontend doesn't have a title for. The row
    // should still render (graceful degradation, not a blank line).
    useGraphStore.setState({
      applySummary: sampleSummary({
        perWorker: [{ subtaskId: 'orphan-1', filesChanged: 1 }],
      }),
      subtasks: [],
    });

    render(<ApplySummaryOverlay />);

    expect(
      screen.getByTestId('apply-summary-worker-orphan-1'),
    ).toHaveTextContent('orphan-1');
  });
});

describe('ApplySummaryOverlay — follow-up input (Phase 7 Step 5)', () => {
  it('renders the follow-up input + send button when summary present', () => {
    useGraphStore.setState({ applySummary: sampleSummary() });
    render(<ApplySummaryOverlay />);
    expect(screen.getByTestId('apply-summary-followup-input')).toBeInTheDocument();
    expect(screen.getByTestId('apply-summary-followup-submit')).toBeInTheDocument();
  });

  it('send button disabled when prompt empty', () => {
    useGraphStore.setState({ applySummary: sampleSummary() });
    render(<ApplySummaryOverlay />);
    expect(screen.getByTestId('apply-summary-followup-submit')).toBeDisabled();
  });

  it('send button enabled when prompt has content', () => {
    useGraphStore.setState({ applySummary: sampleSummary() });
    render(<ApplySummaryOverlay />);
    fireEvent.change(screen.getByTestId('apply-summary-followup-input'), {
      target: { value: 'fix the bug' },
    });
    expect(screen.getByTestId('apply-summary-followup-submit')).not.toBeDisabled();
  });

  it('Enter triggers submitFollowupRun with trimmed prompt', async () => {
    const submitFollowupRun = vi
      .fn<(p: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    useGraphStore.setState({
      applySummary: sampleSummary(),
      submitFollowupRun,
    });
    render(<ApplySummaryOverlay />);
    fireEvent.change(screen.getByTestId('apply-summary-followup-input'), {
      target: { value: '  add tests  ' },
    });
    fireEvent.submit(screen.getByTestId('apply-summary-followup-form'));
    await waitFor(() => {
      expect(submitFollowupRun).toHaveBeenCalledWith('add tests');
    });
  });

  it('shows "Starting follow-up…" status while in flight', () => {
    useGraphStore.setState({
      applySummary: sampleSummary(),
      followupInFlight: true,
    });
    render(<ApplySummaryOverlay />);
    expect(
      screen.getByTestId('apply-summary-followup-status'),
    ).toHaveTextContent(/Starting follow-up/);
    expect(screen.getByTestId('apply-summary-followup-input')).toBeDisabled();
    expect(screen.getByTestId('apply-summary-followup-submit')).toBeDisabled();
  });

  it('respects 500-char maxLength', () => {
    useGraphStore.setState({ applySummary: sampleSummary() });
    render(<ApplySummaryOverlay />);
    const input = screen.getByTestId('apply-summary-followup-input');
    expect(input.getAttribute('maxLength')).toBe('500');
  });
});
