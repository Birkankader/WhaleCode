import { useState, useCallback, useRef } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { commands } from '../bindings';
import type { OutputEvent } from '../bindings';
import { formatClaudeEvent } from '../lib/claude';
import {
  emitProcessOutput,
  useProcessStore,
} from './useProcess';

interface SpawnOnceResult {
  taskId: string | null;
  hitRateLimit: boolean;
  silentFailure: boolean;
}

/**
 * React hook for spawning Claude Code tasks and handling streaming events.
 *
 * Follows the same pattern as useProcessStore.spawnProcess but:
 * - Calls spawnClaudeTask IPC command instead of spawnProcess
 * - Formats stdout lines through formatClaudeEvent before terminal display
 * - Provides hasApiKey state and checkApiKey utility
 * - Detects rate limits in stderr and retries with exponential backoff
 * - Validates result on exit to catch silent failures
 */
export function useClaudeTask() {
  const [isRunning, setIsRunning] = useState(false);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [rateLimitWarning, setRateLimitWarning] = useState<string | false>(false);
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

  /**
   * Spawn a single Claude task attempt. Wraps the Channel-based spawn in a
   * Promise that resolves when the exit event fires, returning whether a
   * rate limit was hit and whether the result was a silent failure.
   */
  const spawnOnce = useCallback(
    async (prompt: string, projectDir: string): Promise<SpawnOnceResult> => {
      return new Promise<SpawnOnceResult>((resolve) => {
        let hitRateLimit = false;
        let lastResultJson: string | null = null;
        let resolvedTaskId: string | null = null;
        const earlyEvents: OutputEvent[] = [];

        const channel = new Channel<OutputEvent>();
        channel.onmessage = async (msg: OutputEvent) => {
          let formattedMsg = msg;

          if (msg.event === 'stdout') {
            // Capture result events for exit validation
            try {
              const parsed = JSON.parse(msg.data);
              if (parsed.type === 'result') {
                lastResultJson = msg.data;
              }
            } catch {
              /* not JSON, ignore */
            }

            formattedMsg = { event: 'stdout', data: formatClaudeEvent(msg.data) || '' };

            // Detect silent failure in formatted output
            const lower = msg.data.toLowerCase();
            if (lower.includes('"is_error":true') || lower.includes('"is_error": true')) {
              silentFailureRef.current = true;
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
              hitRateLimit = true;
            }
          }

          // Handle exit: validate result and resolve promise
          if (msg.event === 'exit') {
            let isSilentFailure = silentFailureRef.current;

            // Validate result via backend IPC
            if (lastResultJson) {
              try {
                const validateResult = await commands.validateClaudeResult(lastResultJson);
                if (validateResult.status === 'error') {
                  isSilentFailure = true;
                }
              } catch {
                isSilentFailure = true;
              }
            } else if (Number(msg.data) === 0) {
              // Exit 0 but no result event = silent failure
              isSilentFailure = true;
            }

            // Update process status in store
            if (resolvedTaskId) {
              const code = Number(msg.data);
              useProcessStore.getState()._updateStatus(
                resolvedTaskId,
                code === 0 && !isSilentFailure ? 'completed' : 'failed',
                code,
              );
            }

            console.log(
              `[ClaudeTask ${resolvedTaskId}] Completed.`,
              `Exit Code: ${msg.data}.`,
              `Silent Failure: ${isSilentFailure}.`,
              `Last Result JSON: ${lastResultJson ? lastResultJson : 'NONE'}`
            );

            resolve({ taskId: resolvedTaskId, hitRateLimit, silentFailure: isSilentFailure });
            return;
          }

          // Buffer or emit events
          if (!resolvedTaskId) {
            earlyEvents.push(formattedMsg);
            return;
          }
          emitProcessOutput(resolvedTaskId, formattedMsg);
        };

        // Spawn the task
        commands.spawnClaudeTask(prompt, projectDir, null, channel).then((result) => {
          if (result.status === 'error') {
            console.error('Failed to spawn Claude task:', result.error);
            resolve({ taskId: null, hitRateLimit: false, silentFailure: false });
            return;
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
          for (const ev of earlyEvents) {
            emitProcessOutput(taskId, ev);
          }
        }).catch(() => {
          resolve({ taskId: null, hitRateLimit: false, silentFailure: false });
        });
      });
    },
    [],
  );

  const spawnTask = useCallback(
    async (prompt: string, projectDir: string): Promise<string | null> => {
      setIsRunning(true);
      setRateLimitWarning(false);
      setSilentFailure(false);
      silentFailureRef.current = false;

      const policy = { maxRetries: 3, baseDelay: 5000, maxDelay: 60000 };

      for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
        if (attempt > 0) {
          const delay = Math.min(policy.baseDelay * 2 ** (attempt - 1), policy.maxDelay);
          setRateLimitWarning(`Retrying in ${delay / 1000}s (attempt ${attempt}/${policy.maxRetries})...`);
          await new Promise((r) => setTimeout(r, delay));
        }

        setRateLimitWarning(false);
        silentFailureRef.current = false;
        const result = await spawnOnce(prompt, projectDir);

        if (result.silentFailure) {
          setSilentFailure(true);
        }

        if (!result.hitRateLimit) {
          setIsRunning(false);
          return result.taskId;
        }

        // Rate limit hit -- cancel and retry
        if (result.taskId) {
          await commands.cancelProcess(result.taskId);
        }
      }

      setRateLimitWarning('Rate limit retry exhausted after 3 attempts');
      setIsRunning(false);
      return null;
    },
    [spawnOnce],
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
