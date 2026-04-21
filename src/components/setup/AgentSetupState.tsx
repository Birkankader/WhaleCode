/**
 * Shown when no master-capable agent is Available — the user can't
 * orchestrate anything until at least one of the master-capable CLIs
 * (Claude Code or Codex) is installed on PATH (or pointed at via
 * settings). Gemini is rendered here too for completeness but tagged
 * as "worker-only" — installing it alone does not dismiss this
 * screen.
 *
 * Replaces the canvas body while keeping the TopBar/ApprovalBar chrome.
 * Each card is one agent: its current status, the install command copied
 * straight from the upstream docs, and a shared Recheck button that
 * re-runs detect_agents.
 *
 * Recheck is debounced by the store's in-flight coalescing — mashing it
 * won't fan out to multiple backend calls. The button is disabled while
 * `checking` is true so the user gets immediate feedback.
 */

import { isMasterCapable, type AgentKind, type AgentStatus } from '../../lib/ipc';
import { useAgentStore } from '../../state/agentStore';
import { AGENT_FULL_LABEL } from '../primitives/agentColor';

const TITLE = 'No master agent available';
const HINT =
  'WhaleCode needs Claude Code or Codex as your master. Install one of them, then recheck. Gemini is supported as a worker — you can assign it per subtask once a master is available.';

const INSTALL_COMMANDS: Record<AgentKind, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  gemini: 'npm install -g @google/gemini-cli',
};

const DOCS_HINT: Record<AgentKind, string> = {
  claude: 'Requires a Claude Pro / Max / API account.',
  codex: 'Requires an OpenAI API key on first launch.',
  gemini: 'Requires a Google AI Studio key. Worker-only — not a master.',
};

const ORDER: AgentKind[] = ['claude', 'codex', 'gemini'];

export function AgentSetupState() {
  const detection = useAgentStore((s) => s.detection);
  const checking = useAgentStore((s) => s.checking);
  const refresh = useAgentStore((s) => s.refresh);
  const error = useAgentStore((s) => s.error);

  return (
    <div
      className="flex h-full w-full items-start justify-center overflow-y-auto px-6 py-12"
      role="region"
      aria-label="Agent setup"
    >
      <div className="flex w-full max-w-[640px] flex-col">
        <h2 className="text-title font-medium text-fg-primary">{TITLE}</h2>
        <p className="mt-3 text-meta text-fg-tertiary">{HINT}</p>

        <div className="mt-10 flex flex-col gap-3">
          {ORDER.map((kind) => (
            <AgentCard
              key={kind}
              kind={kind}
              status={detection?.[kind]}
            />
          ))}
        </div>

        <div className="mt-8 flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
            disabled={checking}
            className="rounded-md border border-border-default bg-bg-elevated px-4 py-2 text-hint font-medium text-fg-primary transition-colors hover:bg-bg-subtle disabled:cursor-not-allowed disabled:text-fg-tertiary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-agent-master)]"
            aria-label="Recheck installed agents"
          >
            {checking ? 'Checking…' : 'Recheck'}
          </button>
          {error && (
            <span className="text-hint text-fg-tertiary" role="alert">
              {error}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentCard({ kind, status }: { kind: AgentKind; status: AgentStatus | undefined }) {
  const label = AGENT_FULL_LABEL[kind];
  const install = INSTALL_COMMANDS[kind];
  const hint = DOCS_HINT[kind];
  const workerOnly = !isMasterCapable(kind);

  return (
    <article
      className="rounded-md border border-border-subtle bg-bg-elevated p-4"
      data-testid={`agent-card-${kind}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[14px] font-medium text-fg-primary">{label}</h3>
          {workerOnly ? (
            <span
              className="rounded-sm border border-border-subtle px-1.5 py-0.5 text-hint text-fg-tertiary"
              data-testid={`agent-card-${kind}-worker-only`}
              title="Not supported as a master agent. Can still be assigned to individual subtasks."
              aria-label="Worker-only agent"
            >
              Worker-only
            </span>
          ) : null}
        </div>
        <StatusBadge status={status} />
      </div>

      <p className="mt-2 text-hint text-fg-tertiary">{hint}</p>

      <pre className="mt-3 overflow-x-auto rounded-sm border border-border-subtle bg-bg-primary px-3 py-2 text-hint text-fg-secondary">
        <code>{install}</code>
      </pre>

      {status?.status === 'broken' && (
        <p className="mt-3 text-hint text-fg-tertiary" role="alert">
          Error: {status.error}
        </p>
      )}
    </article>
  );
}

function StatusBadge({ status }: { status: AgentStatus | undefined }) {
  if (!status) {
    return (
      <span className="text-hint text-fg-tertiary" aria-label="Status: checking">
        Checking…
      </span>
    );
  }
  switch (status.status) {
    case 'available':
      return (
        <span
          className="rounded-sm bg-bg-primary px-2 py-0.5 text-hint text-fg-secondary"
          aria-label={`Status: available (${status.version})`}
        >
          Available · {status.version}
        </span>
      );
    case 'broken':
      return (
        <span
          className="rounded-sm bg-bg-primary px-2 py-0.5 text-hint text-fg-secondary"
          aria-label="Status: broken"
        >
          Broken
        </span>
      );
    case 'not-installed':
      return (
        <span
          className="rounded-sm bg-bg-primary px-2 py-0.5 text-hint text-fg-tertiary"
          aria-label="Status: not installed"
        >
          Not installed
        </span>
      );
  }
}
