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
  startedAt: number;
  hasOutput: boolean;
  lastEventAt: number;
  lastOutputPreview: string;
}

// ── Global output routing (outside React/Zustand to avoid timing issues) ──

const outputCallbacks = new Map<string, (event: OutputEvent) => void>();
const outputLogs = new Map<string, OutputEvent[]>();

function buildOutputPreview(event: OutputEvent): string | null {
  if (event.event === 'stdout' || event.event === 'stderr') {
    const line = event.data.trim();
    return line.length > 0 ? line.slice(0, 220) : null;
  }

  if (event.event === 'error') {
    return `Error: ${event.data}`;
  }

  if (event.event === 'exit') {
    return `Process exited with code ${event.data}`;
  }

  return null;
}

export function registerProcessOutput(
  taskId: string,
  cb: (event: OutputEvent) => void,
) {
  // Replay full event history so re-mounted consoles recover all output
  const log = outputLogs.get(taskId);
  if (log) {
    for (const event of log) {
      cb(event);
    }
  }
  outputCallbacks.set(taskId, cb);
}

export function unregisterProcessOutput(taskId: string) {
  outputCallbacks.delete(taskId);
}

export function emitProcessOutput(taskId: string, event: OutputEvent) {
  // Always persist to log so future consumers can replay
  const log = outputLogs.get(taskId) ?? [];
  log.push(event);
  if (log.length > 5000) {
    log.splice(0, log.length - 5000);
  }
  outputLogs.set(taskId, log);

  const preview = buildOutputPreview(event);
  useProcessStore.setState((state) => {
    const proc = state.processes.get(taskId);
    if (!proc) return state;

    const newProcesses = new Map(state.processes);
    newProcesses.set(taskId, {
      ...proc,
      lastEventAt: Date.now(),
      hasOutput: proc.hasOutput || event.event === 'stdout' || event.event === 'stderr' || event.event === 'error',
      lastOutputPreview: preview ?? proc.lastOutputPreview,
    });
    return { processes: newProcesses };
  });

  const cb = outputCallbacks.get(taskId);
  if (cb) {
    cb(event);
  }
}

export function emitLocalProcessMessage(
  taskId: string,
  data: string,
  event: OutputEvent['event'] = 'stdout',
) {
  if (event === 'exit') {
    emitProcessOutput(taskId, { event, data: Number(data) });
    return;
  }

  emitProcessOutput(taskId, { event, data } as OutputEvent);
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
      if (msg.event === 'exit') {
        const code = Number(msg.data);
        get()._updateStatus(resolvedTaskId, code === 0 ? 'completed' : 'failed', code);
        emitProcessOutput(resolvedTaskId, msg);
        return;
      }
      emitProcessOutput(resolvedTaskId, msg);
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
        startedAt: Date.now(),
        hasOutput: false,
        lastEventAt: Date.now(),
        lastOutputPreview: 'CLI process attached. Waiting for first output...',
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
        if (msg.event === 'exit') {
          const code = Number(msg.data);
          get()._updateStatus(taskId, code === 0 ? 'completed' : 'failed', code);
        }
        emitProcessOutput(taskId, msg);
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
    outputLogs.delete(taskId);
    outputCallbacks.delete(taskId);
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
