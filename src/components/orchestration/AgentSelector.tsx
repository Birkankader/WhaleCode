import { useCallback } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { DetectedAgent } from '../../hooks/useAgentDetection';
import type { AgentConfig, OrchestratorConfig, ToolName } from '../../stores/taskStore';

const AGENT_META: Record<
  ToolName,
  {
    label: string;
    model: string;
    glyph: string;
    accent: string;
    accentBg: string;
    workerTone: string;
  }
> = {
  claude: {
    label: 'Claude Code',
    model: 'claude-opus-4-5',
    glyph: '●',
    accent: 'text-violet-200',
    accentBg: 'bg-[linear-gradient(135deg,#7c3aed_0%,#9333ea_100%)]',
    workerTone: 'border-violet-400/30 bg-violet-500/10 text-violet-100',
  },
  gemini: {
    label: 'Gemini CLI',
    model: 'gemini-2.5-pro',
    glyph: '●',
    accent: 'text-sky-200',
    accentBg: 'bg-[linear-gradient(135deg,#2563eb_0%,#0ea5e9_100%)]',
    workerTone: 'border-sky-400/30 bg-sky-500/10 text-sky-100',
  },
  codex: {
    label: 'Codex CLI',
    model: 'gpt-5-codex',
    glyph: '■',
    accent: 'text-emerald-200',
    accentBg: 'bg-[linear-gradient(135deg,#059669_0%,#10b981_100%)]',
    workerTone: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100',
  },
};

const ALL_TOOLS: ToolName[] = ['claude', 'gemini', 'codex'];

interface AgentSelectorProps {
  config: OrchestratorConfig;
  onConfigChange: (config: OrchestratorConfig) => void;
  apiKeyStatus: Record<ToolName, boolean | null>;
  detectedAgents?: DetectedAgent[];
  detectionLoading?: boolean;
}

function isAuthenticated(detection: DetectedAgent | undefined, apiKeyStatus: boolean | null) {
  if (detection) {
    return detection.installed && detection.auth_status === 'Authenticated';
  }
  return apiKeyStatus === true;
}

function availabilityText(detection: DetectedAgent | undefined, apiKeyStatus: boolean | null): string {
  if (detection?.installed === false) return 'not installed';
  if (isAuthenticated(detection, apiKeyStatus)) return 'Authenticated';
  if (detection?.auth_status === 'NeedsAuth' || apiKeyStatus === false) return 'Need Auth';
  return 'Checking';
}

