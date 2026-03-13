import { useState, useCallback, useEffect } from 'react';
import { commands } from '../bindings';
import type { GitStatusReport, GitLogEntry, GitPullResult, GitPushResult } from '../bindings';

export function useGitStatus(projectDir: string) {
  const [status, setStatus] = useState<GitStatusReport | null>(null);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [expandedDiffs, setExpandedDiffs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectDir) return;
    setLoading(true);
    setError(null);
    try {
      const [statusResult, logResult] = await Promise.all([
        commands.gitStatus(projectDir),
        commands.gitLog(projectDir, 10),
      ]);
      if (statusResult.status === 'ok') setStatus(statusResult.data);
      else setError(statusResult.error as string);
      if (logResult.status === 'ok') setLog(logResult.data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectDir]);

  useEffect(() => { refresh(); }, [refresh]);

  const stageFiles = useCallback(async (paths: string[]) => {
    const result = await commands.gitStageFiles(projectDir, paths);
    if (result.status === 'ok') await refresh();
    else setError(result.error as string);
  }, [projectDir, refresh]);

  const unstageFiles = useCallback(async (paths: string[]) => {
    const result = await commands.gitUnstageFiles(projectDir, paths);
    if (result.status === 'ok') await refresh();
    else setError(result.error as string);
  }, [projectDir, refresh]);

  const commit = useCallback(async (message: string) => {
    const result = await commands.gitCommit(projectDir, message);
    if (result.status === 'ok') {
      await refresh();
      return result.data;
    }
    setError(result.error as string);
    return null;
  }, [projectDir, refresh]);

  const pull = useCallback(async (): Promise<GitPullResult | null> => {
    const result = await commands.gitPull(projectDir);
    if (result.status === 'ok') {
      await refresh();
      return result.data;
    }
    setError(result.error as string);
    return null;
  }, [projectDir, refresh]);

  const push = useCallback(async (): Promise<GitPushResult | null> => {
    const result = await commands.gitPush(projectDir);
    if (result.status === 'ok') {
      await refresh();
      return result.data;
    }
    setError(result.error as string);
    return null;
  }, [projectDir, refresh]);

  const toggleDiff = useCallback(async (filePath: string) => {
    if (expandedDiffs[filePath] !== undefined) {
      setExpandedDiffs(prev => {
        const next = { ...prev };
        delete next[filePath];
        return next;
      });
      return;
    }
    const result = await commands.gitDiffFile(projectDir, filePath);
    if (result.status === 'ok') {
      setExpandedDiffs(prev => ({ ...prev, [filePath]: result.data }));
    }
  }, [projectDir, expandedDiffs]);

  return {
    status, log, expandedDiffs, loading, error,
    refresh, stageFiles, unstageFiles, commit, pull, push, toggleDiff,
  };
}
