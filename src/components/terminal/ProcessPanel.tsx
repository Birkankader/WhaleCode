import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CircleDot,
  Pause,
  Play,
  Send,
  StopCircle,
} from 'lucide-react';
import type { RoutingSuggestion } from '../../bindings';
import { commands } from '../../bindings';
import { ActivityPanel } from '../activity/ActivityPanel';
import { AgentSelector } from '../orchestration/AgentSelector';
import { ContextInfoPanel } from '../orchestration/ContextInfoPanel';
import { Button } from '../ui/button';
import { useAgentDetection } from '../../hooks/useAgentDetection';
import {
  emitLocalProcessMessage,
  useProcessStore,
  type ProcessInfo,
  type ProcessStatus,
} from '../../hooks/useProcess';
import { useTaskDispatch } from '../../hooks/useTaskDispatch';
import {
  useTaskStore,
  type AgentContextInfo,
  type OrchestratorConfig,
  type ToolName,
} from '../../stores/taskStore';
import { useMessengerStore } from '../../stores/messengerStore';
import { useUIStore } from '../../stores/uiStore';
import { OutputConsole } from './OutputConsole';

const TOOL_LABEL: Record<ToolName, string> = {
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  codex: 'Codex CLI',
};

const TOOL_SHORT_LABEL: Record<ToolName, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
};

const TOOL_TINT: Record<ToolName, string> = {
  claude: 'border-violet-400/20 bg-violet-500/10 text-violet-100',
  gemini: 'border-sky-400/20 bg-sky-500/10 text-sky-100',
  codex: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100',
};

const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  agents: [{ toolName: 'claude', subAgentCount: 1, isMaster: true }],
  masterAgent: 'claude',
};

type UISettingKey = 'developerMode' | 'autoMerge' | 'codeReview';

interface ProcessPanelProps {
  projectDir: string;
}

function inferToolName(cmd: string): ToolName | null {
  if (cmd.startsWith('claude:')) return 'claude';
  if (cmd.startsWith('gemini:')) return 'gemini';
  if (cmd.startsWith('codex:')) return 'codex';
  return null;
}

function statusTone(status: ProcessStatus): { dot: string; badge: string; label: string } {
  switch (status) {
    case 'running':
      return {
        dot: 'bg-amber-400',
        badge: 'border-amber-400/20 bg-amber-500/10 text-amber-100',
        label: 'Working',
      };
    case 'paused':
      return {
        dot: 'bg-slate-400',
        badge: 'border-slate-400/20 bg-slate-500/10 text-slate-100',
        label: 'Paused',
      };
    case 'completed':
      return {
        dot: 'bg-emerald-400',
        badge: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100',
        label: 'Done',
      };
    case 'failed':
      return {
        dot: 'bg-rose-400',
        badge: 'border-rose-400/20 bg-rose-500/10 text-rose-100',
        label: 'Failed',
      };
  }
}

