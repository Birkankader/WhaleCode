/**
 * Phase 6 Step 2 — chip-compression unit tests.
 */

import { describe, expect, it } from 'vitest';

import type { ToolEvent } from '../lib/ipc';
import {
  COMPRESSION_WINDOW_MS,
  chipLabel,
  compressActivities,
  truncatePath,
} from './activityCompression';

function read(path: string): ToolEvent {
  return { kind: 'file-read', path };
}

function edit(path: string): ToolEvent {
  return { kind: 'file-edit', path, summary: 'edited' };
}

function bash(command: string): ToolEvent {
  return { kind: 'bash', command };
}

describe('compressActivities', () => {
  it('returns empty list for empty input', () => {
    expect(compressActivities([])).toEqual([]);
  });

  it('keeps single events uncompressed', () => {
    const out = compressActivities([
      { event: read('src/auth.ts'), timestampMs: 1000 },
      { event: bash('pnpm test'), timestampMs: 1100 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].count).toBe(1);
    expect(out[1].count).toBe(1);
  });

  it('collapses 4 same-dir reads into 1 chip with count 4', () => {
    const out = compressActivities([
      { event: read('src/a.ts'), timestampMs: 1000 },
      { event: read('src/b.ts'), timestampMs: 1100 },
      { event: read('src/c.ts'), timestampMs: 1200 },
      { event: read('src/d.ts'), timestampMs: 1300 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(4);
    expect(out[0].parentDir).toBe('src');
  });

  it('keeps different-dir reads as separate chips', () => {
    const out = compressActivities([
      { event: read('src/a.ts'), timestampMs: 1000 },
      { event: read('lib/b.ts'), timestampMs: 1100 },
      { event: read('src/c.ts'), timestampMs: 1200 },
      { event: read('lib/d.ts'), timestampMs: 1300 },
    ]);
    expect(out).toHaveLength(4);
    out.forEach((chip) => expect(chip.count).toBe(1));
  });

  it('breaks compression on kind mismatch', () => {
    const out = compressActivities([
      { event: read('src/a.ts'), timestampMs: 1000 },
      { event: edit('src/b.ts'), timestampMs: 1100 },
      { event: read('src/c.ts'), timestampMs: 1200 },
    ]);
    expect(out).toHaveLength(3);
  });

  it('breaks compression outside the time window', () => {
    const out = compressActivities([
      { event: read('src/a.ts'), timestampMs: 1000 },
      { event: read('src/b.ts'), timestampMs: 1000 + COMPRESSION_WINDOW_MS + 1 },
    ]);
    expect(out).toHaveLength(2);
  });

  it('does not compress events without a path (bash)', () => {
    const out = compressActivities([
      { event: bash('a'), timestampMs: 1000 },
      { event: bash('b'), timestampMs: 1100 },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('truncatePath', () => {
  it('returns path unchanged when within budget', () => {
    expect(truncatePath('src/auth.ts', 40)).toBe('src/auth.ts');
  });

  it('mid-ellipsises when over budget', () => {
    const long = 'src/very/long/path/segment/that/exceeds/forty/chars/auth.ts';
    const out = truncatePath(long, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toContain('…');
    expect(out.startsWith('src/very/')).toBe(true);
    expect(out.endsWith('auth.ts')).toBe(true);
  });
});

describe('chipLabel', () => {
  it('renders single-event labels', () => {
    expect(
      chipLabel({
        id: 'a',
        event: read('src/auth.ts'),
        count: 1,
        timestampMs: 0,
        parentDir: 'src',
      }),
    ).toBe('Reading src/auth.ts');
  });

  it('renders compressed FileRead label with dir + count', () => {
    expect(
      chipLabel({
        id: 'a',
        event: read('src/a.ts'),
        count: 4,
        timestampMs: 0,
        parentDir: 'src',
      }),
    ).toBe('Reading 4 files in src/');
  });

  it('renders bash with truncation', () => {
    const cmd = 'pnpm test --run --reporter verbose --run-only auth.test.ts';
    const out = chipLabel({
      id: 'a',
      event: { kind: 'bash', command: cmd },
      count: 1,
      timestampMs: 0,
      parentDir: null,
    });
    expect(out.startsWith('Running ')).toBe(true);
  });

  it('renders Other with toolName + detail', () => {
    expect(
      chipLabel({
        id: 'a',
        event: { kind: 'other', toolName: 'WebFetch', detail: 'url: https://example.com' },
        count: 1,
        timestampMs: 0,
        parentDir: null,
      }),
    ).toContain('WebFetch');
  });
});
