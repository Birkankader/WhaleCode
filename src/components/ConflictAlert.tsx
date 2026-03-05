import type { ConflictReport } from '../bindings';

/**
 * Conflict warning banner that displays file-level conflict details.
 *
 * SAFE-03: Shows which files conflict and between which worktree branches,
 * prompting the user to resolve conflicts before merging.
 *
 * Renders nothing when no conflicts exist.
 */
export function ConflictAlert({ conflicts }: { conflicts: ConflictReport | null }) {
  if (!conflicts || !conflicts.has_conflicts) {
    return null;
  }

  return (
    <div className="rounded border border-yellow-700/50 bg-yellow-900/30 px-4 py-3">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-yellow-400 shrink-0"
        >
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className="text-sm font-semibold text-yellow-300">Conflict Detected</span>
      </div>

      {/* Task identifiers */}
      <p className="text-xs text-yellow-200/80 mb-2">
        Between <span className="font-mono text-yellow-200">{conflicts.worktree_a}</span> and{' '}
        <span className="font-mono text-yellow-200">{conflicts.worktree_b}</span>
      </p>

      {/* Description */}
      <p className="text-xs text-zinc-400 mb-2">
        The following files were modified by both tasks:
      </p>

      {/* File list */}
      <ul className="space-y-1 mb-3">
        {conflicts.conflicting_files.map((file) => (
          <li key={file.path} className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 shrink-0" />
            <span className="text-xs font-mono text-zinc-300">{file.path}</span>
          </li>
        ))}
      </ul>

      {/* Footer */}
      <p className="text-xs text-zinc-500">
        Resolve conflicts before merging to main.
      </p>
    </div>
  );
}
