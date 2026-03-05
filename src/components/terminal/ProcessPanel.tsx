import { useCallback } from 'react';
import { useProcessStore, type ProcessStatus } from '../../hooks/useProcess';
import { OutputConsole } from './OutputConsole';

function statusColor(status: ProcessStatus): string {
  switch (status) {
    case 'running':
      return 'bg-green-500';
    case 'paused':
      return 'bg-yellow-500';
    case 'completed':
      return 'bg-zinc-500';
    case 'failed':
      return 'bg-red-500';
  }
}

function statusLabel(status: ProcessStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'paused':
      return 'Paused';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed / Cancelled';
  }
}

export function ProcessPanel() {
  const processes = useProcessStore((s) => s.processes);
  const activeProcessId = useProcessStore((s) => s.activeProcessId);
  const setActiveProcess = useProcessStore((s) => s.setActiveProcess);
  const spawnProcess = useProcessStore((s) => s.spawnProcess);
  const cancelProcess = useProcessStore((s) => s.cancelProcess);
  const pauseProcess = useProcessStore((s) => s.pauseProcess);
  const resumeProcess = useProcessStore((s) => s.resumeProcess);

  const handleSpawnTest = useCallback(async () => {
    await spawnProcess(
      '/bin/sh',
      ['-c', 'echo "hello" && sleep 5 && echo "done"'],
      '/tmp',
    );
  }, [spawnProcess]);

  const processList = Array.from(processes.values());
  const activeProcess = activeProcessId ? processes.get(activeProcessId) : null;

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-2 py-1 bg-zinc-900 border-b border-zinc-800 overflow-x-auto shrink-0">
        {processList.map((proc) => (
          <button
            key={proc.taskId}
            onClick={() => setActiveProcess(proc.taskId)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-mono transition-colors shrink-0 ${
              proc.taskId === activeProcessId
                ? 'bg-zinc-700 text-zinc-100'
                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-750 hover:text-zinc-300'
            }`}
            title={`${proc.cmd} - ${statusLabel(proc.status)}`}
          >
            <span className={`w-2 h-2 rounded-full ${statusColor(proc.status)}`} />
            <span className="max-w-[120px] truncate">{proc.cmd}</span>
            {proc.exitCode !== undefined && (
              <span className="text-zinc-500">({proc.exitCode})</span>
            )}
          </button>
        ))}

        {/* Spawn test process button */}
        <button
          onClick={handleSpawnTest}
          className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-mono bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors shrink-0 ml-auto"
        >
          + Spawn Test Process
        </button>
      </div>

      {/* Control bar for active process */}
      {activeProcess && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900/50 border-b border-zinc-800 shrink-0">
          <span className="text-xs text-zinc-500 font-mono truncate flex-1">
            {activeProcess.cmd}
          </span>
          <span className="text-xs text-zinc-500">
            {statusLabel(activeProcess.status)}
          </span>

          {activeProcess.status === 'running' && (
            <>
              <button
                onClick={() => pauseProcess(activeProcess.taskId)}
                className="px-2 py-0.5 text-xs rounded bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/30 transition-colors"
              >
                Pause
              </button>
              <button
                onClick={() => cancelProcess(activeProcess.taskId)}
                className="px-2 py-0.5 text-xs rounded bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors"
              >
                Cancel
              </button>
            </>
          )}

          {activeProcess.status === 'paused' && (
            <>
              <button
                onClick={() => resumeProcess(activeProcess.taskId)}
                className="px-2 py-0.5 text-xs rounded bg-green-600/20 text-green-400 hover:bg-green-600/30 transition-colors"
              >
                Resume
              </button>
              <button
                onClick={() => cancelProcess(activeProcess.taskId)}
                className="px-2 py-0.5 text-xs rounded bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      )}

      {/* Output area */}
      <div className="flex-1 min-h-0 relative">
        {processList.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
            No processes running. Click "Spawn Test Process" to start one.
          </div>
        ) : (
          processList.map((proc) => (
            <div
              key={proc.taskId}
              className="absolute inset-0"
              style={{
                display: proc.taskId === activeProcessId ? 'block' : 'none',
              }}
            >
              <OutputConsole processId={proc.taskId} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
