import { create } from 'zustand';

export type ToolName = 'claude' | 'gemini' | 'codex';

export interface WorktreeReviewEntry {
  dagId: string;
  branchName: string;
  fileCount: number;
  additions: number;
  deletions: number;
}

// Helper: immutably update a single task entry in the Map
function updateTask(
  tasks: Map<string, TaskEntry>,
  taskId: string,
  updater: (task: TaskEntry) => TaskEntry,
): Map<string, TaskEntry> {
  const task = tasks.get(taskId);
  if (!task) return tasks;
  const newTasks = new Map(tasks);
  newTasks.set(taskId, updater(task));
  return newTasks;
}
export type TaskStatus = 'pending' | 'routing' | 'running' | 'completed' | 'failed' | 'waiting' | 'review' | 'blocked' | 'retrying' | 'falling_back';
export type OrchestrationPhase = 'idle' | 'decomposing' | 'awaiting_approval' | 'executing' | 'reviewing' | 'completed' | 'failed';

export interface TaskEntry {
  taskId: string;
  prompt: string;
  toolName: ToolName;
  status: TaskStatus;
  description: string;
  startedAt: number | null;
  dependsOn: string | null;
  role?: 'master' | 'worker';
  resultSummary?: string;
  lastOutputLine?: string;
  // Process info (merged from processStore — single source of truth)
  exitCode?: number;
  lastEventAt?: number;
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

export type OrchestrationLogLevel = 'info' | 'success' | 'warn' | 'cmd' | 'error';

export interface OrchestrationLogEntry {
  id: string;
  timestamp: string;
  agent: ToolName;
  level: OrchestrationLogLevel;
  message: string;
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
  updateTaskProcess: (taskId: string, update: Partial<Pick<TaskEntry, 'exitCode' | 'lastEventAt' | 'status'>>) => void;
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
  orchestrationLogs: OrchestrationLogEntry[];
  addOrchestrationLog: (log: Omit<OrchestrationLogEntry, 'id' | 'timestamp'>) => void;
  clearOrchestrationLogs: () => void;
  orchestrationStartedAt: number | null;
  lastActivityAt: number | null;
  // Worktree review entries (from @@orch::diffs_ready)
  worktreeEntries: Map<string, WorktreeReviewEntry>;
  setWorktreeEntries: (entries: Map<string, WorktreeReviewEntry>) => void;
  // Session management
  clearSession: () => void;
}

export const useTaskStore = create<TaskState>()((set, get) => ({
  tasks: new Map(),
  orchestrationPlan: null,
  agentContexts: new Map(),
  activePlan: null,

  setActivePlan: (plan) => set({ activePlan: plan }),

  pendingQuestion: null,
  setPendingQuestion: (q) => set({ pendingQuestion: q }),

  addTask: (entry) => {
    set((state) => {
      const newTasks = new Map(state.tasks);
      newTasks.set(entry.taskId, entry);
      return { tasks: newTasks };
    });
  },

  updateTaskStatus: (taskId, status) => {
    set((state) => ({ tasks: updateTask(state.tasks, taskId, (t) => ({ ...t, status })) }));
  },

  updateTaskAgent: (taskId, toolName) => {
    set((state) => ({ tasks: updateTask(state.tasks, taskId, (t) => ({ ...t, toolName })) }));
  },

  updateTaskResult: (taskId, resultSummary) => {
    set((state) => ({ tasks: updateTask(state.tasks, taskId, (t) => ({ ...t, resultSummary })) }));
  },

  updateTaskOutputLine: (taskId, line) => {
    set((state) => ({ tasks: updateTask(state.tasks, taskId, (t) => ({ ...t, lastOutputLine: line })) }));
  },

  updateTaskProcess: (taskId, update) => {
    set((state) => ({ tasks: updateTask(state.tasks, taskId, (t) => ({ ...t, ...update })) }));
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

  setOrchestrationPlan: (plan) => set({ orchestrationPlan: plan }),

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
  setDecomposedTasks: (tasks) => set({ decomposedTasks: tasks }),

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

  worktreeEntries: new Map(),
  setWorktreeEntries: (entries) => set({ worktreeEntries: entries }),

  clearSession: () => {
    set({
      tasks: new Map(),
      orchestrationPlan: null,
      agentContexts: new Map(),
      activePlan: null,
      pendingQuestion: null,
      decomposedTasks: [],
      orchestrationLogs: [],
      orchestrationPhase: 'idle',
      orchestrationStartedAt: null,
      lastActivityAt: null,
      worktreeEntries: new Map(),
    });
  },
}));
