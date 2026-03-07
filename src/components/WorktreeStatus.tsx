import { useWorktree } from '../hooks/useWorktree';
import { ConflictAlert } from './ConflictAlert';

/**
 * Active worktree list with merge controls.
 *
 * Shows all active whalecode worktrees for a project directory, with:
 * - "Check Conflicts" button per worktree pair
 * - "Merge" button per worktree (disabled when conflicts exist — SAFE-04 visual gate)
 * - "Cleanup Stale" button for crash recovery
 * - ConflictAlert banner when conflict check returns positive
 * - Loading spinner during IPC calls
 */
export function WorktreeStatus({ projectDir }: { projectDir: string }) {
  const {
    worktrees,
    conflicts,
    loading,
    error,
    checkConflicts,
    mergeWorktree,
    cleanupWorktrees,
    refreshWorktrees,
  } = useWorktree(projectDir);

  /**
   * Extract branch name from worktree name.
   * Worktree name: whalecode-{prefix} -> Branch: whalecode/task/{prefix}
   */
  const branchFromWorktree = (wtName: string): string => {
    const prefix = wtName.startsWith('whalecode-')
      ? wtName.slice('whalecode-'.length)
      : wtName;
    return `whalecode/task/${prefix}`;
  };

  const handleCheckConflicts = async (wtA: string, wtB: string) => {
    const branchA = branchFromWorktree(wtA);
    const branchB = branchFromWorktree(wtB);
    await checkConflicts(branchA, branchB);
  };

  const handleMerge = async (wtName: string) => {
    const branchName = branchFromWorktree(wtName);
    await mergeWorktree(branchName);
  };

  const hasConflicts = conflicts?.has_conflicts ?? false;

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/50">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-200">Active Worktrees</h3>
          <span className="px-1.5 py-0.5 text-xs rounded bg-zinc-700 text-zinc-300">
            {worktrees.length}
          </span>
        </div>
        <button
          onClick={refreshWorktrees}
          disabled={loading}
          className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-50 transition-colors"
          title="Refresh worktree list"
        >
          Refresh
        </button>
      </div>

      {/* Loading indicator */}
      {loading && (
        <div className="px-4 py-2 text-xs text-zinc-500 flex items-center gap-2">
          <span className="inline-block w-3 h-3 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
          Loading...
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 text-xs text-red-400 bg-red-900/20 border-b border-red-800/30">
          {error}
        </div>
      )}

      {/* Conflict alert */}
      {conflicts && (
        <div className="px-4 py-3 border-b border-zinc-800">
          <ConflictAlert conflicts={conflicts} />
        </div>
      )}

      {/* Worktree list */}
      <div className="divide-y divide-zinc-800/50">
        {worktrees.length === 0 && !loading ? (
          <div className="px-4 py-6 text-center text-xs text-zinc-600">
            No active worktrees.
          </div>
        ) : (
          worktrees.map((wt, idx) => (
            <div key={wt} className="flex items-center justify-between px-4 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                <span className="text-xs font-mono text-zinc-300 truncate">{wt}</span>
              </div>

              <div className="flex items-center gap-2 shrink-0 ml-3">
                {/* Check Conflicts: only show when there are 2+ worktrees */}
                {worktrees.length >= 2 && (
                  <select
                    onChange={(e) => {
                      if (e.target.value) {
                        handleCheckConflicts(wt, e.target.value);
                        e.target.value = '';
                      }
                    }}
                    defaultValue=""
                    disabled={loading}
                    className="px-2 py-1 text-xs rounded bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600 disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    <option value="" disabled>
                      Check vs...
                    </option>
                    {worktrees
                      .filter((_, i) => i !== idx)
                      .map((other) => (
                        <option key={other} value={other}>
                          {other}
                        </option>
                      ))}
                  </select>
                )}

                {/* Merge button — disabled when conflicts exist (SAFE-04) */}
                <button
                  onClick={() => handleMerge(wt)}
                  disabled={loading || hasConflicts}
                  className="px-3 py-1 text-xs rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  title={
                    hasConflicts
                      ? 'Resolve conflicts before merging'
                      : `Merge ${wt} into default branch`
                  }
                >
                  Merge
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Cleanup button - only shown when worktrees exist */}
      {worktrees.length > 0 && (
        <div className="px-4 py-3 border-t border-zinc-800">
          <button
            onClick={cleanupWorktrees}
            disabled={loading}
            className="px-3 py-1.5 text-xs rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300 disabled:opacity-50 transition-colors"
          >
            Cleanup Stale Worktrees
          </button>
        </div>
      )}
    </div>
  );
}
