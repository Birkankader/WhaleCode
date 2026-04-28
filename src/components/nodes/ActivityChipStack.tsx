/**
 * Phase 6 Step 2 / Phase 7 polish — activity chip stack on running
 * worker cards.
 *
 * Renders the most recent compressed activity chips. Pulls from
 * `subtaskActivities` (capped 50 events per subtask, FIFO), runs
 * them through `compressActivities` to collapse same-kind same-dir
 * bursts, and shows the latest `MAX_VISIBLE` chips on a single
 * horizontal row.
 *
 * Phase 7 polish addition: each chip is now a button. Click → expand
 * a `ChipDetail` panel below the stack with the full event info
 * (full file path + lines, full command, full search query + paths,
 * etc.). Click the same chip again or click another chip to switch.
 * Replaces the older "click to expand the whole card and read the
 * raw stream-json" path with a focused detail surface that's
 * actually readable.
 *
 * No persistence; the stack disappears when the subtask leaves
 * the running state. Older chips fade out via AnimatePresence.
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  FileText,
  Pencil,
  Search,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { useGraphStore } from '../../state/graphStore';
import {
  chipLabel,
  compressActivities,
  type CompressedChip,
} from '../../state/activityCompression';
import type { ToolEvent } from '../../lib/ipc';

// Phase 7 polish: tightened from 5 to 3 visible chips so the latest-
// activity surface fits one horizontal row on the 280px-wide card
// without wrapping. Older chips still live in `subtaskActivities`
// (capped 50 per subtask) and become visible on expand if needed.
const MAX_VISIBLE = 3;

type Props = { subtaskId: string };

export function ActivityChipStack({ subtaskId }: Props) {
  const stored = useGraphStore((s) => s.subtaskActivities.get(subtaskId));
  const compressed = useMemo(
    () => compressActivities(stored ?? []),
    [stored],
  );
  const visible = compressed.slice(Math.max(0, compressed.length - MAX_VISIBLE));

  // Phase 7 polish: single-chip selection drives the detail panel.
  // Reset on subtask change implicit via React key on parent.
  const [selectedChipId, setSelectedChipId] = useState<string | null>(null);

  if (visible.length === 0) return null;

  // If the selected chip aged out of the visible window (older
  // events flushed by FIFO), drop the selection silently rather
  // than render a stale detail panel.
  const selectedChip = selectedChipId
    ? visible.find((c) => c.id === selectedChipId) ?? null
    : null;

  return (
    <div
      className="flex flex-col gap-1"
      data-testid={`activity-chip-stack-${subtaskId}`}
    >
      <div
        className="flex min-w-0 items-center gap-1 overflow-hidden"
        role="status"
        aria-live="polite"
      >
        <AnimatePresence initial={false}>
          {visible.map((chip) => {
            const isSelected = selectedChip?.id === chip.id;
            return (
              <motion.button
                key={chip.id}
                type="button"
                initial={{ opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: 0.15 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedChipId(isSelected ? null : chip.id);
                }}
                className="nodrag nopan inline-flex min-w-0 shrink items-center gap-1 truncate rounded-sm border bg-bg-elevated px-1.5 py-0.5 text-meta text-fg-secondary hover:border-fg-secondary/60"
                style={{
                  borderColor: isSelected
                    ? 'var(--color-fg-secondary)'
                    : 'var(--color-fg-secondary)',
                  opacity: isSelected ? 1 : 0.85,
                }}
                data-testid={`activity-chip-${subtaskId}-${chip.event.kind}`}
                aria-label={ariaLabelFor(chip)}
                aria-pressed={isSelected}
                title={chipLabel(chip)}
                data-count={chip.count > 1 ? chip.count : undefined}
              >
                <Icon event={chip.event} />
                <span className="truncate">{chipLabel(chip)}</span>
              </motion.button>
            );
          })}
        </AnimatePresence>
      </div>
      {selectedChip ? (
        <ChipDetail
          chip={selectedChip}
          onClose={() => setSelectedChipId(null)}
          subtaskId={subtaskId}
        />
      ) : null}
    </div>
  );
}

function ChipDetail({
  chip,
  onClose,
  subtaskId,
}: {
  chip: CompressedChip;
  onClose: () => void;
  subtaskId: string;
}) {
  const ev = chip.event;
  return (
    <div
      className="flex items-start gap-2 rounded-sm border border-fg-secondary/20 bg-bg-subtle/40 px-2 py-1 font-mono text-meta text-fg-primary"
      data-testid={`activity-chip-detail-${subtaskId}`}
      data-kind={ev.kind}
      role="region"
      aria-label="Activity detail"
    >
      <Icon event={ev} />
      <div className="min-w-0 flex-1">
        {renderDetailBody(ev, chip.count)}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="shrink-0 text-fg-tertiary hover:text-fg-primary"
        aria-label="Close activity detail"
      >
        <span aria-hidden>×</span>
      </button>
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
        <div className="flex flex-col">
          <span className="break-all" data-testid="activity-chip-detail-path">
            Edit <span className="text-fg-secondary">{ev.path}</span>
            {count > 1 ? <span className="text-fg-tertiary"> · {count} edits compressed</span> : null}
          </span>
          {ev.summary ? (
            <span className="text-fg-tertiary" data-testid="activity-chip-detail-summary">
              {ev.summary}
            </span>
          ) : null}
        </div>
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
  const base = chipLabel(chip);
  return chip.count > 1 ? `${base} (compressed ${chip.count} events)` : base;
}
