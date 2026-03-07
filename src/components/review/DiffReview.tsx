import { useState, useEffect, useMemo } from 'react';
import { useWorktree } from '../../hooks/useWorktree';
import { FileDiffView } from './FileDiffView';
import type { FileDiff } from '../../bindings';

interface DiffReviewProps {
  projectDir: string;
  branchName: string;
  taskId: string;
  onClose: () => void;
}

/** Status icon and color for a file diff entry. */
function statusIcon(status: string): { icon: string; color: string } {
  switch (status) {
    case 'added':
      return { icon: '+', color: 'text-green-400' };
    case 'deleted':
      return { icon: 'D', color: 'text-red-400' };
    case 'renamed':
      return { icon: 'R', color: 'text-yellow-400' };
    case 'modified':
    default:
      return { icon: 'M', color: 'text-blue-400' };
  }
}

/**
 * Diff review panel with file list sidebar and unified diff viewer.
 *
 * Allows users to accept/reject individual files before merging.
 * No auto-merge -- every merge requires explicit user action.
 */
export function DiffReview({ projectDir, branchName, taskId: _taskId, onClose }: DiffReviewProps) {
  const { diffReport, loading, error, getWorktreeDiff, selectiveMerge, cleanupWorktrees } =
    useWorktree(projectDir);

  const [acceptedFiles, setAcceptedFiles] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  // Fetch diff on mount
  useEffect(() => {
    getWorktreeDiff(branchName);
  }, [branchName, getWorktreeDiff]);

  // Initialize acceptedFiles when diffReport arrives (default: accept all)
  useEffect(() => {
    if (diffReport?.files) {
      setAcceptedFiles(new Set(diffReport.files.map((f) => f.path)));
      if (diffReport.files.length > 0 && !selectedFile) {
        setSelectedFile(diffReport.files[0].path);
      }
    }
  }, [diffReport]); // eslint-disable-line react-hooks/exhaustive-deps

  const files = diffReport?.files ?? [];

  const selectedDiff: FileDiff | undefined = useMemo(
    () => files.find((f) => f.path === selectedFile),
    [files, selectedFile],
  );

  const acceptedCount = acceptedFiles.size;
  const rejectedCount = files.length - acceptedCount;

  const toggleFile = (path: string) => {
    setAcceptedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const selectAll = () => {
    setAcceptedFiles(new Set(files.map((f) => f.path)));
  };

  const deselectAll = () => {
    setAcceptedFiles(new Set());
  };

  const handleMerge = async () => {
    if (acceptedFiles.size === 0) {
      const discardAll = window.confirm(
        'No files are accepted. Discard all changes from this task?',
      );
      if (!discardAll) return;
      await cleanupWorktrees();
      onClose();
      return;
    }

    const confirmed = window.confirm(
      `Merge ${acceptedCount} file${acceptedCount !== 1 ? 's' : ''}? ${rejectedCount > 0 ? `${rejectedCount} file${rejectedCount !== 1 ? 's' : ''} will be discarded.` : ''}`,
    );
    if (!confirmed) return;

    setMerging(true);
    try {
      await selectiveMerge(branchName, Array.from(acceptedFiles));
      onClose();
    } finally {
      setMerging(false);
    }
  };

  const handleDiscard = async () => {
    const confirmed = window.confirm('Discard all changes from this task?');
    if (!confirmed) return;

    setMerging(true);
    try {
      await cleanupWorktrees();
      onClose();
    } finally {
      setMerging(false);
    }
  };

  // Loading state
  if (loading && !diffReport) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-400">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-zinc-500 border-t-zinc-200 rounded-full animate-spin" />
          <span className="text-sm">Loading diff...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-400">
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={() => getWorktreeDiff(branchName)}
          className="px-3 py-1.5 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900/60">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-200">Review Changes</span>
          <span className="text-xs text-zinc-500">
            {diffReport?.branch_name} &rarr; {diffReport?.default_branch}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span className="text-green-400">+{diffReport?.total_additions ?? 0}</span>
          <span className="text-red-400">-{diffReport?.total_deletions ?? 0}</span>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* File list sidebar */}
        <div className="w-72 shrink-0 flex flex-col border-r border-zinc-800 bg-zinc-900/40">
          {/* Select all / deselect all */}
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
            <button
              onClick={selectAll}
              className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Select All
            </button>
            <span className="text-zinc-700">|</span>
            <button
              onClick={deselectAll}
              className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Deselect All
            </button>
            <span className="ml-auto text-xs text-zinc-500">
              {files.length} file{files.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* File list */}
          <div className="flex-1 overflow-y-auto">
            {files.map((file) => {
              const { icon, color } = statusIcon(file.status);
              const isSelected = selectedFile === file.path;
              const isAccepted = acceptedFiles.has(file.path);

              return (
                <div
                  key={file.path}
                  className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-xs transition-colors ${
                    isSelected
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                  }`}
                  onClick={() => setSelectedFile(file.path)}
                >
                  <input
                    type="checkbox"
                    checked={isAccepted}
                    onChange={(e) => {
                      e.stopPropagation();
                      toggleFile(file.path);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0 rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-0 focus:ring-offset-0"
                  />
                  <span className={`shrink-0 font-mono font-bold ${color}`}>{icon}</span>
                  <span className="truncate flex-1" title={file.path}>
                    {file.path}
                  </span>
                  <span className="shrink-0 text-green-500">+{file.additions}</span>
                  <span className="shrink-0 text-red-500">-{file.deletions}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Diff viewer */}
        <div className="flex-1 min-w-0">
          {selectedDiff ? (
            <FileDiffView patch={selectedDiff.patch} />
          ) : (
            <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
              Select a file to view its diff
            </div>
          )}
        </div>
      </div>

      {/* Bottom bar - only shown when there are files to review */}
      {files.length > 0 && (
        <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-t border-zinc-800 bg-zinc-900/60">
          <span className="text-xs text-zinc-400">
            {acceptedCount} file{acceptedCount !== 1 ? 's' : ''} accepted
            {rejectedCount > 0 && (
              <span className="text-zinc-500">
                , {rejectedCount} rejected
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDiscard}
              disabled={merging}
              className="px-3 py-1.5 text-xs rounded bg-zinc-800 text-red-400 hover:bg-zinc-700 hover:text-red-300 disabled:opacity-50 transition-colors"
            >
              Discard All
            </button>
            <button
              onClick={handleMerge}
              disabled={merging}
              className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
            >
              {merging ? 'Merging...' : 'Merge Accepted'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
