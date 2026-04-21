import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../../lib/ipc')>('../../lib/ipc');
  return {
    ...actual,
    detectAgents: vi.fn(),
    setMasterAgent: vi.fn(),
    setSettings: vi.fn(),
    pickRepo: vi.fn(),
    validateRepo: vi.fn(),
    getSettings: vi.fn(),
  };
});

import { setMasterAgent } from '../../lib/ipc';
import { useAgentStore } from '../../state/agentStore';
import { useGraphStore } from '../../state/graphStore';
import { useRepoStore } from '../../state/repoStore';

import { TopBar } from './TopBar';

function seedAvailable() {
  useAgentStore.setState({
    detection: {
      claude: { status: 'available', version: '1.0.0', binaryPath: '/bin/claude' },
      codex: { status: 'not-installed' },
      gemini: {
        status: 'broken',
        binaryPath: '/bad/gemini',
        error: 'missing libfoo',
      },
      recommendedMaster: 'claude',
    },
    checking: false,
    error: null,
  });
}

function resetStores() {
  useAgentStore.setState({ detection: null, checking: false, error: null });
  useRepoStore.setState({
    initializing: false,
    settings: {
      lastRepo: null,
      masterAgent: 'claude',
      autoApprove: false,
      maxSubtasksPerAutoApprovedRun: 20,
      autoApproveConsentGiven: false,
    },
    currentRepo: null,
    pickerError: null,
  });
  // Reset graphStore master selection to default
  useGraphStore.setState({ selectedMasterAgent: 'claude', masterNode: null });
}

describe('TopBar master dropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('opens on click and lists all three agents', () => {
    seedAvailable();
    render(<TopBar />);
    const chip = screen.getByRole('button', { name: /master agent:/i });
    fireEvent.click(chip);
    const menu = screen.getByRole('menu', { name: /select master agent/i });
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /claude code/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /codex cli/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /gemini cli/i })).toBeInTheDocument();
  });

  it('disables broken and not-installed entries with an explanatory tooltip', () => {
    seedAvailable();
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: /master agent:/i }));

    const codex = screen.getByRole('menuitem', { name: /codex cli/i });
    expect(codex).toBeDisabled();
    expect(codex).toHaveAttribute('title', 'Not installed');

    const gemini = screen.getByRole('menuitem', { name: /gemini cli/i });
    expect(gemini).toBeDisabled();
    expect(gemini).toHaveAttribute('title', expect.stringContaining('missing libfoo'));
  });

  it('disables the chip when no agent is available', () => {
    useAgentStore.setState({
      detection: {
        claude: { status: 'not-installed' },
        codex: { status: 'not-installed' },
        gemini: { status: 'not-installed' },
        recommendedMaster: null,
      },
      checking: false,
      error: null,
    });
    render(<TopBar />);
    const chip = screen.getByRole('button', { name: /master agent:/i });
    expect(chip).toBeDisabled();
    expect(chip).toHaveTextContent(/no agents available/i);
  });

  it('selecting a different available master calls set_master_agent', async () => {
    // Claude is selected by default; add codex as available.
    useAgentStore.setState({
      detection: {
        claude: { status: 'available', version: '1.0.0', binaryPath: '/bin/claude' },
        codex: { status: 'available', version: '0.5.0', binaryPath: '/bin/codex' },
        gemini: { status: 'not-installed' },
        recommendedMaster: 'claude',
      },
      checking: false,
      error: null,
    });
    vi.mocked(setMasterAgent).mockResolvedValueOnce({
      lastRepo: null,
      masterAgent: 'codex',
      autoApprove: false,
      maxSubtasksPerAutoApprovedRun: 20,
      autoApproveConsentGiven: false,
    });

    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: /master agent:/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /codex cli/i }));

    expect(setMasterAgent).toHaveBeenCalledWith('codex');
  });
});

describe('TopBar auto-approve badge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('hides the Auto badge when auto-approve is off', () => {
    seedAvailable();
    render(<TopBar />);
    expect(screen.queryByTestId('auto-approve-badge')).toBeNull();
  });

  it('shows the Auto badge when autoApprove is true', () => {
    seedAvailable();
    useRepoStore.setState({
      settings: {
        lastRepo: null,
        masterAgent: 'claude',
        autoApprove: true,
        maxSubtasksPerAutoApprovedRun: 20,
        autoApproveConsentGiven: true,
      },
    });
    render(<TopBar />);
    expect(screen.getByTestId('auto-approve-badge')).toBeInTheDocument();
    expect(screen.getByLabelText(/auto-approve enabled/i)).toBeInTheDocument();
  });
});

