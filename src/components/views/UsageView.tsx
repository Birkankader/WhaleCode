import { useEffect } from 'react';
import { C } from '@/lib/theme';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore, type ToolName } from '@/stores/taskStore';
import { commands } from '@/bindings';

/* ── Constants ─────────────────────────────────────────── */

const AGENT_META: Record<ToolName, { name: string; model: string; icon: { letter: string; gradient: string } }> = {
  claude: { name: 'Claude Code', model: 'claude-sonnet-4', icon: { letter: 'C', gradient: 'linear-gradient(135deg, #6d5efc 0%, #8b5cf6 100%)' } },
  gemini: { name: 'Gemini CLI', model: 'gemini-2.5-pro', icon: { letter: 'G', gradient: 'linear-gradient(135deg, #0ea5e9 0%, #38bdf8 100%)' } },
  codex: { name: 'Codex CLI', model: 'o3-mini', icon: { letter: 'X', gradient: 'linear-gradient(135deg, #22c55e 0%, #4ade80 100%)' } },
};

/* ── Helpers ───────────────────────────────────────────── */

function formatTokens(n: number | null): string {
  if (n == null) return '--';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/* ── Main Component ────────────────────────────────────── */

export function UsageView() {
  const agentContexts = useTaskStore((s) => s.agentContexts);
  const activePlan = useTaskStore((s) => s.activePlan);
  const updateAgentContext = useTaskStore((s) => s.updateAgentContext);

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

  // Build usage list from contexts
  const usageList = Array.from(agentContexts.entries()).map(([toolName, ctx]) => ({
    toolName: toolName as ToolName,
    meta: AGENT_META[toolName as ToolName],
    inputTokens: ctx.inputTokens,
    outputTokens: ctx.outputTokens,
    totalTokens: ctx.totalTokens,
    costUsd: ctx.costUsd,
    status: ctx.status,
  }));

  return (
    <ScrollArea style={{ height: '100%' }}>
      <div
        style={{
          maxWidth: 640,
          padding: '32px 28px',
          fontFamily: 'Inter, sans-serif',
        }}
      >
        <h2
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: C.textPrimary,
            margin: 0,
          }}
        >
          Usage &amp; Tokens
        </h2>
        <p
          style={{
            fontSize: 13,
            color: C.textSecondary,
            marginTop: 6,
            marginBottom: 28,
            lineHeight: '20px',
          }}
        >
          Token consumption for agents in the current orchestration.
        </p>

        {usageList.length === 0 ? (
          <div
            style={{
              padding: 32,
              borderRadius: 18,
              background: C.surface,
              border: `1px solid ${C.border}`,
              textAlign: 'center',
              color: C.textMuted,
              fontSize: 13,
            }}
          >
            No active orchestration — usage data will appear here during a task.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {usageList.map((agent) => {
              const meta = agent.meta;
              return (
                <div
                  key={agent.toolName}
                  style={{
                    padding: 20,
                    borderRadius: 18,
                    background: C.surface,
                    border: `1px solid ${C.border}`,
                  }}
                >
                  {/* Header row */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 14,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 10,
                          background: meta.icon.gradient,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 14,
                          fontWeight: 700,
                          color: '#fff',
                          flexShrink: 0,
                        }}
                      >
                        {meta.icon.letter}
                      </div>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: C.textPrimary }}>
                          {meta.name}
                        </div>
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                          {meta.model}
                        </div>
                      </div>
                    </div>

                    {/* Status badge */}
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '4px 12px',
                        borderRadius: 999,
                        background: C.accentSoft,
                        color: C.accentText,
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      {agent.status}
                    </span>
                  </div>

                  {/* Token counts */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, 1fr)',
                      gap: 12,
                    }}
                  >
                    <div style={{ textAlign: 'center', padding: '8px 0' }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: agent.inputTokens != null ? C.textPrimary : C.textMuted }}>{formatTokens(agent.inputTokens)}</div>
                      <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>Input</div>
                    </div>
                    <div style={{ textAlign: 'center', padding: '8px 0' }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: agent.outputTokens != null ? C.textPrimary : C.textMuted }}>{formatTokens(agent.outputTokens)}</div>
                      <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>Output</div>
                    </div>
                    <div style={{ textAlign: 'center', padding: '8px 0' }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: agent.totalTokens != null ? C.accentText : C.textMuted }}>{formatTokens(agent.totalTokens)}</div>
                      <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>Total</div>
                    </div>
                  </div>

                  {/* Cost */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      paddingTop: 12,
                      marginTop: 12,
                      borderTop: `1px solid ${C.border}`,
                    }}
                  >
                    <span style={{ fontSize: 12, color: C.textMuted }}>Estimated Cost</span>
                    <span style={{ fontSize: 16, fontWeight: 700, color: agent.costUsd != null ? C.green : C.textMuted }}>
                      {agent.costUsd != null ? `$${agent.costUsd.toFixed(4)}` : '--'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
