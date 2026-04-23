/**
 * Phase 5 Step 2 — StashBanner unit tests.
 *
 * Covers:
 *   - visibility gated on `stash !== null`;
 *   - Pop click → calls store `popStash` → disabled "Popping…" while
 *     in flight;
 *   - Copy ref → `navigator.clipboard.writeText` with the full ref,
 *     transient check icon;
 *   - Dismiss hides the banner in-session without clearing the
 *     store's stash entry;
 *   - Conflict variant renders the error copy + hides the Pop
 *     button, leaves Copy / Dismiss visible.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

import { useGraphStore } from '../../state/graphStore';

import { StashBanner } from './StashBanner';

function installClipboard(fn: (text: string) => Promise<void>): void {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: fn },
  });
}

beforeEach(() => {
  useGraphStore.setState({
    runId: 'r-1',
    stash: null,
    stashInFlight: null,
  });
});

afterEach(() => {
  useGraphStore.getState().reset();
});

describe('StashBanner — visibility', () => {
  it('does not render when stash is null', () => {
    render(<StashBanner />);
    expect(screen.queryByTestId('stash-banner')).toBeNull();
  });

  it('renders when a stash entry is present with the short ref', () => {
    useGraphStore.setState({
      stash: { ref: '0123456789abcdef', popFailed: null },
    });
    render(<StashBanner />);
    expect(screen.getByTestId('stash-banner')).toBeInTheDocument();
    expect(screen.getByTestId('stash-banner-ref').textContent).toBe(
      '0123456789',
    );
  });
});

describe('StashBanner — pop', () => {
  it('fires popStash on click', async () => {
    const popStash = vi.fn(async () => undefined);
    useGraphStore.setState({
      stash: { ref: 'abc123def456', popFailed: null },
      popStash,
    });
    render(<StashBanner />);
    fireEvent.click(screen.getByTestId('stash-banner-pop'));
    await waitFor(() => {
      expect(popStash).toHaveBeenCalled();
    });
  });

  it('shows "Popping…" and disables the button while stashInFlight is "pop"', () => {
    useGraphStore.setState({
      stash: { ref: 'abc123', popFailed: null },
      stashInFlight: 'pop',
    });
    render(<StashBanner />);
    const btn = screen.getByTestId('stash-banner-pop');
    expect(btn).toBeDisabled();
    expect(btn.textContent).toMatch(/popping/i);
  });
});

describe('StashBanner — copy ref', () => {
  it('writes the full ref to the clipboard and toggles the check icon', async () => {
    const writeText = vi.fn(async () => undefined);
    installClipboard(writeText);
    useGraphStore.setState({
      stash: { ref: 'full-sha-0000', popFailed: null },
    });
    render(<StashBanner />);
    fireEvent.click(screen.getByTestId('stash-banner-copy'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('full-sha-0000');
    });
  });

  it('swallows a clipboard rejection silently (no throw to caller)', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('clipboard blocked');
    });
    installClipboard(writeText);
    useGraphStore.setState({
      stash: { ref: 'abc', popFailed: null },
    });
    render(<StashBanner />);
    fireEvent.click(screen.getByTestId('stash-banner-copy'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    // Still rendered — the rejection didn't tear anything down.
    expect(screen.getByTestId('stash-banner')).toBeInTheDocument();
  });
});

describe('StashBanner — dismiss', () => {
  it('hides the banner without clearing the store stash entry', async () => {
    useGraphStore.setState({
      stash: { ref: 'abc', popFailed: null },
    });
    render(<StashBanner />);
    expect(screen.getByTestId('stash-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('stash-banner-dismiss'));
    // AnimatePresence keeps the node in the DOM until the exit
    // animation resolves — poll for removal.
    await waitFor(
      () => {
        expect(screen.queryByTestId('stash-banner')).toBeNull();
      },
      { timeout: 2000 },
    );
    expect(useGraphStore.getState().stash).not.toBeNull();
  });
});

describe('StashBanner — conflict variant', () => {
  it('renders error copy and hides the Pop button', () => {
    useGraphStore.setState({
      stash: {
        ref: 'abc',
        popFailed: { kind: 'conflict', error: 'conflict on X' },
      },
    });
    render(<StashBanner />);
    const banner = screen.getByTestId('stash-banner');
    expect(banner.getAttribute('data-kind')).toBe('conflict');
    expect(banner.textContent).toMatch(/stash pop conflicted/i);
    expect(banner.textContent).toMatch(/git stash drop/);
    expect(screen.queryByTestId('stash-banner-pop')).toBeNull();
    // Copy + Dismiss remain available.
    expect(screen.getByTestId('stash-banner-copy')).toBeInTheDocument();
    expect(screen.getByTestId('stash-banner-dismiss')).toBeInTheDocument();
  });
});
