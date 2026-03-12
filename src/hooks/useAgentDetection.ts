import { useState, useEffect, useCallback } from 'react';
import { commands } from '../bindings';
import type { DetectedAgent, AuthStatus } from '../bindings';

export type { DetectedAgent, AuthStatus };

interface AgentDetectionState {
  agents: DetectedAgent[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  getAgent: (toolName: string) => DetectedAgent | undefined;
  isAuthenticated: (toolName: string) => boolean;
  isInstalled: (toolName: string) => boolean;
}

export function useAgentDetection(): AgentDetectionState {
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await commands.detectAgents();
      if (result.status === 'ok') {
        setAgents(result.data);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to detect agents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const getAgent = useCallback(
    (toolName: string) => agents.find((a) => a.tool_name === toolName),
    [agents],
  );

  const isAuthenticated = useCallback(
    (toolName: string) => {
      const agent = agents.find((a) => a.tool_name === toolName);
      return agent?.auth_status === 'Authenticated';
    },
    [agents],
  );

  const isInstalled = useCallback(
    (toolName: string) => {
      const agent = agents.find((a) => a.tool_name === toolName);
      return agent?.installed === true;
    },
    [agents],
  );

  return { agents, loading, error, refresh, getAgent, isAuthenticated, isInstalled };
}
