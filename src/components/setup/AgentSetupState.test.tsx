import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../../lib/ipc')>('../../lib/ipc');
  return {
    ...actual,
    detectAgents: vi.fn(),
    setMasterAgent: vi.fn(),
  };
});

import { detectAgents, type AgentDetectionResult } from '../../lib/ipc';
import { useAgentStore } from '../../state/agentStore';

import { AgentSetupState } from './AgentSetupState';

function seedDetection(detection: AgentDetectionResult) {
  useAgentStore.setState({ detection, checking: false, error: null });
}

describe('AgentSetupState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentStore.setState({ detection: null, checking: false, error: null });
  });

  it('renders a card per agent with the install command and hint', () => {
    seedDetection({
      claude: { status: 'not-installed' },
      codex: { status: 'not-installed' },
      gemini: { status: 'not-installed' },
      recommendedMaster: null,
    });
    render(<AgentSetupState />);
    expect(screen.getByTestId('agent-card-claude')).toBeInTheDocument();
    expect(screen.getByTestId('agent-card-codex')).toBeInTheDocument();
    expect(screen.getByTestId('agent-card-gemini')).toBeInTheDocument();
    // Install command surfaces for each card.
    expect(screen.getByText(/@anthropic-ai\/claude-code/)).toBeInTheDocument();
    expect(screen.getByText(/@openai\/codex/)).toBeInTheDocument();
    expect(screen.getByText(/@google\/gemini-cli/)).toBeInTheDocument();
  });

  it('shows the error line for a broken agent', () => {
    seedDetection({
      claude: {
        status: 'broken',
        binaryPath: '/bad/claude',
        error: 'library missing',
      },
      codex: { status: 'not-installed' },
      gemini: { status: 'not-installed' },
      recommendedMaster: null,
    });
    render(<AgentSetupState />);
    const card = screen.getByTestId('agent-card-claude');
    expect(within(card).getByRole('alert')).toHaveTextContent('library missing');
  });

  it('Recheck button dispatches detect_agents and disables while in flight', async () => {
    let resolve!: (v: Awaited<ReturnType<typeof detectAgents>>) => void;
    vi.mocked(detectAgents).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render(<AgentSetupState />);
    const button = screen.getByRole('button', { name: /recheck installed agents/i });
    fireEvent.click(button);
    // Flush the sync store update from refresh() start.
    expect(vi.mocked(detectAgents)).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/checking/i);

    // Complete the probe; button should re-enable.
    await act(async () => {
      resolve({
        claude: { status: 'available', version: '1.0.0', binaryPath: '/b' },
        codex: { status: 'not-installed' },
        gemini: { status: 'not-installed' },
        recommendedMaster: 'claude',
      });
    });
    expect(button).not.toBeDisabled();
  });
});
