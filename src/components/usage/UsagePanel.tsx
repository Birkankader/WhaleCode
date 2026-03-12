import { useMemo } from 'react';
import { BarChart3, Coins, Zap, RefreshCw, AlertTriangle } from 'lucide-react';
import { Button } from '../ui/button';
import type { ToolName, AgentContextInfo } from '../../stores/taskStore';
import { useTaskStore } from '../../stores/taskStore';

const AGENT_META: Record<ToolName, { label: string; color: string; barColor: string; bgColor: string }> = {
  claude: { label: 'Claude Code', color: 'text-violet-400', barColor: 'bg-violet-500', bgColor: 'bg-violet-500/10' },
  gemini: { label: 'Gemini CLI', color: 'text-blue-400', barColor: 'bg-blue-500', bgColor: 'bg-blue-500/10' },
  codex: { label: 'Codex CLI', color: 'text-emerald-400', barColor: 'bg-emerald-500', bgColor: 'bg-emerald-500/10' },
};

function formatTokens(count: number | null): string {
  if (count === null || count === 0) return '0';
  if (count < 1000) return count.toString();
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

function formatCost(usd: number | null): string {
  if (usd === null || usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

interface AgentUsageCardProps {
  info: AgentContextInfo;
}

function AgentUsageCard({ info }: AgentUsageCardProps) {
  const meta = AGENT_META[info.toolName] ?? AGENT_META.claude;
  const totalTokens = info.totalTokens ?? 0;
  const inputTokens = info.inputTokens ?? 0;
  const outputTokens = info.outputTokens ?? 0;

  // Simple bar visualization - max width based on token count
  const maxTokens = 1_000_000; // 1M as reference maximum
  const barPercent = Math.min((totalTokens / maxTokens) * 100, 100);
  const inputPercent = totalTokens > 0 ? (inputTokens / totalTokens) * barPercent : 0;
  const outputPercent = totalTokens > 0 ? (outputTokens / totalTokens) * barPercent : 0;

  return (
    <div className={`p-4 rounded-xl border border-white/5 ${meta.bgColor}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${meta.barColor}`} />
          <span className={`text-sm font-medium ${meta.color}`}>{meta.label}</span>
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded-full ${
          info.status === 'active' ? 'bg-green-500/20 text-green-400' :
          info.status === 'rate_limited' ? 'bg-red-500/20 text-red-400' :
          'bg-zinc-800 text-zinc-500'
        }`}>
          {info.status}
        </span>
      </div>

      {/* Token usage bar */}
      <div className="mb-3">
        <div className="flex items-center justify-between text-[10px] text-zinc-500 mb-1">
          <span>Token Usage</span>
          <span>{formatTokens(totalTokens)}</span>
        </div>
        <div className="h-2 bg-black/30 rounded-full overflow-hidden flex">
          <div
            className={`${meta.barColor} opacity-80 transition-all duration-500`}
            style={{ width: `${inputPercent}%` }}
            title={`Input: ${formatTokens(inputTokens)}`}
          />
          <div
            className={`${meta.barColor} opacity-50 transition-all duration-500`}
            style={{ width: `${outputPercent}%` }}
            title={`Output: ${formatTokens(outputTokens)}`}
          />
        </div>
        <div className="flex items-center gap-3 mt-1">
          <span className="text-[10px] text-zinc-600">
            In: {formatTokens(inputTokens)}
          </span>
          <span className="text-[10px] text-zinc-600">
            Out: {formatTokens(outputTokens)}
          </span>
        </div>
      </div>

      {/* Cost */}
      <div className="flex items-center justify-between pt-2 border-t border-white/5">
        <div className="flex items-center gap-1.5">
          <Coins className="w-3 h-3 text-zinc-500" />
          <span className="text-xs text-zinc-400">Cost</span>
        </div>
        <span className="text-xs font-mono text-zinc-200">
          {formatCost(info.costUsd)}
        </span>
      </div>
    </div>
  );
}

interface UsagePanelProps {
  className?: string;
}

export function UsagePanel({ className = '' }: UsagePanelProps) {
  const agentContexts = useTaskStore((s) => s.agentContexts);

  const agents = useMemo(() => {
    return Array.from(agentContexts.values());
  }, [agentContexts]);

  const totals = useMemo(() => {
    let tokens = 0;
    let cost = 0;
    for (const agent of agents) {
      tokens += agent.totalTokens ?? 0;
      cost += agent.costUsd ?? 0;
    }
    return { tokens, cost };
  }, [agents]);

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-white/5 bg-black/20">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-zinc-400" />
          <h2 className="text-sm font-semibold text-zinc-200">Usage & Quotas</h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-zinc-500 hover:text-zinc-300 h-7"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Session totals */}
      <div className="shrink-0 px-6 py-3 border-b border-white/5 bg-black/10">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-0.5">Session Tokens</p>
            <p className="text-lg font-mono text-zinc-200">{formatTokens(totals.tokens)}</p>
          </div>
          <div>
            <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-0.5">Session Cost</p>
            <p className="text-lg font-mono text-zinc-200">{formatCost(totals.cost)}</p>
          </div>
        </div>
      </div>

      {/* Agent cards */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-600">
            <Zap className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-sm">No usage data yet</p>
            <p className="text-xs mt-1">Run a task to see agent usage</p>
          </div>
        ) : (
          agents.map((agent) => (
            <AgentUsageCard key={agent.toolName} info={agent} />
          ))
        )}
      </div>

      {/* Rate limit warning */}
      {agents.some((a) => a.status === 'rate_limited') && (
        <div className="shrink-0 flex items-center gap-2 px-6 py-2 border-t border-yellow-500/20 bg-yellow-500/5">
          <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
          <p className="text-xs text-yellow-400">
            One or more agents are rate limited. Tasks may be delayed.
          </p>
        </div>
      )}
    </div>
  );
}
