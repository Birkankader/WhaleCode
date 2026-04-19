import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

// Framer Motion's AnimatePresence exit animations would defer unmount; the
// tests here assert on initial render + click handlers, so we stub to a
// passthrough Fragment-like wrapper to keep DOM state instantly reflective.
vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion');
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

import { useAgentStore } from '../../state/agentStore';
import { useGraphStore } from '../../state/graphStore';
import type { AgentDetectionResult } from '../../lib/ipc';

import { ApprovalBar } from './ApprovalBar';

function seedAwaitingApproval(subtaskCount = 1) {
  useGraphStore.setState({
    status: 'awaiting_approval',
    subtasks: Array.from({ length: subtaskCount }, (_, i) => ({
      id: `s${i}`,
      title: `Subtask ${i}`,
      why: null,
      agent: 'claude',
      dependsOn: [],
    })),
  });
}

const DETECTION_ALL_AVAILABLE: AgentDetectionResult = {
  claude: { status: 'available', version: '1.0', binaryPath: '/c' },
  codex: { status: 'available', version: '1.0', binaryPath: '/co' },
  gemini: { status: 'available', version: '1.0', binaryPath: '/g' },
  recommendedMaster: 'claude',
};

beforeEach(() => {
  useGraphStore.getState().reset();
  useAgentStore.setState({ detection: null, checking: false, error: null });
});

afterEach(() => {
  useGraphStore.getState().reset();
  useAgentStore.setState({ detection: null, checking: false, error: null });
});

describe('ApprovalBar visibility', () => {
  it('hides when status is not awaiting_approval', () => {
    render(<ApprovalBar />);
    expect(screen.queryByRole('region', { name: /Approval bar/i })).toBeNull();
  });

  it('shows when status is awaiting_approval', () => {
    seedAwaitingApproval(3);
    render(<ApprovalBar />);
    expect(screen.getByRole('region', { name: /Approval bar/i })).toBeDefined();
    expect(screen.getByText(/Master proposes 3 subtasks/i)).toBeDefined();
  });
});

describe('ApprovalBar — "+ Add subtask" button', () => {
  it('is visible in the bar while awaiting approval', () => {
    seedAwaitingApproval();
    render(<ApprovalBar />);
    expect(screen.getByRole('button', { name: /\+ Add subtask/i })).toBeDefined();
  });

  it('click calls addSubtask with recommendedMaster when available', async () => {
    seedAwaitingApproval();
    useAgentStore.setState({ detection: DETECTION_ALL_AVAILABLE });
    const addSubtask = vi.fn().mockResolvedValue('new-id');
    useGraphStore.setState({ addSubtask });
    render(<ApprovalBar />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /\+ Add subtask/i }));
    });
    expect(addSubtask).toHaveBeenCalledWith({
      title: '',
      why: null,
      assignedWorker: 'claude',
    });
  });

  it('falls back to first available agent when recommendedMaster is null', async () => {
    seedAwaitingApproval();
    useAgentStore.setState({
      detection: {
        claude: { status: 'not-installed' },
        codex: { status: 'available', version: '1.0', binaryPath: '/co' },
        gemini: { status: 'available', version: '1.0', binaryPath: '/g' },
        recommendedMaster: null,
      },
    });
    const addSubtask = vi.fn().mockResolvedValue('new-id');
    useGraphStore.setState({ addSubtask });
    render(<ApprovalBar />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /\+ Add subtask/i }));
    });
    expect(addSubtask).toHaveBeenCalledWith({
      title: '',
      why: null,
      assignedWorker: 'codex',
    });
  });

  it('falls back to first available when recommendedMaster is itself not available', async () => {
    seedAwaitingApproval();
    useAgentStore.setState({
      detection: {
        claude: { status: 'broken', binaryPath: '/c', error: 'nope' },
        codex: { status: 'available', version: '1.0', binaryPath: '/co' },
        gemini: { status: 'not-installed' },
        recommendedMaster: 'claude',
      },
    });
    const addSubtask = vi.fn().mockResolvedValue('new-id');
    useGraphStore.setState({ addSubtask });
    render(<ApprovalBar />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /\+ Add subtask/i }));
    });
    expect(addSubtask).toHaveBeenCalledWith({
      title: '',
      why: null,
      assignedWorker: 'codex',
    });
  });

  it('defaults to claude when detection has not yet loaded', async () => {
    seedAwaitingApproval();
    const addSubtask = vi.fn().mockResolvedValue('new-id');
    useGraphStore.setState({ addSubtask });
    render(<ApprovalBar />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /\+ Add subtask/i }));
    });
    expect(addSubtask).toHaveBeenCalledWith({
      title: '',
      why: null,
      assignedWorker: 'claude',
    });
  });

  it('swallows addSubtask rejection (error surfaces via currentError)', async () => {
    seedAwaitingApproval();
    const addSubtask = vi.fn().mockRejectedValue(new Error('backend boom'));
    useGraphStore.setState({ addSubtask });
    render(<ApprovalBar />);
    // Should not throw — the bar's click handler catches.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /\+ Add subtask/i }));
    });
    expect(addSubtask).toHaveBeenCalled();
  });
});

describe('ApprovalBar — existing buttons', () => {
  it('Approve selected disabled when no subtasks selected', () => {
    seedAwaitingApproval(2);
    useGraphStore.setState({ selectedSubtaskIds: new Set() });
    render(<ApprovalBar />);
    const btn = screen.getByRole('button', { name: /Approve selected/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Approve all approves every subtask id', () => {
    seedAwaitingApproval(2);
    const approveSubtasks = vi.fn().mockResolvedValue(undefined);
    useGraphStore.setState({ approveSubtasks });
    render(<ApprovalBar />);
    fireEvent.click(screen.getByRole('button', { name: /Approve all/i }));
    expect(approveSubtasks).toHaveBeenCalledWith(['s0', 's1']);
  });

  it('Reject all calls rejectAll', () => {
    seedAwaitingApproval();
    const rejectAll = vi.fn().mockResolvedValue(undefined);
    useGraphStore.setState({ rejectAll });
    render(<ApprovalBar />);
    fireEvent.click(screen.getByRole('button', { name: /Reject all/i }));
    expect(rejectAll).toHaveBeenCalled();
  });
});
