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

// ── Global output routing (outside React/Zustand to avoid timing issues) ──

const outputCallbacks = new Map<string, (event: OutputEvent) => void>();
const outputBuffers = new Map<string, OutputEvent[]>();

export function registerProcessOutput(
  taskId: string,
  cb: (event: OutputEvent) => void,
) {
  // Flush any buffered events first
  const buf = outputBuffers.get(taskId);
  console.log('[register]', taskId, 'buffered:', buf?.length ?? 0);
  if (buf) {
    for (const event of buf) {
      cb(event);
    }
    outputBuffers.delete(taskId);
  }
  outputCallbacks.set(taskId, cb);
}

export function unregisterProcessOutput(taskId: string) {
  outputCallbacks.delete(taskId);
}

function emitProcessOutput(taskId: string, event: OutputEvent) {
  console.log('[emit]', taskId, event.event, outputCallbacks.has(taskId) ? 'HAS_CB' : 'BUFFERING');
  const cb = outputCallbacks.get(taskId);
  if (cb) {
    cb(event);
  } else {
    const buf = outputBuffers.get(taskId) ?? [];
    buf.push(event);
    outputBuffers.set(taskId, buf);
  }
}

// ── Zustand store (only manages process state, not output routing) ──

interface ProcessState {
  processes: Map<string, ProcessInfo>;
  activeProcessId: string | null;

  setActiveProcess: (taskId: string | null) => void;

  spawnProcess: (
    cmd: string,
    args: string[],
    cwd: string,
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

  spawnProcess: async (cmd, args, cwd) => {
    let channel: Channel<OutputEvent>;
    try {
      channel = new Channel<OutputEvent>();
    } catch {
      return null;
    }

    let resolvedTaskId: string | null = null;
    const earlyEvents: OutputEvent[] = [];

    channel.onmessage = (msg: OutputEvent) => {
      if (!resolvedTaskId) {
        earlyEvents.push(msg);
        return;
      }
      emitProcessOutput(resolvedTaskId, msg);
      if (msg.event === 'exit') {
        const code = Number(msg.data);
        get()._updateStatus(resolvedTaskId, code === 0 ? 'completed' : 'failed', code);
      }
    };

    try {
      const result = await commands.spawnProcess(cmd, args, cwd, channel);
      if (result.status === 'error') {
        console.error('Failed to spawn process:', result.error);
        return null;
      }

      const taskId = result.data;
      resolvedTaskId = taskId;

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

      // Replay events that arrived during the await
      for (const msg of earlyEvents) {
        emitProcessOutput(taskId, msg);
        if (msg.event === 'exit') {
          const code = Number(msg.data);
          get()._updateStatus(taskId, code === 0 ? 'completed' : 'failed', code);
        }
      }

      return taskId;
    } catch {
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
