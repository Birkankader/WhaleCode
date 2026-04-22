import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';

import { parseUnifiedDiff, type DiffRow, type DiffRowKind } from '../../lib/diffParser';
import type { FileDiff } from '../../lib/ipc';
import {
  detectLanguage,
  loadLanguage,
  tokenizeCode,
  type HighlighterLike,
  type TokenizedLine,
} from '../../lib/shikiHighlighter';

/**
 * Expanded diff body for a single file. Lazy-loaded by `DiffPopover` via
 * `React.lazy` so the heavy dependencies — Shiki grammar loader glue and
 * `@tanstack/react-virtual` — never land in the main bundle. Rendered
 * only after the user clicks a file header to expand it.
 *
 * Rendering path:
 *   1. Shiki highlighter + language grammar lazy-load via dynamic import.
 *      Unsupported extensions skip this step and fall back to untokenised
 *      plain text. `data-highlight-state` exposes `pending`/`ready`/`plain`
 *      for tests.
 *   2. Unified diff parsed into typed rows (hunk / context / add / remove).
 *   3. `useVirtualizer` windows the rows so a 10k-line diff mounts only
 *      ~visible DOM nodes.
 */

type HighlightState =
  | { kind: 'pending' }
  | { kind: 'plain' }
  | { kind: 'ready'; lines: TokenizedLine[] };

export default function DiffBody({ file, id }: { file: FileDiff; id: string }) {
  if (file.status?.kind === 'binary') {
    return (
      <div
        id={id}
        className="px-3 py-2 font-mono text-meta italic text-fg-tertiary"
        data-testid="diff-body-binary"
      >
        binary file, preview skipped
      </div>
    );
  }

  const patch = file.unifiedDiff;
  if (!patch) {
    return (
      <div
        id={id}
        className="px-3 py-2 font-mono text-meta italic text-fg-tertiary"
        data-testid="diff-body-empty"
      >
        no diff content available
      </div>
    );
  }

  return <DiffBodyLoaded file={file} id={id} patch={patch} />;
}

function DiffBodyLoaded({
  file,
  id,
  patch,
}: {
  file: FileDiff;
  id: string;
  patch: string;
}) {
  const rows = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const langId = useMemo(() => detectLanguage(file.path), [file.path]);

  const [highlight, setHighlight] = useState<HighlightState>(() =>
    langId ? { kind: 'pending' } : { kind: 'plain' },
  );

  useEffect(() => {
    if (!langId) {
      setHighlight({ kind: 'plain' });
      return;
    }
    let cancelled = false;
    setHighlight({ kind: 'pending' });
    loadLanguage(langId)
      .then((highlighter) => {
        if (cancelled) return;
        if (!highlighter) {
          setHighlight({ kind: 'plain' });
          return;
        }
        // Tokenise just the content lines (stripped of +/- markers); hunk
        // headers stay untokenised because they're not the file's language.
        const contentLines: string[] = [];
        const contentIndex: number[] = [];
        rows.forEach((r, i) => {
          if (r.kind !== 'hunk') {
            contentIndex.push(i);
            contentLines.push(r.text);
          }
        });
        if (contentLines.length === 0) {
          setHighlight({ kind: 'ready', lines: [] });
          return;
        }
        const tokens = tokenizeCode(
          highlighter as HighlighterLike,
          contentLines.join('\n'),
          langId,
        );
        const lines: TokenizedLine[] = new Array(rows.length);
        tokens.forEach((lineTokens, i) => {
          const rowIdx = contentIndex[i];
          if (rowIdx !== undefined) lines[rowIdx] = lineTokens;
        });
        setHighlight({ kind: 'ready', lines });
      })
      .catch(() => {
        if (!cancelled) setHighlight({ kind: 'plain' });
      });
    return () => {
      cancelled = true;
    };
  }, [langId, rows]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 18,
    overscan: 20,
  });

  if (rows.length === 0) {
    return (
      <div
        id={id}
        className="px-3 py-2 font-mono text-meta italic text-fg-tertiary"
        data-testid="diff-body-empty"
      >
        no diff content available
      </div>
    );
  }

  return (
    <div
      id={id}
      ref={scrollRef}
      className="relative h-60 overflow-auto font-mono text-meta leading-[18px]"
      data-testid="diff-body"
      data-lang={langId ?? 'plain'}
      data-highlight-state={highlight.kind}
    >
      <div
        style={{
          height: rowVirtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          const tokensForLine =
            highlight.kind === 'ready' ? highlight.lines[virtualRow.index] : undefined;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
                height: virtualRow.size,
              }}
            >
              <DiffRowView row={row} tokens={tokensForLine} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffRowView({
  row,
  tokens,
}: {
  row: DiffRow;
  tokens: TokenizedLine | undefined;
}) {
  const bg = rowBackground(row.kind);
  const marker = rowMarker(row.kind);
  const isHunk = row.kind === 'hunk';
  return (
    <div
      className="flex whitespace-pre px-2"
      style={{
        backgroundColor: bg,
        color: isHunk ? 'var(--color-fg-tertiary)' : undefined,
      }}
      data-row-kind={row.kind}
    >
      <span aria-hidden className="w-4 shrink-0 select-none text-fg-tertiary">
        {marker}
      </span>
      <span className="min-w-0 flex-1">
        {isHunk || !tokens ? row.text : <TokenLine tokens={tokens} />}
      </span>
    </div>
  );
}

function TokenLine({ tokens }: { tokens: TokenizedLine }) {
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} style={t.color ? { color: t.color } : undefined}>
          {t.content}
        </span>
      ))}
    </>
  );
}

function rowBackground(kind: DiffRowKind): string | undefined {
  switch (kind) {
    case 'add':
      return 'rgba(45, 150, 80, 0.18)';
    case 'remove':
      return 'rgba(200, 60, 60, 0.18)';
    case 'hunk':
      return 'var(--color-bg-subtle)';
    case 'context':
      return undefined;
  }
}

function rowMarker(kind: DiffRowKind): string {
  switch (kind) {
    case 'add':
      return '+';
    case 'remove':
      return '−';
    case 'hunk':
      return '@';
    case 'context':
      return ' ';
  }
}
