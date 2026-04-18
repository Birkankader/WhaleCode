import { ApprovalBar } from './components/approval/ApprovalBar';
import { GraphCanvas } from './components/graph/GraphCanvas';
import { EmptyState } from './components/shell/EmptyState';
import { Footer } from './components/shell/Footer';
import { TopBar } from './components/shell/TopBar';
import { useGraphStore } from './state/graphStore';

export default function App() {
  const status = useGraphStore((s) => s.status);

  return (
    <div className="flex h-screen w-screen flex-col bg-bg-primary text-fg-primary">
      <TopBar />
      <main className="relative flex-1 overflow-hidden">
        {status === 'idle' ? <EmptyState /> : <GraphCanvas />}
        <ApprovalBar />
      </main>
      <Footer />
    </div>
  );
}
