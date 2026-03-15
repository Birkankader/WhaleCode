import { useState, useCallback, useRef } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { commands } from '../bindings';
import type { OutputEvent } from '../bindings';
import { formatGeminiEvent } from '../lib/gemini';
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
 * React hook for spawning Gemini CLI tasks and handling streaming events.
 *
 * Mirrors useClaudeTask exactly but:
 * - Calls spawnGeminiTask IPC command instead of spawnClaudeTask
 * - Formats stdout lines through formatGeminiEvent instead of formatClaudeEvent
 * - Uses hasGeminiApiKey for key checking
 * - Uses validateGeminiResult for exit validation
 * - Detects Gemini-specific rate limit patterns (429, RESOURCE_EXHAUSTED, quota, rate limit)
 */
export function useGeminiTask() {
  const [isRunning, setIsRunning] = useState(false);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [rateLimitWarning, setRateLimitWarning] = useState<string | false>(false);
  const [silentFailure, setSilentFailure] = useState(false);
  const silentFailureRef = useRef(false);

  const checkApiKey = useCallback(async () => {
    try {
      const result = await commands.hasGeminiApiKey();
      if (result.status === 'ok') {
        setHasApiKey(result.data);
        return result.data;
      }
      setHasApiKey(false);
      return false;
    } catch (e) {
      console.error('Failed to check Gemini API key:', e);
      setHasApiKey(false);
      return false;
    }
  }, []);

  /**
   * Spawn a single Gemini task attempt. Wraps the Channel-based spawn in a
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
            } catch (e) {
              /* not JSON, ignore */
            }

            formattedMsg = { event: 'stdout', data: formatGeminiEvent(msg.data) };

            // Detect error events in stream
            const lower = msg.data.toLowerCase();
            if (lower.includes('"type":"error"') || lower.includes('"type": "error"')) {
              silentFailureRef.current = true;
            }
          }

          // Detect rate limit in stderr
          if (msg.event === 'stderr') {
            const lower = msg.data.toLowerCase();
            if (
              lower.includes('429') ||
              lower.includes('resource_exhausted') ||
              lower.includes('quota') ||
              lower.includes('rate limit') ||
              lower.includes('too many requests')
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
                const validateResult = await commands.validateGeminiResult(lastResultJson);
                if (validateResult.status === 'error') {
                  isSilentFailure = true;
                }
              } catch (e) {
                console.error('Failed to validate Gemini result:', e);
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
              `[GeminiTask ${resolvedTaskId}] Completed.`,
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
        commands.spawnGeminiTask(prompt, projectDir, null, channel).then((result) => {
          if (result.status === 'error') {
            console.error('Failed to spawn Gemini task:', result.error);
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
            cmd: `gemini: ${prompt.slice(0, 60)}`,
            status: 'running',
            channel,
            startedAt: Date.now(),
            hasOutput: false,
            lastEventAt: Date.now(),
            lastOutputPreview: 'Gemini process started. Waiting for first output...',
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