export function AgentSelector({
  config,
  onConfigChange,
  apiKeyStatus,
  detectedAgents,
  detectionLoading,
}: AgentSelectorProps) {
  const getDetection = useCallback(
    (tool: ToolName) => detectedAgents?.find((agent) => agent.tool_name === tool),
    [detectedAgents],
  );

  const getConfig = useCallback(
    (tool: ToolName) => config.agents.find((agent) => agent.toolName === tool),
    [config.agents],
  );

  const ensureAgent = useCallback(
    (tool: ToolName) => {
      const existing = getConfig(tool);
      if (existing) return existing;
      return { toolName: tool, subAgentCount: 1, isMaster: false } satisfies AgentConfig;
    },
    [getConfig],
  );

  const upsertAgent = useCallback(
    (agent: AgentConfig) => {
      const existing = getConfig(agent.toolName);
      const agents = existing
        ? config.agents.map((entry) => (entry.toolName === agent.toolName ? agent : entry))
        : [...config.agents, agent];

      onConfigChange({
        ...config,
        agents,
      });
    },
    [config, getConfig, onConfigChange],
  );

  const setMaster = useCallback(
    (tool: ToolName) => {
      const nextAgents = ALL_TOOLS
        .map((name) => getConfig(name))
        .filter((entry): entry is AgentConfig => Boolean(entry))
        .map((entry) => ({
          ...entry,
          isMaster: entry.toolName === tool,
        }));

      const existing = nextAgents.find((entry) => entry.toolName === tool);
      const finalAgents = existing
        ? nextAgents
        : [...nextAgents, { toolName: tool, subAgentCount: 1, isMaster: true }];

      onConfigChange({
        masterAgent: tool,
        agents: finalAgents,
      });
    },
    [getConfig, onConfigChange],
  );

  const toggleWorker = useCallback(
    (tool: ToolName) => {
      const entry = ensureAgent(tool);
      upsertAgent({
        ...entry,
        isMaster: config.masterAgent === tool,
        subAgentCount: entry.subAgentCount || 1,
      });
    },
    [config.masterAgent, ensureAgent, upsertAgent],
  );

  const setWorkerCount = useCallback(
    (tool: ToolName, nextCount: number) => {
      const count = Math.max(1, Math.min(4, nextCount));
      const entry = ensureAgent(tool);
      upsertAgent({
        ...entry,
        isMaster: config.masterAgent === tool,
        subAgentCount: count,
      });
    },
    [config.masterAgent, ensureAgent, upsertAgent],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pb-4 pt-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-violet-300/90">
          Discovered Agents
        </div>
        <div className="mt-2 text-sm text-slate-500">
          {detectionLoading ? 'Scanning CLI tools...' : 'Choose your conductor and worker lanes.'}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <div className="space-y-4">
          {ALL_TOOLS.map((tool) => {
            const meta = AGENT_META[tool];
            const detection = getDetection(tool);
            const selected = getConfig(tool);
            const authenticated = isAuthenticated(detection, apiKeyStatus[tool]);
            const isMaster = config.masterAgent === tool;
            const workerCount = selected?.subAgentCount ?? 1;

            return (
              <div
                key={tool}
                className={`rounded-[24px] border px-5 py-5 transition-all ${
                  selected
                    ? 'border-violet-400/40 bg-[#121228] shadow-[0_0_0_1px_rgba(99,102,241,0.18)]'
                    : 'border-white/8 bg-[#0b0d18]/92'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className={`flex size-10 shrink-0 items-center justify-center rounded-2xl ${meta.accentBg} text-base text-white shadow-lg`}>
                      <span>{meta.glyph}</span>
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white">
                        {meta.label}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {detection?.version ?? meta.model}
                      </div>
                    </div>
                  </div>

                  <div
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      authenticated
                        ? 'bg-emerald-500/14 text-emerald-300'
                        : 'bg-amber-500/14 text-amber-300'
                    }`}
                  >
                    {availabilityText(detection, apiKeyStatus[tool])}
                  </div>
                </div>

                {authenticated ? (
                  <div className="mt-5 space-y-4">
                    <div className="flex gap-2">
                      <button
                        onClick={() => setMaster(tool)}
                        className={`flex-1 rounded-[14px] border px-3 py-2 text-[13px] font-medium transition-colors ${
                          isMaster
                            ? 'border-violet-400/40 bg-violet-500/18 text-white'
                            : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.06]'
                        }`}
                      >
                        {isMaster ? 'Master' : 'Set Master'}
                      </button>

                      <button
                        onClick={() => toggleWorker(tool)}
                        className={`flex-1 rounded-[14px] border px-3 py-2 text-[13px] font-medium transition-colors ${
                          selected
                            ? `${meta.workerTone}`
                            : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.06]'
                        }`}
                      >
                        {selected ? `Worker x${workerCount}` : '+ Worker'}
                      </button>
                    </div>

                    {selected && (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setWorkerCount(tool, workerCount - 1)}
                          className="flex size-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.06]"
                        >
                          <Minus className="size-3.5" />
                        </button>
                        <div className="min-w-12 text-center text-sm font-semibold text-white">
                          x{workerCount}
                        </div>
                        <button
                          onClick={() => setWorkerCount(tool, workerCount + 1)}
                          className="flex size-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.06]"
                        >
                          <Plus className="size-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    disabled
                    className="mt-5 w-full rounded-[14px] border border-amber-500/20 bg-amber-500/6 px-3 py-2 text-[13px] font-medium text-amber-300/80"
                  >
                    Login to use →
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
