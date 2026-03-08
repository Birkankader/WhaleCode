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
import { MessengerPanel } from '../messenger/MessengerPanel';
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
  const cancelProcess = useProcessStore((s) => s.cancelProcess);
  const pauseProcess = useProcessStore((s) => s.pauseProcess);
  const resumeProcess = useProcessStore((s) => s.resumeProcess);

  const { suggestTool, dispatchTask, dispatchOrchestratedTask, isToolBusy } = useTaskDispatch();

  const agentContexts = useTaskStore((s) => s.agentContexts);

  const [taskPrompt, setTaskPrompt] = useState('');
  const [suggestion, setSuggestion] = useState<RoutingSuggestion | null>(null);
  const [selectedTool, setSelectedTool] = useState<ToolName | null>(null);
  const [isDispatching, setIsDispatching] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [activeView, setActiveView] = useState<'process' | 'messenger'>('process');

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

  const hasActiveRunningProcess = useMemo(() => {
    for (const proc of processes.values()) {
      if (proc.status === 'running') return true;
    }
    return false;
  }, [processes]);

  const handleSuggest = useCallback(async () => {
    if (!taskPrompt.trim()) return;
    const result = await suggestTool(taskPrompt.trim());
    setSuggestion(result);
    setSelectedTool(null);
  }, [taskPrompt, suggestTool]);

  const handleSubmit = useCallback(async () => {
    if (!taskPrompt.trim()) return;

    if (hasActiveRunningProcess) {
      // Send to active process stdin
      const targetId = isMultiAgent
        ? multiAgentTaskIds.get(orchestratorConfig.masterAgent as ToolName) ?? activeProcessId
        : activeProcessId;

      if (targetId) {
        try {
          await commands.sendToProcess(targetId, taskPrompt.trim());
          setTaskPrompt('');
        } catch (e) {
          console.error('Failed to send to process:', e);
        }
      }
    } else {
      // New task dispatch
      if (!projectDir.trim()) return;
      setIsDispatching(true);

      if (isMultiAgent) {
        const results = await dispatchOrchestratedTask(
          taskPrompt.trim(),
          projectDir.trim(),
          orchestratorConfig,
        );
        setMultiAgentTaskIds(results);
        // Auto-switch to Messenger for orchestrated tasks
        setActiveView('messenger');
      } else {
        const tool: ToolName = selectedTool ?? orchestratorConfig.agents[0]?.toolName ?? 'claude';
        await dispatchTask(taskPrompt.trim(), projectDir.trim(), tool);
      }

      setIsDispatching(false);
      setTaskPrompt('');
      setSuggestion(null);
      setSelectedTool(null);
    }
  }, [taskPrompt, projectDir, selectedTool, dispatchTask, dispatchOrchestratedTask, isMultiAgent, orchestratorConfig, hasActiveRunningProcess, activeProcessId, multiAgentTaskIds, processes]);

  const effectiveTool: ToolName = selectedTool ?? orchestratorConfig.agents[0]?.toolName ?? (suggestion?.suggested_tool as ToolName) ?? 'claude';
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
    <div className="flex flex-col h-full bg-transparent">
      {/* Tab bar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-black/20 backdrop-blur-md border-b border-white/5 overflow-x-auto shrink-0">
        {processList.map((proc) => (
          <button
            key={proc.taskId}
            onClick={() => { setActiveProcess(proc.taskId); setActiveView('process'); }}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-mono transition-all shadow-sm shrink-0 ${proc.taskId === activeProcessId && activeView === 'process'
              ? 'bg-violet-500/20 text-violet-200 border border-violet-500/30 shadow-violet-500/10'
              : 'bg-white/5 text-zinc-400 border border-white/5 hover:bg-white/10 hover:text-zinc-200 hover:border-white/10'
              }`}
            title={`${proc.cmd} - ${statusLabel(proc.status)}`}
          >
            <span className={`w-2 h-2 rounded-full ${statusColor(proc.status)}`} />
            <span className="max-w-[120px] truncate">{proc.cmd}</span>
            {proc.exitCode !== undefined && (
              <span className="text-zinc-500">({proc.exitCode})</span>
            )}
            {(proc.status === 'completed' || proc.status === 'failed') && (
              <span
                className="ml-1 text-zinc-600 hover:text-zinc-300 cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  useProcessStore.getState()._removeProcess(proc.taskId);
                  useTaskStore.getState().removeTask(proc.taskId);
                }}
              >
                x
              </span>
            )}
          </button>
        ))}

        {/* Multi-agent view button */}
        {hasMultiAgentOutput && (
          <button
            onClick={() => { setActiveProcess(null as unknown as string); setActiveView('process'); }}
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-mono bg-white/5 text-zinc-300 border border-white/5 hover:bg-white/10 hover:border-white/10 transition-all shadow-sm shrink-0"
          >
            Multi-Agent View
          </button>
        )}

        {/* Messenger tab */}
        <button
          onClick={() => setActiveView('messenger')}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-mono transition-all shadow-sm shrink-0 ${
            activeView === 'messenger'
              ? 'bg-amber-500/20 text-amber-200 border border-amber-500/30 shadow-amber-500/10'
              : 'bg-white/5 text-zinc-400 border border-white/5 hover:bg-white/10 hover:text-zinc-200 hover:border-white/10'
          }`}
        >
          Messenger
        </button>
      </div>

      {/* Context info panel */}
      {typedContexts.size > 0 && (
        <ContextInfoPanel
          contexts={typedContexts}
          className="shrink-0 px-4 py-2 border-b border-white/5 bg-black/20"
        />
      )}

      {/* Control bar for active process (single-agent mode) */}
      {activeView === 'process' && !hasMultiAgentOutput && activeProcess && (
        <div className="flex items-center gap-3 px-4 py-2 bg-black/20 backdrop-blur-md border-b border-white/5 shrink-0">
          <span className="text-xs text-zinc-400 font-mono truncate flex-1">
            {activeProcess.cmd}
          </span>
          <span className="text-xs text-zinc-500 font-medium">
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
        {activeView === 'messenger' ? (
          <MessengerPanel />
        ) : hasMultiAgentOutput && !activeProcessId ? (
          <MultiAgentOutput taskIds={multiAgentTaskIds} />
        ) : processList.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
            Enter a prompt below to start a task.
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

      {/* Persistent input bar */}
      <div className="border-t border-white/5 bg-black/40 backdrop-blur-xl shrink-0">
        <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-violet-500/20 to-transparent" />

        <AgentSelector
          config={orchestratorConfig}
          onConfigChange={setOrchestratorConfig}
          apiKeyStatus={apiKeyStatus}
        />

        <div className="px-4 py-3 space-y-3">
          <div className="flex gap-3">
            <Input
              type="text"
              value={taskPrompt}
              onChange={(e) => setTaskPrompt(e.target.value)}
              placeholder={hasActiveRunningProcess ? "Send follow-up message..." : "Enter prompt for task..."}
              className="flex-1 h-9 text-sm bg-black/40 border-white/10 text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-violet-500/50 rounded-lg shadow-inner transition-all"
              onBlur={() => { if (!isMultiAgent && !hasActiveRunningProcess) handleSuggest(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (hasActiveRunningProcess || isMultiAgent || suggestion) {
                    handleSubmit();
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
              className="bg-white/5 border-white/10 hover:bg-white/10 text-zinc-200 transition-colors rounded-lg h-9"
            >
              Preview
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={isDispatching || !taskPrompt.trim() || (!hasActiveRunningProcess && !projectDir.trim())}
              className="bg-violet-600 border border-violet-500/50 shadow-lg shadow-violet-500/20 text-white hover:bg-violet-500 transition-all rounded-lg h-9"
            >
              {hasActiveRunningProcess ? 'Send' : isMultiAgent ? 'Run All' : 'Run'}
            </Button>
          </div>

          {/* Tool suggestion and override (single-agent mode only, not when sending to stdin) */}
          {!isMultiAgent && !hasActiveRunningProcess && suggestion && (
            <div className="flex items-center gap-3">
              <span className="text-xs text-zinc-500">
                Suggested: <span className="text-zinc-300">{TOOL_LABEL[suggestion.suggested_tool as ToolName] ?? suggestion.suggested_tool}</span>
                {suggestion.reason && (
                  <span className="text-zinc-600"> -- {suggestion.reason}</span>
                )}
              </span>
              <div className="flex gap-1 ml-auto">
                <button
                  onClick={() => setSelectedTool(selectedTool === 'claude' && suggestion.suggested_tool === 'claude' ? null : 'claude')}
                  className={`px-3 py-1 text-xs rounded-md transition-all ${effectiveTool === 'claude'
                    ? 'bg-violet-500/20 text-violet-300 border border-violet-500/50 shadow-sm'
                    : 'bg-white/5 text-zinc-400 border border-white/5 hover:bg-white/10 hover:text-zinc-200'
                    }`}
                >
                  Claude
                </button>
                <button
                  onClick={() => setSelectedTool(selectedTool === 'gemini' && suggestion.suggested_tool === 'gemini' ? null : 'gemini')}
                  className={`px-3 py-1 text-xs rounded-md transition-all ${effectiveTool === 'gemini'
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/50 shadow-sm'
                    : 'bg-white/5 text-zinc-400 border border-white/5 hover:bg-white/10 hover:text-zinc-200'
                    }`}
                >
                  Gemini
                </button>
                <button
                  onClick={() => setSelectedTool(selectedTool === 'codex' && suggestion.suggested_tool === 'codex' ? null : 'codex')}
                  className={`px-3 py-1 text-xs rounded-md transition-all ${effectiveTool === 'codex'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-sm'
                    : 'bg-white/5 text-zinc-400 border border-white/5 hover:bg-white/10 hover:text-zinc-200'
                    }`}
                >
                  Codex
                </button>
              </div>
            </div>
          )}

          {/* Tool busy warning */}
          {!hasActiveRunningProcess && toolBusy && (
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
    </div>
  );
}
