/**
 * Phase 6 Step 3 — agent reasoning / thinking panel.
 *
 * Renders above the log tail when the per-card "Show thinking"
 * toggle is on. Italicized + muted color so it reads as
 * meta-commentary distinct from the log lines below it.
 *
 * Default-collapsed: shows the latest 3 chunks. Click expand →
 * shows the full backlog (capped at 500 chunks per subtask in the
 * store, FIFO eviction). Toggle off elsewhere → component
 * unmounts entirely (no collapsed-empty state).
 *
 * Backed by `subtaskThinking` (Step 2 store wiring) — Claude-only
 * in practice; Codex / Gemini emit no events into the map per
 * Step 0 diagnostic.
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useGraphStore } from '../../state/graphStore';

const COLLAPSED_VISIBLE = 3;

type Props = { subtaskId: string };

export function ThinkingPanel({ subtaskId }: Props) {
  const stored = useGraphStore((s) => s.subtaskThinking.get(subtaskId));
  const [expanded, setExpanded] = useState(false);

  const chunks = useMemo(() => stored ?? [], [stored]);
  const visible = expanded
    ? chunks
    : chunks.slice(Math.max(0, chunks.length - COLLAPSED_VISIBLE));

  return (
    <div
      className="flex flex-col gap-1 rounded-sm border border-fg-secondary/20 bg-bg-subtle/40 px-2 py-1.5"
      data-testid={`thinking-panel-${subtaskId}`}
      role="region"
      aria-label="Agent thinking"
    >
      {chunks.length === 0 ? (
        <span
          className="text-meta italic text-fg-tertiary"
          data-testid={`thinking-empty-${subtaskId}`}
        >
          No thinking yet — agent hasn't emitted reasoning blocks.
        </span>
      ) : (
        <>
          <ul
            className="flex flex-col gap-1 text-meta italic text-fg-tertiary"
            data-testid={`thinking-list-${subtaskId}`}
          >
            {visible.map((entry, i) => (
              <li
                key={`${entry.timestampMs}-${i}`}
                className="whitespace-pre-wrap"
              >
                {entry.chunk}
              </li>
            ))}
          </ul>
          {chunks.length > COLLAPSED_VISIBLE ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              data-testid={`thinking-toggle-expand-${subtaskId}`}
              className="inline-flex w-fit items-center gap-1 text-hint text-fg-secondary hover:text-fg-primary"
              aria-expanded={expanded}
            >
              {expanded ? (
                <>
                  <ChevronDown size={10} aria-hidden="true" />
                  Show latest {COLLAPSED_VISIBLE}
                </>
              ) : (
                <>
                  <ChevronRight size={10} aria-hidden="true" />
                  Show all {chunks.length} chunks
                </>
              )}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
