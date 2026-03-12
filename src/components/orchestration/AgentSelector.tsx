import { useCallback } from 'react';
import { CheckSquare, Square, Circle, AlertTriangle, XCircle } from 'lucide-react';
import type { ToolName, OrchestratorConfig, AgentConfig } from '../../stores/taskStore';
import type { DetectedAgent } from '../../hooks/useAgentDetection';

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
  apiKeyStatus: Record<ToolName, boolean | null>;
  detectedAgents?: DetectedAgent[];
  detectionLoading?: boolean;
}

export function AgentSelector({ config, onConfigChange, apiKeyStatus, detectedAgents, detectionLoading }: AgentSelectorProps) {
  const getDetection = useCallback(
    (tool: ToolName) => detectedAgents?.find((a) => a.tool_name === tool),
    [detectedAgents],
  );

  const isAgentEnabled = useCallback(
    (tool: ToolName) => config.agents.some((a) => a.toolName === tool),
    [config.agents],
  );

  const canEnable = useCallback(
    (tool: ToolName) => {
      const detection = getDetection(tool);
      if (!detection) return apiKeyStatus[tool] !== false;
      return detection.installed && detection.auth_status === 'Authenticated';
    },
    [getDetection, apiKeyStatus],
  );

  const toggleAgent = useCallback(
    (tool: ToolName) => {
      if (!canEnable(tool)) return;
      const enabled = isAgentEnabled(tool);
      let newAgents: AgentConfig[];

      if (enabled) {
        if (config.agents.length <= 1) return;
        newAgents = config.agents.filter((a) => a.toolName !== tool);
      } else {
        newAgents = [...config.agents, { toolName: tool, subAgentCount: 1, isMaster: false }];
      }

      let newMaster = config.masterAgent;
      if (!newAgents.some((a) => a.toolName === newMaster)) {
        newMaster = newAgents[0].toolName;
      }

      newAgents = newAgents.map((a) => ({ ...a, isMaster: a.toolName === newMaster }));

      onConfigChange({ agents: newAgents, masterAgent: newMaster });
    },
    [config, isAgentEnabled, canEnable, onConfigChange],
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
        const detection = getDetection(tool);
        const isAvailable = canEnable(tool);

        return (
          <div
            key={tool}
            className={`flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors ${
              !isAvailable
                ? 'bg-zinc-900/50 border-zinc-800 text-zinc-600 opacity-60'
                : enabled
                  ? `${meta.activeColor} ${meta.color}`
                  : 'bg-zinc-800/50 border-zinc-700 text-zinc-500'
            }`}
          >
            {/* Checkbox toggle */}
            <button
              onClick={() => toggleAgent(tool)}
              className={`hover:opacity-80 transition-opacity ${!isAvailable ? 'cursor-not-allowed' : ''}`}
              title={
                !isAvailable
                  ? detection && !detection.installed
                    ? `${meta.label} not installed`
                    : `${meta.label} needs authentication`
                  : enabled
                    ? `Disable ${meta.label}`
                    : `Enable ${meta.label}`
              }
              disabled={!isAvailable}
            >
              {enabled ? (
                <CheckSquare className="w-3.5 h-3.5" />
              ) : (
                <Square className="w-3.5 h-3.5" />
              )}
            </button>

            {/* Agent name */}
            <span className="font-medium">{meta.label}</span>

            {/* Status indicator */}
            {detectionLoading ? (
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-pulse shrink-0" title="Detecting..." />
            ) : detection && !detection.installed ? (
              <span title="Not installed" className="shrink-0">
                <XCircle className="w-3 h-3 text-zinc-600" />
              </span>
            ) : detection && detection.auth_status === 'NeedsAuth' ? (
              <span title="Needs authentication" className="shrink-0 flex items-center gap-0.5">
                <AlertTriangle className="w-3 h-3 text-yellow-500" />
                <span className="text-[9px] text-yellow-500 font-medium">Auth</span>
              </span>
            ) : (
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  keyStatus === true || detection?.auth_status === 'Authenticated'
                    ? 'bg-green-500'
                    : keyStatus === false
                      ? 'bg-red-500'
                      : 'bg-zinc-600 animate-pulse'
                }`}
                title={
                  keyStatus === true || detection?.auth_status === 'Authenticated'
                    ? 'Authenticated'
                    : keyStatus === false
                      ? 'No API key'
                      : 'Checking...'
                }
              />
            )}

            {/* Version badge */}
            {detection?.version && enabled && (
              <span className="text-[9px] text-zinc-600 font-mono hidden sm:inline">
                {detection.version.slice(0, 12)}
              </span>
            )}

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
