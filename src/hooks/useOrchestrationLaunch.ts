import { useCallback } from 'react';
import { toast } from 'sonner';
import { useUIStore } from '@/stores/uiStore';
import { useTaskStore, type ToolName, type OrchestratorConfig } from '@/stores/taskStore';
import { useTaskDispatch } from '@/hooks/useTaskDispatch';
import { humanizeError } from '@/lib/humanizeError';

export interface LaunchConfig {
  sessionName: string;
  projectDir: string;
  master: { cli: string; name: string } | null;
  workers: { agent: { cli: string; name: string }; count: number }[];
  taskDescription: string;
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
  const { dispatchOrchestratedTask } = useTaskDispatch();

  const handleLaunch = useCallback(
    (config: LaunchConfig) => {
      if (!config.master || !config.taskDescription.trim() || !config.projectDir.trim()) return;

      const masterToolName = config.master.cli as ToolName;
      const agents: OrchestratorConfig['agents'] = [
        { toolName: masterToolName, subAgentCount: 1, isMaster: true },
        ...config.workers.map((w) => ({
          toolName: w.agent.cli as ToolName,
          subAgentCount: w.count,
          isMaster: false,
        })),
      ];
      const orchestratorConfig: OrchestratorConfig = { agents, masterAgent: masterToolName };

      // Store project dir, session name, and update UI
      setProjectDir(config.projectDir);
      setSessionName(config.sessionName);
      setShowSetup(false);
      setActiveView('kanban');

      // Clean previous session before starting a new one
      const store = useTaskStore.getState();
      store.clearSession();

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
          store.setOrchestrationPhase('failed');
        });
    },
    [dispatchOrchestratedTask, setProjectDir, setSessionName, setShowSetup, setActiveView],
  );

  return { handleLaunch };
}
