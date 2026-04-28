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
import { useMemo, useState } from 'react';

import { useGraphStore } from '../../state/graphStore';
import {
  compressActivities,
  truncatePath,
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

  // Single-row selection drives the inline detail panel. Re-click
  // closes; clicking another row switches.
  const [selectedChipId, setSelectedChipId] = useState<string | null>(null);

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
                onToggle={() => setSelectedChipId(isSelected ? null : chip.id)}
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
      className="ml-5 mr-1 mb-1 flex flex-col gap-0.5 rounded-sm border border-fg-secondary/20 bg-bg-subtle/40 px-2 py-1 font-mono text-meta text-fg-primary"
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
      return (
        <span className="block break-all" data-testid="activity-chip-detail-path">
          Read <span className="text-fg-secondary">{ev.path}</span>
          {range}
          {count > 1 ? <span className="text-fg-tertiary"> · {count} reads compressed</span> : null}
        </span>
      );
    }
    case 'file-edit':
      return (
        <>
          <span className="break-all" data-testid="activity-chip-detail-path">
            Edit <span className="text-fg-secondary">{ev.path}</span>
            {count > 1 ? <span className="text-fg-tertiary"> · {count} edits compressed</span> : null}
          </span>
          {ev.summary ? (
            <span className="text-fg-tertiary" data-testid="activity-chip-detail-summary">
              {ev.summary}
            </span>
          ) : null}
        </>
      );
    case 'bash':
      return (
        <span className="block break-all" data-testid="activity-chip-detail-command">
          <span className="text-fg-tertiary">$</span> {ev.command}
        </span>
      );
    case 'search': {
      const where = ev.paths.length > 0 ? ` in ${ev.paths.join(', ')}` : '';
      return (
        <span className="block break-all" data-testid="activity-chip-detail-query">
          Search <span className="text-fg-secondary">&ldquo;{ev.query}&rdquo;</span>
          {where}
        </span>
      );
    }
    case 'other':
      return (
        <span className="block break-all" data-testid="activity-chip-detail-other">
          <span className="text-fg-secondary">{ev.toolName}</span>: {ev.detail}
        </span>
      );
  }
}

/**
 * Compact row segments. `verb` is the action ("Read", "Edit", etc.)
 * in muted color; `primary` is the file path / command in mono;
 * `secondary` is an optional trailing badge ("× 4" for compressed
 * bursts).
 */
function rowParts(chip: CompressedChip): {
  verb: string;
  primary: string;
  secondary: string | null;
} {
  const ev = chip.event;
  const compressed = chip.count > 1;
  const dirHint = chip.parentDir ? `${chip.parentDir}/` : '.';
  switch (ev.kind) {
    case 'file-read':
      return compressed
        ? { verb: 'Read', primary: dirHint, secondary: `× ${chip.count}` }
        : { verb: 'Read', primary: truncatePath(ev.path), secondary: null };
    case 'file-edit':
      return compressed
        ? { verb: 'Edit', primary: dirHint, secondary: `× ${chip.count}` }
        : { verb: 'Edit', primary: truncatePath(ev.path), secondary: null };
    case 'bash':
      return compressed
        ? { verb: 'Run', primary: 'shell commands', secondary: `× ${chip.count}` }
        : { verb: 'Run', primary: truncateInline(ev.command, 50), secondary: null };
    case 'search':
      return compressed
        ? { verb: 'Search', primary: 'queries', secondary: `× ${chip.count}` }
        : { verb: 'Search', primary: `"${truncateInline(ev.query, 40)}"`, secondary: null };
    case 'other':
      return compressed
        ? { verb: ev.toolName, primary: 'calls', secondary: `× ${chip.count}` }
        : {
            verb: ev.toolName,
            primary: ev.detail.length > 0 ? truncateInline(ev.detail, 50) : '',
            secondary: null,
          };
  }
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
