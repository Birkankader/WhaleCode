import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    });

    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: /master agent:/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /codex cli/i }));

    expect(setMasterAgent).toHaveBeenCalledWith('codex');
  });
});
