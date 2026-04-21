import { useRepoStore } from '../../state/repoStore';

const TITLE = 'No repo loaded';
const HINT =
  'WhaleCode needs a git repository to work in. Pick the folder you want your AI team to operate on.';

// Cmd+O is bound globally from App.tsx so it works both here and in the
// normal graph view; this component just renders the overlay + button.
export function RepoPicker() {
  const pickInteractively = useRepoStore((s) => s.pickInteractively);
  const pickerError = useRepoStore((s) => s.pickerError);

  return (
    <div className="flex h-full w-full items-center justify-center px-6">
      <div className="flex w-full max-w-[480px] flex-col items-center text-center">
        <h2 className="text-title font-medium text-fg-primary">{TITLE}</h2>
        <p className="mt-3 text-meta text-fg-tertiary">{HINT}</p>

        <button
          type="button"
          onClick={pickInteractively}
          className="mt-10 rounded-md border border-border-default bg-bg-elevated px-5 py-3 text-[14px] font-medium text-fg-primary transition-colors hover:bg-bg-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-agent-master)]"
          aria-label="Open a repository"
        >
          Open folder
        </button>

        <div className="mt-3 flex items-center gap-2 text-hint text-fg-tertiary">
          <KeyChip>⌘O</KeyChip>
          <span>to open</span>
        </div>

        {pickerError && (
          <p
            className="mt-6 rounded-sm border border-border-default bg-bg-elevated px-3 py-2 text-hint text-fg-secondary"
            role="alert"
          >
            {pickerError}
          </p>
        )}
      </div>
    </div>
  );
}

function KeyChip({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-border-default bg-bg-elevated px-1.5 py-0.5 text-hint text-fg-secondary">
      {children}
    </span>
  );
}
