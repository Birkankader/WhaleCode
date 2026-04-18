import { useEffect } from 'react';

import { ApprovalBar } from './components/approval/ApprovalBar';
import { GraphCanvas } from './components/graph/GraphCanvas';
import { EmptyState } from './components/shell/EmptyState';
import { Footer } from './components/shell/Footer';
import { RepoPicker } from './components/shell/RepoPicker';
import { TopBar } from './components/shell/TopBar';
import { WindowTooSmall } from './components/shell/WindowTooSmall';
import { useRepoPickerShortcut } from './hooks/useRepoPickerShortcut';
import { useGraphStore } from './state/graphStore';
import { useRepoStore } from './state/repoStore';

export default function App() {
  const status = useGraphStore((s) => s.status);
  const initializing = useRepoStore((s) => s.initializing);
  const currentRepo = useRepoStore((s) => s.currentRepo);
  const init = useRepoStore((s) => s.init);
  const pickInteractively = useRepoStore((s) => s.pickInteractively);

  useEffect(() => {
    init();
  }, [init]);

  useRepoPickerShortcut(pickInteractively);

  let body: React.ReactNode;
  if (initializing) {
    body = null;
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
        <main className="relative flex-1 overflow-hidden">
          {body}
          <ApprovalBar />
        </main>
        <Footer />
      </div>
    </WindowTooSmall>
  );
}
