import { useState, useCallback, useRef } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { commands } from '../bindings';
import type { OutputEvent } from '../bindings';
import { formatClaudeEvent } from '../lib/claude';
import {
  emitProcessOutput,
  useProcessStore,
} from './useProcess';

/**
 * React hook for spawning Claude Code tasks and handling streaming events.
 *
 * Follows the same pattern as useProcessStore.spawnProcess but:
 * - Calls spawnClaudeTask IPC command instead of spawnProcess
 * - Formats stdout lines through formatClaudeEvent before terminal display
 * - Provides hasApiKey state and checkApiKey utility
 * - Detects rate limits in stderr and silent failures in stdout
 */
export function useClaudeTask() {
  const [isRunning, setIsRunning] = useState(false);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [rateLimitWarning, setRateLimitWarning] = useState(false);
  const [silentFailure, setSilentFailure] = useState(false);
  const silentFailureRef = useRef(false);

  const checkApiKey = useCallback(async () => {
    try {
      const result = await commands.hasClaudeApiKey();
      if (result.status === 'ok') {
        setHasApiKey(result.data);
        return result.data;
      }
      setHasApiKey(false);
      return false;
    } catch {
      setHasApiKey(false);
      return false;
    }
  }, []);

  const spawnTask = useCallback(
    async (prompt: string, projectDir: string): Promise<string | null> => {
      setIsRunning(true);
      setRateLimitWarning(false);
      setSilentFailure(false);
      silentFailureRef.current = false;

      const channel = new Channel<OutputEvent>();
      let resolvedTaskId: string | null = null;
      const earlyEvents: OutputEvent[] = [];

      channel.onmessage = (msg: OutputEvent) => {
        // Format Claude NDJSON stdout into readable text
        let formattedMsg = msg;
        if (msg.event === 'stdout') {
          formattedMsg = { event: 'stdout', data: formatClaudeEvent(msg.data) };

          // Detect silent failure in formatted output
          const lower = msg.data.toLowerCase();
          if (lower.includes('"is_error":true') || lower.includes('"is_error": true')) {
            silentFailureRef.current = true;
            setSilentFailure(true);
          }
        }

        // Detect rate limit in stderr
        if (msg.event === 'stderr') {
          const lower = msg.data.toLowerCase();
          if (
            lower.includes('429') ||
            lower.includes('529') ||
            lower.includes('rate_limit') ||
            lower.includes('overloaded')
          ) {
            setRateLimitWarning(true);
          }
        }

        // Handle exit: update process status
        if (msg.event === 'exit' && resolvedTaskId) {
          setIsRunning(false);
          const code = Number(msg.data);
          useProcessStore.getState()._updateStatus(
            resolvedTaskId,
            code === 0 && !silentFailureRef.current ? 'completed' : 'failed',
            code,
          );
        }

        if (!resolvedTaskId) {
          earlyEvents.push(formattedMsg);
          return;
        }
        emitProcessOutput(resolvedTaskId, formattedMsg);
      };

      try {
        const result = await commands.spawnClaudeTask(prompt, projectDir, channel);
        if (result.status === 'error') {
          console.error('Failed to spawn Claude task:', result.error);
          setIsRunning(false);
          return null;
        }

        const taskId = result.data;
        resolvedTaskId = taskId;

        // Register in process store for UI tracking
        const store = useProcessStore.getState();
        const newProcesses = new Map(store.processes);
        newProcesses.set(taskId, {
          taskId,
          cmd: `claude: ${prompt.slice(0, 60)}`,
          status: 'running',
          channel,
        });
        useProcessStore.setState({
          processes: newProcesses,
          activeProcessId: taskId,
        });

        // Replay early events
        for (const msg of earlyEvents) {
          emitProcessOutput(taskId, msg);
        }

        return taskId;
      } catch {
        setIsRunning(false);
        return null;
      }
    },
    [],
  );

  return {
    spawnTask,
    isRunning,
    hasApiKey,
    checkApiKey,
    rateLimitWarning,
    silentFailure,
  };
}
