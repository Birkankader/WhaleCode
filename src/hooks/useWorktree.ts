import { useState, useCallback, useEffect } from 'react';
import { commands } from '../bindings';
import type { ConflictReport, WorktreeDiffReport } from '../bindings';

/**
 * React hook for managing git worktrees via IPC.
 *
 * Wraps all 5 worktree IPC commands (create, list, check conflicts, merge, cleanup)
 * and provides reactive state for worktree list, conflict reports, and loading status.
 */
export function useWorktree(projectDir: string) {
  const [worktrees, setWorktrees] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<ConflictReport | null>(null);
  const [diffReport, setDiffReport] = useState<WorktreeDiffReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshWorktrees = useCallback(async () => {
    if (!projectDir) return;
    setLoading(true);
    setError(null);
    try {
      const result = await commands.listWorktrees(projectDir);
      if (result.status === 'ok') {
        setWorktrees(result.data);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError('Failed to list worktrees');
    } finally {
      setLoading(false);
    }
  }, [projectDir]);

  const checkConflicts = useCallback(
    async (branchA: string, branchB: string) => {
      if (!projectDir) return;
      setLoading(true);
      setError(null);
      try {
        const result = await commands.checkWorktreeConflicts(projectDir, branchA, branchB);
        if (result.status === 'ok') {
          setConflicts(result.data);
        } else {
          setError(result.error);
        }
      } catch (err) {
        setError('Failed to check conflicts');
      } finally {
        setLoading(false);
      }
    },
    [projectDir],
  );

  const mergeWorktree = useCallback(
    async (branchName: string) => {
      if (!projectDir) return;
      setLoading(true);
      setError(null);
      try {
        const result = await commands.mergeWorktree(projectDir, branchName, null);
        if (result.status === 'ok') {
          setConflicts(null);
          await refreshWorktrees();
        } else {
          setError(result.error);
        }
      } catch (err) {
        setError('Failed to merge worktree');
      } finally {
        setLoading(false);
      }
    },
    [projectDir, refreshWorktrees],
  );

  const getWorktreeDiff = useCallback(
    async (branchName: string): Promise<WorktreeDiffReport | null> => {
      if (!projectDir) return null;
      setLoading(true);
      setError(null);
      try {
        const result = await commands.getWorktreeDiff(projectDir, branchName);
        if (result.status === 'ok') {
          setDiffReport(result.data);
          return result.data;
        } else {
          setError(result.error);
          return null;
        }
      } catch (err) {
        setError('Failed to get worktree diff');
        return null;
      } finally {
        setLoading(false);
      }
    },
    [projectDir],
  );

  const selectiveMerge = useCallback(
    async (branchName: string, acceptedFiles: string[]) => {
      if (!projectDir) return;
      setLoading(true);
      setError(null);
      try {
        const result = await commands.mergeWorktree(projectDir, branchName, acceptedFiles);
        if (result.status === 'ok') {
          setConflicts(null);
          setDiffReport(null);
          await refreshWorktrees();
        } else {
          setError(result.error);
        }
      } catch (err) {
        setError('Failed to merge selected files');
      } finally {
        setLoading(false);
      }
    },
    [projectDir, refreshWorktrees],
  );

  const cleanupWorktrees = useCallback(async () => {
    if (!projectDir) return;
    setLoading(true);
    setError(null);
    try {
      const result = await commands.cleanupWorktrees(projectDir);
      if (result.status === 'ok') {
        await refreshWorktrees();
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError('Failed to cleanup worktrees');
    } finally {
      setLoading(false);
    }
  }, [projectDir, refreshWorktrees]);

  // Refresh worktree list on mount and when projectDir changes
  useEffect(() => {
    if (projectDir) {
      refreshWorktrees();
    }
  }, [projectDir, refreshWorktrees]);

  return {
    worktrees,
    conflicts,
    diffReport,
    loading,
    error,
    refreshWorktrees,
    checkConflicts,
    mergeWorktree,
    getWorktreeDiff,
    selectiveMerge,
    cleanupWorktrees,
  };
}
