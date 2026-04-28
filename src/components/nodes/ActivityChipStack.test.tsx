/**
 * Phase 6 Step 2 — ActivityChipStack unit tests.
 */

import { fireEvent, render, screen } from '@testing-library/react';
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

  it('caps visible chips at 3 even when more events stored (Phase 7 polish — narrower default)', () => {
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
    expect(chips).toHaveLength(3);
    // Latest 3 — newest is cmd-7.
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

// ---------------------------------------------------------------------
// Phase 7 polish — click chip → expand inline detail panel
// ---------------------------------------------------------------------

describe('ActivityChipStack — chip click → detail panel', () => {
  it('detail panel hidden by default (no chip selected)', () => {
    seedActivities('s-1', [
      { event: { kind: 'file-read', path: 'src/auth.ts' }, timestampMs: 1000 },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    expect(screen.queryByTestId('activity-chip-detail-s-1')).toBeNull();
  });

  it('clicking a file-read chip opens the detail panel with full path', () => {
    seedActivities('s-1', [
      {
        event: { kind: 'file-read', path: 'apps/web/src/routes/very/long/path.tsx' },
        timestampMs: 1000,
      },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('activity-chip-s-1-file-read'));
    const detail = screen.getByTestId('activity-chip-detail-s-1');
    expect(detail.getAttribute('data-kind')).toBe('file-read');
    expect(screen.getByTestId('activity-chip-detail-path')).toHaveTextContent(
      /Read.+apps\/web\/src\/routes\/very\/long\/path\.tsx/,
    );
  });

  it('file-read detail surfaces line range when present', () => {
    seedActivities('s-1', [
      {
        event: { kind: 'file-read', path: 'src/auth.ts', lines: [1, 50] },
        timestampMs: 1000,
      },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('activity-chip-s-1-file-read'));
    expect(screen.getByTestId('activity-chip-detail-path')).toHaveTextContent(
      /lines 1.50/,
    );
  });

  it('file-edit detail shows full path AND summary line', () => {
    seedActivities('s-1', [
      {
        event: { kind: 'file-edit', path: 'src/signup.tsx', summary: 'wired onChange handler' },
        timestampMs: 1000,
      },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('activity-chip-s-1-file-edit'));
    expect(screen.getByTestId('activity-chip-detail-path')).toHaveTextContent(/src\/signup\.tsx/);
    expect(screen.getByTestId('activity-chip-detail-summary')).toHaveTextContent(
      /wired onChange handler/,
    );
  });

  it('bash detail shows the full command verbatim', () => {
    seedActivities('s-1', [
      {
        event: { kind: 'bash', command: 'pnpm test --run --filter=signup' },
        timestampMs: 1000,
      },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('activity-chip-s-1-bash'));
    expect(screen.getByTestId('activity-chip-detail-command')).toHaveTextContent(
      /pnpm test --run --filter=signup/,
    );
  });

  it('search detail shows query and paths', () => {
    seedActivities('s-1', [
      {
        event: { kind: 'search', query: 'validateToken', paths: ['src/auth', 'tests'] },
        timestampMs: 1000,
      },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('activity-chip-s-1-search'));
    expect(screen.getByTestId('activity-chip-detail-query')).toHaveTextContent(/validateToken/);
    expect(screen.getByTestId('activity-chip-detail-query')).toHaveTextContent(/src\/auth/);
  });

  it('other detail shows tool name and detail string', () => {
    seedActivities('s-1', [
      {
        event: { kind: 'other', toolName: 'WebFetch', detail: 'fetched https://example.com' },
        timestampMs: 1000,
      },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('activity-chip-s-1-other'));
    expect(screen.getByTestId('activity-chip-detail-other')).toHaveTextContent(/WebFetch/);
    expect(screen.getByTestId('activity-chip-detail-other')).toHaveTextContent(
      /fetched https:\/\/example\.com/,
    );
  });

  it('clicking the same chip a second time closes the panel', () => {
    seedActivities('s-1', [
      { event: { kind: 'bash', command: 'ls' }, timestampMs: 1000 },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    const chip = screen.getByTestId('activity-chip-s-1-bash');
    fireEvent.click(chip);
    expect(screen.getByTestId('activity-chip-detail-s-1')).toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.queryByTestId('activity-chip-detail-s-1')).toBeNull();
  });

  it('clicking a different chip switches the detail (not stacks them)', () => {
    seedActivities('s-1', [
      { event: { kind: 'file-read', path: 'a.ts' }, timestampMs: 1000 },
      { event: { kind: 'bash', command: 'pnpm test' }, timestampMs: 1100 },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('activity-chip-s-1-file-read'));
    expect(screen.getByTestId('activity-chip-detail-s-1').getAttribute('data-kind')).toBe(
      'file-read',
    );
    fireEvent.click(screen.getByTestId('activity-chip-s-1-bash'));
    const details = screen.getAllByTestId('activity-chip-detail-s-1');
    expect(details).toHaveLength(1);
    expect(details[0].getAttribute('data-kind')).toBe('bash');
  });

  it('explicit close button closes the panel', () => {
    seedActivities('s-1', [
      { event: { kind: 'bash', command: 'ls' }, timestampMs: 1000 },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('activity-chip-s-1-bash'));
    fireEvent.click(screen.getByLabelText(/Close activity detail/i));
    expect(screen.queryByTestId('activity-chip-detail-s-1')).toBeNull();
  });

  it('compressed chip detail cites the count in the body', () => {
    seedActivities('s-1', [
      { event: { kind: 'file-read', path: 'src/a.ts' }, timestampMs: 1000 },
      { event: { kind: 'file-read', path: 'src/b.ts' }, timestampMs: 1100 },
      { event: { kind: 'file-read', path: 'src/c.ts' }, timestampMs: 1200 },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    fireEvent.click(screen.getByTestId('activity-chip-s-1-file-read'));
    expect(screen.getByTestId('activity-chip-detail-path')).toHaveTextContent(
      /3 reads compressed/,
    );
  });

  it('chip aria-pressed reflects selection state', () => {
    seedActivities('s-1', [
      { event: { kind: 'bash', command: 'ls' }, timestampMs: 1000 },
    ]);
    render(<ActivityChipStack subtaskId="s-1" />);
    const chip = screen.getByTestId('activity-chip-s-1-bash');
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
  });
});
