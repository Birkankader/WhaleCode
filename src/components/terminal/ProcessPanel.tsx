import { useCallback, useState } from 'react';
import { useProcessStore, type ProcessStatus } from '../../hooks/useProcess';
import { useTaskDispatch } from '../../hooks/useTaskDispatch';
import type { RoutingSuggestion } from '../../bindings';
import type { ToolName } from '../../stores/taskStore';
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

interface ProcessPanelProps {
  projectDir: string;
}

export function ProcessPanel({ projectDir }: ProcessPanelProps) {
  const processes = useProcessStore((s) => s.processes);
  const activeProcessId = useProcessStore((s) => s.activeProcessId);
  const setActiveProcess = useProcessStore((s) => s.setActiveProcess);
  const spawnProcess = useProcessStore((s) => s.spawnProcess);
  const cancelProcess = useProcessStore((s) => s.cancelProcess);
  const pauseProcess = useProcessStore((s) => s.pauseProcess);
  const resumeProcess = useProcessStore((s) => s.resumeProcess);

  const { suggestTool, dispatchTask, isToolBusy } = useTaskDispatch();

  const [taskPrompt, setTaskPrompt] = useState('');
  const [showTaskInput, setShowTaskInput] = useState(false);
  const [suggestion, setSuggestion] = useState<RoutingSuggestion | null>(null);
  const [selectedTool, setSelectedTool] = useState<ToolName | null>(null);
  const [isDispatching, setIsDispatching] = useState(false);

  const handleSpawnTest = useCallback(async () => {
    await spawnProcess(
      '/bin/sh',
      ['-c', 'echo "hello" && sleep 5 && echo "done"'],
      '/tmp',
    );
  }, [spawnProcess]);

  const handleSuggest = useCallback(async () => {
    if (!taskPrompt.trim()) return;
    const result = await suggestTool(taskPrompt.trim());
    setSuggestion(result);
    setSelectedTool(null); // reset override on new suggestion
  }, [taskPrompt, suggestTool]);

  const handleDispatch = useCallback(async () => {
    if (!taskPrompt.trim() || !projectDir.trim()) return;
    const tool: ToolName = selectedTool ?? (suggestion?.suggested_tool as ToolName) ?? 'claude';

    setIsDispatching(true);
    await dispatchTask(taskPrompt.trim(), projectDir.trim(), tool);
    setIsDispatching(false);
    setTaskPrompt('');
    setSuggestion(null);
    setSelectedTool(null);
    setShowTaskInput(false);
  }, [taskPrompt, projectDir, selectedTool, suggestion, dispatchTask]);

  const effectiveTool: ToolName = selectedTool ?? (suggestion?.suggested_tool as ToolName) ?? 'claude';
  const toolBusy = isToolBusy(effectiveTool);

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

        {/* New Task button */}
        <button
          onClick={() => setShowTaskInput(!showTaskInput)}
          disabled={isDispatching}
          className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-mono bg-violet-900/30 text-violet-300 hover:bg-violet-800/40 hover:text-violet-200 disabled:opacity-50 transition-colors shrink-0 ml-auto"
        >
          + New Task
        </button>

        {/* Spawn test process button */}
        <button
          onClick={handleSpawnTest}
          className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-mono bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors shrink-0"
        >
          + Test Process
        </button>
      </div>

      {/* Unified task input area */}
      {showTaskInput && (
        <div className="px-3 py-2 bg-zinc-900/70 border-b border-zinc-800 space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={taskPrompt}
              onChange={(e) => setTaskPrompt(e.target.value)}
              placeholder="Enter prompt for task..."
              className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
              onBlur={handleSuggest}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (suggestion) {
                    handleDispatch();
                  } else {
                    handleSuggest();
                  }
                }
              }}
            />
            <button
              onClick={handleDispatch}
              disabled={isDispatching || !taskPrompt.trim() || !projectDir.trim() || toolBusy}
              className="px-4 py-1.5 text-xs rounded bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Run
            </button>
            <button
              onClick={() => {
                setShowTaskInput(false);
                setSuggestion(null);
                setSelectedTool(null);
                setTaskPrompt('');
              }}
              className="px-3 py-1.5 text-xs rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition-colors"
            >
              Cancel
            </button>
          </div>

          {/* Tool suggestion and override */}
          {suggestion && (
            <div className="flex items-center gap-3">
              <span className="text-xs text-zinc-500">
                Suggested: <span className="text-zinc-300">{suggestion.suggested_tool === 'claude' ? 'Claude Code' : 'Gemini CLI'}</span>
                {suggestion.reason && (
                  <span className="text-zinc-600"> — {suggestion.reason}</span>
                )}
              </span>
              <div className="flex gap-1 ml-auto">
                <button
                  onClick={() => setSelectedTool(selectedTool === 'claude' && suggestion.suggested_tool === 'claude' ? null : 'claude')}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    effectiveTool === 'claude'
                      ? 'bg-violet-600/40 text-violet-300 border border-violet-500/50'
                      : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
                  }`}
                >
                  Claude
                </button>
                <button
                  onClick={() => setSelectedTool(selectedTool === 'gemini' && suggestion.suggested_tool === 'gemini' ? null : 'gemini')}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    effectiveTool === 'gemini'
                      ? 'bg-blue-600/40 text-blue-300 border border-blue-500/50'
                      : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
                  }`}
                >
                  Gemini
                </button>
              </div>
            </div>
          )}

          {/* Tool busy warning */}
          {toolBusy && (
            <div className="text-xs text-yellow-400">
              {effectiveTool === 'claude' ? 'Claude Code' : 'Gemini CLI'} is currently busy. Wait for it to finish or select the other tool.
            </div>
          )}
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
            No processes running. Click &quot;+ New Task&quot; or &quot;+ Test Process&quot; to start.
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
