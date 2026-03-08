import { RefreshCw } from 'lucide-react';
import type { ToolName, AgentContextInfo } from '../../stores/taskStore';

const AGENT_COLORS: Record<ToolName, string> = {
  claude: 'text-violet-400',
  gemini: 'text-blue-400',
  codex: 'text-emerald-400',
};

const AGENT_BAR_COLORS: Record<ToolName, { input: string; output: string }> = {
  claude: { input: 'bg-violet-600', output: 'bg-violet-400' },
  gemini: { input: 'bg-blue-600', output: 'bg-blue-400' },
  codex: { input: 'bg-emerald-600', output: 'bg-emerald-400' },
};

const AGENT_LABELS: Record<ToolName, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
};

function formatTokens(n: number | null): string {
  if (n === null) return '--';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatCost(usd: number | null): string {
  if (usd === null) return '--';
  return `$${usd.toFixed(4)}`;
}

interface ContextInfoPanelProps {
  contexts: Map<ToolName, AgentContextInfo>;
  onRefresh?: () => void;
  className?: string;
}

export function ContextInfoPanel({ contexts, onRefresh, className = '' }: ContextInfoPanelProps) {
  const entries = Array.from(contexts.entries());

  if (entries.length === 0) return null;

  // Find max total tokens for bar scaling
  const maxTokens = Math.max(
    ...entries.map(([, info]) => info.totalTokens ?? 0),
    1,
  );

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <span className="text-xs text-zinc-600 shrink-0">Context:</span>

      {entries.map(([tool, info]) => {
        const colors = AGENT_BAR_COLORS[tool];
        const inputPct = info.totalTokens
          ? ((info.inputTokens ?? 0) / maxTokens) * 100
          : 0;
        const outputPct = info.totalTokens
          ? ((info.outputTokens ?? 0) / maxTokens) * 100
          : 0;

        return (
          <div key={tool} className="flex items-center gap-1.5 min-w-0">
            <span className={`text-xs font-medium shrink-0 ${AGENT_COLORS[tool]}`}>
              {AGENT_LABELS[tool]}
            </span>

            {/* Token bar */}
            <div className="flex items-center gap-px w-20 h-2 bg-zinc-800 rounded overflow-hidden">
              <div
                className={`h-full ${colors.input} rounded-l`}
                style={{ width: `${inputPct}%` }}
                title={`Input: ${formatTokens(info.inputTokens)}`}
              />
              <div
                className={`h-full ${colors.output}`}
                style={{ width: `${outputPct}%` }}
                title={`Output: ${formatTokens(info.outputTokens)}`}
              />
            </div>

            <span className="text-[10px] text-zinc-500 shrink-0">
              {formatTokens(info.totalTokens)}
            </span>

            {info.costUsd !== null && (
              <span className="text-[10px] text-zinc-600 shrink-0">
                {formatCost(info.costUsd)}
              </span>
            )}

            {/* Status */}
            <span className={`text-[10px] shrink-0 ${
              info.status === 'running' ? 'text-green-500' :
              info.status === 'completed' ? 'text-zinc-500' :
              info.status === 'failed' ? 'text-red-500' :
              'text-zinc-600'
            }`}>
              {info.status}
            </span>
          </div>
        );
      })}

      {onRefresh && (
        <button
          onClick={onRefresh}
          className="p-0.5 text-zinc-600 hover:text-zinc-400 transition-colors ml-auto shrink-0"
          title="Refresh context info"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
