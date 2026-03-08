import { useState, useMemo } from 'react';
import { Columns, Layers } from 'lucide-react';
import type { ToolName } from '../../stores/taskStore';
import { useProcessStore, type ProcessStatus } from '../../hooks/useProcess';
import { OutputConsole } from '../terminal/OutputConsole';

const AGENT_COLORS: Record<ToolName, { tab: string; activeTab: string; badge: string }> = {
  claude: {
    tab: 'text-violet-400 border-violet-500/50',
    activeTab: 'bg-violet-600/20 text-violet-300 border-violet-500',
    badge: 'bg-violet-600/30 text-violet-300',
  },
  gemini: {
    tab: 'text-blue-400 border-blue-500/50',
    activeTab: 'bg-blue-600/20 text-blue-300 border-blue-500',
    badge: 'bg-blue-600/30 text-blue-300',
  },
  codex: {
    tab: 'text-emerald-400 border-emerald-500/50',
    activeTab: 'bg-emerald-600/20 text-emerald-300 border-emerald-500',
    badge: 'bg-emerald-600/30 text-emerald-300',
  },
};

const AGENT_LABELS: Record<ToolName, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
};

function statusDot(status: ProcessStatus): string {
  switch (status) {
    case 'running':
      return 'bg-green-500 animate-pulse';
    case 'completed':
      return 'bg-zinc-500';
    case 'failed':
      return 'bg-red-500';
    case 'paused':
      return 'bg-yellow-500';
  }
}

function statusText(status: ProcessStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'paused':
      return 'Paused';
  }
}

export const DISPLAY_LINE_STYLES: Record<string, string> = {
  AgentThinking: 'text-zinc-500 italic',
  ToolExecution: 'font-mono bg-zinc-900 px-2 py-0.5 text-emerald-400',
  Result: 'text-zinc-200',
  Info: 'text-blue-400',
};

interface MultiAgentOutputProps {
  taskIds: Map<ToolName, string>; // toolName -> processId mapping
}

export function MultiAgentOutput({ taskIds }: MultiAgentOutputProps) {
  const [viewMode, setViewMode] = useState<'split' | 'tabbed'>('split');
  const [activeTab, setActiveTab] = useState<ToolName | null>(null);
  const processes = useProcessStore((s) => s.processes);

  const agents = useMemo(() => Array.from(taskIds.entries()), [taskIds]);

  // Default to first agent if no tab selected
  const currentTab = activeTab && taskIds.has(activeTab) ? activeTab : agents[0]?.[0] ?? null;

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
        No agent tasks active.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-2 py-1 bg-zinc-900 border-b border-zinc-800 shrink-0">
        {agents.map(([tool, taskId]) => {
          const proc = processes.get(taskId);
          const colors = AGENT_COLORS[tool];
          const isActive = viewMode === 'tabbed' && currentTab === tool;

          return (
            <button
              key={tool}
              onClick={() => {
                setActiveTab(tool);
                if (viewMode !== 'tabbed') setViewMode('tabbed');
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono transition-colors border ${
                isActive
                  ? colors.activeTab
                  : `bg-zinc-800/50 ${colors.tab} hover:bg-zinc-800`
              }`}
            >
              {proc && (
                <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(proc.status)}`} />
              )}
              <span>{AGENT_LABELS[tool]}</span>
              {proc && (
                <span className={`px-1 py-0 rounded text-[10px] ${colors.badge}`}>
                  {statusText(proc.status)}
                </span>
              )}
            </button>
          );
        })}

        {/* View mode toggle */}
        <div className="flex items-center gap-0.5 ml-auto">
          <button
            onClick={() => setViewMode('split')}
            className={`p-1 rounded transition-colors ${
              viewMode === 'split'
                ? 'bg-zinc-700 text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
            title="Split view"
          >
            <Columns className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setViewMode('tabbed')}
            className={`p-1 rounded transition-colors ${
              viewMode === 'tabbed'
                ? 'bg-zinc-700 text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
            title="Tabbed view"
          >
            <Layers className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Output area */}
      <div className="flex-1 min-h-0 relative">
        {viewMode === 'split' ? (
          <div className="flex h-full divide-x divide-zinc-800">
            {agents.map(([tool, taskId]) => {
              const colors = AGENT_COLORS[tool];
              return (
                <div key={tool} className="flex-1 flex flex-col min-w-0">
                  {/* Agent header */}
                  <div className={`flex items-center gap-1.5 px-2 py-1 bg-zinc-900/50 border-b border-zinc-800`}>
                    <span className={`text-xs font-medium ${colors.tab.split(' ')[0]}`}>
                      {AGENT_LABELS[tool]}
                    </span>
                    {processes.get(taskId) && (
                      <span className={`w-1.5 h-1.5 rounded-full ${statusDot(processes.get(taskId)!.status)}`} />
                    )}
                  </div>
                  {/* Console */}
                  <div className="flex-1 min-h-0">
                    <OutputConsole processId={taskId} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* Tabbed view */
          agents.map(([tool, taskId]) => (
            <div
              key={tool}
              className="absolute inset-0"
              style={{ display: tool === currentTab ? 'block' : 'none' }}
            >
              <OutputConsole processId={taskId} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
