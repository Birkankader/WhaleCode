/**
 * Phase 6 Step 2 — activity chip stack on running worker cards.
 *
 * Renders the most recent compressed activity chips above the log
 * tail. Pulls from `subtaskActivities` (capped 50 events per
 * subtask, FIFO), runs them through `compressActivities` to
 * collapse same-kind same-dir bursts, and shows the latest
 * `MAX_VISIBLE` chips.
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
import { useMemo } from 'react';

import { useGraphStore } from '../../state/graphStore';
import {
  chipLabel,
  compressActivities,
  type CompressedChip,
} from '../../state/activityCompression';
import type { ToolEvent } from '../../lib/ipc';

const MAX_VISIBLE = 5;

type Props = { subtaskId: string };

export function ActivityChipStack({ subtaskId }: Props) {
  const stored = useGraphStore((s) => s.subtaskActivities.get(subtaskId));
  const compressed = useMemo(
    () => compressActivities(stored ?? []),
    [stored],
  );
  const visible = compressed.slice(Math.max(0, compressed.length - MAX_VISIBLE));

  if (visible.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-1"
      data-testid={`activity-chip-stack-${subtaskId}`}
      role="status"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {visible.map((chip) => (
          <motion.span
            key={chip.id}
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2 }}
            transition={{ duration: 0.15 }}
            className="inline-flex max-w-full items-center gap-1 truncate rounded-sm border border-fg-secondary/30 bg-bg-elevated px-1.5 py-0.5 text-meta text-fg-secondary"
            data-testid={`activity-chip-${subtaskId}-${chip.event.kind}`}
            aria-label={ariaLabelFor(chip)}
            title={chipLabel(chip)}
            data-count={chip.count > 1 ? chip.count : undefined}
          >
            <Icon event={chip.event} />
            <span className="truncate">{chipLabel(chip)}</span>
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
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
