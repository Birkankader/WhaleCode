import { useCallback } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { commands } from '../bindings';
import type { OutputEvent, RoutingSuggestion } from '../bindings';
import { formatClaudeEvent } from '../lib/claude';
import { formatGeminiEvent } from '../lib/gemini';
import {
  emitProcessOutput,
  useProcessStore,
} from './useProcess';
import { useTaskStore, type ToolName } from '../stores/taskStore';

/**
 * Unified task dispatch hook that composes useClaudeTask/useGeminiTask patterns
 * but routes through the backend dispatch_task IPC command.
 *
 * Provides:
 * - suggestTool: get routing suggestion for a prompt
 * - dispatchTask: dispatch a task to the selected tool
 * - isToolBusy: check if a tool has a running process
 */
export function useTaskDispatch() {
  const suggestTool = useCallback(
    async (prompt: string): Promise<RoutingSuggestion | null> => {
      try {
        const result = await commands.suggestTool(prompt);
        if (result.status === 'ok') {
          return result.data;
        }
        return null;
      } catch {
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

          // Wait for dependency to complete
          const completed = await new Promise<boolean>((resolve) => {
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
          });

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

      const formatEvent = toolName === 'claude' ? formatClaudeEvent : formatGeminiEvent;

      channel.onmessage = (msg: OutputEvent) => {
        let formattedMsg = msg;

        if (msg.event === 'stdout') {
          formattedMsg = { event: 'stdout', data: formatEvent(msg.data) };
        }

        if (msg.event === 'exit') {
          const code = Number(msg.data);
          const finalId = resolvedTaskId ?? tempId;

          // Update process store status
          useProcessStore.getState()._updateStatus(
            finalId,
            code === 0 ? 'completed' : 'failed',
            code,
          );

          // Update task store status
          useTaskStore.getState().updateTaskStatus(
            tempId,
            code === 0 ? 'completed' : 'failed',
          );

          // Emit the exit event
          emitProcessOutput(finalId, formattedMsg);
          return;
        }

        // Buffer or emit events
        if (!resolvedTaskId) {
          earlyEvents.push(formattedMsg);
          return;
        }
        emitProcessOutput(resolvedTaskId, formattedMsg);
      };

      try {
        const result = await commands.dispatchTask(prompt, projectDir, toolName, channel);

        if (result.status === 'error') {
          console.error('Failed to dispatch task:', result.error);
          useTaskStore.getState().updateTaskStatus(tempId, 'failed');
          return null;
        }

        const taskId = result.data;
        resolvedTaskId = taskId;

        // Register in process store (same pattern as useClaudeTask/useGeminiTask)
        const store = useProcessStore.getState();
        const newProcesses = new Map(store.processes);
        newProcesses.set(taskId, {
          taskId,
          cmd: `${toolName}: ${description}`,
          status: 'running',
          channel,
        });
        useProcessStore.setState({
          processes: newProcesses,
          activeProcessId: taskId,
        });

        // Update task store with real taskId and running status
        useTaskStore.getState().updateTaskStatus(tempId, 'running');
        // Update startedAt
        const taskState = useTaskStore.getState();
        const task = taskState.tasks.get(tempId);
        if (task) {
          const newTasks = new Map(taskState.tasks);
          newTasks.set(tempId, { ...task, status: 'running', startedAt: Date.now() });
          useTaskStore.setState({ tasks: newTasks });
        }

        // Replay early events
        for (const ev of earlyEvents) {
          emitProcessOutput(taskId, ev);
        }

        return taskId;
      } catch {
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

  return { suggestTool, dispatchTask, isToolBusy };
}