describe('TopBar cancel-run button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetStores();
    seedAvailable();
    useGraphStore.setState({ status: 'idle' });
  });

  afterEach(() => {
    vi.useRealTimers();
    useGraphStore.setState({ status: 'idle' });
  });

  const CANCELLABLE: ReadonlyArray<
    'planning' | 'awaiting_approval' | 'running' | 'merging'
  > = ['planning', 'awaiting_approval', 'running', 'merging'];

  const NON_CANCELLABLE: ReadonlyArray<
    'idle' | 'done' | 'applied' | 'rejected' | 'failed' | 'cancelled' | 'awaiting_human_fix'
  > = [
    'idle',
    'done',
    'applied',
    'rejected',
    'failed',
    'cancelled',
    'awaiting_human_fix',
  ];

  it.each(CANCELLABLE)('is visible when status is %s', (status) => {
    useGraphStore.setState({ status });
    render(<TopBar />);
    expect(screen.getByTestId('topbar-cancel-run')).toBeInTheDocument();
  });

  it.each(NON_CANCELLABLE)('is hidden when status is %s', (status) => {
    useGraphStore.setState({ status });
    render(<TopBar />);
    expect(screen.queryByTestId('topbar-cancel-run')).toBeNull();
  });

  it('clicking the button arms an inline confirm; clicking Yes calls cancelRun', async () => {
    useGraphStore.setState({ status: 'running' });
    const cancelRun = vi.fn().mockResolvedValue(undefined);
    useGraphStore.setState({ cancelRun });

    render(<TopBar />);
    fireEvent.click(screen.getByTestId('topbar-cancel-run'));
    const confirm = screen.getByTestId('topbar-cancel-confirm');
    expect(confirm).toBeInTheDocument();
    expect(confirm).toHaveTextContent(/cancel run\?/i);

    await act(async () => {
      fireEvent.click(screen.getByTestId('topbar-cancel-confirm-yes'));
    });
    expect(cancelRun).toHaveBeenCalledTimes(1);
  });

  it('clicking No dismisses the confirm without calling cancelRun', () => {
    useGraphStore.setState({ status: 'running' });
    const cancelRun = vi.fn();
    useGraphStore.setState({ cancelRun });

    render(<TopBar />);
    fireEvent.click(screen.getByTestId('topbar-cancel-run'));
    fireEvent.click(screen.getByTestId('topbar-cancel-confirm-no'));
    expect(cancelRun).not.toHaveBeenCalled();
    // Back to the unarmed trigger.
    expect(screen.getByTestId('topbar-cancel-run')).toBeInTheDocument();
    expect(screen.queryByTestId('topbar-cancel-confirm')).toBeNull();
  });

  it('auto-dismisses the inline confirm after 4 seconds', () => {
    vi.useFakeTimers();
    useGraphStore.setState({ status: 'running' });
    render(<TopBar />);
    fireEvent.click(screen.getByTestId('topbar-cancel-run'));
    expect(screen.getByTestId('topbar-cancel-confirm')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.queryByTestId('topbar-cancel-confirm')).toBeNull();
    expect(screen.getByTestId('topbar-cancel-run')).toBeInTheDocument();
  });

  it('hides the confirm when status transitions out of cancellable set mid-prompt', async () => {
    useGraphStore.setState({ status: 'running' });
    render(<TopBar />);
    fireEvent.click(screen.getByTestId('topbar-cancel-run'));
    expect(screen.getByTestId('topbar-cancel-confirm')).toBeInTheDocument();

    // Run finishes naturally (e.g. done or cancelled via some other path).
    act(() => {
      useGraphStore.setState({ status: 'done' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-cancel-confirm')).toBeNull();
      expect(screen.queryByTestId('topbar-cancel-run')).toBeNull();
    });
  });

  it('swallows cancelRun rejection (error surfaces via currentError)', async () => {
    useGraphStore.setState({ status: 'running' });
    const cancelRun = vi.fn().mockRejectedValue(new Error('backend boom'));
    useGraphStore.setState({ cancelRun });
    render(<TopBar />);
    fireEvent.click(screen.getByTestId('topbar-cancel-run'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('topbar-cancel-confirm-yes'));
    });
    expect(cancelRun).toHaveBeenCalled();
    // Confirm clears regardless of outcome.
    expect(screen.queryByTestId('topbar-cancel-confirm')).toBeNull();
  });
});

describe('TopBar repo label', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    seedAvailable();
  });

  it('shows the repo name alone when no branch info is available', () => {
    useRepoStore.setState({
      currentRepo: {
        path: '/tmp/foo',
        name: 'foo',
        isGitRepo: true,
        currentBranch: null,
      },
    });
    render(<TopBar />);
    expect(screen.getByTestId('topbar-repo-label')).toHaveTextContent('· foo');
    expect(screen.queryByTestId('topbar-branch-label')).toBeNull();
  });

  it('appends the branch name after a middle-dot separator', () => {
    useRepoStore.setState({
      currentRepo: {
        path: '/tmp/foo',
        name: 'foo',
        isGitRepo: true,
        currentBranch: 'feature/x',
      },
    });
    render(<TopBar />);
    const branch = screen.getByTestId('topbar-branch-label');
    expect(branch).toHaveTextContent('feature/x');
    expect(branch).toHaveAttribute('title', 'Branch: feature/x');
    expect(screen.getByTestId('topbar-repo-label')).toHaveAccessibleName(
      /Switch repository \(current: foo on feature\/x\)/,
    );
  });

  it('shows a short SHA for detached HEAD (backend returns it via current_branch)', () => {
    useRepoStore.setState({
      currentRepo: {
        path: '/tmp/foo',
        name: 'foo',
        isGitRepo: true,
        currentBranch: 'deadbee',
      },
    });
    render(<TopBar />);
    expect(screen.getByTestId('topbar-branch-label')).toHaveTextContent('deadbee');
  });
});

describe('TopBar settings gear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('opens the settings dialog on gear click', () => {
    seedAvailable();
    render(<TopBar />);
    const gear = screen.getByRole('button', { name: /settings/i });
    fireEvent.click(gear);
    expect(screen.getByRole('dialog', { name: /settings/i })).toBeInTheDocument();
  });
});
