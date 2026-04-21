/**
 * Chrome strip across the top of the window. Shows the app name, the
 * currently-loaded repo (clickable to switch), and the master-agent
 * dropdown.
 *
 * The master dropdown lists only master-capable agents (see
 * {@link MASTER_CAPABLE_AGENTS}). Phase 4 Step 1 filtered Gemini out
 * of this list — it remains available for per-subtask worker
 * assignment but is no longer a valid planner. Available entries are
 * selectable, Broken/NotInstalled are disabled with a tooltip.
 * Clicking outside or pressing Escape closes the menu.
 */

import { Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  MASTER_CAPABLE_AGENTS,
  type AgentKind,
  type AgentStatus,
} from '../../lib/ipc';
import { useAgentStore } from '../../state/agentStore';
import { useGraphStore, type GraphStatus } from '../../state/graphStore';
import { useRepoStore } from '../../state/repoStore';
import { AGENT_FULL_LABEL } from '../primitives/agentColor';
import { SettingsPanel } from './SettingsPanel';

const APP_NAME = 'WhaleCode';
const NO_REPO_LABEL = 'No repo loaded';
const NO_AGENTS_LABEL = 'No agents available';

// Mirror of `detection::RECOMMENDED_ORDER`: master-capable agents only.
// Gemini is deliberately excluded — see MASTER_CAPABLE_AGENTS.
const DROPDOWN_ORDER: readonly AgentKind[] = MASTER_CAPABLE_AGENTS;

/**
 * Statuses during which a top-level "Cancel run" affordance is offered.
 * `awaiting_human_fix` is deliberately omitted — the escalation surface on
 * the affected WorkerNode already carries an "Abort run" inline-confirm
 * (see EscalationActions); a second entry in the chrome would be
 * redundant and split the user's attention away from the worker-level
 * decision they're being asked to make.
 */
const CANCELLABLE_STATUSES: ReadonlySet<GraphStatus> = new Set<GraphStatus>([
  'planning',
  'awaiting_approval',
  'running',
  'merging',
]);

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
  const branchLabel = currentRepo?.currentBranch ?? null;
  const noAgentsAvailable = detection !== null && detection.recommendedMaster === null;
  const chipLabel = noAgentsAvailable ? NO_AGENTS_LABEL : masterName;

  const repoButtonLabel = currentRepo
    ? branchLabel
      ? `Switch repository (current: ${repoLabel} on ${branchLabel})`
      : `Switch repository from ${repoLabel}`
    : 'Open a repository';

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
          aria-label={repoButtonLabel}
          title="Open repository (⌘O)"
          data-testid="topbar-repo-label"
        >
          · {repoLabel}
          {branchLabel ? (
            <>
              <span aria-hidden> · </span>
              <span
                className="text-fg-tertiary"
                data-testid="topbar-branch-label"
                title={`Branch: ${branchLabel}`}
              >
                {branchLabel}
              </span>
            </>
          ) : null}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <CancelRunButton />
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

/**
 * Cancel-run affordance in the TopBar. Visible only while the run is in
 * one of the `CANCELLABLE_STATUSES`; hidden otherwise so the chrome
 * stays empty when there's no run to cancel.
 *
 * Split into an outer gate and an inner prompt so confirm-mode state
 * naturally resets on each new cancellable window: when `status`
 * transitions out of the set (done / cancelled / failed / …) the outer
 * returns `null`, the inner component unmounts, and the next run that
 * re-enters `planning` mounts a fresh `CancelRunPrompt` with
 * `confirming = false`. This keeps the state declaration effect-free.
 */
function CancelRunButton() {
  const status = useGraphStore((s) => s.status);
  const cancelInFlight = useGraphStore((s) => s.cancelInFlight);
  // Cancel already dispatched — show a disabled chip for the short
  // window between the user's confirm click and the backend's
  // `StatusChanged(Cancelled)`. Without this the two-step prompt
  // collapses back to the plain "Cancel run" button the instant the
  // IPC returns, which reads as "nothing happened". See Phase 3.5
  // Item 1 investigation.
  if (cancelInFlight) return <CancelInFlightChip />;
  if (!CANCELLABLE_STATUSES.has(status)) return null;
  return <CancelRunPrompt />;
}

function CancelInFlightChip() {
  return (
    <span
      className="rounded-sm border border-border-default bg-bg-elevated px-2 py-0.5 text-hint text-fg-tertiary"
      style={{ color: 'var(--color-status-failed)', borderColor: 'var(--color-status-failed)' }}
      role="status"
      aria-live="polite"
      data-testid="topbar-cancel-in-flight"
      title="Cancellation requested; cleaning up workers."
    >
      Cancelling…
    </span>
  );
}

/**
 * Inner two-step prompt. Click the unarmed button → "Cancel run? Yes / No"
 * inline. Yes calls `cancelRun`; No or a 4 s idle auto-dismiss returns to
 * the unarmed state — cancelling a running plan discards worker progress,
 * so a single click should never be enough.
 */
function CancelRunPrompt() {
  const cancelRun = useGraphStore((s) => s.cancelRun);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const arm = () => {
    setConfirming(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setConfirming(false), 4000);
  };

  const confirm = async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setBusy(true);
    try {
      await cancelRun();
    } catch {
      // `currentError` is already populated by the store action — the
      // ErrorBanner surfaces it. Swallow to avoid unhandled rejection.
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <span
        className="flex items-center gap-1 text-hint"
        data-testid="topbar-cancel-confirm"
      >
        <span style={{ color: 'var(--color-status-failed)' }}>Cancel run?</span>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy}
          className="rounded-sm border px-1 py-0.5 disabled:opacity-50"
          style={{
            borderColor: 'var(--color-status-failed)',
            color: 'var(--color-status-failed)',
          }}
          data-testid="topbar-cancel-confirm-yes"
          aria-label="Confirm cancel run"
        >
          {busy ? 'Cancelling…' : 'Yes'}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="rounded-sm border px-1 py-0.5 text-fg-tertiary disabled:opacity-50"
          style={{ borderColor: 'var(--color-border-default)' }}
          data-testid="topbar-cancel-confirm-no"
          aria-label="Keep run running"
        >
          No
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={arm}
      className="rounded-sm border border-border-default bg-bg-elevated px-2 py-0.5 text-hint text-fg-secondary transition-colors hover:border-[var(--color-status-failed)] hover:text-[var(--color-status-failed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-status-failed)]"
      data-testid="topbar-cancel-run"
      aria-label="Cancel run"
      title="Cancel run"
    >
      Cancel run
    </button>
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
