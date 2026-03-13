import { C } from '@/lib/theme';

/* ── Types ─────────────────────────────────────────────── */

export interface DetectedAgent {
  id: string;
  name: string;
  icon: string;
  auth: boolean;
  version: string | null;
  model: string | null;
  cli: string;
}

interface AgentSetupProps {
  agents: DetectedAgent[];
  agentsLoading: boolean;
  master: string | null;
  setMaster: (id: string) => void;
  workerCounts: Record<string, number>;
  toggleWorker: (agentId: string) => void;
  adjustWorkerCount: (agentId: string, delta: number) => void;
}

/* ── Component ─────────────────────────────────────────── */

export function AgentSetup({
  agents,
  agentsLoading,
  master,
  setMaster,
  workerCounts,
  toggleWorker,
  adjustWorkerCount,
}: AgentSetupProps) {
  if (agentsLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: C.textMuted, fontSize: 14 }}>
        Detecting agents...
      </div>
    );
  }

  return (
    <div>
      {/* Conductor selection */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
          Conductor (Master)
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {agents.map((agent) => {
            const selected = master === agent.id;
            return (
              <button
                key={agent.id}
                onClick={() => agent.auth ? setMaster(agent.id) : undefined}
                disabled={!agent.auth}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 16px',
                  background: selected ? C.accentSoft : C.surface,
                  border: `1px solid ${selected ? C.accent : C.border}`,
                  borderRadius: 14,
                  cursor: agent.auth ? 'pointer' : 'not-allowed',
                  opacity: agent.auth ? 1 : 0.5,
                  transition: 'all 0.15s',
                  textAlign: 'left',
                  width: '100%',
                }}
              >
                {/* Radio circle */}
                <div
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    border: `2px solid ${selected ? C.accent : C.borderStrong}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {selected && (
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: C.accent }} />
                  )}
                </div>
                <span style={{ fontSize: 18, flexShrink: 0 }}>{agent.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary }}>{agent.name}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>
                    {agent.cli}{agent.version ? ` ${agent.version}` : ''}{agent.model ? ` \u00B7 ${agent.model}` : ''}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    padding: '3px 8px',
                    borderRadius: 6,
                    background: agent.auth ? C.greenBg : C.amberBg,
                    color: agent.auth ? C.green : C.amber,
                    border: `1px solid ${agent.auth ? C.greenBorder : C.amberBorder}`,
                    flexShrink: 0,
                  }}
                >
                  {agent.auth ? 'Authenticated' : 'No Auth'}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Worker selection */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
          Workers
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {agents.map((agent) => {
            const isWorker = agent.id in workerCounts;
            const count = workerCounts[agent.id] ?? 0;
            return (
              <div
                key={agent.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 16px',
                  background: isWorker ? C.accentSoft : C.surface,
                  border: `1px solid ${isWorker ? C.accent : C.border}`,
                  borderRadius: 14,
                  opacity: agent.auth ? 1 : 0.5,
                  transition: 'all 0.15s',
                }}
              >
                <span style={{ fontSize: 18, flexShrink: 0 }}>{agent.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary }}>{agent.name}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>
                    {agent.cli}{agent.version ? ` ${agent.version}` : ''}
                  </div>
                </div>

                {agent.auth ? (
                  isWorker ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <button
                        onClick={() => count <= 1 ? toggleWorker(agent.id) : adjustWorkerCount(agent.id, -1)}
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 8,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: C.surface,
                          border: `1px solid ${C.border}`,
                          color: C.textSecondary,
                          cursor: 'pointer',
                          fontSize: 14,
                          fontWeight: 600,
                        }}
                      >
                        -
                      </button>
                      <span style={{ fontSize: 14, fontWeight: 600, color: C.textPrimary, minWidth: 20, textAlign: 'center' }}>
                        {count}
                      </span>
                      <button
                        onClick={() => adjustWorkerCount(agent.id, 1)}
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 8,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: C.surface,
                          border: `1px solid ${C.border}`,
                          color: C.textSecondary,
                          cursor: 'pointer',
                          fontSize: 14,
                          fontWeight: 600,
                        }}
                      >
                        +
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => toggleWorker(agent.id)}
                      style={{
                        padding: '5px 12px',
                        borderRadius: 8,
                        background: C.surface,
                        border: `1px solid ${C.border}`,
                        color: C.textSecondary,
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 500,
                        flexShrink: 0,
                      }}
                    >
                      + Add
                    </button>
                  )
                ) : (
                  <span style={{ fontSize: 11, color: C.amber, flexShrink: 0 }}>No Auth</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
