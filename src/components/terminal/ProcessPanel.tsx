import { useCallback, useState } from 'react';
import { useProcessStore, type ProcessStatus } from '../../hooks/useProcess';
import { useClaudeTask } from '../../hooks/useClaudeTask';
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

  const { spawnTask, isRunning: isClaudeRunning, rateLimitWarning, silentFailure } = useClaudeTask();

  const [claudePrompt, setClaudePrompt] = useState('');
  const [claudeProjectDir, setClaudeProjectDir] = useState('');
  const [showClaudeInput, setShowClaudeInput] = useState(false);

  const handleSpawnTest = useCallback(async () => {
    await spawnProcess(
      '/bin/sh',
      ['-c', 'echo "hello" && sleep 5 && echo "done"'],
      '/tmp',
    );
  }, [spawnProcess]);

  const handleSpawnClaude = useCallback(async () => {
    if (!claudePrompt.trim() || !claudeProjectDir.trim()) return;
    await spawnTask(claudePrompt.trim(), claudeProjectDir.trim());
    setClaudePrompt('');
    setShowClaudeInput(false);
  }, [claudePrompt, claudeProjectDir, spawnTask]);

  const processList = Array.from(processes.values());
  const activeProcess = activeProcessId ? processes.get(activeProcessId) : null;

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* Rate limit warning banner */}
      {rateLimitWarning && (
        <div className="px-3 py-2 bg-yellow-900/40 border-b border-yellow-700/50 text-yellow-300 text-xs flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          {typeof rateLimitWarning === 'string' ? rateLimitWarning : 'Rate limit detected.'}
        </div>
      )}

      {/* Silent failure warning banner */}
      {silentFailure && (
        <div className="px-3 py-2 bg-red-900/40 border-b border-red-700/50 text-red-300 text-xs flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          Silent failure detected: Task exited cleanly but returned an error in its result.
        </div>
      )}

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

        {/* Claude Task button */}
        <button
          onClick={() => setShowClaudeInput(!showClaudeInput)}
          disabled={isClaudeRunning}
          className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-mono bg-violet-900/30 text-violet-300 hover:bg-violet-800/40 hover:text-violet-200 disabled:opacity-50 transition-colors shrink-0 ml-auto"
        >
          + Claude Task
        </button>

        {/* Spawn test process button */}
        <button
          onClick={handleSpawnTest}
          className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-mono bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors shrink-0"
        >
          + Test Process
        </button>
      </div>

      {/* Claude task input area */}
      {showClaudeInput && (
        <div className="px-3 py-2 bg-zinc-900/70 border-b border-zinc-800 space-y-2">
          <input
            type="text"
            value={claudeProjectDir}
            onChange={(e) => setClaudeProjectDir(e.target.value)}
            placeholder="Project directory (e.g., /Users/you/project)"
            className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
          />
          <div className="flex gap-2">
            <input
              type="text"
              value={claudePrompt}
              onChange={(e) => setClaudePrompt(e.target.value)}
              placeholder="Enter prompt for Claude Code..."
              className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSpawnClaude();
                }
              }}
            />
            <button
              onClick={handleSpawnClaude}
              disabled={isClaudeRunning || !claudePrompt.trim() || !claudeProjectDir.trim()}
              className="px-4 py-1.5 text-xs rounded bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Run
            </button>
            <button
              onClick={() => setShowClaudeInput(false)}
              className="px-3 py-1.5 text-xs rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

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
            No processes running. Click "+ Claude Task" or "+ Test Process" to start.
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
