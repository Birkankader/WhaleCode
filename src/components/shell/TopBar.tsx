import { useGraphStore } from '../../state/graphStore';
import { useRepoStore } from '../../state/repoStore';
import { AGENT_FULL_LABEL } from '../primitives/agentColor';

const APP_NAME = 'WhaleCode';
const NO_REPO_LABEL = 'No repo loaded';

export function TopBar() {
  const masterAgent = useGraphStore((s) => s.masterNode?.agent ?? s.selectedMasterAgent);
  const masterName = AGENT_FULL_LABEL[masterAgent];
  const currentRepo = useRepoStore((s) => s.currentRepo);
  const pickInteractively = useRepoStore((s) => s.pickInteractively);

  const repoLabel = currentRepo?.name ?? NO_REPO_LABEL;

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
        <span className="text-hint text-fg-tertiary">Master:</span>
        <button
          type="button"
          onClick={() => {
            // Phase 2 wires the agent selector dropdown here.
          }}
          className="rounded-sm border border-border-default bg-bg-elevated px-2 py-0.5 text-hint text-fg-primary transition-colors hover:bg-bg-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-agent-master)]"
          aria-label={`Master agent: ${masterName}`}
        >
          {masterName}
        </button>
      </div>
    </header>
  );
}
