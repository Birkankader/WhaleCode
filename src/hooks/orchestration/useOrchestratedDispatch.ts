import { useCallback } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { commands } from '../../bindings';
import type { OutputEvent } from '../../bindings';
import {
  emitProcessOutput,
  emitLocalProcessMessage,
  useProcessStore,
} from '../useProcess';
import { useTaskStore, type ToolName, type TaskStatus, type OrchestratorConfig } from '../../stores/taskStore';
import { handleOrchEvent } from './handleOrchEvent';

/**
 * Hook that provides the `dispatchOrchestratedTask` function for multi-agent orchestration.
 */
export function useOrchestratedDispatch() {
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

      // Buffer for capturing agent result text to attach to completing tasks
      let lastResultText = '';
      // Ordered queue of sub-task IDs for matching sequential completion messages
      const subTaskQueue: string[] = [];
      // Map DAG IDs (t1, t2, ...) to frontend task IDs — assigned in order
      const dagToFrontendId = new Map<string, string>();
      let dagCounter = 0;

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

        if (msg.event === 'stdout' && msg.data) {
          const line = msg.data;
          const masterAgent = orchestratorConfig.masterAgent;

          // --- Structured orchestrator events (@@orch:: prefix) ---
          if (line.startsWith('@@orch::')) {
            try {
              const ev = JSON.parse(line.slice(8));
              handleOrchEvent(ev, masterAgent, subTaskQueue, dagToFrontendId, dagCounter);
              if (ev.type === 'task_assigned') dagCounter++;
            } catch (e) { console.error('Malformed orch event:', e); }
            return;
          }

          // --- NDJSON agent output (Claude/Gemini result events) ---
          if (line.startsWith('{')) {
            try {
              const ev = JSON.parse(line);
              if (ev.type === 'result') {
                const resultText = ev.result || ev.response;
                let isDecompositionJson = false;
                if (resultText) {
                  try {
                    const parsed = typeof resultText === 'string' ? JSON.parse(resultText) : null;
                    if (parsed && Array.isArray(parsed.tasks) && parsed.tasks[0]?.agent) {
                      isDecompositionJson = true;
                    } else if (parsed && Array.isArray(parsed.sub_tasks) && parsed.sub_tasks[0]?.assigned_agent) {
                      isDecompositionJson = true;
                    }
                  } catch (e) { /* not decomposition JSON */ }
                }
                if (resultText && !isDecompositionJson) {
                  lastResultText = resultText.length > 800 ? resultText.slice(0, 797) + '...' : resultText;
                  if (resultText.length < 500) {
                    useTaskStore.getState().addOrchestrationLog({
                      agent: masterAgent,
                      level: 'success',
                      message: resultText.length > 200 ? resultText.slice(0, 200) + '...' : resultText,
                    });
                  }
                }
                const inputTokens = ev.usage?.input_tokens ?? ev.stats?.input_tokens ?? null;
                const outputTokens = ev.usage?.output_tokens ?? ev.stats?.output_tokens ?? null;
                const totalTokens = ev.usage?.total_tokens ?? ev.stats?.total_tokens
                  ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null);
                useTaskStore.getState().updateAgentContext(masterAgent, {
                  toolName: masterAgent,
                  inputTokens,
                  outputTokens,
                  totalTokens,
                  costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
                  status: ev.is_error ? 'failed' : 'completed',
                });
              }
            } catch (e) { /* not valid JSON */ }
          }
          // Skip all other raw text (MCP warnings, echoed prompts, verbose agent output)
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

          // Determine final phase status
          const phaseStr = plan.phase as string;
          const isFailure = phaseStr === 'Failed';
          const finalStatus: TaskStatus = isFailure ? 'failed' : 'completed';

          // Update the initial orchestration task that was added immediately at launch
          // Find it: it's the task with status 'running' matching the prompt
          const currentTasks = taskState.tasks;
          for (const [id, t] of currentTasks) {
            if (t.status === 'running' && t.prompt === prompt) {
              taskState.updateTaskStatus(id, finalStatus);
              // Attach final result summary to the master task
              if (lastResultText) {
                taskState.updateTaskResult(id, lastResultText);
                lastResultText = '';
              }
              break;
            }
          }

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

          // Store active plan for /clear command
          taskState.setActivePlan({
            task_id: plan.task_id,
            master_agent: plan.master_agent,
            master_process_id: plan.master_process_id,
          });

          // Mark orchestration phase as completed or failed
          taskState.setOrchestrationPhase(isFailure ? 'failed' : 'completed');

          useProcessStore.getState()._updateStatus(orchestrationId, finalStatus, isFailure ? -1 : 0);
        } else {
          console.error('Orchestration failed:', result.error);
          useProcessStore.getState()._updateStatus(orchestrationId, 'failed', -1);
          useTaskStore.getState().setOrchestrationPhase('failed');
          throw new Error(result.error);
        }
      } catch (e) {
        console.error('Orchestration error:', e);
        useProcessStore.getState()._updateStatus(orchestrationId, 'failed', -1);
        const taskState = useTaskStore.getState();
        taskState.setOrchestrationPhase('failed');

        // Mark any running tasks as failed
        const currentTasks = new Map(taskState.tasks);
        for (const [id, t] of currentTasks) {
          if (t.status === 'running') {
            currentTasks.set(id, { ...t, status: 'failed' });
          }
        }
        useTaskStore.setState({ tasks: currentTasks });

        throw e;
      }

      return results;
    },
    [],
  );

  return { dispatchOrchestratedTask };
}
