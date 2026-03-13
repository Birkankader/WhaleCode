import { useState, useCallback } from 'react';
import { C } from '@/lib/theme';
import { useUIStore } from '@/stores/uiStore';
import { useGitStatus } from '@/hooks/useGitStatus';
import type { GitFileEntry, GitLogEntry } from '@/bindings';

/* ── Status badge colors ─────────────────────────────── */

const STATUS_BADGE: Record<string, { letter: string; color: string; bg: string }> = {
  modified: { letter: 'M', color: C.amber, bg: C.amberBg },
  added: { letter: 'A', color: C.green, bg: C.greenBg },
  deleted: { letter: 'D', color: C.red, bg: C.redBg },
  renamed: { letter: 'R', color: C.accentText, bg: C.accentSoft },
  typechange: { letter: 'T', color: C.textSecondary, bg: C.surface },
  unknown: { letter: '?', color: C.textMuted, bg: C.surface },
};

/* ── Sub-components ───────────────────────────────────── */

function FileRow({
  file,
  isStaged,
  expanded,
  diffContent,
  onToggleStage,
  onToggleDiff,
}: {
  file: GitFileEntry;
  isStaged: boolean;
  expanded: boolean;
  diffContent?: string;
  onToggleStage: () => void;
  onToggleDiff: () => void;
}) {
  const badge = STATUS_BADGE[file.status] ?? STATUS_BADGE.unknown;

  return (
    <div>
      <div
        className="flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors group"
        style={{ background: expanded ? C.surface : 'transparent' }}
        onClick={onToggleDiff}
      >
        {/* Stage/unstage checkbox */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleStage(); }}
          className="w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors"
          style={{
            borderColor: isStaged ? C.accent : C.borderStrong,
            background: isStaged ? C.accent : 'transparent',
          }}
        >
          {isStaged && <span className="text-white text-[10px]">✓</span>}
        </button>

        {/* Status badge */}
        <span
          className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold flex-shrink-0"
          style={{ background: badge.bg, color: badge.color }}
        >
          {badge.letter}
        </span>

        {/* File path */}
        <span
          className="flex-1 text-xs font-mono truncate"
          style={{ color: C.textPrimary }}
        >
          {file.path}
        </span>

        {/* +/- counts */}
        {(file.additions > 0 || file.deletions > 0) && (
          <span className="text-[10px] flex gap-1 flex-shrink-0">
            {file.additions > 0 && <span style={{ color: C.green }}>+{file.additions}</span>}
            {file.deletions > 0 && <span style={{ color: C.red }}>-{file.deletions}</span>}
          </span>
        )}

        {/* Expand indicator */}
        <span
          className="text-[10px] flex-shrink-0 transition-transform"
          style={{
            color: C.textMuted,
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          ▶
        </span>
      </div>

      {/* Inline diff */}
      {expanded && diffContent !== undefined && (
        <div
          className="mx-3 mb-2 rounded-lg overflow-hidden border"
          style={{ borderColor: C.border, background: '#08080e' }}
        >
          <pre className="text-[11px] leading-[18px] font-mono p-3 overflow-x-auto" style={{ margin: 0 }}>
            {diffContent ? diffContent.split('\n').map((line, i) => {
              let lineColor: string = C.textSecondary;
              let lineBg: string = 'transparent';
              if (line.startsWith('+')) { lineColor = C.green; lineBg = C.greenBg; }
              else if (line.startsWith('-')) { lineColor = C.red; lineBg = C.redBg; }
              return (
                <div key={i} style={{ color: lineColor, background: lineBg, padding: '0 4px' }}>
                  {line || ' '}
                </div>
              );
            }) : (
              <span style={{ color: C.textMuted }}>No diff available</span>
            )}
          </pre>
        </div>
      )}
    </div>
  );
}

function FileSection({
  title,
  count,
  files,
  isStaged,
  expandedDiffs,
  onToggleStage,
  onToggleDiff,
  onBulkAction,
  bulkLabel,
}: {
  title: string;
  count: number;
  files: GitFileEntry[];
  isStaged: boolean;
  expandedDiffs: Record<string, string>;
  onToggleStage: (path: string) => void;
  onToggleDiff: (path: string) => void;
  onBulkAction: () => void;
  bulkLabel: string;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="mb-3">
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span
          className="text-[10px] transition-transform"
          style={{ color: C.textMuted, transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}
        >
          ▶
        </span>
        <span className="text-xs font-semibold" style={{ color: C.textPrimary }}>
          {title}
        </span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
          style={{ background: C.surface, color: C.textSecondary }}
        >
          {count}
        </span>
        <div className="flex-1" />
        {count > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); onBulkAction(); }}
            className="text-[10px] px-2 py-0.5 rounded-md font-medium transition-colors"
            style={{ color: C.accentText, background: C.accentSoft }}
          >
            {bulkLabel}
          </button>
        )}
      </div>

      {!collapsed && files.map((file) => (
        <FileRow
          key={file.path}
          file={file}
          isStaged={isStaged}
          expanded={expandedDiffs[file.path] !== undefined}
          diffContent={expandedDiffs[file.path]}
          onToggleStage={() => onToggleStage(file.path)}
          onToggleDiff={() => onToggleDiff(file.path)}
        />
      ))}

      {!collapsed && files.length === 0 && (
        <div className="px-3 py-2 text-xs" style={{ color: C.textMuted }}>
          No files
        </div>
      )}
    </div>
  );
}

