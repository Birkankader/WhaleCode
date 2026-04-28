/**
 * Phase 6 Step 2 / Phase 7 polish — activity list on running worker
 * cards.
 *
 * Originally shipped Phase 6 as a horizontal "chip stack"; redesigned
 * in Phase 7 polish round 3 to a Cursor-style vertical list after
 * real-usage screenshots showed the chip-with-truncated-label layout
 * never told the user *which* file was being read. The new shape
 * mirrors the Cursor / OpenCode reference UI: one compact row per
 * compressed activity, full-width inside the card, click a row to
 * expand inline detail (full path + lines / full command / full
 * search query) without leaving the card or opening a modal.
 *
 * Component name + `activity-chip-*` testids are preserved so the
 * Phase 6 spec references and existing tests stay valid.
 *
 * Pulls from `subtaskActivities` (capped 50 events per subtask,
 * FIFO), runs them through `compressActivities` to collapse same-
 * kind same-dir bursts. The list shows the latest `MAX_VISIBLE`
 * rows; older rows roll off (they remain in the store).
 *
 * No persistence; the list disappears when the subtask leaves the
 * running state. Rows fade in via AnimatePresence.
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronRight,
  FileText,
  Pencil,
  Search,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { useMemo } from 'react';

import { useGraphStore } from '../../state/graphStore';
import {
  compressActivities,
  type CompressedChip,
} from '../../state/activityCompression';
import type { ToolEvent } from '../../lib/ipc';

// Phase 7 polish round 3: vertical list at 4 rows fits comfortably
// in the ~80px activity slot of a 200px-tall card. Older rows roll
// off (still in the store, capped at 50 per subtask).
const MAX_VISIBLE = 4;

type Props = { subtaskId: string };

export function ActivityChipStack({ subtaskId }: Props) {
  const stored = useGraphStore((s) => s.subtaskActivities.get(subtaskId));
  const compressed = useMemo(
    () => compressActivities(stored ?? []),
    [stored],
  );
  const visible = compressed.slice(Math.max(0, compressed.length - MAX_VISIBLE));

  // Phase 7 polish: chip-expansion state lives in the store so
  // `GraphCanvas.buildGraph` can read it for dynamic card height.
  const selectedChipId = useGraphStore(
    (s) => s.subtaskChipExpanded.get(subtaskId) ?? null,
  );
  const setChipExpanded = useGraphStore((s) => s.setChipExpanded);

  if (visible.length === 0) return null;

  return (
    <div
      className="flex flex-col"
      data-testid={`activity-chip-stack-${subtaskId}`}
      role="status"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {visible.map((chip) => {
          const isSelected = selectedChipId === chip.id;
          return (
            <motion.div
              key={chip.id}
              initial={{ opacity: 0, y: -2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -2 }}
              transition={{ duration: 0.15 }}
              className="flex flex-col"
            >
              <ActivityRow
                chip={chip}
                isSelected={isSelected}
                onToggle={() =>
                  setChipExpanded(subtaskId, isSelected ? null : chip.id)
                }
                subtaskId={subtaskId}
              />
              {isSelected ? <ChipDetail chip={chip} subtaskId={subtaskId} /> : null}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function ActivityRow({
  chip,
  isSelected,
  onToggle,
  subtaskId,
}: {
  chip: CompressedChip;
  isSelected: boolean;
  onToggle: () => void;
  subtaskId: string;
}) {
  const { verb, primary, secondary } = rowParts(chip);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="nodrag nopan group flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-meta text-fg-secondary hover:bg-bg-subtle/40"
      data-testid={`activity-chip-${subtaskId}-${chip.event.kind}`}
      data-count={chip.count > 1 ? chip.count : undefined}
      aria-pressed={isSelected}
      aria-label={ariaLabelFor(chip)}
      title={`${verb} ${primary}`}
    >
      <Icon event={chip.event} />
      <span className="shrink-0 text-fg-tertiary">{verb}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-fg-primary">{primary}</span>
      {secondary ? (
        <span className="shrink-0 text-fg-tertiary">{secondary}</span>
      ) : null}
      <ChevronRight
        size={12}
        aria-hidden
        className="shrink-0 text-fg-tertiary transition-transform"
        style={{ transform: isSelected ? 'rotate(90deg)' : 'rotate(0deg)' }}
      />
    </button>
  );
}

function ChipDetail({ chip, subtaskId }: { chip: CompressedChip; subtaskId: string }) {
  const ev = chip.event;
  return (
    <div
      // Tight indent so it visually nests under the row, no
      // border/background — keeps the card calm and avoids the
      // panel-on-panel feel the round-3 design had. The detail is
      // verb-less (the row above carries the verb); just the
      // information the row hid behind a basename.
      className="ml-5 mr-1 -mt-0.5 mb-0.5 break-words font-mono text-meta text-fg-tertiary"
      data-testid={`activity-chip-detail-${subtaskId}`}
      data-kind={ev.kind}
      role="region"
      aria-label="Activity detail"
    >
      {renderDetailBody(ev, chip.count)}
    </div>
  );
}

function renderDetailBody(ev: ToolEvent, count: number) {
  switch (ev.kind) {
    case 'file-read': {
      const range = ev.lines ? ` (lines ${ev.lines[0]}–${ev.lines[1]})` : '';
      const suffix = count > 1 ? ` · ${count} reads compressed` : '';
      return (
        <span className="block" data-testid="activity-chip-detail-path">
          <span className="text-fg-secondary">{relativePath(ev.path)}</span>
          {range}
          {suffix ? <span className="text-fg-tertiary">{suffix}</span> : null}
        </span>
      );
    }
    case 'file-edit': {
      const suffix = count > 1 ? ` · ${count} edits compressed` : '';
      return (
        <>
          <span className="block" data-testid="activity-chip-detail-path">
            <span className="text-fg-secondary">{relativePath(ev.path)}</span>
            {suffix ? <span className="text-fg-tertiary">{suffix}</span> : null}
          </span>
          {ev.summary ? (
            <span className="block" data-testid="activity-chip-detail-summary">
              {ev.summary}
            </span>
          ) : null}
        </>
      );
    }
    case 'bash':
      return (
        <span className="block" data-testid="activity-chip-detail-command">
          <span className="text-fg-tertiary">$</span>{' '}
          <span className="text-fg-secondary">{relativeCommand(ev.command)}</span>
        </span>
      );
    case 'search': {
      const where =
        ev.paths.length > 0
          ? ` in ${ev.paths.map(relativePath).join(', ')}`
          : '';
      return (
        <span className="block" data-testid="activity-chip-detail-query">
          <span className="text-fg-secondary">&ldquo;{ev.query}&rdquo;</span>
          {where}
        </span>
      );
    }
    case 'other':
      return (
        <span className="block" data-testid="activity-chip-detail-other">
          {ev.detail || ev.toolName}
        </span>
      );
  }
}

/**
 * Strip worktree / $HOME prefixes from absolute paths embedded in
 * shell commands (typically `cd /Users/.../worktree/sub/apps/api`).
 * Conservative — only rewrites the recognised prefixes; leaves the
 * rest of the command unchanged.
 */
