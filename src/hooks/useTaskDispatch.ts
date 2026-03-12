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
import { useTaskStore, type ToolName, type TaskStatus, type OrchestratorConfig } from '../stores/taskStore';

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
          startedAt: Date.now(),
          hasOutput: false,
          lastEventAt: Date.now(),
          lastOutputPreview: `${toolName} process started. Waiting for first output...`,
        });
        useProcessStore.setState({
          processes: newProcesses,
          activeProcessId: taskId,
        });

        emitLocalProcessMessage(taskId, `$ ${prompt}`);

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

        // Route meaningful stdout to orchestrationLogs for TerminalView display.
        // Filter out raw NDJSON events — only show orchestrator messages and parsed agent output.
        if (msg.event === 'stdout' && msg.data) {
          const line = msg.data;
          const masterAgent = orchestratorConfig.masterAgent;

          // --- Task lifecycle tracking from messenger/orchestrator messages ---

          // "Assigned to <agent>: <desc>" → add sub-task as pending (Queued)
          const assignMatch = line.match(/^Assigned to (\w+): (.+)$/);
          if (assignMatch) {
            const [, agent, desc] = assignMatch;
            const subId = crypto.randomUUID();
            useTaskStore.getState().addTask({
              taskId: subId,
              prompt: desc,
              toolName: agent as ToolName,
              status: 'pending',
              description: desc.length > 60 ? desc.slice(0, 57) + '...' : desc,
              startedAt: null,
              dependsOn: null,
            });
          }

          // "Phase 2: Executing..." → move all pending tasks to running (In Progress)
          if (line.includes('Phase 2: Executing')) {
            const taskState = useTaskStore.getState();
            const newTasks = new Map(taskState.tasks);
            for (const [id, task] of newTasks) {
              if (task.status === 'pending') {
                newTasks.set(id, { ...task, status: 'running', startedAt: Date.now() });
              }
            }
            useTaskStore.setState({ tasks: newTasks });
          }

          // "Completed (exit 0): ..." or "Failed (exit X): ..." → mark task done
          const completionMatch = line.match(/^(Completed|Failed) \(exit (\d+)\)/);
          if (completionMatch) {
            const [, result] = completionMatch;
            const status: TaskStatus = result === 'Completed' ? 'completed' : 'failed';
            // Find a running task and mark it as completed/failed
            const taskState = useTaskStore.getState();
            for (const [id, task] of taskState.tasks) {
              if (task.status === 'running') {
                useTaskStore.getState().updateTaskStatus(id, status);
                break;
              }
            }
          }

          // Orchestrator status messages (always show)
          if (line.startsWith('[orchestrator]')) {
            useTaskStore.getState().addOrchestrationLog({
              agent: masterAgent,
              level: 'cmd',
              message: line,
            });
          } else if (line.startsWith('{')) {
            // Try to extract meaningful content from NDJSON
            try {
              const ev = JSON.parse(line);
              if (ev.type === 'assistant' && ev.message?.content) {
                for (const block of ev.message.content) {
                  if (block.type === 'text' && block.text) {
                    useTaskStore.getState().addOrchestrationLog({
                      agent: masterAgent,
                      level: 'info',
                      message: block.text,
                    });
                  }
                }
              } else if (ev.type === 'result') {
                if (ev.result) {
                  useTaskStore.getState().addOrchestrationLog({
                    agent: masterAgent,
                    level: 'success',
                    message: ev.result,
                  });
                }
                // Extract usage data from result event
                useTaskStore.getState().updateAgentContext(masterAgent, {
                  toolName: masterAgent,
                  inputTokens: ev.stats?.input_tokens ?? null,
                  outputTokens: ev.stats?.output_tokens ?? null,
                  totalTokens: ev.stats?.total_tokens ?? null,
                  costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
                  status: ev.is_error ? 'failed' : 'completed',
                });
              }
            } catch {
              // Not valid JSON — skip
            }
          } else if (line.trim()) {
            // Non-JSON, non-orchestrator text — show as-is
            useTaskStore.getState().addOrchestrationLog({
              agent: masterAgent,
              level: 'info',
              message: line,
            });
          }
        }
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
        startedAt: Date.now(),
        hasOutput: false,
        lastEventAt: Date.now(),
        lastOutputPreview: 'Master orchestration started. Worker output will stream here.',
      });
      useProcessStore.setState({
        processes: newProcesses,
        activeProcessId: orchestrationId,
      });

      emitLocalProcessMessage(orchestrationId, `$ ${prompt}`);

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
          const taskState = useTaskStore.getState();

          // Add any sub-tasks that weren't already tracked via real-time events
          for (const subTask of plan.sub_tasks) {
            results.set(subTask.assigned_agent as ToolName, subTask.id);
            const alreadyTracked = Array.from(taskState.tasks.values()).some(
              t => t.prompt === subTask.prompt
            );
            if (!alreadyTracked) {
              taskState.addTask({
                taskId: subTask.id,
                prompt: subTask.prompt,
                toolName: subTask.assigned_agent as ToolName,
                status: 'completed',
                description: subTask.prompt.length > 60 ? subTask.prompt.slice(0, 57) + '...' : subTask.prompt,
                startedAt: Date.now(),
                dependsOn: null,
              });
            }
          }

          // If no sub-tasks (master handled directly), add the master as a completed task
          if (plan.sub_tasks.length === 0 && useTaskStore.getState().tasks.size === 0) {
            taskState.addTask({
              taskId: plan.task_id,
              prompt,
              toolName: plan.master_agent as ToolName,
              status: 'completed',
              description: description,
              startedAt: Date.now(),
              dependsOn: null,
            });
          }

          // Store active plan for /clear command
          taskState.setActivePlan({
            task_id: plan.task_id,
            master_agent: plan.master_agent,
            master_process_id: plan.master_process_id,
          });

          // Mark orchestration phase as completed
          const phaseStr = plan.phase as string;
          if (phaseStr === 'Completed' || phaseStr === 'Failed') {
            taskState.setOrchestrationPhase(phaseStr === 'Completed' ? 'completed' : 'failed');
          } else {
            taskState.setOrchestrationPhase('completed');
          }

          useProcessStore.getState()._updateStatus(orchestrationId, 'completed', 0);
        } else {
          console.error('Orchestration failed:', result.error);
          useProcessStore.getState()._updateStatus(orchestrationId, 'failed', -1);
          useTaskStore.getState().setOrchestrationPhase('failed');
          throw new Error(result.error);
        }
      } catch (e) {
        console.error('Orchestration error:', e);
        useProcessStore.getState()._updateStatus(orchestrationId, 'failed', -1);
        useTaskStore.getState().setOrchestrationPhase('failed');
        throw e;
      }

      return results;
    },
    [],
  );

  return { suggestTool, dispatchTask, dispatchOrchestratedTask, isToolBusy };
}