function SetupSummaryPanel({
  config,
}: {
  config: OrchestratorConfig;
}) {
  const workerEntries = config.agents
    .filter((agent) => !agent.isMaster)
    .map((agent, index) => `${agent.toolName}-worker-${index + 1}`);
  const workerCount = config.agents.reduce((sum, agent) => sum + agent.subAgentCount, 0);

  return (
    <section className="flex h-full flex-col rounded-[24px] border border-white/8 bg-[#090b16]/90">
      <div className="border-b border-white/8 px-5 py-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-violet-300/90">
          Orchestra Summary
        </div>
      </div>

      <div className="space-y-5 p-5">
        <div className="rounded-[20px] border border-white/8 bg-white/[0.02] p-4">
          <div className="text-sm font-semibold text-white">Git Worktrees</div>
          <div className="mt-3 space-y-2 text-sm text-slate-400">
            {workerEntries.length === 0 ? (
              <div>No worker branches selected yet.</div>
            ) : (
              workerEntries.map((entry) => (
                <div key={entry} className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-violet-400" />
                  <span>{entry}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-[20px] border border-white/8 bg-white/[0.02] p-4">
          <div className="text-sm font-semibold text-white">Settings</div>
          <div className="mt-3 space-y-2.5 text-sm text-slate-400">
            {([
              ['Developer Mode', 'developerMode'],
              ['Auto Merge', 'autoMerge'],
              ['Code Review', 'codeReview'],
            ] as const).map(([label, storeKey]) => (
              <SetupSettingToggle key={label} label={label} storeKey={storeKey} />
            ))}
          </div>
        </div>

        <div className="rounded-[20px] border border-white/8 bg-white/[0.02] p-4">
          <div className="text-sm font-semibold text-white">Estimated Resources</div>
          <div className="mt-3 space-y-2 text-sm text-slate-400">
            <div className="flex items-center justify-between">
              <span>Workers</span>
              <span className="text-white">{workerCount} instances</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Worktrees</span>
              <span className="text-white">{workerEntries.length} branches</span>
            </div>
            <div className="flex items-center justify-between">
              <span>PRs</span>
              <span className="text-white">{workerEntries.length > 0 ? `~${workerEntries.length} expected` : '--'}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SetupSettingToggle({
  label,
  storeKey,
}: {
  label: string;
  storeKey: UISettingKey;
}) {
  const value = useUIStore((state) => state[storeKey]);
  const setter = useUIStore((state) => {
    switch (storeKey) {
      case 'autoMerge':
        return state.setAutoMerge;
      case 'codeReview':
        return state.setCodeReview;
      default:
        return state.setDeveloperMode;
    }
  });

  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => setter(!value)}
      className="flex w-full items-center justify-between rounded-[14px] border border-white/6 bg-white/[0.015] px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
    >
      <span className="text-[13px] text-slate-300">{label}</span>
      <span
        className={`relative inline-flex h-5 w-8.5 items-center rounded-full border transition-colors ${
          value ? 'border-violet-400/34 bg-violet-500/22' : 'border-white/10 bg-white/[0.04]'
        }`}
      >
        <span
          className={`inline-block size-3 rounded-full bg-white transition-transform ${
            value ? 'translate-x-[1.05rem]' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}

function SetupCenterPanel({
  projectDir,
  config,
  taskPrompt,
  setTaskPrompt,
  onSubmit,
  isDispatching,
  disabled,
  suggestion,
  selectedTool,
  setSelectedTool,
  effectiveTool,
  toolBusy,
  submitShortcutLabel,
}: {
  projectDir: string;
  config: OrchestratorConfig;
  taskPrompt: string;
  setTaskPrompt: (value: string) => void;
  onSubmit: () => void;
  isDispatching: boolean;
  disabled: boolean;
  suggestion: RoutingSuggestion | null;
  selectedTool: ToolName | null;
  setSelectedTool: (tool: ToolName | null) => void;
  effectiveTool: ToolName;
  toolBusy: boolean;
  submitShortcutLabel: string;
}) {
  const master = config.agents.find((agent) => agent.isMaster) ?? config.agents[0];
  const workers = config.agents.filter((agent) => !agent.isMaster);
  const totalWorkers = config.agents.reduce((sum, agent) => sum + agent.subAgentCount, 0);

  return (
    <section className="flex h-full flex-col rounded-[24px] border border-white/8 bg-[#090b16]/90">
      <div className="px-8 py-7">
        <h1 className="text-[2.1rem] font-semibold tracking-tight text-white">New Orchestration</h1>
        <p className="mt-3 text-[1.05rem] leading-8 text-slate-400">
          Configure your master conductor and worker agents, then describe your task.
        </p>
      </div>

      <div className="space-y-8 px-8 pb-8">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-violet-300/90">
            Task Description
          </div>
          <div className="mt-5 rounded-[22px] border border-violet-400/18 bg-[#101223] px-6 py-6 shadow-[0_0_0_1px_rgba(99,102,241,0.12)]">
            <textarea
              value={taskPrompt}
              onChange={(event) => setTaskPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  onSubmit();
                }
              }}
              rows={4}
              placeholder="Build a full-stack task management app with React frontend and Node.js API. Include user auth, CRUD for tasks, real-time updates, and responsive mobile design."
              className="min-h-[220px] w-full resize-none bg-transparent text-[1.05rem] leading-9 text-white outline-none placeholder:text-slate-500"
            />
          </div>
          <div className="mt-2 text-xs text-slate-500">
            Press {submitShortcutLabel} + Enter to launch.
          </div>
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-violet-300/90">
            Conductor (Master Agent)
          </div>
          <div className="mt-4 rounded-[22px] border border-violet-400/28 bg-[#101223] p-5 shadow-[0_0_0_1px_rgba(99,102,241,0.14)]">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="flex size-16 items-center justify-center rounded-[20px] bg-[linear-gradient(135deg,#6d5efc_0%,#8b5cf6_100%)] text-lg font-semibold text-white">
                  {TOOL_SHORT_LABEL[master.toolName].charAt(0)}
                </div>
                <div>
                  <div className="text-[1.15rem] font-semibold text-white">
                    {TOOL_LABEL[master.toolName]}
                  </div>
                  <div className="mt-1 text-sm text-slate-400">
                    {master.toolName} master · {master.subAgentCount} worker lane{master.subAgentCount > 1 ? 's' : ''}
                  </div>
                  <div className="mt-2 text-sm text-violet-200/80">
                    Will decompose tasks and orchestrate all workers.
                  </div>
                </div>
              </div>
              <div className="rounded-full border border-violet-400/20 bg-violet-500/14 px-4 py-2 text-sm font-semibold text-violet-100">
                Conductor
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-violet-300/90">
              Worker Agents
            </div>
            <div className="text-sm text-slate-500">
              {totalWorkers} total instances
            </div>
          </div>
          <div className="mt-4 space-y-3">
            {workers.length === 0 ? (
              <div className="rounded-[18px] border border-dashed border-white/10 px-4 py-6 text-sm text-slate-500">
                Add at least one worker from the Discovered Agents panel.
              </div>
            ) : (
              workers.map((worker) => (
                <div key={worker.toolName} className="flex items-center justify-between rounded-[18px] border border-white/8 bg-[#101223] px-5 py-4">
                  <div>
                    <div className="text-lg font-semibold text-white">
                      {TOOL_LABEL[worker.toolName]}
                    </div>
                    <div className="mt-1 text-sm text-slate-500">
                      {worker.toolName} · {worker.subAgentCount} worker lane{worker.subAgentCount > 1 ? 's' : ''}
                    </div>
                  </div>
                  <div className={`rounded-full border px-2.5 py-0.5 text-xs ${TOOL_TINT[worker.toolName]}`}>
                    x{worker.subAgentCount}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {suggestion && (
          <div className="rounded-[18px] border border-white/8 bg-white/[0.02] px-4 py-4">
            <div className="text-sm text-slate-300">
              Suggested tool: <span className="font-semibold text-white">{TOOL_LABEL[suggestion.suggested_tool as ToolName] ?? suggestion.suggested_tool}</span>
              {suggestion.reason ? <span className="text-slate-500"> · {suggestion.reason}</span> : null}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {(['claude', 'gemini', 'codex'] as ToolName[]).map((toolName) => (
                <button
                  key={toolName}
                  onClick={() => setSelectedTool(selectedTool === toolName && suggestion.suggested_tool === toolName ? null : toolName)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    effectiveTool === toolName
                      ? 'border-violet-400/24 bg-violet-500/14 text-violet-100'
                      : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.06]'
                  }`}
                >
                  {TOOL_LABEL[toolName]}
                </button>
              ))}
            </div>
          </div>
        )}

        {toolBusy && (
          <div className="rounded-[18px] border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            One or more selected agents are already busy.
          </div>
        )}

        <Button
          onClick={onSubmit}
          disabled={disabled}
          className="h-13 w-full rounded-[18px] bg-[linear-gradient(90deg,#6d5efc_0%,#8b5cf6_100%)] px-5 text-base font-semibold text-white shadow-[0_16px_36px_rgba(109,94,252,0.28)] hover:brightness-110"
        >
          <Play className="size-4" />
          {isDispatching
            ? 'Launching...'
            : `Launch Orchestra (${totalWorkers} worker${totalWorkers === 1 ? '' : 's'})`}
        </Button>

        <div className="text-xs text-slate-500">
          {projectDir
            ? 'Workspace connected. You can change it from the header at any time.'
            : 'Choose a workspace from the header before starting.'}
        </div>
      </div>
    </section>
  );
}

