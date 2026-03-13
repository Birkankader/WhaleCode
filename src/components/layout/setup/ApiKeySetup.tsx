import { C } from '@/lib/theme';
import type { DetectedAgent } from './AgentSetup';

/* ── Types ─────────────────────────────────────────────── */

interface ApiKeySetupProps {
  taskDescription: string;
  setTaskDescription: (v: string) => void;
  masterAgent: DetectedAgent | null;
  workerAgents: { agent: DetectedAgent; count: number }[];
}

/* ── Component ─────────────────────────────────────────── */

export function ApiKeySetup({
  taskDescription,
  setTaskDescription,
  masterAgent,
  workerAgents,
}: ApiKeySetupProps) {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Task Description
        </label>
        <textarea
          value={taskDescription}
          onChange={(e) => setTaskDescription(e.target.value)}
          placeholder="Describe the task you want the orchestra to complete..."
          autoFocus
          rows={6}
          style={{
            display: 'block',
            width: '100%',
            marginTop: 8,
            padding: '12px 14px',
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            color: C.textPrimary,
            fontSize: 14,
            lineHeight: 1.5,
            resize: 'vertical',
            outline: 'none',
            fontFamily: 'inherit',
            transition: 'border-color 0.2s',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
        />
      </div>

      {/* Orchestra summary card */}
      <div
        style={{
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 14,
          padding: 16,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
          Orchestra Summary
        </div>

        {/* Master */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, padding: '10px 12px', background: C.panel, borderRadius: 10, border: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 16 }}>{masterAgent?.icon ?? '-'}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 500 }}>Conductor</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.accentText }}>{masterAgent?.name ?? 'None selected'}</div>
          </div>
        </div>

        {/* Workers */}
        {workerAgents.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {workerAgents.map(({ agent, count }) => (
              <div key={agent.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: C.panel, borderRadius: 10, border: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 16 }}>{agent.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 500 }}>Worker</div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: C.textPrimary }}>{agent.name}</div>
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary }}>x{count}</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: C.textMuted, padding: '8px 12px' }}>
            No workers selected
          </div>
        )}
      </div>
    </div>
  );
}
