import { useCallback, useState, useEffect, useMemo } from 'react';
import { useProcessStore, type ProcessStatus } from '../../hooks/useProcess';
import { useTaskDispatch } from '../../hooks/useTaskDispatch';
import { commands } from '../../bindings';
import type { RoutingSuggestion } from '../../bindings';
import type { ToolName, OrchestratorConfig, AgentContextInfo } from '../../stores/taskStore';
import { useTaskStore } from '../../stores/taskStore';
import { OutputConsole } from './OutputConsole';
import { PromptPreview } from '../prompt/PromptPreview';
import { AgentSelector } from '../orchestration/AgentSelector';
import { MultiAgentOutput } from '../orchestration/MultiAgentOutput';
import { ContextInfoPanel } from '../orchestration/ContextInfoPanel';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

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

const TOOL_LABEL: Record<ToolName, string> = {
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  codex: 'Codex CLI',
};

const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  agents: [{ toolName: 'claude', subAgentCount: 1, isMaster: true }],
  masterAgent: 'claude',
};

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

  const { suggestTool, dispatchTask, dispatchOrchestratedTask, isToolBusy } = useTaskDispatch();

  const agentContexts = useTaskStore((s) => s.agentContexts);

  const [taskPrompt, setTaskPrompt] = useState('');
  const [showTaskInput, setShowTaskInput] = useState(false);
  const [suggestion, setSuggestion] = useState<RoutingSuggestion | null>(null);
  const [selectedTool, setSelectedTool] = useState<ToolName | null>(null);
  const [isDispatching, setIsDispatching] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // Orchestration state
  const [orchestratorConfig, setOrchestratorConfig] = useState<OrchestratorConfig>(DEFAULT_ORCHESTRATOR_CONFIG);
  const [multiAgentTaskIds, setMultiAgentTaskIds] = useState<Map<ToolName, string>>(new Map());

  // API key status
  const [apiKeyStatus, setApiKeyStatus] = useState<Record<ToolName, boolean | null>>({
    claude: null,
    gemini: null,
    codex: null,
  });

  useEffect(() => {
    const checkKeys = async () => {
      const [claudeResult, geminiResult, codexResult] = await Promise.allSettled([
        commands.hasClaudeApiKey(),
        commands.hasGeminiApiKey(),
        commands.hasCodexApiKey(),
      ]);

      setApiKeyStatus({
        claude: claudeResult.status === 'fulfilled' && claudeResult.value.status === 'ok'
          ? claudeResult.value.data
          : false,
        gemini: geminiResult.status === 'fulfilled' && geminiResult.value.status === 'ok'
          ? geminiResult.value.data
          : false,
        codex: codexResult.status === 'fulfilled' && codexResult.value.status === 'ok'
          ? codexResult.value.data
          : false,
      });
    };
    checkKeys();
  }, []);

  const isMultiAgent = orchestratorConfig.agents.length > 1;

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

    setIsDispatching(true);

    if (isMultiAgent) {
      // Multi-agent orchestrated dispatch
      const results = await dispatchOrchestratedTask(
        taskPrompt.trim(),
        projectDir.trim(),
        orchestratorConfig,
      );
      setMultiAgentTaskIds(results);
    } else {
      // Single-agent dispatch
      const tool: ToolName = selectedTool ?? (suggestion?.suggested_tool as ToolName) ?? orchestratorConfig.agents[0]?.toolName ?? 'claude';
      await dispatchTask(taskPrompt.trim(), projectDir.trim(), tool);
    }

    setIsDispatching(false);
    setTaskPrompt('');
    setSuggestion(null);
    setSelectedTool(null);
    setShowTaskInput(false);
  }, [taskPrompt, projectDir, selectedTool, suggestion, dispatchTask, dispatchOrchestratedTask, isMultiAgent, orchestratorConfig]);

  const effectiveTool: ToolName = selectedTool ?? (suggestion?.suggested_tool as ToolName) ?? orchestratorConfig.agents[0]?.toolName ?? 'claude';
  const toolBusy = isMultiAgent
    ? orchestratorConfig.agents.some((a) => isToolBusy(a.toolName))
    : isToolBusy(effectiveTool);

  const processList = Array.from(processes.values());
  const activeProcess = activeProcessId ? processes.get(activeProcessId) : null;

  // Check if we have an active multi-agent session
  const hasMultiAgentOutput = multiAgentTaskIds.size > 1;

  // Typed agent contexts for ContextInfoPanel
  const typedContexts = useMemo(() => {
    const map = new Map<ToolName, AgentContextInfo>();
    for (const [key, val] of agentContexts.entries()) {
      map.set(key as ToolName, val);
    }
    return map;
  }, [agentContexts]);

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

        {/* Multi-agent view button */}
        {hasMultiAgentOutput && (
          <button
            onClick={() => setActiveProcess(null as unknown as string)}
            className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-mono bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors shrink-0"
          >
            Multi-Agent View
          </button>
        )}

        {/* New Task button */}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setShowTaskInput(!showTaskInput)}
          disabled={isDispatching}
          className="ml-auto bg-violet-900/30 text-violet-300 hover:bg-violet-800/40 hover:text-violet-200 font-mono text-xs shrink-0"
        >
          + New Task
        </Button>

        {/* Spawn test process button */}
        <Button
          variant="outline"
          size="sm"
          onClick={handleSpawnTest}
          className="font-mono text-xs shrink-0"
        >
          + Test Process
        </Button>
      </div>

      {/* Unified task input area */}
      {showTaskInput && (
        <div className="border-b border-zinc-800">
          {/* Agent selector */}
          <AgentSelector
            config={orchestratorConfig}
            onConfigChange={setOrchestratorConfig}
            apiKeyStatus={apiKeyStatus}
          />

          <div className="px-3 py-2 bg-zinc-900/70 space-y-2">
            <div className="flex gap-2">
              <Input
                type="text"
                value={taskPrompt}
                onChange={(e) => setTaskPrompt(e.target.value)}
                placeholder="Enter prompt for task..."
                className="flex-1 h-8 text-xs"
                onBlur={() => { if (!isMultiAgent) handleSuggest(); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (isMultiAgent || suggestion) {
                      handleDispatch();
                    } else {
                      handleSuggest();
                    }
                  }
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowPreview(!showPreview)}
              >
                Preview
              </Button>
              <Button
                size="sm"
                onClick={handleDispatch}
                disabled={isDispatching || !taskPrompt.trim() || !projectDir.trim() || toolBusy}
                className="bg-violet-600 text-white hover:bg-violet-500"
              >
                {isMultiAgent ? 'Run All' : 'Run'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setShowTaskInput(false);
                  setSuggestion(null);
                  setSelectedTool(null);
                  setTaskPrompt('');
                }}
              >
                Cancel
              </Button>
            </div>

            {/* Tool suggestion and override (single-agent mode only) */}
            {!isMultiAgent && suggestion && (
              <div className="flex items-center gap-3">
                <span className="text-xs text-zinc-500">
                  Suggested: <span className="text-zinc-300">{TOOL_LABEL[suggestion.suggested_tool as ToolName] ?? suggestion.suggested_tool}</span>
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
                  <button
                    onClick={() => setSelectedTool(selectedTool === 'codex' && suggestion.suggested_tool === 'codex' ? null : 'codex')}
                    className={`px-2 py-0.5 text-xs rounded transition-colors ${
                      effectiveTool === 'codex'
                        ? 'bg-emerald-600/40 text-emerald-300 border border-emerald-500/50'
                        : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
                    }`}
                  >
                    Codex
                  </button>
                </div>
              </div>
            )}

            {/* Tool busy warning */}
            {toolBusy && (
              <div className="text-xs text-yellow-400">
                {isMultiAgent
                  ? 'One or more selected agents are currently busy.'
                  : `${TOOL_LABEL[effectiveTool]} is currently busy. Wait for it to finish or select another tool.`
                }
              </div>
            )}

            {/* Prompt preview panel */}
            <PromptPreview
              prompt={taskPrompt}
              projectDir={projectDir}
              visible={showPreview}
              onClose={() => setShowPreview(false)}
            />
          </div>
        </div>
      )}

      {/* Context info panel */}
      {typedContexts.size > 0 && (
        <ContextInfoPanel
          contexts={typedContexts}
          className="shrink-0 px-3 py-1 border-b border-zinc-800 bg-zinc-900/40"
        />
      )}

      {/* Control bar for active process (single-agent mode) */}
      {!hasMultiAgentOutput && activeProcess && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900/50 border-b border-zinc-800 shrink-0">
          <span className="text-xs text-zinc-500 font-mono truncate flex-1">
            {activeProcess.cmd}
          </span>
          <span className="text-xs text-zinc-500">
            {statusLabel(activeProcess.status)}
          </span>

          {activeProcess.status === 'running' && (
            <>
              <Button
                variant="outline"
                size="xs"
                onClick={() => pauseProcess(activeProcess.taskId)}
                className="bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/30 border-yellow-600/30"
              >
                Pause
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={() => cancelProcess(activeProcess.taskId)}
                className="bg-red-600/20 text-red-400 hover:bg-red-600/30 border-red-600/30"
              >
                Cancel
              </Button>
            </>
          )}

          {activeProcess.status === 'paused' && (
            <>
              <Button
                variant="outline"
                size="xs"
                onClick={() => resumeProcess(activeProcess.taskId)}
                className="bg-green-600/20 text-green-400 hover:bg-green-600/30 border-green-600/30"
              >
                Resume
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={() => cancelProcess(activeProcess.taskId)}
                className="bg-red-600/20 text-red-400 hover:bg-red-600/30 border-red-600/30"
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      )}

      {/* Output area */}
      <div className="flex-1 min-h-0 relative">
        {hasMultiAgentOutput && !activeProcessId ? (
          /* Multi-agent split/tabbed view */
          <MultiAgentOutput taskIds={multiAgentTaskIds} />
        ) : processList.length === 0 ? (
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
