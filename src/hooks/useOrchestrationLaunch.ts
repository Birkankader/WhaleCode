import { useCallback } from 'react';
import { toast } from 'sonner';
import { ask } from '@tauri-apps/plugin-dialog';
import { useUIStore } from '@/stores/uiStore';
import { useTaskStore, type ToolName, type OrchestratorConfig } from '@/stores/taskStore';
import { useTaskDispatch } from '@/hooks/useTaskDispatch';
import { emitLocalProcessMessage } from '@/hooks/useProcess';
import { humanizeError } from '@/lib/humanizeError';
import { asToolName } from '@/lib/agents';

export interface LaunchConfig {
  sessionName: string;
  projectDir: string;
  master: { cli: string; name: string } | null;
  workers: { agent: { cli: string; name: string }; count: number }[];
  taskDescription: string;
}

export interface LaunchDispatchPlan {
  mode: 'single' | 'orchestrated';
  masterToolName: ToolName;
  totalWorkerCount: number;
  orchestratorConfig: OrchestratorConfig;
}

export function buildLaunchDispatchPlan(config: Pick<LaunchConfig, 'master' | 'workers'>): LaunchDispatchPlan | null {
  if (!config.master) return null;

  const masterToolName = asToolName(config.master.cli);
  const workerCounts = new Map<ToolName, number>();

  for (const worker of config.workers) {
    const toolName = asToolName(worker.agent.cli);
    workerCounts.set(toolName, (workerCounts.get(toolName) ?? 0) + worker.count);
  }

  const masterWorkerCount = workerCounts.get(masterToolName) ?? 0;
  workerCounts.delete(masterToolName);

  const otherAgents: OrchestratorConfig['agents'] = Array.from(workerCounts.entries()).map(
    ([toolName, count]) => ({
      toolName,
      subAgentCount: count,
      isMaster: false,
    }),
  );

  const totalWorkerCount = masterWorkerCount + otherAgents.reduce(
    (sum, agent) => sum + agent.subAgentCount,
    0,
  );

  return {
    mode: totalWorkerCount > 0 ? 'orchestrated' : 'single',
    masterToolName,
    totalWorkerCount,
    orchestratorConfig: {
      agents: [
        { toolName: masterToolName, subAgentCount: masterWorkerCount, isMaster: true },
        ...otherAgents,
      ],
      masterAgent: masterToolName,
    },
  };
}

/**
 * Hook that encapsulates orchestration launch logic.
 * Extracted from AppShell to maintain single responsibility.
 */
export function useOrchestrationLaunch() {
  const setProjectDir = useUIStore((s) => s.setProjectDir);
  const setSessionName = useUIStore((s) => s.setSessionName);
  const setShowSetup = useUIStore((s) => s.setShowSetup);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setSelectedTaskId = useUIStore((s) => s.setSelectedTaskId);
  const { dispatchTask, dispatchOrchestratedTask } = useTaskDispatch();

  const handleLaunch = useCallback(
    async (config: LaunchConfig) => {
      if (!config.master || !config.taskDescription.trim() || !config.projectDir.trim()) return;

      const launchPlan = buildLaunchDispatchPlan(config);
      if (!launchPlan) return;

      const { masterToolName, mode, orchestratorConfig } = launchPlan;

      // Store project dir, session name, and update UI
      setProjectDir(config.projectDir);
      setSessionName(config.sessionName);
      setShowSetup(false);
      setActiveView('kanban');

      // Clean previous session before starting a new one
      const store = useTaskStore.getState();
      if (store.tasks.size > 0) {
        const confirmed = await ask('This will clear the current session. Continue?', {
          title: 'Clear Session',
          kind: 'warning',
        });
        if (!confirmed) return;
      }
      store.clearSession();

      if (mode === 'single') {
        store.setOrchestrationPlan(null);
        store.setOrchestrationPhase('idle');

        const taskId = await dispatchTask(
          config.taskDescription,
          config.projectDir,
          masterToolName,
        );

        if (!taskId) {
          toast.error('Task failed to start');
          return;
        }

        const taskState = useTaskStore.getState();
        const task = taskState.tasks.get(taskId);
        if (task) {
          useTaskStore.setState((state) => {
            const current = state.tasks.get(taskId);
            if (!current) return state;
            const newTasks = new Map(state.tasks);
            newTasks.set(taskId, { ...current, role: 'master' });
            return { tasks: newTasks };
          });
        }
        setSelectedTaskId(taskId);
        return;
      }

      // Store orchestrator config
      store.setOrchestrationPlan(orchestratorConfig);
      store.setOrchestrationPhase('decomposing');

      // Add an orchestration task immediately so the Kanban board shows progress
      const orchTaskId = crypto.randomUUID();
      store.addTask({
        taskId: orchTaskId,
        prompt: config.taskDescription,
        toolName: masterToolName,
        status: 'running',
        description: config.taskDescription.length > 60 ? config.taskDescription.slice(0, 57) + '...' : config.taskDescription,
        startedAt: Date.now(),
        dependsOn: null,
        role: 'master',
      });
      setSelectedTaskId(orchTaskId);

      // Immediate feedback in logs
      store.addOrchestrationLog({ agent: masterToolName, level: 'cmd', message: `Session "${config.sessionName}" starting...` });
      store.addOrchestrationLog({ agent: masterToolName, level: 'info', message: `Master: ${config.master.name} | Project: ${config.projectDir}` });
      store.addOrchestrationLog({ agent: masterToolName, level: 'info', message: config.taskDescription });

      // Fire orchestration (async, errors logged to terminal)
      dispatchOrchestratedTask(config.taskDescription, config.projectDir, orchestratorConfig)
        .catch((e) => {
          console.error('Launch failed:', e);
          toast.error('Orchestration failed', { description: humanizeError(e) });
          store.addOrchestrationLog({ agent: masterToolName, level: 'error', message: `Launch failed: ${e}` });
          emitLocalProcessMessage(orchTaskId, `[error] Orchestration launch failed: ${humanizeError(e)}`, 'stderr');
          store.setOrchestrationPhase('failed');
        });
    },
    [dispatchOrchestratedTask, dispatchTask, setProjectDir, setSessionName, setShowSetup, setActiveView, setSelectedTaskId],
  );

  return { handleLaunch };
}