function relativeCommand(cmd: string): string {
  return cmd
    .replace(
      /\/[^\s]+\.whalecode(?:-worktrees)?\/[^/\s]+\/[^/\s]+\/([^\s]+)/g,
      '$1',
    )
    .replace(/\/(?:Users|home)\/[^/\s]+\/([^\s]+)/g, '~/$1');
}

/**
 * Compact row segments. `verb` is the action ("Read", "Edit", etc.)
 * in muted color; `primary` is the *basename* of the file (or the
 * command, or the search query) — no full paths, those live in the
 * detail panel. `secondary` is an optional trailing badge ("× 4" for
 * compressed bursts).
 *
 * Phase 7 polish round 4: rows previously showed truncated full
 * paths ("/Users/birkankader/Documents/.../App.tsx") which ate row
 * width and forced middle-ellipsis. Real-usage feedback: just show
 * `App.tsx`. Click → detail panel reveals the full path.
 */
function rowParts(chip: CompressedChip): {
  verb: string;
  primary: string;
  secondary: string | null;
} {
  const ev = chip.event;
  const compressed = chip.count > 1;
  const dirBasename = chip.parentDir ? `${basenameDir(chip.parentDir)}/` : './';
  switch (ev.kind) {
    case 'file-read':
      return compressed
        ? { verb: 'Read', primary: dirBasename, secondary: `× ${chip.count}` }
        : { verb: 'Read', primary: basename(ev.path), secondary: null };
    case 'file-edit':
      return compressed
        ? { verb: 'Edit', primary: dirBasename, secondary: `× ${chip.count}` }
        : { verb: 'Edit', primary: basename(ev.path), secondary: null };
    case 'bash':
      return compressed
        ? { verb: 'Run', primary: 'shell commands', secondary: `× ${chip.count}` }
        : {
            verb: 'Run',
            primary: truncateInline(relativeCommand(ev.command), 36),
            secondary: null,
          };
    case 'search':
      return compressed
        ? { verb: 'Search', primary: 'queries', secondary: `× ${chip.count}` }
        : { verb: 'Search', primary: `"${truncateInline(ev.query, 30)}"`, secondary: null };
    case 'other':
      return compressed
        ? { verb: ev.toolName, primary: 'calls', secondary: `× ${chip.count}` }
        : {
            verb: ev.toolName,
            primary: ev.detail.length > 0 ? truncateInline(ev.detail, 36) : '',
            secondary: null,
          };
  }
}

/** Strip everything before the final `/`. Returns `path` unchanged when there's no slash. */
function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1) || path;
}

/** Basename for a directory path — drops trailing slash if present. */
function basenameDir(dir: string): string {
  const trimmed = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  return basename(trimmed);
}

/**
 * Strip the worktree prefix and `$HOME/` prefix so the detail panel
 * shows a workspace-relative path instead of the full absolute path.
 *
 * Worktree shape: `<repo>/.whalecode-worktrees/<run-id>/<subtask-id>/<rest>`.
 * Returns just `<rest>` when the prefix is recognised; falls through
 * to `~/<rest>` when the path is under `$HOME`; returns the input
 * unchanged otherwise (already relative or a different workspace).
 */
function relativePath(absolute: string): string {
  const worktreeMatch = absolute.match(
    /\.whalecode(?:-worktrees)?\/[^/]+\/[^/]+\/(.+)$/,
  );
  if (worktreeMatch) return worktreeMatch[1];
  const homeMatch = absolute.match(/^\/(?:Users|home)\/[^/]+\/(.+)$/);
  if (homeMatch) return `~/${homeMatch[1]}`;
  return absolute;
}

function truncateInline(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function Icon({ event }: { event: ToolEvent }) {
  const props = { size: 12, 'aria-hidden': true } as const;
  switch (event.kind) {
    case 'file-read':
      return <FileText {...props} />;
    case 'file-edit':
      return <Pencil {...props} />;
    case 'bash':
      return <Terminal {...props} />;
    case 'search':
      return <Search {...props} />;
    case 'other':
      return <Sparkles {...props} />;
  }
}

function ariaLabelFor(chip: CompressedChip): string {
  const { verb, primary, secondary } = rowParts(chip);
  const parts = [verb, primary];
  if (secondary) parts.push(secondary);
  if (chip.count > 1) parts.push(`(compressed ${chip.count} events)`);
  return parts.join(' ');
}
