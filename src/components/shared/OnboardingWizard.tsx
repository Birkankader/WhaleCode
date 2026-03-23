import { useState, useEffect } from 'react';
import { commands } from '@/bindings';
import type { DetectedAgent as BackendDetectedAgent } from '@/bindings';
import { useUIStore } from '@/stores/uiStore';

/* ── Types ─────────────────────────────────────────────── */

interface AgentStatus {
  name: string;
  cli: string;
  installed: boolean;
  authenticated: boolean;
  version: string | null;
}

/* ── Component ─────────────────────────────────────────── */

export function OnboardingWizard() {
  const [step, setStep] = useState(0);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const setShowSetup = useUIStore((s) => s.setShowSetup);

  // Check if onboarding was already completed
  useEffect(() => {
    try {
      const completed = localStorage.getItem('whalecode-onboarding-done');
      if (completed === 'true') setDismissed(true);
    } catch {
      // localStorage unavailable (test environment)
      setDismissed(true);
    }
  }, []);

  // Detect agents on mount
  useEffect(() => {
    if (dismissed) return;
    commands.detectAgents()
      .then((result) => {
        if (result.status === 'ok') {
          setAgents(result.data.map((a: BackendDetectedAgent) => ({
            name: a.display_name,
            cli: a.tool_name,
            installed: a.installed,
            authenticated: a.auth_status === 'Authenticated',
            version: a.version,
          })));
        } else {
          setAgents([
            { name: 'Claude Code', cli: 'claude', installed: false, authenticated: false, version: null },
            { name: 'Gemini CLI', cli: 'gemini', installed: false, authenticated: false, version: null },
            { name: 'Codex CLI', cli: 'codex', installed: false, authenticated: false, version: null },
          ]);
        }
      })
      .catch(() => {
        setAgents([
          { name: 'Claude Code', cli: 'claude', installed: false, authenticated: false, version: null },
          { name: 'Gemini CLI', cli: 'gemini', installed: false, authenticated: false, version: null },
          { name: 'Codex CLI', cli: 'codex', installed: false, authenticated: false, version: null },
        ]);
      })
      .finally(() => setLoading(false));
  }, [dismissed]);

  const finish = () => {
    try { localStorage.setItem('whalecode-onboarding-done', 'true'); } catch { /* test env */ }
    setDismissed(true);
  };

  const startOrchestration = () => {
    finish();
    setShowSetup(true);
  };

  if (dismissed) return null;

  const hasAnyAgent = agents.some((a) => a.installed);
  const hasAuthAgent = agents.some((a) => a.authenticated);

  const STEPS = [
    { title: 'Welcome', icon: '🐋' },
    { title: 'Agents', icon: '🤖' },
    { title: 'Ready', icon: '🚀' },
  ];

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(5,5,12,0.85)', backdropFilter: 'blur(8px)' }}
    >
      <div className="w-[520px] rounded-2xl border border-wc-border-strong bg-wc-panel shadow-[0_32px_80px_rgba(0,0,0,0.7)] overflow-hidden">
        {/* Step indicators */}
        <div className="flex items-center justify-center gap-2 px-6 pt-6 pb-2">
          {STEPS.map((s, i) => (
            <div key={s.title} className="flex items-center gap-1.5">
              {i > 0 && <div className={`w-8 h-px ${i <= step ? 'bg-wc-accent' : 'bg-wc-border'}`} />}
              <div className={`size-7 rounded-full flex items-center justify-center text-xs font-bold ${
                i < step ? 'bg-wc-accent text-white'
                : i === step ? 'bg-wc-accent-soft text-wc-accent-text border border-wc-accent'
                : 'bg-wc-surface text-wc-text-muted border border-wc-border'
              }`}>
                {i < step ? '✓' : s.icon}
              </div>
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="px-8 py-6">
          {step === 0 && (
            <div className="text-center">
              <div className="text-5xl mb-4">🐋</div>
              <h2 className="text-xl font-bold text-wc-text-primary mb-2">Welcome to WhaleCode</h2>
              <p className="text-sm text-wc-text-secondary leading-relaxed mb-6">
                WhaleCode orchestrates multiple AI coding agents — Claude Code, Gemini CLI, and Codex —
                to work on your projects simultaneously. Each agent runs in an isolated Git worktree,
                and you review & merge their changes.
              </p>
              <div className="grid grid-cols-3 gap-3 text-center mb-2">
                {[
                  { icon: '⊞', label: 'Kanban Board', desc: 'Track all tasks' },
                  { icon: '🔀', label: 'Git Isolation', desc: 'No conflicts' },
                  { icon: '👁', label: 'Code Review', desc: 'Before merge' },
                ].map((f) => (
                  <div key={f.label} className="p-3 rounded-xl bg-wc-surface border border-wc-border">
                    <div className="text-lg mb-1">{f.icon}</div>
                    <div className="text-xs font-semibold text-wc-text-primary">{f.label}</div>
                    <div className="text-[10px] text-wc-text-muted mt-0.5">{f.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 1 && (
            <div>
              <h2 className="text-lg font-bold text-wc-text-primary mb-1">Agent Detection</h2>
              <p className="text-xs text-wc-text-secondary mb-4">
                WhaleCode detected the following CLI tools on your system.
                At least one is needed to get started.
              </p>
              {loading ? (
                <div className="py-8 text-center text-sm text-wc-text-muted">Scanning...</div>
              ) : (
                <div className="space-y-2">
                  {agents.map((agent) => (
                    <div key={agent.cli} className={`flex items-center gap-3 p-3 rounded-xl border ${
                      agent.installed ? 'bg-wc-green-bg border-wc-green-border' : 'bg-wc-surface border-wc-border'
                    }`}>
                      <span className={`size-8 rounded-lg flex items-center justify-center text-sm font-bold ${
                        agent.installed ? 'bg-wc-green/20 text-wc-green' : 'bg-wc-surface text-wc-text-muted'
                      }`}>
                        {agent.installed ? '✓' : '✕'}
                      </span>
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-wc-text-primary">{agent.name}</div>
                        <div className="text-[10px] text-wc-text-muted">
                          {agent.installed
                            ? `${agent.version ?? ''} · ${agent.authenticated ? 'Authenticated' : 'Not authenticated'}`
                            : `Install: npm i -g ${agent.cli === 'claude' ? '@anthropic-ai/claude-code' : agent.cli === 'gemini' ? '@anthropic-ai/gemini-cli' : 'codex'}`
                          }
                        </div>
                      </div>
                      {agent.installed && (
                        <span className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded ${
                          agent.authenticated ? 'bg-wc-green-bg text-wc-green' : 'bg-wc-amber-bg text-wc-amber'
                        }`}>
                          {agent.authenticated ? 'Ready' : 'No Auth'}
                        </span>
                      )}
                    </div>
                  ))}
                  {!hasAnyAgent && (
                    <div className="mt-3 p-3 rounded-xl bg-wc-amber-bg border border-wc-amber-border text-xs text-wc-amber leading-relaxed">
                      No agents found. Install at least one CLI tool and try again.
                      <button
                        onClick={() => {
                          setLoading(true);
                          commands.detectAgents()
                            .then((result) => {
                              if (result.status === 'ok') {
                                setAgents(result.data.map((a: BackendDetectedAgent) => ({
                                  name: a.display_name,
                                  cli: a.tool_name,
                                  installed: a.installed,
                                  authenticated: a.auth_status === 'Authenticated',
                                  version: a.version,
                                })));
                              }
                            })
                            .finally(() => setLoading(false));
                        }}
                        className="ml-2 px-2 py-0.5 rounded-md bg-wc-amber/20 text-wc-amber font-semibold hover:bg-wc-amber/30 transition-colors"
                      >
                        Check Again
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="text-center">
              <div className="text-5xl mb-4">🚀</div>
              <h2 className="text-xl font-bold text-wc-text-primary mb-2">You're All Set!</h2>
              <p className="text-sm text-wc-text-secondary leading-relaxed mb-4">
                {hasAuthAgent
                  ? 'Your agents are ready. Start your first orchestration to see WhaleCode in action.'
                  : 'Configure API keys in Settings, then start your first orchestration.'
                }
              </p>
              <div className="space-y-2 text-left bg-wc-surface rounded-xl border border-wc-border p-4">
                <div className="text-xs font-semibold text-wc-text-primary mb-2">Quick tips:</div>
                {[
                  ['⌘P', 'Open Command Palette for quick actions'],
                  ['⌘K', 'Start a quick task with any agent'],
                  ['⌘1-4', 'Switch between views instantly'],
                ].map(([key, desc]) => (
                  <div key={key} className="flex items-center gap-3 text-xs">
                    <kbd className="font-mono text-[10px] text-wc-accent-text bg-wc-accent-soft px-1.5 py-0.5 rounded border border-wc-accent/20 shrink-0">
                      {key}
                    </kbd>
                    <span className="text-wc-text-secondary">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-8 py-4 border-t border-wc-border">
          <button
            onClick={finish}
            className="text-xs text-wc-text-muted hover:text-wc-text-secondary transition-colors"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep(step - 1)}
                className="px-4 py-2 text-xs font-medium text-wc-text-secondary bg-wc-surface border border-wc-border rounded-lg hover:bg-wc-surface-hover transition-colors"
              >
                Back
              </button>
            )}
            {step < 2 ? (
              <button
                onClick={() => setStep(step + 1)}
                className="px-5 py-2 text-xs font-semibold text-white bg-wc-accent rounded-lg hover:brightness-110 transition-all"
              >
                Continue
              </button>
            ) : (
              <button
                onClick={startOrchestration}
                className="px-5 py-2 text-xs font-semibold text-white bg-wc-accent rounded-lg shadow-[0_4px_16px_rgba(99,102,241,0.3)] hover:brightness-110 transition-all"
              >
                Start First Orchestration
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