function ActiveSessionsRail({
  processes,
  activeProcess,
  setActiveProcess,
  removeProcess,
}: {
  processes: ProcessInfo[];
  activeProcess: ProcessInfo | null;
  setActiveProcess: (taskId: string) => void;
  removeProcess: (taskId: string) => void;
}) {
  return (
    <section className="flex h-full flex-col rounded-[24px] border border-white/8 bg-[#090b16]/90">
      <div className="border-b border-white/8 px-5 py-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-violet-300/90">
          Active Agents
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-3">
          {processes.map((process) => {
            const tone = statusTone(process.status);
            const toolName = inferToolName(process.cmd);
            return (
              <button
                key={process.taskId}
                onClick={() => setActiveProcess(process.taskId)}
                className={`w-full rounded-[20px] border p-4 text-left transition-all ${
                  activeProcess?.taskId === process.taskId
                    ? 'border-violet-400/34 bg-[#121228] shadow-[0_0_0_1px_rgba(99,102,241,0.18)]'
                    : 'border-white/8 bg-[#0b0d18]/92 hover:bg-white/[0.03]'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[1.05rem] font-semibold text-white">
                      {toolName ? TOOL_LABEL[toolName] : process.cmd}
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-sm text-slate-500">
                      <span className={`size-2.5 rounded-full ${tone.dot}`} />
                      <span>{tone.label}</span>
                    </div>
                    <div className="mt-3 truncate font-mono text-sm text-slate-600">
                      {process.lastOutputPreview}
                    </div>
                  </div>

                  {(process.status === 'completed' || process.status === 'failed') && (
                    <span
                      onClick={(event) => {
                        event.stopPropagation();
                        removeProcess(process.taskId);
                      }}
                      className="rounded-full px-2 py-1 text-xs text-slate-500 hover:bg-white/[0.05] hover:text-slate-200"
                    >
                      x
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ActiveComposer({
  taskPrompt,
  setTaskPrompt,
  onSubmit,
  canSendFollowUp,
  isDispatching,
  submitShortcutLabel,
}: {
  taskPrompt: string;
  setTaskPrompt: (value: string) => void;
  onSubmit: () => void;
  canSendFollowUp: boolean;
  isDispatching: boolean;
  submitShortcutLabel: string;
}) {
  return (
    <section className="rounded-[24px] border border-white/8 bg-[#090b16]/90">
      <div className="border-b border-white/8 px-5 py-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-violet-300/90">
          Developer Mode
        </div>
        <div className="mt-1 text-sm text-slate-400">
          Type directly to the active agent and mirror the conversation in the output console.
        </div>
      </div>

      <div className="space-y-4 p-4">
        <textarea
          value={taskPrompt}
          onChange={(event) => setTaskPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              onSubmit();
            }
          }}
          rows={3}
          placeholder={canSendFollowUp ? 'Type a prompt or instruction...' : 'Start a new task...'}
          className="min-h-[120px] w-full resize-none rounded-[20px] border border-white/8 bg-[#0b0d18]/92 px-4 py-4 text-base leading-8 text-white outline-none placeholder:text-slate-500"
        />
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-slate-500">
            Press {submitShortcutLabel} + Enter to send.
          </div>
          <Button
            onClick={onSubmit}
            disabled={isDispatching || !taskPrompt.trim()}
            className="rounded-[16px] bg-[linear-gradient(90deg,#6d5efc_0%,#8b5cf6_100%)] px-5 text-white hover:brightness-110"
          >
            <Send className="size-4" />
            {canSendFollowUp ? 'Send' : isDispatching ? 'Starting...' : 'Start Task'}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function ProcessPanel({ projectDir }: ProcessPanelProps) {
  const processes = useProcessStore((s) => s.processes);
  const activeProcessId = useProcessStore((s) => s.activeProcessId);
  const setActiveProcess = useProcessStore((s) => s.setActiveProcess);
  const cancelProcess = useProcessStore((s) => s.cancelProcess);
  const pauseProcess = useProcessStore((s) => s.pauseProcess);
  const resumeProcess = useProcessStore((s) => s.resumeProcess);

  const { suggestTool, dispatchTask, dispatchOrchestratedTask, isToolBusy } = useTaskDispatch();
  const { agents: detectedAgents, loading: detectionLoading } = useAgentDetection();
  const activePlan = useTaskStore((s) => s.activePlan);
  const agentContexts = useTaskStore((s) => s.agentContexts);

  const [taskPrompt, setTaskPrompt] = useState('');
  const [suggestion, setSuggestion] = useState<RoutingSuggestion | null>(null);
  const [selectedTool, setSelectedTool] = useState<ToolName | null>(null);
  const [isDispatching, setIsDispatching] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [orchestratorConfig, setOrchestratorConfig] = useState<OrchestratorConfig>(DEFAULT_ORCHESTRATOR_CONFIG);

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

    void checkKeys();
  }, []);

  const processList = useMemo(
    () => Array.from(processes.values()).sort((left, right) => right.startedAt - left.startedAt),
    [processes],
  );

  useEffect(() => {
    if (!activeProcessId && processList.length > 0) {
      setActiveProcess(processList[0].taskId);
    }
  }, [activeProcessId, processList, setActiveProcess]);

  const activeProcess = activeProcessId ? processes.get(activeProcessId) ?? processList[0] ?? null : processList[0] ?? null;
  const isMultiAgent = orchestratorConfig.agents.length > 1;
  const hasActiveRunningProcess = useMemo(
    () => processList.some((process) => process.status === 'running'),
    [processList],
  );

  const canSendFollowUp = hasActiveRunningProcess && (!isMultiAgent || Boolean(activePlan?.master_process_id));
  const submitShortcutLabel =
    typeof navigator !== 'undefined' && navigator.platform.includes('Mac')
      ? 'Cmd'
      : 'Ctrl';

  const typedContexts = useMemo(() => {
    const map = new Map<ToolName, AgentContextInfo>();
    for (const [key, value] of agentContexts.entries()) {
      map.set(key as ToolName, value);
    }
    return map;
  }, [agentContexts]);

  const handleClear = useCallback(async () => {
    const plan = useTaskStore.getState().activePlan;
    if (!plan?.task_id) return;

    setIsClearing(true);
    try {
      await commands.clearOrchestrationContext(plan.task_id, projectDir);
      useMessengerStore.getState().clearMessages();
      useTaskStore.getState().setActivePlan(null);
      useTaskStore.getState().setOrchestrationPlan(null);
    } catch (error) {
      console.error('Clear failed:', error);
    } finally {
      setIsClearing(false);
    }
  }, [projectDir]);

  const handleSubmit = useCallback(async () => {
    const trimmedPrompt = taskPrompt.trim();
    if (!trimmedPrompt) return;

    if (trimmedPrompt === '/clear') {
      await handleClear();
      setTaskPrompt('');
      return;
    }

    if (canSendFollowUp) {
      const targetId = isMultiAgent
        ? activePlan?.master_process_id ?? null
        : activeProcess?.taskId ?? null;

      if (targetId) {
        try {
          await commands.sendToProcess(targetId, trimmedPrompt);
          emitLocalProcessMessage(targetId, `$ ${trimmedPrompt}`);
          setTaskPrompt('');
        } catch (error) {
          console.error('Failed to send to process:', error);
          emitLocalProcessMessage(targetId, `Failed to send input: ${String(error)}`, 'error');
        }
      }
      return;
    }

    if (hasActiveRunningProcess || !projectDir.trim()) return;

    setIsDispatching(true);
    try {
      if (isMultiAgent) {
        await dispatchOrchestratedTask(trimmedPrompt, projectDir.trim(), orchestratorConfig);
      } else {
        const tool: ToolName =
          selectedTool ??
          orchestratorConfig.agents[0]?.toolName ??
          (suggestion?.suggested_tool as ToolName) ??
          'claude';
        await dispatchTask(trimmedPrompt, projectDir.trim(), tool);
      }

      setTaskPrompt('');
      setSuggestion(null);
      setSelectedTool(null);
    } finally {
      setIsDispatching(false);
    }
  }, [
    activePlan?.master_process_id,
    activeProcess,
    canSendFollowUp,
    dispatchOrchestratedTask,
    dispatchTask,
    handleClear,
    hasActiveRunningProcess,
    isMultiAgent,
    orchestratorConfig,
    projectDir,
    selectedTool,
    suggestion?.suggested_tool,
    taskPrompt,
  ]);

  const effectiveTool: ToolName =
    selectedTool ??
    orchestratorConfig.agents[0]?.toolName ??
    (suggestion?.suggested_tool as ToolName) ??
    'claude';

  const toolBusy = isMultiAgent
    ? orchestratorConfig.agents.some((agent) => isToolBusy(agent.toolName))
    : isToolBusy(effectiveTool);

  const showSetup = processList.length === 0;

  useEffect(() => {
    if (!showSetup || !taskPrompt.trim() || isMultiAgent) return;
    const timeout = setTimeout(() => {
      void suggestTool(taskPrompt.trim()).then((result) => {
        setSuggestion(result);
        setSelectedTool(null);
      });
    }, 350);

    return () => clearTimeout(timeout);
  }, [isMultiAgent, showSetup, suggestTool, taskPrompt]);

  if (showSetup) {
    return (
      <div className="grid h-full min-h-0 gap-6 px-6 pb-6 pt-5 xl:grid-cols-[340px_minmax(0,1fr)_300px]">
        <section className="min-h-0 overflow-hidden rounded-[24px] border border-white/8 bg-[#090b16]/90">
          <AgentSelector
            config={orchestratorConfig}
            onConfigChange={setOrchestratorConfig}
            apiKeyStatus={apiKeyStatus}
            detectedAgents={detectedAgents}
            detectionLoading={detectionLoading}
          />
        </section>

        <SetupCenterPanel
          projectDir={projectDir}
          config={orchestratorConfig}
          taskPrompt={taskPrompt}
          setTaskPrompt={setTaskPrompt}
          onSubmit={() => void handleSubmit()}
          isDispatching={isDispatching}
          disabled={isDispatching || !taskPrompt.trim() || !projectDir.trim()}
          suggestion={suggestion}
          selectedTool={selectedTool}
          setSelectedTool={setSelectedTool}
          effectiveTool={effectiveTool}
          toolBusy={toolBusy}
          submitShortcutLabel={submitShortcutLabel}
        />

        <SetupSummaryPanel config={orchestratorConfig} />
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 gap-6 px-6 pb-6 pt-5 xl:grid-cols-[280px_minmax(0,1fr)_300px]">
      <ActiveSessionsRail
        processes={processList}
        activeProcess={activeProcess}
        setActiveProcess={(taskId) => setActiveProcess(taskId)}
        removeProcess={(taskId) => {
          useProcessStore.getState()._removeProcess(taskId);
          useTaskStore.getState().removeTask(taskId);
        }}
      />

      <div className="flex min-h-0 flex-col gap-6">
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-white/8 bg-[#090b16]/90">
          <div className="flex items-center justify-between gap-4 border-b border-white/8 px-5 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-violet-300/90">
                <span>Agent Terminals</span>
              </div>
              {activeProcess && (
                <div className="mt-2 text-[1.05rem] font-semibold text-white">
                  {activeProcess.cmd}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {activeProcess && (
                <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs ${statusTone(activeProcess.status).badge}`}>
                  <CircleDot className="size-4" />
                  {statusTone(activeProcess.status).label}
                </span>
              )}
              {activePlan?.task_id && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleClear()}
                  disabled={isClearing}
                  className="rounded-full border-white/10 bg-white/[0.03] text-slate-100 hover:bg-white/[0.08]"
                >
                  {isClearing ? 'Clearing...' : 'Backup & Clear'}
                </Button>
              )}
            </div>
          </div>

          {typedContexts.size > 0 && (
            <ContextInfoPanel
              contexts={typedContexts}
              className="flex-wrap gap-2 border-b border-white/8 px-4 py-3"
            />
          )}

          {activeProcess && (
            <div className="flex items-center justify-between gap-4 border-b border-white/8 bg-black/20 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-white">
                  {activeProcess.lastOutputPreview}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Streaming directly to output. Incoming replies will appear here.
                </div>
              </div>

              <div className="flex items-center gap-2">
                {activeProcess.status === 'running' && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void pauseProcess(activeProcess.taskId)}
                      className="rounded-full border-white/10 bg-white/[0.03] text-slate-100 hover:bg-white/[0.08]"
                    >
                      <Pause className="size-4" />
                      Pause
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void cancelProcess(activeProcess.taskId)}
                      className="rounded-full border-rose-400/20 bg-rose-500/10 text-rose-100 hover:bg-rose-500/16"
                    >
                      <StopCircle className="size-4" />
                      Stop
                    </Button>
                  </>
                )}

                {activeProcess.status === 'paused' && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void resumeProcess(activeProcess.taskId)}
                      className="rounded-full border-emerald-400/20 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/16"
                    >
                      <Play className="size-4" />
                      Resume
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void cancelProcess(activeProcess.taskId)}
                      className="rounded-full border-rose-400/20 bg-rose-500/10 text-rose-100 hover:bg-rose-500/16"
                    >
                      <StopCircle className="size-4" />
                      Stop
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="min-h-0 flex-1 bg-black">
            {activeProcess ? (
              <OutputConsole processId={activeProcess.taskId} />
            ) : (
              <div className="flex h-full items-center justify-center text-slate-500">
                Select an active process.
              </div>
            )}
          </div>
        </section>

        <ActiveComposer
          taskPrompt={taskPrompt}
          setTaskPrompt={setTaskPrompt}
          onSubmit={() => void handleSubmit()}
          canSendFollowUp={canSendFollowUp}
          isDispatching={isDispatching}
          submitShortcutLabel={submitShortcutLabel}
        />
      </div>

      <ActivityPanel className="min-h-0" />
    </div>
  );
}
