import { useEffect } from 'react';

import { ApprovalBar } from './components/approval/ApprovalBar';
import { GraphCanvas } from './components/graph/GraphCanvas';
import { AgentSetupState } from './components/setup/AgentSetupState';
import { AutoApproveSuspendedBanner } from './components/shell/AutoApproveSuspendedBanner';
import { EmptyState } from './components/shell/EmptyState';
import { ErrorBanner } from './components/shell/ErrorBanner';
import { Footer } from './components/shell/Footer';
import { RepoPicker } from './components/shell/RepoPicker';
import { TopBar } from './components/shell/TopBar';
import { WindowTooSmall } from './components/shell/WindowTooSmall';
import { useRepoPickerShortcut } from './hooks/useRepoPickerShortcut';
import { consumeRecoveryReport } from './lib/ipc';
import { useAgentStore } from './state/agentStore';
import { useGraphStore } from './state/graphStore';
import { useRepoStore } from './state/repoStore';

export default function App() {
  const status = useGraphStore((s) => s.status);
  const initializing = useRepoStore((s) => s.initializing);
  const currentRepo = useRepoStore((s) => s.currentRepo);
  const init = useRepoStore((s) => s.init);
  const pickInteractively = useRepoStore((s) => s.pickInteractively);
  const detection = useAgentStore((s) => s.detection);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    // Boot-time heads-up for crash recovery. The backend already
    // marked any active-at-crash runs as `Failed` and swept their
    // worktrees in `lib.rs` setup; we just consume the report and
    // surface a banner so the user knows something happened —
    // silently cleaning behind the user was the prior UX gap that
    // made "recovery" feel invisible. Read-once by contract, so
    // StrictMode's double-fire is harmless: the second run gets
    // `[]` and does nothing.
    void consumeRecoveryReport()
      .then((entries) => {
        if (entries.length === 0) return;
        const label =
          entries.length === 1
            ? `Previous run "${entries[0].task}" was interrupted at ${entries[0].repoPath} and has been marked failed. Worktrees cleaned up — you can start a fresh task.`
            : `${entries.length} previous runs were interrupted and have been marked failed. Worktrees cleaned up — you can start a fresh task.`;
        useGraphStore.setState({ currentError: label });
      })
      .catch((err) => {
        // Best-effort: the banner is a nicety, not a correctness
        // requirement. Log and move on — the user still has a
        // working app, just no recovery notice.
        console.error('[App] consumeRecoveryReport failed', err);
      });
  }, []);

  useRepoPickerShortcut(pickInteractively);

  // No-agents case takes priority once detection has completed: without a
  // working CLI, picking a repo is pointless. Before detection resolves the
  // first time, keep the regular flow (repo picker / canvas) — the setup
  // screen flashing up for a beat on boot would be worse than a brief wait.
  const noAgentsAvailable =
    detection !== null && detection.recommendedMaster === null;

  let body: React.ReactNode;
  if (initializing) {
    body = null;
  } else if (noAgentsAvailable) {
    body = <AgentSetupState />;
  } else if (!currentRepo) {
    body = <RepoPicker />;
  } else if (status === 'idle' || status === 'applied' || status === 'cancelled') {
    // `cancelled` routes back to EmptyState like `idle`/`applied`: the
    // user explicitly stopped the run, so there's nothing to inspect
    // — preserving the dead graph just left them staring at a
    // tombstone with no obvious next action (Bug #5 follow-up). The
    // store still carries the final subtasks/logs/snapshots, but the
    // UI surfaces a fresh task input and lets them move on.
    body = <EmptyState />;
  } else {
    body = <GraphCanvas />;
  }

  return (
    <WindowTooSmall>
      <div className="flex h-screen w-screen flex-col bg-bg-primary text-fg-primary">
        <TopBar />
        <main className="relative flex flex-1 flex-col overflow-hidden">
          <ErrorBanner />
          <AutoApproveSuspendedBanner />
          <div className="relative flex-1 overflow-hidden">{body}</div>
          <ApprovalBar />
        </main>
        <Footer />
      </div>
    </WindowTooSmall>
  );
}
