import { useEffect, useMemo } from 'react';
import { C } from '@/lib/theme';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AGENTS } from '@/lib/agents';
import { useTaskStore, type ToolName } from '@/stores/taskStore';
import { commands } from '@/bindings';

/* ── Constants ─────────────────────────────────────────── */

const AGENT_META: Record<ToolName, { name: string; model: string; color: string }> = {
  claude: { name: 'Claude Code', model: 'claude-sonnet-4', color: '#8b5cf6' },
  gemini: { name: 'Gemini CLI', model: 'gemini-2.5-pro', color: '#38bdf8' },
  codex: { name: 'Codex CLI', model: 'o3-mini', color: '#4ade80' },
};

/* ── Helpers ───────────────────────────────────────────── */

function formatTokens(n: number | null): string {
  if (n == null) return '--';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number | null): string {
  if (n == null) return '--';
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

/* ── Bar Chart (pure CSS, no dependency) ───────────────── */

function TokenDistributionBar({ data }: { data: { label: string; value: number; color: string }[] }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (total === 0) {
    return (
      <div style={{ height: 28, borderRadius: 8, background: C.surface, border: `1px solid ${C.border}` }} />
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', height: 28, borderRadius: 8, overflow: 'hidden', background: C.surface }}>
        {data.filter(d => d.value > 0).map((d) => (
          <div
            key={d.label}
            title={`${d.label}: ${formatTokens(d.value)} (${((d.value / total) * 100).toFixed(0)}%)`}
            style={{
              width: `${(d.value / total) * 100}%`,
              background: d.color,
              minWidth: d.value > 0 ? 4 : 0,
              transition: 'width 500ms ease',
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {data.filter(d => d.value > 0).map((d) => (
          <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: d.color, flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: C.textSecondary }}>{d.label}</span>
            <span style={{ fontSize: 11, color: C.textPrimary, fontWeight: 600 }}>{formatTokens(d.value)}</span>
            <span style={{ fontSize: 10, color: C.textMuted }}>({((d.value / total) * 100).toFixed(0)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Mini bar for task cost ─────────────────────────────── */

function CostBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div style={{ width: 80, height: 6, borderRadius: 3, background: C.border, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: C.accent, transition: 'width 300ms ease' }} />
    </div>
  );
}

/* ── Main Component ────────────────────────────────────── */

export function UsageView() {
  const agentContexts = useTaskStore((s) => s.agentContexts);
  const activePlan = useTaskStore((s) => s.activePlan);
  const updateAgentContext = useTaskStore((s) => s.updateAgentContext);
  const tasks = useTaskStore((s) => s.tasks);

  // Fetch usage data when plan is active
  useEffect(() => {
    if (!activePlan?.task_id) return;
    commands.getAgentContextInfo(activePlan.task_id)
      .then((result) => {
        if (result.status === 'ok') {
          for (const info of result.data) {
            updateAgentContext(info.tool_name as ToolName, {
              toolName: info.tool_name as ToolName,
              inputTokens: info.input_tokens ?? null,
              outputTokens: info.output_tokens ?? null,
              totalTokens: info.total_tokens ?? null,
              costUsd: info.cost_usd ?? null,
              status: info.status,
            });
          }
        }
      })
      .catch(() => {});
  }, [activePlan?.task_id, updateAgentContext]);

  // Build usage list
  const usageList = useMemo(() =>
    Array.from(agentContexts.entries()).map(([toolName, ctx]) => ({
      toolName: toolName as ToolName,
      meta: AGENT_META[toolName as ToolName],
      inputTokens: ctx.inputTokens,
      outputTokens: ctx.outputTokens,
      totalTokens: ctx.totalTokens,
      costUsd: ctx.costUsd,
      status: ctx.status,
    })),
    [agentContexts],
  );

  // Aggregate stats
  const totals = useMemo(() => {
    let input = 0, output = 0, total = 0, cost = 0;
    let hasData = false;
    for (const a of usageList) {
      if (a.inputTokens != null) { input += a.inputTokens; hasData = true; }
      if (a.outputTokens != null) { output += a.outputTokens; hasData = true; }
      if (a.totalTokens != null) { total += a.totalTokens; hasData = true; }
      if (a.costUsd != null) { cost += a.costUsd; hasData = true; }
    }
    return { input, output, total, cost, hasData };
  }, [usageList]);

  // Token distribution by agent
  const tokenDistribution = useMemo(() =>
    usageList.map((a) => ({
      label: a.meta.name,
      value: a.totalTokens ?? 0,
      color: a.meta.color,
    })),
    [usageList],
  );

  // Task-level cost breakdown
  const taskCosts = useMemo(() => {
    const list: { id: string; title: string; agent: ToolName; status: string; cost: number | null }[] = [];
    for (const [, task] of tasks) {
      const ctx = agentContexts.get(task.toolName);
      // Approximate: spread agent cost evenly across its tasks
      const agentTasks = Array.from(tasks.values()).filter(t => t.toolName === task.toolName);
      const perTaskCost = ctx?.costUsd != null && agentTasks.length > 0
        ? ctx.costUsd / agentTasks.length
        : null;
      list.push({
        id: task.taskId,
        title: task.description || task.prompt.slice(0, 50),
        agent: task.toolName,
        status: task.status,
        cost: perTaskCost,
      });
    }
    return list.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  }, [tasks, agentContexts]);

  const maxTaskCost = useMemo(() => Math.max(...taskCosts.map(t => t.cost ?? 0), 0.001), [taskCosts]);

  return (
    <ScrollArea style={{ height: '100%' }}>
      <div style={{ maxWidth: 720, padding: '32px 28px', fontFamily: 'Inter, sans-serif' }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: C.textPrimary, margin: 0 }}>
          Usage &amp; Cost
        </h2>
        <p style={{ fontSize: 13, color: C.textSecondary, marginTop: 6, marginBottom: 28, lineHeight: '20px' }}>
          Token consumption and cost breakdown for this session.
        </p>

        {!totals.hasData && usageList.length === 0 ? (
          <div style={{ padding: 32, borderRadius: 18, background: C.surface, border: `1px solid ${C.border}`, textAlign: 'center', color: C.textMuted, fontSize: 13 }}>
            No active orchestration — usage data will appear here during a task.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

            {/* Summary cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              {[
                { label: 'Total Tokens', value: formatTokens(totals.hasData ? totals.total : null), color: C.accentText },
                { label: 'Input', value: formatTokens(totals.hasData ? totals.input : null), color: C.textPrimary },
                { label: 'Output', value: formatTokens(totals.hasData ? totals.output : null), color: C.textPrimary },
                { label: 'Total Cost', value: formatCost(totals.hasData ? totals.cost : null), color: C.green },
              ].map((stat) => (
                <div key={stat.label} style={{ padding: '16px 12px', borderRadius: 14, background: C.surface, border: `1px solid ${C.border}`, textAlign: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: stat.color }}>{stat.value}</div>
                  <div style={{ fontSize: 10, color: C.textMuted, marginTop: 4 }}>{stat.label}</div>
                </div>
              ))}
            </div>

            {/* Token distribution bar */}
            <div style={{ padding: 20, borderRadius: 18, background: C.surface, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, marginBottom: 14 }}>
                Token Distribution by Agent
              </div>
              <TokenDistributionBar data={tokenDistribution} />
            </div>

            {/* Per-agent cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {usageList.map((agent) => (
                <div key={agent.toolName} style={{ padding: 16, borderRadius: 14, background: C.surface, border: `1px solid ${C.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 28, height: 28, borderRadius: 8, background: AGENTS[agent.toolName].gradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                        {AGENTS[agent.toolName].letter}
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary }}>{agent.meta.name}</div>
                        <div style={{ fontSize: 10, color: C.textMuted, marginTop: 1 }}>{agent.meta.model}</div>
                      </div>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 999, background: C.accentSoft, color: C.accentText }}>
                      {agent.status}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: agent.inputTokens != null ? C.textPrimary : C.textMuted }}>{formatTokens(agent.inputTokens)}</div>
                      <div style={{ fontSize: 9, color: C.textMuted, marginTop: 2 }}>Input</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: agent.outputTokens != null ? C.textPrimary : C.textMuted }}>{formatTokens(agent.outputTokens)}</div>
                      <div style={{ fontSize: 9, color: C.textMuted, marginTop: 2 }}>Output</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: agent.totalTokens != null ? C.accentText : C.textMuted }}>{formatTokens(agent.totalTokens)}</div>
                      <div style={{ fontSize: 9, color: C.textMuted, marginTop: 2 }}>Total</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: agent.costUsd != null ? C.green : C.textMuted }}>{formatCost(agent.costUsd)}</div>
                      <div style={{ fontSize: 9, color: C.textMuted, marginTop: 2 }}>Cost</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Task-level cost breakdown */}
            {taskCosts.length > 0 && (
              <div style={{ padding: 20, borderRadius: 18, background: C.surface, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, marginBottom: 14 }}>
                  Cost by Task (estimated)
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {taskCosts.map((task) => (
                    <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                      <div style={{ width: 6, height: 6, borderRadius: 3, background: AGENT_META[task.agent].color, flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: 12, color: C.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {task.title}
                      </span>
                      <CostBar value={task.cost ?? 0} max={maxTaskCost} />
                      <span style={{ fontSize: 11, fontWeight: 600, color: task.cost != null ? C.textPrimary : C.textMuted, minWidth: 56, textAlign: 'right' }}>
                        {formatCost(task.cost)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
