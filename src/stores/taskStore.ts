import { create } from 'zustand';

export type ToolName = 'claude' | 'gemini' | 'codex';
export type TaskStatus = 'pending' | 'routing' | 'running' | 'completed' | 'failed' | 'waiting' | 'review' | 'blocked' | 'retrying' | 'falling_back';
export type OrchestrationPhase = 'idle' | 'decomposing' | 'awaiting_approval' | 'executing' | 'reviewing' | 'completed' | 'failed';

export interface TaskEntry {
  taskId: string;
  prompt: string;
  toolName: ToolName;
  status: TaskStatus;
  description: string;       // prompt truncated to 60 chars for display
  startedAt: number | null;  // Date.now() when dispatched
  dependsOn: string | null;  // taskId of dependency (optional, manual)
}

export interface AgentConfig {
  toolName: ToolName;
  subAgentCount: number;
  isMaster: boolean;
}

export interface OrchestratorConfig {
  agents: AgentConfig[];
  masterAgent: ToolName;
}

export interface SubTaskEntry {
  id: string;
  prompt: string;
  assignedAgent: ToolName;
  status: TaskStatus;
  parentTaskId: string;
  dependsOn: string[];
}

export interface AgentContextInfo {
  toolName: ToolName;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  status: string;
}

export interface PendingQuestion {
  questionId: string;
  sourceAgent: string;
  content: string;
  planId: string;
}

interface TaskState {
  tasks: Map<string, TaskEntry>;
  orchestrationPlan: OrchestratorConfig | null;
  agentContexts: Map<string, AgentContextInfo>;
  addTask: (entry: TaskEntry) => void;
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  updateTaskAgent: (taskId: string, toolName: ToolName) => void;
  removeTask: (taskId: string) => void;
  getRunningTaskForTool: (toolName: ToolName) => TaskEntry | undefined;
  setOrchestrationPlan: (plan: OrchestratorConfig | null) => void;
  activePlan: { task_id: string; master_agent: string; master_process_id: string | null } | null;
  setActivePlan: (plan: { task_id: string; master_agent: string; master_process_id: string | null } | null) => void;
  pendingQuestion: PendingQuestion | null;
  setPendingQuestion: (q: PendingQuestion | null) => void;
  updateAgentContext: (toolName: ToolName, info: AgentContextInfo) => void;
  orchestrationPhase: OrchestrationPhase;
  setOrchestrationPhase: (phase: OrchestrationPhase) => void;
  decomposedTasks: SubTaskEntry[];
  setDecomposedTasks: (tasks: SubTaskEntry[]) => void;
  orchestrationLogs: Array<{ id: string; timestamp: string; agent: ToolName; level: 'info' | 'success' | 'warn' | 'cmd' | 'error'; message: string }>;
  addOrchestrationLog: (log: { agent: ToolName; level: 'info' | 'success' | 'warn' | 'cmd' | 'error'; message: string }) => void;
  clearOrchestrationLogs: () => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: new Map(),
  orchestrationPlan: null,
  agentContexts: new Map(),
  activePlan: null,

  setActivePlan: (plan) => {
    set({ activePlan: plan });
  },

  pendingQuestion: null,

  setPendingQuestion: (q) => {
    set({ pendingQuestion: q });
  },

  addTask: (entry) => {
    set((state) => {
      const newTasks = new Map(state.tasks);
      newTasks.set(entry.taskId, entry);
      return { tasks: newTasks };
    });
  },

  updateTaskStatus: (taskId, status) => {
    set((state) => {
      const task = state.tasks.get(taskId);
      if (!task) return state;
      const newTasks = new Map(state.tasks);
      newTasks.set(taskId, { ...task, status });
      return { tasks: newTasks };
    });
  },

  updateTaskAgent: (taskId, toolName) => {
    set((state) => {
      const task = state.tasks.get(taskId);
      if (!task) return state;
      const newTasks = new Map(state.tasks);
      newTasks.set(taskId, { ...task, toolName });
      return { tasks: newTasks };
    });
  },

  removeTask: (taskId) => {
    set((state) => {
      const newTasks = new Map(state.tasks);
      newTasks.delete(taskId);
      return { tasks: newTasks };
    });
  },

  getRunningTaskForTool: (toolName) => {
    const { tasks } = get();
    for (const task of tasks.values()) {
      if (task.toolName === toolName && task.status === 'running') {
        return task;
      }
    }
    return undefined;
  },

  setOrchestrationPlan: (plan) => {
    set({ orchestrationPlan: plan });
  },

  updateAgentContext: (toolName, info) => {
    set((state) => {
      const newContexts = new Map(state.agentContexts);
      newContexts.set(toolName, info);
      return { agentContexts: newContexts };
    });
  },

  orchestrationPhase: 'idle',
  setOrchestrationPhase: (phase) => {
    set({ orchestrationPhase: phase });
  },

  decomposedTasks: [],
  setDecomposedTasks: (tasks) => {
    set({ decomposedTasks: tasks });
  },

  orchestrationLogs: [],
  addOrchestrationLog: (log) => {
    set((state) => ({
      orchestrationLogs: [
        ...state.orchestrationLogs.slice(-499),
        {
          id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
          timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          ...log,
        },
      ],
    }));
  },
  clearOrchestrationLogs: () => set({ orchestrationLogs: [] }),
}));
