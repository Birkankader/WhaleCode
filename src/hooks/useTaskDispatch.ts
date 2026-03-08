import { useCallback } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { commands } from '../bindings';
import type { OutputEvent, RoutingSuggestion } from '../bindings';
import { formatClaudeEvent } from '../lib/claude';
import { formatGeminiEvent } from '../lib/gemini';
import { formatCodexEvent } from '../lib/codex';
import {
  emitProcessOutput,
  useProcessStore,
} from './useProcess';
import { useTaskStore, type ToolName, type OrchestratorConfig } from '../stores/taskStore';

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

      const formatEvent =
        toolName === 'claude' ? formatClaudeEvent :
        toolName === 'codex' ? formatCodexEvent :
        formatGeminiEvent;

      channel.onmessage = (msg: OutputEvent) => {
        let formattedMsg = msg;

        if (msg.event === 'stdout') {
          const formatted = formatEvent(msg.data);
          if (!formatted) return; // Skip empty/suppressed events
          formattedMsg = { event: 'stdout', data: formatted };
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
        const result = await commands.dispatchTask(prompt, projectDir, toolName, tempId, channel);

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

  const dispatchOrchestratedTask = useCallback(
    async (
      prompt: string,
      projectDir: string,
      orchestratorConfig: OrchestratorConfig,
    ): Promise<Map<ToolName, string>> => {
      const results = new Map<ToolName, string>();

      // Create channel for orchestration output (all phases stream through this)
      const channel = new Channel<OutputEvent>();
      const orchestrationId = crypto.randomUUID();

      channel.onmessage = (msg: OutputEvent) => {
        if (msg.event === 'exit') {
          const code = Number(msg.data);
          useProcessStore.getState()._updateStatus(
            orchestrationId,
            code === 0 ? 'completed' : 'failed',
            code,
          );
          emitProcessOutput(orchestrationId, msg);
          return;
        }
        emitProcessOutput(orchestrationId, msg);
      };

      // Register orchestration as a single process in frontend
      const store = useProcessStore.getState();
      const newProcesses = new Map(store.processes);
      const description = prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt;
      newProcesses.set(orchestrationId, {
        taskId: orchestrationId,
        cmd: `orchestration: ${description}`,
        status: 'running',
        channel,
      });
      useProcessStore.setState({
        processes: newProcesses,
        activeProcessId: orchestrationId,
      });

      try {
        // Convert frontend config format (camelCase) to backend format (snake_case)
        const backendConfig = {
          agents: orchestratorConfig.agents.map(a => ({
            tool_name: a.toolName,
            sub_agent_count: a.subAgentCount,
            is_master: a.isMaster,
          })),
          master_agent: orchestratorConfig.masterAgent,
        };

        const result = await commands.dispatchOrchestratedTask(
          prompt,
          projectDir,
          backendConfig,
          channel,
        );

        if (result.status === 'ok') {
          const plan = result.data;
          // Map sub-task agents to their IDs for tracking
          for (const subTask of plan.sub_tasks) {
            results.set(subTask.assigned_agent as ToolName, subTask.id);
          }
          // Mark orchestration complete
          useProcessStore.getState()._updateStatus(orchestrationId, 'completed', 0);
        } else {
          console.error('Orchestration failed:', result.error);
          useProcessStore.getState()._updateStatus(orchestrationId, 'failed', -1);
        }
      } catch (e) {
        console.error('Orchestration error:', e);
        useProcessStore.getState()._updateStatus(orchestrationId, 'failed', -1);
      }

      return results;
    },
    [],
  );

  return { suggestTool, dispatchTask, dispatchOrchestratedTask, isToolBusy };
}
