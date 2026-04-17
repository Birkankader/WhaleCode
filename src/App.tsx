/*
 * Placeholder scaffold. Step 10 of docs/phase-1-spec.md will replace this
 * with the real App shell (TopBar, EmptyState/GraphCanvas switch, ApprovalBar,
 * Footer). For now we render a minimal dark-canvas smoke test so we can
 * verify Tailwind v4 tokens load correctly.
 */
export default function App() {
  return (
    <main className="flex h-screen items-center justify-center bg-bg-primary text-fg-primary font-mono">
      <div className="space-y-4 text-center">
        <h1 className="text-hero font-medium">WhaleCode</h1>
        <p className="text-body text-fg-secondary">Your AI team, orchestrated visually</p>
        <p className="text-meta text-fg-tertiary">v2 scaffold — Phase 1 in progress</p>
      </div>
    </main>
  );
}
