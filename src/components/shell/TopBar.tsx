/**
 * Chrome strip across the top of the window. Shows the app name, the
 * currently-loaded repo (clickable to switch), and the master-agent
 * dropdown.
 *
 * The master dropdown is the only place (in Phase 2) where the user
 * changes their master agent. It lists all three kinds regardless of
 * availability: Available ones are selectable, Broken/NotInstalled are
 * disabled with a tooltip explaining why. Clicking outside or pressing
 * Escape closes the menu.
 */

import { Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { type AgentKind, type AgentStatus } from '../../lib/ipc';
import { useAgentStore } from '../../state/agentStore';
import { useGraphStore } from '../../state/graphStore';
import { useRepoStore } from '../../state/repoStore';
import { AGENT_FULL_LABEL } from '../primitives/agentColor';
import { SettingsPanel } from './SettingsPanel';

const APP_NAME = 'WhaleCode';
const NO_REPO_LABEL = 'No repo loaded';
const NO_AGENTS_LABEL = 'No agents available';

const DROPDOWN_ORDER: AgentKind[] = ['claude', 'codex', 'gemini'];

export function TopBar() {
  const masterAgent = useGraphStore((s) => s.masterNode?.agent ?? s.selectedMasterAgent);
  const masterName = AGENT_FULL_LABEL[masterAgent];

  const currentRepo = useRepoStore((s) => s.currentRepo);
  const pickInteractively = useRepoStore((s) => s.pickInteractively);
  const autoApprove = useRepoStore((s) => s.settings?.autoApprove ?? false);

  const detection = useAgentStore((s) => s.detection);
  const checking = useAgentStore((s) => s.checking);
  const selectMaster = useAgentStore((s) => s.selectMaster);

  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const repoLabel = currentRepo?.name ?? NO_REPO_LABEL;
  const noAgentsAvailable = detection !== null && detection.recommendedMaster === null;
  const chipLabel = noAgentsAvailable ? NO_AGENTS_LABEL : masterName;

  async function handleSelect(agent: AgentKind) {
    setOpen(false);
    if (agent === masterAgent) return;
    await selectMaster(agent);
  }

  return (
    <header
      className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle px-4"
      role="banner"
    >
      <div className="flex items-center gap-3">
        <span
          className="block size-1.5 rounded-full"
          style={{ background: 'var(--color-agent-master)' }}
          aria-hidden
        />
        <span className="text-[13px] font-medium text-fg-primary">{APP_NAME}</span>
        <button
          type="button"
          onClick={pickInteractively}
          className="-mx-1 rounded-sm px-1 py-0.5 text-meta text-fg-tertiary transition-colors hover:bg-bg-subtle hover:text-fg-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-agent-master)]"
          aria-label={currentRepo ? `Switch repository from ${repoLabel}` : 'Open a repository'}
          title="Open repository (⌘O)"
        >
          · {repoLabel}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex items-center gap-2" ref={menuRef}>
          <span className="text-hint text-fg-tertiary">Master:</span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-sm border border-border-default bg-bg-elevated px-2 py-0.5 text-hint text-fg-primary transition-colors hover:bg-bg-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-agent-master)] disabled:cursor-not-allowed disabled:text-fg-tertiary"
            disabled={noAgentsAvailable}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`Master agent: ${chipLabel}`}
          >
            {chipLabel}
            {checking && detection === null && <span className="ml-1 text-fg-tertiary">…</span>}
          </button>

          {autoApprove ? (
            <span
              data-testid="auto-approve-badge"
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-hint"
              style={{
                color: 'var(--color-agent-master)',
                background: 'rgba(251, 191, 36, 0.1)',
              }}
              title="Auto-approve is on. Plans skip the approval bar."
              aria-label="Auto-approve enabled"
            >
              <span
                className="block size-1.5 rounded-full"
                style={{ background: 'var(--color-agent-master)' }}
                aria-hidden
              />
              Auto
            </span>
          ) : null}

          {open && (
            <div
              role="menu"
              aria-label="Select master agent"
              className="absolute right-0 top-full z-10 mt-1 min-w-[180px] rounded-md border border-border-default bg-bg-elevated p-1 shadow-lg"
            >
              {DROPDOWN_ORDER.map((kind) => (
                <DropdownItem
                  key={kind}
                  kind={kind}
                  status={detection?.[kind]}
                  isSelected={kind === masterAgent}
                  onSelect={handleSelect}
                />
              ))}
            </div>
          )}
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-label="Settings"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            className="inline-flex size-7 items-center justify-center rounded-sm text-fg-tertiary transition-colors hover:bg-bg-subtle hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-agent-master)]"
          >
            <SettingsIcon size={14} />
          </button>
          {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
        </div>
      </div>
    </header>
  );
}

function DropdownItem({
  kind,
  status,
  isSelected,
  onSelect,
}: {
  kind: AgentKind;
  status: AgentStatus | undefined;
  isSelected: boolean;
  onSelect: (agent: AgentKind) => void;
}) {
  const label = AGENT_FULL_LABEL[kind];
  const disabled = status?.status !== 'available';
  let tooltip: string | undefined;
  if (status?.status === 'broken') tooltip = `Broken: ${status.error}`;
  else if (status?.status === 'not-installed') tooltip = 'Not installed';

  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        if (!disabled) onSelect(kind);
      }}
      disabled={disabled}
      title={tooltip}
      aria-disabled={disabled}
      aria-current={isSelected ? 'true' : undefined}
      className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-hint text-fg-primary transition-colors hover:bg-bg-subtle disabled:cursor-not-allowed disabled:text-fg-tertiary disabled:hover:bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-agent-master)]"
    >
      <span>{label}</span>
      <span className="text-fg-tertiary">
        {status?.status === 'available' && status.version}
        {status?.status === 'broken' && 'broken'}
        {status?.status === 'not-installed' && 'missing'}
      </span>
    </button>
  );
}
