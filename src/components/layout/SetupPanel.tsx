import { useState, useEffect, useCallback, useMemo } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { C } from '@/lib/theme';
import { useUIStore } from '@/stores/uiStore';
// taskStore types available via: import { useTaskStore } from '@/stores/taskStore'
import { commands } from '@/bindings';
import type { DetectedAgent as BackendDetectedAgent } from '@/bindings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DetectedAgent {
  id: string;
  name: string;
  icon: string;
  auth: boolean;
  version: string | null;
  model: string | null;
  cli: string;
}

// ---------------------------------------------------------------------------
// Mock data – used as fallback until the real command works
// ---------------------------------------------------------------------------

const DISCOVERED_AGENTS: DetectedAgent[] = [
  { id: 'claude-opus', name: 'Claude Opus 4', cli: 'claude', icon: '\u{1F7E3}', auth: true, version: 'v1.2.3', model: 'claude-opus-4-5' },
  { id: 'claude-haiku', name: 'Claude Haiku 3.5', cli: 'claude', icon: '\u{1F7E3}', auth: true, version: 'v1.2.3', model: 'claude-haiku-3-5' },
  { id: 'gemini', name: 'Gemini 2.5 Pro', cli: 'gemini', icon: '\u{1F535}', auth: true, version: 'v0.9.1', model: 'gemini-2.5-pro' },
  { id: 'codex', name: 'Codex CLI', cli: 'codex', icon: '\u{2B1B}', auth: false, version: 'v0.1.2504', model: null },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapBackendAgent(a: BackendDetectedAgent): DetectedAgent {
  const iconMap: Record<string, string> = { claude: '\u{1F7E3}', gemini: '\u{1F535}', codex: '\u{2B1B}' };
  return {
    id: a.tool_name,
    name: a.display_name,
    icon: iconMap[a.tool_name] ?? '\u{2B1C}',
    auth: a.auth_status === 'Authenticated',
    version: a.version,
    model: null,
    cli: a.tool_name,
  };
}

const STEP_LABELS = ['Session', 'Agents', 'Task'] as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface LaunchConfig {
  sessionName: string;
  projectDir: string;
  master: DetectedAgent | null;
  workers: { agent: DetectedAgent; count: number }[];
  taskDescription: string;
}

interface SetupPanelProps {
  onLaunch?: (config: LaunchConfig) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SetupPanel({ onLaunch }: SetupPanelProps) {
  const showSetup = useUIStore((s) => s.showSetup);
  const setShowSetup = useUIStore((s) => s.setShowSetup);

  // Settings from uiStore
  const developerMode = useUIStore((s) => s.developerMode);
  const setDeveloperMode = useUIStore((s) => s.setDeveloperMode);
  const autoMerge = useUIStore((s) => s.autoMerge);
  const setAutoMerge = useUIStore((s) => s.setAutoMerge);
  const codeReview = useUIStore((s) => s.codeReview);
  const setCodeReview = useUIStore((s) => s.setCodeReview);

  const globalProjectDir = useUIStore((s) => s.projectDir);

  // Local state
  const [step, setStep] = useState(0);
  const [sessionName, setSessionName] = useState(
    new Date().toLocaleDateString('en', { month: 'short', day: 'numeric' }) + ' session'
  );
  const [projectDir, setProjectDir] = useState(globalProjectDir || '');
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [master, setMaster] = useState<string | null>(null);
  const [workerCounts, setWorkerCounts] = useState<Record<string, number>>({});
  const [taskDescription, setTaskDescription] = useState('');

  // Fetch agents on mount
  useEffect(() => {
    if (!showSetup) return;
    let cancelled = false;
    setAgentsLoading(true);

    commands.detectAgents().then((result) => {
      if (cancelled) return;
      if (result.status === 'ok' && result.data.length > 0) {
        setAgents(result.data.map(mapBackendAgent));
      } else {
        // Fallback to mock data
        setAgents(DISCOVERED_AGENTS);
      }
      setAgentsLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setAgents(DISCOVERED_AGENTS);
      setAgentsLoading(false);
    });

    return () => { cancelled = true; };
  }, [showSetup]);

  // Reset when panel opens
  useEffect(() => {
    if (showSetup) {
      setStep(0);
      setSessionName(new Date().toLocaleDateString('en', { month: 'short', day: 'numeric' }) + ' session');
      setProjectDir(globalProjectDir || '');
      setMaster(null);
      setWorkerCounts({});
      setTaskDescription('');
    }
  }, [showSetup, globalProjectDir]);

  // Worker helpers
  const toggleWorker = useCallback((agentId: string) => {
    setWorkerCounts((prev) => {
      if (agentId in prev) {
        const next = { ...prev };
        delete next[agentId];
        return next;
      }
      return { ...prev, [agentId]: 1 };
    });
  }, []);

  const adjustWorkerCount = useCallback((agentId: string, delta: number) => {
    setWorkerCounts((prev) => {
      const current = prev[agentId] ?? 1;
      const next = Math.max(1, Math.min(4, current + delta));
      return { ...prev, [agentId]: next };
    });
  }, []);

  // Derived
  const masterAgent = useMemo(() => agents.find((a) => a.id === master) ?? null, [agents, master]);
  const workerAgents = useMemo(
    () =>
      Object.entries(workerCounts)
        .map(([id, count]) => {
          const agent = agents.find((a) => a.id === id);
          return agent ? { agent, count } : null;
        })
        .filter((w): w is { agent: DetectedAgent; count: number } => w !== null),
    [agents, workerCounts],
  );

  const canContinue = useMemo(() => {
    if (step === 0) return sessionName.trim().length > 0 && projectDir.trim().length > 0;
    if (step === 1) return master !== null;
    if (step === 2) return taskDescription.trim().length > 0;
    return false;
  }, [step, sessionName, projectDir, master, taskDescription]);

  // Handlers
  const close = useCallback(() => setShowSetup(false), [setShowSetup]);

  const handleLaunch = useCallback(() => {
    onLaunch?.({
      sessionName: sessionName.trim(),
      projectDir: projectDir.trim(),
      master: masterAgent,
      workers: workerAgents,
      taskDescription: taskDescription.trim(),
    });
    // AppShell.handleLaunch already closes the panel
  }, [onLaunch, sessionName, projectDir, masterAgent, workerAgents, taskDescription]);

  if (!showSetup) return null;

  // -------------------------------------------------------------------
  // Styles
  // -------------------------------------------------------------------

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 50,
    background: 'rgba(5,5,12,0.75)',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    display: 'flex',
    justifyContent: 'flex-end',
  };

  const panelStyle: React.CSSProperties = {
    width: 560,
    height: '100%',
    background: C.panel,
    borderLeft: `1px solid ${C.border}`,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '20px 24px',
    borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
  };

  const footerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 24px',
    borderTop: `1px solid ${C.border}`,
    flexShrink: 0,
  };

  const scrollBodyStyle: React.CSSProperties = {
    flex: 1,
    overflowY: 'auto',
    padding: '24px',
  };

  // -------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------

  function renderStepIndicators() {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 24px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        {STEP_LABELS.map((label, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {i > 0 && (
                <div style={{ width: 24, height: 1, background: done ? C.accent : C.border }} />
              )}
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 600,
                  background: active ? C.accent : done ? C.accentSoft : C.surface,
                  color: active ? '#fff' : done ? C.accentText : C.textMuted,
                  border: `1px solid ${active ? C.accent : done ? C.accent : C.border}`,
                  transition: 'all 0.2s',
                }}
              >
                {done ? '\u2713' : i + 1}
              </div>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: active ? 600 : 400,
                  color: active ? C.textPrimary : done ? C.textSecondary : C.textMuted,
                }}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  function renderToggle(label: string, value: boolean, onChange: (v: boolean) => void, description?: string) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 0',
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: C.textPrimary }}>{label}</div>
          {description && (
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{description}</div>
          )}
        </div>
        <button
          onClick={() => onChange(!value)}
          style={{
            width: 40,
            height: 22,
            borderRadius: 11,
            background: value ? C.accent : C.surface,
            border: `1px solid ${value ? C.accent : C.borderStrong}`,
            position: 'relative',
            cursor: 'pointer',
            transition: 'background 0.2s, border-color 0.2s',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: '#fff',
              position: 'absolute',
              top: 2,
              left: value ? 20 : 2,
              transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            }}
          />
        </button>
      </div>
    );
  }

  // -------------------------------------------------------------------
  // Step 0: Session
  // -------------------------------------------------------------------

  function renderStepSession() {
    return (
      <div>
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Session Name
          </label>
          <input
            type="text"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            placeholder="e.g. refactor-auth-module"
            autoFocus
            style={{
              display: 'block',
              width: '100%',
              marginTop: 8,
              padding: '10px 14px',
              background: C.surface,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              color: C.textPrimary,
              fontSize: 14,
              outline: 'none',
              transition: 'border-color 0.2s',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Project Directory
          </label>
          <button
            type="button"
            onClick={async () => {
              const selected = await open({ directory: true, multiple: false, title: 'Select Project Directory' });
              if (selected) setProjectDir(selected as string);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              width: '100%',
              marginTop: 8,
              padding: projectDir ? '10px 14px' : '20px 14px',
              background: C.surface,
              border: `1.5px dashed ${projectDir ? C.accent : C.borderStrong}`,
              borderRadius: 12,
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = C.accent;
              e.currentTarget.style.background = C.surfaceHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = projectDir ? C.accent : C.borderStrong;
              e.currentTarget.style.background = C.surface;
            }}
          >
            {projectDir ? (
              <>
                <div style={{
                  width: 32, height: 32, borderRadius: 8,
                  background: C.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.29a1 1 0 0 1 .7.29L8 4.3h4.5c.83 0 1.5.67 1.5 1.5V12c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5Z" fill={C.accent} opacity="0.9"/>
                  </svg>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {projectDir.split('/').pop()}
                  </div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
                    {projectDir}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: C.accentText, fontWeight: 500, flexShrink: 0 }}>Change</div>
              </>
            ) : (
              <div style={{ width: '100%', textAlign: 'center' }}>
                <div style={{ marginBottom: 4 }}>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" style={{ display: 'inline-block' }}>
                    <path d="M3 6C3 4.9 3.9 4 5 4H8.17a1 1 0 0 1 .71.29L10 5.41h5c1.1 0 2 .9 2 2V15c0 1.1-.9 2-2 2H5a2 2 0 0 1-2-2V6Z" stroke={C.textMuted} strokeWidth="1.5" fill="none"/>
                  </svg>
                </div>
                <div style={{ fontSize: 13, fontWeight: 500, color: C.textSecondary }}>
                  Click to select project folder
                </div>
              </div>
            )}
          </button>
        </div>

        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
            Settings
          </div>
          {renderToggle('Developer Mode', developerMode, setDeveloperMode, 'Show raw output and debug info')}
          {renderToggle('Auto Merge', autoMerge, setAutoMerge, 'Merge worktree branches automatically')}
          {renderToggle('Code Review Gate', codeReview, setCodeReview, 'Require review before merging')}
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------
  // Step 1: Agents
  // -------------------------------------------------------------------

  function renderStepAgents() {
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

  // -------------------------------------------------------------------
  // Step 2: Task
  // -------------------------------------------------------------------

  function renderStepTask() {
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

  // -------------------------------------------------------------------
  // Main render
  // -------------------------------------------------------------------

  const stepContent = [renderStepSession, renderStepAgents, renderStepTask];

  return (
    <div style={overlayStyle} onClick={close}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.textPrimary, margin: 0 }}>
            New Orchestration
          </h2>
          <button
            onClick={close}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: `1px solid ${C.border}`,
              color: C.textSecondary,
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.surfaceHover; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            &times;
          </button>
        </div>

        {/* Step indicators */}
        {renderStepIndicators()}

        {/* Scrollable body */}
        <div style={scrollBodyStyle}>
          {stepContent[step]()}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          <div>
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                style={{
                  padding: '8px 20px',
                  borderRadius: 10,
                  background: 'transparent',
                  border: `1px solid ${C.border}`,
                  color: C.textSecondary,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = C.surfaceHover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                Back
              </button>
            )}
          </div>

          <div>
            {step < 2 ? (
              <span title={!canContinue ? (step === 0 ? 'Select a project directory to continue' : 'Select a conductor agent to continue') : undefined}>
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={!canContinue}
                style={{
                  padding: '8px 24px',
                  borderRadius: 10,
                  background: canContinue ? C.accent : C.surface,
                  border: 'none',
                  color: canContinue ? '#fff' : C.textMuted,
                  cursor: canContinue ? 'pointer' : 'not-allowed',
                  fontSize: 13,
                  fontWeight: 600,
                  transition: 'background 0.15s, opacity 0.15s',
                  opacity: canContinue ? 1 : 0.6,
                }}
              >
                Continue
              </button>
              </span>
            ) : (
              <span title={!canContinue ? 'Enter a task description to launch' : undefined}>
              <button
                onClick={handleLaunch}
                disabled={!canContinue}
                style={{
                  padding: '8px 28px',
                  borderRadius: 10,
                  background: canContinue ? C.accent : C.surface,
                  border: 'none',
                  color: canContinue ? '#fff' : C.textMuted,
                  cursor: canContinue ? 'pointer' : 'not-allowed',
                  fontSize: 13,
                  fontWeight: 700,
                  transition: 'background 0.15s, opacity 0.15s',
                  opacity: canContinue ? 1 : 0.6,
                  boxShadow: canContinue ? '0 0 20px rgba(99,102,241,0.3)' : 'none',
                }}
              >
                Launch
              </button>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
