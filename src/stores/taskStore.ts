import { create } from 'zustand';

export type ToolName = 'claude' | 'gemini';
export type TaskStatus = 'pending' | 'routing' | 'running' | 'completed' | 'failed' | 'waiting' | 'review';

export interface TaskEntry {
  taskId: string;
  prompt: string;
  toolName: ToolName;
  status: TaskStatus;
  description: string;       // prompt truncated to 60 chars for display
  startedAt: number | null;  // Date.now() when dispatched
  dependsOn: string | null;  // taskId of dependency (optional, manual)
}

interface TaskState {
  tasks: Map<string, TaskEntry>;
  addTask: (entry: TaskEntry) => void;
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  removeTask: (taskId: string) => void;
  getRunningTaskForTool: (toolName: ToolName) => TaskEntry | undefined;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: new Map(),

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
}));
