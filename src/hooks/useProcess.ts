import { create } from 'zustand';
import { Channel } from '@tauri-apps/api/core';
import { commands } from '../bindings';
import type { OutputEvent } from '../bindings';

export type ProcessStatus = 'running' | 'paused' | 'completed' | 'failed';

export interface ProcessInfo {
  taskId: string;
  cmd: string;
  status: ProcessStatus;
  exitCode?: number;
  channel: Channel<OutputEvent>;
}

interface ProcessState {
  processes: Map<string, ProcessInfo>;
  activeProcessId: string | null;

  setActiveProcess: (taskId: string | null) => void;

  spawnProcess: (
    cmd: string,
    args: string[],
    cwd: string,
    onOutput: (event: OutputEvent) => void,
  ) => Promise<string | null>;

  cancelProcess: (taskId: string) => Promise<void>;
  pauseProcess: (taskId: string) => Promise<void>;
  resumeProcess: (taskId: string) => Promise<void>;

  _updateStatus: (taskId: string, status: ProcessStatus, exitCode?: number) => void;
  _removeProcess: (taskId: string) => void;
}

export const useProcessStore = create<ProcessState>((set, get) => ({
  processes: new Map(),
  activeProcessId: null,

  setActiveProcess: (taskId) => set({ activeProcessId: taskId }),

  spawnProcess: async (cmd, args, cwd, onOutput) => {
    const channel = new Channel<OutputEvent>();

    channel.onmessage = (msg: OutputEvent) => {
      onOutput(msg);

      if (msg.event === 'exit') {
        const code = Number(msg.data);
        get()._updateStatus(
          // We need to find taskId after spawn resolves; handled below
          '', // placeholder, overwritten after spawn
          code === 0 ? 'completed' : 'failed',
          code,
        );
      }
    };

    try {
      const result = await commands.spawnProcess(cmd, args, cwd, channel);
      if (result.status === 'error') {
        console.error('Failed to spawn process:', result.error);
        return null;
      }

      const taskId = result.data;

      // Replace the channel handler now that we have the real taskId
      channel.onmessage = (msg: OutputEvent) => {
        onOutput(msg);
        if (msg.event === 'exit') {
          const code = Number(msg.data);
          get()._updateStatus(taskId, code === 0 ? 'completed' : 'failed', code);
        }
      };

      const processInfo: ProcessInfo = {
        taskId,
        cmd: `${cmd} ${args.join(' ')}`.trim(),
        status: 'running',
        channel,
      };

      set((state) => {
        const newProcesses = new Map(state.processes);
        newProcesses.set(taskId, processInfo);
        return {
          processes: newProcesses,
          activeProcessId: taskId,
        };
      });

      return taskId;
    } catch {
      // Not running inside Tauri runtime (e.g., browser dev or test)
      return null;
    }
  },

  cancelProcess: async (taskId) => {
    try {
      await commands.cancelProcess(taskId);
      get()._updateStatus(taskId, 'failed');
    } catch {
      // Non-Tauri environment
    }
  },

  pauseProcess: async (taskId) => {
    try {
      await commands.pauseProcess(taskId);
      get()._updateStatus(taskId, 'paused');
    } catch {
      // Non-Tauri environment
    }
  },

  resumeProcess: async (taskId) => {
    try {
      await commands.resumeProcess(taskId);
      get()._updateStatus(taskId, 'running');
    } catch {
      // Non-Tauri environment
    }
  },

  _updateStatus: (taskId, status, exitCode) => {
    set((state) => {
      const proc = state.processes.get(taskId);
      if (!proc) return state;
      const newProcesses = new Map(state.processes);
      newProcesses.set(taskId, { ...proc, status, exitCode });
      return { processes: newProcesses };
    });
  },

  _removeProcess: (taskId) => {
    set((state) => {
      const newProcesses = new Map(state.processes);
      newProcesses.delete(taskId);
      const newActive =
        state.activeProcessId === taskId
          ? (newProcesses.keys().next().value ?? null)
          : state.activeProcessId;
      return { processes: newProcesses, activeProcessId: newActive };
    });
  },
}));
