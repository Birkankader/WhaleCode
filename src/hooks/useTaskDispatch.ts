import { useCallback } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { commands } from '../bindings';
import type { OutputEvent, RoutingSuggestion } from '../bindings';
import { formatClaudeEvent } from '../lib/claude';
import { formatGeminiEvent } from '../lib/gemini';
import { formatCodexEvent } from '../lib/codex';
import {
  emitProcessOutput,
  emitLocalProcessMessage,
  useProcessStore,
} from './useProcess';
import { useTaskStore, type ToolName, type TaskStatus } from '../stores/taskStore';
import { useOrchestratedDispatch } from './orchestration/useOrchestratedDispatch';

// Re-export for consumers that may need the type
export type { OrchEvent } from './orchestration/handleOrchEvent';

/**
 * Unified task dispatch hook that composes useClaudeTask/useGeminiTask patterns
 * but routes through the backend dispatch_task IPC command.
 *
 * Provides:
 * - suggestTool: get routing suggestion for a prompt
 * - dispatchTask: dispatch a task to the selected tool
 * - dispatchOrchestratedTask: dispatch a multi-agent orchestrated task
 * - isToolBusy: check if a tool has a running process
 */
export function useTaskDispatch() {
  const { dispatchOrchestratedTask } = useOrchestratedDispatch();

  const suggestTool = useCallback(
    async (prompt: string): Promise<RoutingSuggestion | null> => {
      try {
        const result = await commands.suggestTool(prompt);
        if (result.status === 'ok') {
          return result.data;
        }
        return null;
      } catch (e) {
        console.error('Failed to suggest tool:', e);
        return null;
      }
    },
    [],
  );

  const dispatchTask = useCallback(
    async (
      prompt: string,
      projectDir: string,
      toolName: ToolName,
      dependsOn?: string,
    ): Promise<string | null> => {
      const tempId = crypto.randomUUID();
      const description = prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt;

      // Add task to task store with pending status
      useTaskStore.getState().addTask({
        taskId: tempId,
        prompt,
        toolName,
        status: 'pending',
        description,
        startedAt: null,
        dependsOn: dependsOn ?? null,
      });

      // Handle dependency waiting
      if (dependsOn) {
        const depProcess = useProcessStore.getState().processes.get(dependsOn);
        if (depProcess && depProcess.status === 'running') {
          useTaskStore.getState().updateTaskStatus(tempId, 'waiting');

          // Wait for dependency to complete (with 5-minute timeout)
          const completed = await Promise.race([
            new Promise<boolean>((resolve) => {
              const unsub = useProcessStore.subscribe((state) => {
                const dep = state.processes.get(dependsOn);
                if (!dep || dep.status === 'completed') {
                  unsub();
                  resolve(true);
                } else if (dep.status === 'failed') {
                  unsub();
                  resolve(false);
                }
              });
            }),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300_000)),
          ]);

          if (!completed) {
            useTaskStore.getState().updateTaskStatus(tempId, 'failed');
            return null;
          }
        } else if (depProcess && depProcess.status === 'failed') {
          useTaskStore.getState().updateTaskStatus(tempId, 'failed');
          return null;
        }
      }

      // Create channel for streaming events
      const channel = new Channel<OutputEvent>();
      let resolvedTaskId: string | null = null;
      const earlyEvents: OutputEvent[] = [];
      let singleTaskResultText = '';

      const formatEvent =
        toolName === 'claude' ? formatClaudeEvent :
        toolName === 'codex' ? formatCodexEvent :
        formatGeminiEvent;

      let lastOutputUpdateAt = 0;

      channel.onmessage = (msg: OutputEvent) => {
        let formattedMsg = msg;

        if (msg.event === 'stdout') {
          const formatted = formatEvent(msg.data);
          if (!formatted) return; // Skip empty/suppressed events
          formattedMsg = { event: 'stdout', data: formatted };

          // Update lastOutputLine for live preview on task cards (throttled to 500ms)
          const now = Date.now();
          if (now - lastOutputUpdateAt > 500) {
            const previewLine = formatted.trim();
            if (previewLine.length > 0) {
              lastOutputUpdateAt = now;
              useTaskStore.getState().updateTaskOutputLine(tempId, previewLine.slice(0, 160));
            }
          }

          // Capture result text from NDJSON events for single tasks
          const rawLine = msg.data;
          if (rawLine && rawLine.startsWith('{')) {
            try {
              const ev = JSON.parse(rawLine);
              if (ev.type === 'result') {
                const resultText = ev.result || ev.response;
                if (resultText && typeof resultText === 'string') {
                  singleTaskResultText = resultText.length > 800 ? resultText.slice(0, 797) + '...' : resultText;
                }
              }
              // Capture assistant/message content (final response)
              if (ev.type === 'message' || ev.type === 'assistant') {
                let msgText = '';
                if (typeof ev.content === 'string' && ev.content.trim()) {
                  msgText = ev.content.trim();
                } else if (Array.isArray(ev.content)) {
                  msgText = ev.content
                    .filter((b: { type: string; text?: string }) => b.type === 'text' && b.text)
                    .map((b: { text: string }) => b.text.trim())
                    .filter(Boolean)
                    .join('\n');
                }
                if (msgText && msgText.length > 10) {
                  singleTaskResultText = msgText.length > 800 ? msgText.slice(0, 797) + '...' : msgText;
                }
              }
            } catch (e) { /* not valid JSON */ }
          }
        }

        if (msg.event === 'exit') {
          const code = Number(msg.data);
          const finalStatus: TaskStatus = code === 0 ? 'completed' : 'failed';

          // Update task store (single source of truth)
          useTaskStore.getState().updateTaskStatus(tempId, finalStatus);
          useTaskStore.getState().updateTaskProcess(tempId, { exitCode: code });
          if (singleTaskResultText) {
            useTaskStore.getState().updateTaskResult(tempId, singleTaskResultText);
          }

          // Legacy processStore for xterm/OutputConsole compatibility
          useProcessStore.getState()._updateStatus(tempId, finalStatus, code);

          emitProcessOutput(tempId, formattedMsg);
          return;
        }

        // Buffer or emit events
        if (!resolvedTaskId) {
          earlyEvents.push(formattedMsg);
          return;
        }
        emitProcessOutput(tempId, formattedMsg);
      };

      try {
        const result = await commands.dispatchTask(prompt, projectDir, toolName, tempId, channel);

        if (result.status === 'error') {
          console.error('Failed to dispatch task:', result.error);
          useTaskStore.getState().updateTaskStatus(tempId, 'failed');
          return null;
        }

        const taskId = result.data;
        resolvedTaskId = taskId;

        // Register in process store — use tempId for consistency with taskStore
        // Backend usually returns the same tempId, but we normalize here
        const processKey = tempId;
        const store = useProcessStore.getState();
        const newProcesses = new Map(store.processes);
        newProcesses.set(processKey, {
          taskId: processKey,
          cmd: `${toolName}: ${description}`,
          status: 'running',
          channel,
          startedAt: Date.now(),
          hasOutput: false,
          lastEventAt: Date.now(),
          lastOutputPreview: `${toolName} process started. Waiting for first output...`,
        });
        useProcessStore.setState({
          processes: newProcesses,
          activeProcessId: processKey,
        });

        emitLocalProcessMessage(processKey, `$ ${prompt}`);

        // Update task store with real taskId and running status
        const taskState = useTaskStore.getState();
        const task = taskState.tasks.get(tempId);
        if (task) {
          const newTasks = new Map(taskState.tasks);
          newTasks.set(tempId, { ...task, status: 'running', startedAt: Date.now() });
          useTaskStore.setState({ tasks: newTasks });
        }

        // Replay early events
        for (const ev of earlyEvents) {
          emitProcessOutput(tempId, ev);
        }

        return processKey;
      } catch (e) {
        console.error('Failed to dispatch task:', e);
        useTaskStore.getState().updateTaskStatus(tempId, 'failed');
        return null;
      }
    },
    [],
  );

  const isToolBusy = useCallback(
    (toolName: ToolName): boolean => {
      const processes = useProcessStore.getState().processes;
      for (const proc of processes.values()) {
        if (proc.status === 'running' && proc.cmd.startsWith(`${toolName}:`)) {
          return true;
        }
      }
      return false;
    },
    [],
  );

  return { suggestTool, dispatchTask, dispatchOrchestratedTask, isToolBusy };
}
