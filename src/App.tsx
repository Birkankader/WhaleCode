import { useEffect } from 'react';

import { ApprovalBar } from './components/approval/ApprovalBar';
import { GraphCanvas } from './components/graph/GraphCanvas';
import { AgentSetupState } from './components/setup/AgentSetupState';
import { EmptyState } from './components/shell/EmptyState';
import { ErrorBanner } from './components/shell/ErrorBanner';
import { Footer } from './components/shell/Footer';
import { RepoPicker } from './components/shell/RepoPicker';
import { TopBar } from './components/shell/TopBar';
import { WindowTooSmall } from './components/shell/WindowTooSmall';
import { useRepoPickerShortcut } from './hooks/useRepoPickerShortcut';
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
  } else if (status === 'idle' || status === 'applied') {
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
          <div className="relative flex-1 overflow-hidden">{body}</div>
          <ApprovalBar />
        </main>
        <Footer />
      </div>
    </WindowTooSmall>
  );
}