function CommitLog({ entries }: { entries: GitLogEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <div>
      <div className="px-3 py-2">
        <span className="text-xs font-semibold" style={{ color: C.textPrimary }}>
          Recent Commits
        </span>
      </div>
      {entries.map((entry) => (
        <div
          key={entry.hash}
          className="flex items-center gap-2.5 px-3 py-1.5"
        >
          <span
            className="text-[10px] font-mono flex-shrink-0 px-1.5 py-0.5 rounded"
            style={{ background: C.surface, color: C.accentText }}
          >
            {entry.hash}
          </span>
          <span className="text-xs truncate flex-1" style={{ color: C.textPrimary }}>
            {entry.message}
          </span>
          <span className="text-[10px] flex-shrink-0" style={{ color: C.textMuted }}>
            {entry.author}
          </span>
          <span className="text-[10px] flex-shrink-0" style={{ color: C.textMuted }}>
            {entry.time_ago}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Main GitView ─────────────────────────────────────── */

export function GitView() {
  const projectDir = useUIStore((s) => s.projectDir);
  const {
    status, log: commitLog, expandedDiffs, loading, error,
    refresh, stageFiles, unstageFiles, commit, pull, push, toggleDiff,
  } = useGitStatus(projectDir);

  const [commitMsg, setCommitMsg] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim()) return;
    setActionLoading('commit');
    const hash = await commit(commitMsg.trim());
    if (hash) setCommitMsg('');
    setActionLoading(null);
  }, [commitMsg, commit]);

  const handlePull = useCallback(async () => {
    setActionLoading('pull');
    await pull();
    setActionLoading(null);
  }, [pull]);

  const handlePush = useCallback(async () => {
    setActionLoading('push');
    await push();
    setActionLoading(null);
  }, [push]);

  const handleStageToggle = useCallback(async (path: string, isCurrentlyStaged: boolean) => {
    if (isCurrentlyStaged) {
      await unstageFiles([path]);
    } else {
      await stageFiles([path]);
    }
  }, [stageFiles, unstageFiles]);

  const handleStageAll = useCallback(async () => {
    if (!status) return;
    const paths = [
      ...status.unstaged.map((f: GitFileEntry) => f.path),
      ...status.untracked,
    ];
    if (paths.length > 0) await stageFiles(paths);
  }, [status, stageFiles]);

  const handleUnstageAll = useCallback(async () => {
    if (!status) return;
    const paths = status.staged.map((f: GitFileEntry) => f.path);
    if (paths.length > 0) await unstageFiles(paths);
  }, [status, unstageFiles]);

  const isNotRepo = error?.includes('No git repository');

  // No project dir selected
  if (!projectDir) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: C.bg }}>
        <div className="text-center">
          <div className="text-2xl mb-2">⎇</div>
          <div className="text-sm font-medium" style={{ color: C.textSecondary }}>
            No project directory selected
          </div>
          <div className="text-xs mt-1" style={{ color: C.textMuted }}>
            Launch a session to view git status
          </div>
        </div>
      </div>
    );
  }

  // Project dir is not inside a git repo
  if (isNotRepo) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: C.bg }}>
        <div className="text-center" style={{ maxWidth: 400 }}>
          <div className="text-2xl mb-2">⎇</div>
          <div className="text-sm font-medium" style={{ color: C.textSecondary }}>
            Not a Git Repository
          </div>
          <div className="text-xs mt-2 leading-relaxed" style={{ color: C.textMuted }}>
            <span className="font-mono text-[11px]" style={{ color: C.textSecondary }}>
              {projectDir.split('/').pop()}
            </span>{' '}
            is not inside a git repository. Git features like status, commit, and push are not available.
          </div>
          <div className="text-xs mt-3" style={{ color: C.textMuted }}>
            Run <span className="font-mono px-1 py-0.5 rounded" style={{ background: C.surface }}>git init</span> in the project directory to start tracking changes.
          </div>
        </div>
      </div>
    );
  }

  // Build untracked as GitFileEntry-like for display
  const untrackedFiles: GitFileEntry[] = (status?.untracked ?? []).map((path: string) => ({
    path,
    status: 'added',
    additions: 0,
    deletions: 0,
  }));

  const stagedCount = status?.staged.length ?? 0;
  const unstagedCount = (status?.unstaged.length ?? 0) + untrackedFiles.length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: C.bg }}>
      {/* Branch header */}
      <div
        className="flex items-center gap-3 px-4 py-3 border-b flex-shrink-0"
        style={{ borderColor: C.border, background: C.panel }}
      >
        {/* Branch info */}
        <div className="flex items-center gap-2">
          <span className="text-sm" style={{ color: C.textMuted }}>⎇</span>
          <span className="text-sm font-semibold font-mono" style={{ color: C.textPrimary }}>
            {status?.branch ?? '—'}
          </span>

          {/* Ahead/behind pills */}
          {status && (status.ahead > 0 || status.behind > 0) && (
            <div className="flex items-center gap-1 ml-1">
              {status.ahead > 0 && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                  style={{ background: C.greenBg, color: C.green, border: `1px solid ${C.greenBorder}` }}
                >
                  ↑{status.ahead}
                </span>
              )}
              {status.behind > 0 && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                  style={{ background: C.amberBg, color: C.amber, border: `1px solid ${C.amberBorder}` }}
                >
                  ↓{status.behind}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="text-xs px-2.5 py-1.5 rounded-lg font-medium transition-colors"
            style={{
              background: C.surface,
              color: C.textSecondary,
              border: `1px solid ${C.border}`,
              opacity: loading ? 0.5 : 1,
            }}
          >
            {loading ? '⟳' : '↻'} Refresh
          </button>
          <button
            onClick={handlePull}
            disabled={actionLoading === 'pull'}
            className="text-xs px-2.5 py-1.5 rounded-lg font-medium transition-colors"
            style={{
              background: C.surface,
              color: C.textSecondary,
              border: `1px solid ${C.border}`,
              opacity: actionLoading === 'pull' ? 0.5 : 1,
            }}
          >
            {actionLoading === 'pull' ? '⟳' : '↓'} Pull
          </button>
          <button
            onClick={handlePush}
            disabled={actionLoading === 'push'}
            className="text-xs px-2.5 py-1.5 rounded-lg font-medium transition-colors"
            style={{
              background: C.surface,
              color: C.textSecondary,
              border: `1px solid ${C.border}`,
              opacity: actionLoading === 'push' ? 0.5 : 1,
            }}
          >
            {actionLoading === 'push' ? '⟳' : '↑'} Push
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div
          className="px-4 py-2 text-xs border-b flex-shrink-0"
          style={{ background: C.redBg, color: C.red, borderColor: C.red + '30' }}
        >
          {error}
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto py-4">
          {/* Staged changes */}
          <FileSection
            title="Staged Changes"
            count={stagedCount}
            files={status?.staged ?? []}
            isStaged={true}
            expandedDiffs={expandedDiffs}
            onToggleStage={(path) => handleStageToggle(path, true)}
            onToggleDiff={toggleDiff}
            onBulkAction={handleUnstageAll}
            bulkLabel="Unstage All"
          />

          {/* Unstaged changes (working tree + untracked) */}
          <FileSection
            title="Changes"
            count={unstagedCount}
            files={[...(status?.unstaged ?? []), ...untrackedFiles]}
            isStaged={false}
            expandedDiffs={expandedDiffs}
            onToggleStage={(path) => handleStageToggle(path, false)}
            onToggleDiff={toggleDiff}
            onBulkAction={handleStageAll}
            bulkLabel="Stage All"
          />

          {/* Commit area */}
          <div
            className="mx-3 mb-4 rounded-xl border overflow-hidden"
            style={{ borderColor: C.border, background: C.panel }}
          >
            <textarea
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder="Commit message..."
              rows={3}
              className="w-full text-xs font-mono p-3 resize-none"
              style={{
                background: 'transparent',
                color: C.textPrimary,
                outline: 'none',
                border: 'none',
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleCommit();
              }}
            />
            <div
              className="flex items-center justify-between px-3 py-2 border-t"
              style={{ borderColor: C.border }}
            >
              <span className="text-[10px]" style={{ color: C.textMuted }}>
                {stagedCount} file{stagedCount !== 1 ? 's' : ''} staged &middot; ⌘+Enter to commit
              </span>
              <button
                onClick={handleCommit}
                disabled={stagedCount === 0 || !commitMsg.trim() || actionLoading === 'commit'}
                className="text-xs px-3 py-1.5 rounded-lg font-semibold transition-all"
                style={{
                  background: stagedCount > 0 && commitMsg.trim() ? C.accent : C.borderStrong,
                  color: stagedCount > 0 && commitMsg.trim() ? '#fff' : C.textMuted,
                  opacity: actionLoading === 'commit' ? 0.5 : 1,
                }}
              >
                {actionLoading === 'commit' ? 'Committing...' : `Commit (${stagedCount})`}
              </button>
            </div>
          </div>

          {/* Divider */}
          <div className="mx-3 mb-3" style={{ borderTop: `1px solid ${C.border}` }} />

          {/* Recent commits */}
          <CommitLog entries={commitLog} />
        </div>
      </div>
    </div>
  );
}
