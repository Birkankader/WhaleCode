import { describe, expect, it } from 'vitest';

import { describeErrorCategory, sameErrorCategoryKind } from './errorCategory';
import type { ErrorCategoryWire } from './ipc';

describe('describeErrorCategory', () => {
  // The five locked strings are a product contract (see
  // `docs/phase-4-spec.md` → Step 5). Any change to these assertions
  // is a copy change and should be a conscious review item.
  it('maps ProcessCrashed to "Subprocess crashed"', () => {
    expect(describeErrorCategory({ kind: 'process-crashed' })).toBe('Subprocess crashed');
  });

  it('maps TaskFailed to "Task failed"', () => {
    expect(describeErrorCategory({ kind: 'task-failed' })).toBe('Task failed');
  });

  it('maps ParseFailed to "Invalid agent output"', () => {
    expect(describeErrorCategory({ kind: 'parse-failed' })).toBe('Invalid agent output');
  });

  it('maps SpawnFailed to "Agent couldn\'t start"', () => {
    expect(describeErrorCategory({ kind: 'spawn-failed' })).toBe("Agent couldn't start");
  });

  describe('Timeout formatting', () => {
    it('renders <1m for sub-minute durations', () => {
      expect(describeErrorCategory({ kind: 'timeout', afterSecs: 0 })).toBe(
        'Timed out after <1m',
      );
      expect(describeErrorCategory({ kind: 'timeout', afterSecs: 45 })).toBe(
        'Timed out after <1m',
      );
    });

    it('rounds to the nearest whole minute for minute-scale durations', () => {
      expect(describeErrorCategory({ kind: 'timeout', afterSecs: 60 })).toBe(
        'Timed out after 1m',
      );
      expect(describeErrorCategory({ kind: 'timeout', afterSecs: 119 })).toBe(
        'Timed out after 2m',
      );
      expect(describeErrorCategory({ kind: 'timeout', afterSecs: 600 })).toBe(
        'Timed out after 10m',
      );
      expect(describeErrorCategory({ kind: 'timeout', afterSecs: 1800 })).toBe(
        'Timed out after 30m',
      );
    });
  });
});

describe('sameErrorCategoryKind', () => {
  it('returns true for identical kinds', () => {
    expect(
      sameErrorCategoryKind(
        { kind: 'process-crashed' },
        { kind: 'process-crashed' },
      ),
    ).toBe(true);
  });

  it('returns true for Timeout pairs with different afterSecs', () => {
    // Structural compare on `kind` only — two subtasks that both
    // timed out at different deadlines should still collapse to one
    // banner variant.
    const a: ErrorCategoryWire = { kind: 'timeout', afterSecs: 60 };
    const b: ErrorCategoryWire = { kind: 'timeout', afterSecs: 600 };
    expect(sameErrorCategoryKind(a, b)).toBe(true);
  });

  it('returns false across kinds', () => {
    expect(
      sameErrorCategoryKind({ kind: 'process-crashed' }, { kind: 'parse-failed' }),
    ).toBe(false);
  });
});
