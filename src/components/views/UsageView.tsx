import { useEffect, useState, useCallback, useRef } from 'react';
import { C } from '@/lib/theme';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AGENTS } from '@/lib/agents';
import { commands } from '@/bindings';
import type { AgentUsage, UsageLine } from '@/bindings';
import type { ToolName } from '@/stores/taskStore';

/* ── Helpers ───────────────────────────────────────────── */

function formatPercent(n: number): string {
  return `${Math.round(n)}%`;
}

function formatDollars(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function formatValue(line: UsageLine): string {
  if (line.value) return line.value;
  if (line.used == null) return '--';
  const kind = line.format_kind ?? 'percent';
  if (kind === 'dollars') return formatDollars(line.used);
  if (kind === 'count') return String(Math.round(line.used));
  return formatPercent(line.used);
}

function progressColor(used: number, limit: number): string {
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  if (pct >= 80) return C.red;
  if (pct >= 50) return C.amber;
  return C.green;
}

function timeUntilReset(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const resetMs = new Date(resetsAt).getTime();
  if (isNaN(resetMs)) {
    // Try as epoch seconds
    const asNum = Number(resetsAt);
    if (!isNaN(asNum)) {
      const ms = asNum > 1e12 ? asNum : asNum * 1000;
      const diff = ms - Date.now();
      if (diff <= 0) return 'now';
      const hours = Math.floor(diff / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }
    return null;
  }
  const diff = resetMs - Date.now();
  if (diff <= 0) return 'now';
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

/* ── Progress Bar ──────────────────────────────────────── */

function UsageProgressBar({ line }: { line: UsageLine }) {
  const used = line.used ?? 0;
  const limit = line.limit ?? 0;
  const isUnlimited = limit <= 0;
  const pct = isUnlimited ? 0 : Math.min((used / limit) * 100, 100);
  const color = isUnlimited ? C.green : progressColor(used, limit);
  const reset = timeUntilReset(line.resets_at);

  return (
    <div style={{ padding: '10px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary }}>{line.label}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color }}>{formatValue(line)}</span>
          {!isUnlimited && line.format_kind === 'percent' && (
            <span style={{ fontSize: 11, color: C.textMuted }}>/ {formatPercent(limit)}</span>
          )}
          {isUnlimited && (
            <span style={{ fontSize: 11, color: C.textMuted }}>/ Unlimited</span>
          )}
        </div>
      </div>
      {!isUnlimited && (
        <div style={{ width: '100%', height: 8, borderRadius: 4, background: C.border, overflow: 'hidden' }}>
          <div style={{
            width: `${pct}%`, height: '100%', borderRadius: 4,
            background: color, transition: 'width 500ms ease',
          }} />
        </div>
      )}
      {reset && (
        <div style={{ fontSize: 10, color: C.textMuted, marginTop: 4, textAlign: 'right' }}>
          Resets in {reset}
        </div>
      )}
    </div>
  );
}

/* ── Agent Card ────────────────────────────────────────── */

function AgentUsageCard({ usage }: { usage: AgentUsage }) {
  const agentKey = usage.agent as ToolName;
  const agent = AGENTS[agentKey];
  if (!agent) return null;

  const progressLines = usage.lines.filter(l => l.line_type === 'progress');
  const textLines = usage.lines.filter(l => l.line_type === 'text');

  return (
    <div style={{
      padding: 20, borderRadius: 18,
      background: C.surface, border: `1px solid ${C.border}`,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 10,
            background: agent.gradient,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, fontWeight: 700, color: '#fff', flexShrink: 0,
          }}>
            {agent.letter}
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.textPrimary }}>{agent.label}</div>
            {usage.plan && (
              <div style={{ fontSize: 11, color: C.accentText, marginTop: 1 }}>{usage.plan}</div>
            )}
          </div>
        </div>
        {usage.error ? (
          <span style={{
            fontSize: 10, fontWeight: 600, padding: '3px 10px', borderRadius: 999,
            background: C.redBg, color: C.red,
          }}>
            {usage.error}
          </span>
        ) : (
          <span style={{
            fontSize: 10, fontWeight: 600, padding: '3px 10px', borderRadius: 999,
            background: C.greenBg, color: C.green,
          }}>
            Connected
          </span>
        )}
      </div>

      {/* Progress bars */}
      {progressLines.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {progressLines.map((line, i) => (
            <UsageProgressBar key={i} line={line} />
          ))}
        </div>
      ) : !usage.error ? (
        <div style={{ padding: '16px 0', textAlign: 'center', color: C.textMuted, fontSize: 12 }}>
          No usage data available
        </div>
      ) : null}

      {/* Text lines (Today, Yesterday, etc.) */}
      {textLines.length > 0 && (
        <div style={{
          marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}`,
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {textLines.map((line, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, color: C.textMuted }}>{line.label}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.textPrimary }}>{line.value ?? '--'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main Component ────────────────────────────────────── */

export function UsageView() {
  const [usageData, setUsageData] = useState<AgentUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    try {
      const result = await commands.fetchAgentUsage();
      if (result.status === 'ok') {
        setError(null);
        setUsageData(result.data);
      }
    } catch {
      setError('Failed to fetch usage data');
    } finally {
      setLoading(false);
      setLastFetch(new Date());
    }
  }, []);

  const startInterval = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchUsage, 60_000);
  }, [fetchUsage]);

  const handleManualRefresh = useCallback(() => {
    fetchUsage();
    startInterval(); // Reset the auto-refresh timer
  }, [fetchUsage, startInterval]);

  // Fetch on mount
  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  // Auto-refresh every 60s
  useEffect(() => {
    startInterval();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [startInterval]);

  return (
    <ScrollArea style={{ height: '100%' }}>
      <div style={{ maxWidth: 640, padding: '32px 28px', fontFamily: 'var(--font-mono, Inter, sans-serif)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: C.textPrimary, margin: 0 }}>
              Usage
            </h2>
            <p style={{ fontSize: 13, color: C.textSecondary, margin: '4px 0 0 0' }}>
              Live rate limits and consumption from your AI agents.
            </p>
          </div>
          <button
            onClick={handleManualRefresh}
            disabled={loading}
            style={{
              padding: '6px 14px', borderRadius: 8,
              background: C.surface, border: `1px solid ${C.border}`,
              color: C.textSecondary, fontSize: 11, fontWeight: 600,
              cursor: loading ? 'wait' : 'pointer',
              opacity: loading ? 0.5 : 1,
              transition: 'all 150ms',
            }}
          >
            {loading ? 'Fetching...' : 'Refresh'}
          </button>
        </div>

        {lastFetch && (
          <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 16 }}>
            Last updated: {lastFetch.toLocaleTimeString()}
          </div>
        )}

        {error && (
          <div style={{
            padding: '12px 16px', borderRadius: 12, marginBottom: 16,
            background: C.redBg,
            border: `1px solid ${C.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ fontSize: 13, color: C.red }}>{error}</span>
            <button
              onClick={handleManualRefresh}
              style={{
                padding: '4px 12px', borderRadius: 8,
                background: 'transparent', border: `1px solid ${C.red}`,
                color: C.red, fontSize: 11, fontWeight: 600,
                cursor: 'pointer', flexShrink: 0,
              }}
            >
              Retry
            </button>
          </div>
        )}

        {loading && usageData.length === 0 ? (
          <div style={{
            padding: 48, borderRadius: 18, background: C.surface, border: `1px solid ${C.border}`,
            textAlign: 'center', color: C.textMuted, fontSize: 13,
          }}>
            Fetching usage data from agents...
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {usageData.map((usage) => (
              <AgentUsageCard key={usage.agent} usage={usage} />
            ))}
            {usageData.length === 0 && !loading && (
              <div style={{
                padding: 48, borderRadius: 18, background: C.surface, border: `1px solid ${C.border}`,
                textAlign: 'center', color: C.textMuted, fontSize: 13,
              }}>
                No agents configured. Set up API keys in Settings.
              </div>
            )}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
