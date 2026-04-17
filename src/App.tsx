import { useEffect } from 'react';

import { GraphCanvas } from './components/graph/GraphCanvas';
import { useGraphStore } from './state/graphStore';

/**
 * Step 5 shell: just the canvas, full viewport. A dev-only mock seed puts
 * master + three workers + final on screen so Dagre placement is verifiable.
 * Steps 7–10 replace this with the real TopBar / EmptyState / ApprovalBar /
 * Footer and drop the seed.
 */
export default function App() {
  useEffect(() => {
    const { status, submitTask, proposeSubtasks, approveSubtasks } = useGraphStore.getState();
    if (status !== 'idle') return;
    submitTask('Scaffold a TODO app with tests and docs', 'master');
    proposeSubtasks([
      { id: 'auth', title: 'Auth scaffold', agent: 'claude', dependsOn: [] },
      { id: 'tests', title: 'Write tests', agent: 'gemini', dependsOn: ['auth'] },
      { id: 'docs', title: 'Docs', agent: 'codex', dependsOn: [] },
    ]);
    approveSubtasks(['auth', 'tests', 'docs']);
    useGraphStore.getState().updateSubtaskState('auth', { type: 'START' });
  }, []);

  return (
    <main className="h-screen w-screen bg-bg-primary text-fg-primary">
      <GraphCanvas />
    </main>
  );
}
