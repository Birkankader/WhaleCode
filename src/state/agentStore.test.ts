import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the IPC module before importing the store so the store's `detectAgents`
// / `setMasterAgent` references bind to the mocks.
vi.mock('../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../lib/ipc')>('../lib/ipc');
  return {
    ...actual,
    detectAgents: vi.fn(),
    setMasterAgent: vi.fn(),
  };
});

import { detectAgents, setMasterAgent, type AgentDetectionResult } from '../lib/ipc';
import { useAgentStore } from './agentStore';
import { useRepoStore } from './repoStore';

const fullyAvailable: AgentDetectionResult = {
  claude: { status: 'available', version: '1.0.0', binaryPath: '/bin/claude' },
  codex: { status: 'not-installed' },
  gemini: { status: 'not-installed' },
  recommendedMaster: 'claude',
};

function resetStore() {
  useAgentStore.setState({ detection: null, checking: false, error: null });
}

describe('useAgentStore.refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it('populates detection on success', async () => {
    vi.mocked(detectAgents).mockResolvedValueOnce(fullyAvailable);
    const result = await useAgentStore.getState().refresh();
    expect(result).toEqual(fullyAvailable);
    expect(useAgentStore.getState().detection).toEqual(fullyAvailable);
    expect(useAgentStore.getState().checking).toBe(false);
    expect(useAgentStore.getState().error).toBeNull();
  });

  it('coalesces concurrent calls into a single backend invocation', async () => {
    let resolve!: (v: AgentDetectionResult) => void;
    vi.mocked(detectAgents).mockReturnValueOnce(
      new Promise<AgentDetectionResult>((r) => {
        resolve = r;
      }),
    );

    const a = useAgentStore.getState().refresh();
    const b = useAgentStore.getState().refresh();
    // Second call should not spawn a second request while the first is pending.
    expect(detectAgents).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().checking).toBe(true);

    resolve(fullyAvailable);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(fullyAvailable);
    expect(rb).toEqual(fullyAvailable);
    expect(useAgentStore.getState().checking).toBe(false);
  });

  it('captures errors and clears checking flag', async () => {
    vi.mocked(detectAgents).mockRejectedValueOnce(new Error('boom'));
    const result = await useAgentStore.getState().refresh();
    expect(result).toBeNull();
    expect(useAgentStore.getState().error).toContain('boom');
    expect(useAgentStore.getState().checking).toBe(false);
  });
});

describe('useAgentStore.selectMaster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    useRepoStore.setState({ settings: null });
  });

  it('calls set_master_agent and mirrors returned Settings into repoStore', async () => {
    const merged = {
      lastRepo: '/x',
      masterAgent: 'gemini' as const,
    };
    vi.mocked(setMasterAgent).mockResolvedValueOnce(merged);

    await useAgentStore.getState().selectMaster('gemini');
    expect(setMasterAgent).toHaveBeenCalledWith('gemini');
    expect(useRepoStore.getState().settings).toEqual(merged);
  });
});
