import { useCallback } from 'react';
import { CheckSquare, Square, Circle } from 'lucide-react';
import type { ToolName, OrchestratorConfig, AgentConfig } from '../../stores/taskStore';

const AGENT_META: Record<ToolName, { label: string; color: string; activeColor: string; borderColor: string }> = {
  claude: {
    label: 'Claude',
    color: 'text-violet-400',
    activeColor: 'bg-violet-600/30 border-violet-500/50',
    borderColor: 'border-violet-500/30',
  },
  gemini: {
    label: 'Gemini',
    color: 'text-blue-400',
    activeColor: 'bg-blue-600/30 border-blue-500/50',
    borderColor: 'border-blue-500/30',
  },
  codex: {
    label: 'Codex',
    color: 'text-emerald-400',
    activeColor: 'bg-emerald-600/30 border-emerald-500/50',
    borderColor: 'border-emerald-500/30',
  },
};

const ALL_TOOLS: ToolName[] = ['claude', 'gemini', 'codex'];

interface AgentSelectorProps {
  config: OrchestratorConfig;
  onConfigChange: (config: OrchestratorConfig) => void;
  apiKeyStatus: Record<ToolName, boolean | null>; // null = loading
}

export function AgentSelector({ config, onConfigChange, apiKeyStatus }: AgentSelectorProps) {
  const isAgentEnabled = useCallback(
    (tool: ToolName) => config.agents.some((a) => a.toolName === tool),
    [config.agents],
  );

  const toggleAgent = useCallback(
    (tool: ToolName) => {
      const enabled = isAgentEnabled(tool);
      let newAgents: AgentConfig[];

      if (enabled) {
        // Don't allow disabling the last agent
        if (config.agents.length <= 1) return;
        newAgents = config.agents.filter((a) => a.toolName !== tool);
      } else {
        newAgents = [...config.agents, { toolName: tool, subAgentCount: 1, isMaster: false }];
      }

      // If master was removed, assign first agent as master
      let newMaster = config.masterAgent;
      if (!newAgents.some((a) => a.toolName === newMaster)) {
        newMaster = newAgents[0].toolName;
      }

      // Update isMaster flags
      newAgents = newAgents.map((a) => ({ ...a, isMaster: a.toolName === newMaster }));

      onConfigChange({ agents: newAgents, masterAgent: newMaster });
    },
    [config, isAgentEnabled, onConfigChange],
  );

  const setMaster = useCallback(
    (tool: ToolName) => {
      if (!isAgentEnabled(tool)) return;
      const newAgents = config.agents.map((a) => ({
        ...a,
        isMaster: a.toolName === tool,
      }));
      onConfigChange({ agents: newAgents, masterAgent: tool });
    },
    [config, isAgentEnabled, onConfigChange],
  );

  const setSubAgentCount = useCallback(
    (tool: ToolName, count: number) => {
      const clamped = Math.max(1, Math.min(3, count));
      const newAgents = config.agents.map((a) =>
        a.toolName === tool ? { ...a, subAgentCount: clamped } : a,
      );
      onConfigChange({ ...config, agents: newAgents });
    },
    [config, onConfigChange],
  );

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 bg-zinc-900/70 border-b border-zinc-800">
      <span className="text-xs text-zinc-500 shrink-0">Agents:</span>

      {ALL_TOOLS.map((tool) => {
        const meta = AGENT_META[tool];
        const enabled = isAgentEnabled(tool);
        const isMaster = config.masterAgent === tool;
        const keyStatus = apiKeyStatus[tool];
        const agentConfig = config.agents.find((a) => a.toolName === tool);

        return (
          <div
            key={tool}
            className={`flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors ${
              enabled
                ? `${meta.activeColor} ${meta.color}`
                : 'bg-zinc-800/50 border-zinc-700 text-zinc-500'
            }`}
          >
            {/* Checkbox toggle */}
            <button
              onClick={() => toggleAgent(tool)}
              className="hover:opacity-80 transition-opacity"
              title={enabled ? `Disable ${meta.label}` : `Enable ${meta.label}`}
            >
              {enabled ? (
                <CheckSquare className="w-3.5 h-3.5" />
              ) : (
                <Square className="w-3.5 h-3.5" />
              )}
            </button>

            {/* Agent name */}
            <span className="font-medium">{meta.label}</span>

            {/* API key status dot */}
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                keyStatus === true
                  ? 'bg-green-500'
                  : keyStatus === false
                    ? 'bg-red-500'
                    : 'bg-zinc-600 animate-pulse'
              }`}
              title={
                keyStatus === true
                  ? 'API key configured'
                  : keyStatus === false
                    ? 'No API key'
                    : 'Checking...'
              }
            />

            {/* Master radio */}
            {enabled && (
              <button
                onClick={() => setMaster(tool)}
                className={`ml-0.5 hover:opacity-80 transition-opacity ${
                  isMaster ? 'text-yellow-400' : 'text-zinc-600'
                }`}
                title={isMaster ? 'Master agent' : `Set ${meta.label} as master`}
              >
                <Circle
                  className="w-3 h-3"
                  fill={isMaster ? 'currentColor' : 'none'}
                />
              </button>
            )}

            {/* Sub-agent count */}
            {enabled && (
              <input
                type="number"
                min={1}
                max={3}
                value={agentConfig?.subAgentCount ?? 1}
                onChange={(e) => setSubAgentCount(tool, parseInt(e.target.value, 10) || 1)}
                className="w-8 px-1 py-0 text-xs text-center bg-zinc-800 border border-zinc-700 rounded focus:outline-none focus:border-zinc-500"
                title="Sub-agent count"
              />
            )}
          </div>
        );
      })}

      {/* Master indicator */}
      <span className="text-xs text-zinc-600 ml-auto shrink-0">
        Master: <span className={AGENT_META[config.masterAgent].color}>{AGENT_META[config.masterAgent].label}</span>
      </span>
    </div>
  );
}
