/**
 * Phase 6 Step 2 — ActivityChipStack unit tests.
 */

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

import { useGraphStore } from '../../state/graphStore';
import type { ToolEvent } from '../../lib/ipc';

import { ActivityChipStack } from './ActivityChipStack';

beforeEach(() => {
  useGraphStore.setState({ runId: 'r-1' });
});

afterEach(() => {
  useGraphStore.getState().reset();
});

function seedActivities(
  subtaskId: string,
  entries: ReadonlyArray<{ event: ToolEvent; timestampMs: number }>,
) {
  const map = new Map<
    string,
    ReadonlyArray<{ event: ToolEvent; timestampMs: number }>
  >();
  map.set(subtaskId, entries);
  useGraphStore.setState({ subtaskActivities: map });
}

describe('ActivityChipStack — render', () => {
  it('renders nothing when no activities recorded', () => {
    render(<ActivityChipStack subtaskId="s-1" />);
    expect(screen.queryByTestId('activity-chip-stack-s-1')).toBeNull();
  });

  it('renders a chip per event up to MAX_VISIBLE', () => {
    seedActivities('s-1', [
      { event: { kind: 'file-read', path: 'a.ts' }, timestampMs: 1000 },
      { event: { kind: 'bash', command: 'pnpm test' }, timestampMs: 1100 },
      {
        event: { kind: 'search', query: 'foo', paths: [] },
        timestampMs: 1200,
      },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    expect(screen.getByTestId('activity-chip-stack-s-1')).toBeInTheDocument();
    expect(screen.getByTestId('activity-chip-s-1-file-read')).toBeInTheDocument();
    expect(screen.getByTestId('activity-chip-s-1-bash')).toBeInTheDocument();
    expect(screen.getByTestId('activity-chip-s-1-search')).toBeInTheDocument();
  });

  it('compresses 4 same-dir reads into one chip with count', () => {
    seedActivities('s-1', [
      { event: { kind: 'file-read', path: 'src/a.ts' }, timestampMs: 1000 },
      { event: { kind: 'file-read', path: 'src/b.ts' }, timestampMs: 1100 },
      { event: { kind: 'file-read', path: 'src/c.ts' }, timestampMs: 1200 },
      { event: { kind: 'file-read', path: 'src/d.ts' }, timestampMs: 1300 },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    const chips = screen.getAllByTestId(/^activity-chip-s-1-/);
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toMatch(/Reading 4 files in src\//);
    expect(chips[0].getAttribute('data-count')).toBe('4');
  });

  it('caps visible chips at 5 even when more events stored', () => {
    const events = Array.from({ length: 8 }, (_, i) => ({
      event: {
        kind: 'bash' as const,
        command: `cmd-${i}`,
      },
      timestampMs: 1000 + i,
    }));
    seedActivities('s-1', events);
    render(<ActivityChipStack subtaskId="s-1" />);
    const chips = screen.getAllByTestId(/^activity-chip-s-1-/);
    expect(chips).toHaveLength(5);
    // Latest 5 — newest is cmd-7.
    expect(chips[chips.length - 1].textContent).toContain('cmd-7');
  });

  it('renders aria-label per chip', () => {
    seedActivities('s-1', [
      { event: { kind: 'file-read', path: 'src/a.ts' }, timestampMs: 1000 },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    const chip = screen.getByTestId('activity-chip-s-1-file-read');
    expect(chip.getAttribute('aria-label')).toMatch(/Reading src\/a\.ts/);
  });

  it('compressed chip aria-label cites event count', () => {
    seedActivities('s-1', [
      { event: { kind: 'file-read', path: 'src/a.ts' }, timestampMs: 1000 },
      { event: { kind: 'file-read', path: 'src/b.ts' }, timestampMs: 1100 },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    const chip = screen.getByTestId('activity-chip-s-1-file-read');
    expect(chip.getAttribute('aria-label')).toMatch(/compressed 2 events/);
  });
});
