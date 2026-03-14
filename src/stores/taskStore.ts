import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';

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
  role?: 'master' | 'worker'; // Role in orchestration
  resultSummary?: string;     // Agent's final response/output summary
  lastOutputLine?: string;    // Last meaningful line of agent output (for live preview)
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
  updateTaskResult: (taskId: string, resultSummary: string) => void;
  updateTaskOutputLine: (taskId: string, line: string) => void;
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
  orchestrationStartedAt: number | null;
  lastActivityAt: number | null;
}

// Custom storage that handles Map serialization for the tasks field
type PersistedTaskSlice = Pick<TaskState, 'tasks' | 'orchestrationPhase' | 'orchestrationLogs' | 'orchestrationStartedAt' | 'lastActivityAt'>;

interface SerializedTaskSlice {
  tasks: [string, TaskEntry][];
  orchestrationPhase: OrchestrationPhase;
  orchestrationLogs: TaskState['orchestrationLogs'];
  orchestrationStartedAt: number | null;
  lastActivityAt: number | null;
}

const taskStorage: PersistStorage<PersistedTaskSlice> = {
  getItem: (name) => {
    const raw = localStorage.getItem(name);
    if (!raw) return null;
    try {
      const parsed: StorageValue<SerializedTaskSlice> = JSON.parse(raw);
      return {
        ...parsed,
        state: {
          ...parsed.state,
          tasks: new Map(parsed.state.tasks),
        },
      };
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    const serialized: StorageValue<SerializedTaskSlice> = {
      ...value,
      state: {
        ...value.state,
        tasks: [...value.state.tasks.entries()],
      },
    };
    localStorage.setItem(name, JSON.stringify(serialized));
  },
  removeItem: (name) => {
    localStorage.removeItem(name);
  },
};

export const useTaskStore = create<TaskState>()(persist((set, get) => ({
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

  updateTaskResult: (taskId, resultSummary) => {
    set((state) => {
      const task = state.tasks.get(taskId);
      if (!task) return state;
      const newTasks = new Map(state.tasks);
      newTasks.set(taskId, { ...task, resultSummary });
      return { tasks: newTasks };
    });
  },

  updateTaskOutputLine: (taskId, line) => {
    set((state) => {
      const task = state.tasks.get(taskId);
      if (!task) return state;
      const newTasks = new Map(state.tasks);
      newTasks.set(taskId, { ...task, lastOutputLine: line });
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
    const updates: Partial<TaskState> = { orchestrationPhase: phase };
    if (phase === 'decomposing') {
      updates.orchestrationStartedAt = Date.now();
    } else if (phase === 'idle') {
      updates.orchestrationStartedAt = null;
    }
    set(updates);
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
      lastActivityAt: Date.now(),
    }));
  },
  clearOrchestrationLogs: () => set({ orchestrationLogs: [] }),

  orchestrationStartedAt: null,
  lastActivityAt: null,
}), {
  name: 'whalecode-tasks',
  storage: taskStorage,
  partialize: (state) => ({
    tasks: state.tasks,
    orchestrationPhase: state.orchestrationPhase,
    orchestrationLogs: state.orchestrationLogs.slice(-100),
    orchestrationStartedAt: state.orchestrationStartedAt,
    lastActivityAt: state.lastActivityAt,
  }),
  onRehydrateStorage: () => {
    return (state) => {
      if (!state) return;
      // Reset stale terminal phases on app restart.
      // 'failed' and 'completed' are end-states — showing them on fresh launch
      // is confusing (e.g. DecompositionErrorCard appearing immediately).
      // 'decomposing', 'executing', 'reviewing' are active phases that can't
      // survive a restart (the backend process is gone).
      const phase = state.orchestrationPhase;
      if (phase !== 'idle' && phase !== 'awaiting_approval') {
        state.orchestrationPhase = 'idle';
        state.orchestrationStartedAt = null;
      }
      // Also reset any running/retrying tasks to failed since the processes are dead
      const newTasks = new Map(state.tasks);
      let changed = false;
      for (const [id, task] of newTasks) {
        if (task.status === 'running' || task.status === 'retrying' || task.status === 'falling_back') {
          newTasks.set(id, { ...task, status: 'failed' });
          changed = true;
        }
      }
      if (changed) state.tasks = newTasks;
    };
  },
}));
