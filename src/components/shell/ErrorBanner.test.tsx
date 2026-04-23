import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

import { useGraphStore } from '../../state/graphStore';

import { ErrorBanner } from './ErrorBanner';

beforeEach(() => {
  useGraphStore.getState().reset();
});

afterEach(() => {
  useGraphStore.getState().reset();
});

describe('ErrorBanner', () => {
  it('renders nothing when currentError is null', () => {
    render(<ErrorBanner />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the summary when an error is set', () => {
    useGraphStore.setState({ currentError: 'Failed to start run: boom' });
    render(<ErrorBanner />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Failed to start run: boom')).toBeInTheDocument();
  });

  it('omits the details toggle for single-line errors', () => {
    useGraphStore.setState({ currentError: 'Short error' });
    render(<ErrorBanner />);
    expect(screen.queryByRole('button', { name: /show details/i })).toBeNull();
  });

  it('toggles the details block when the chevron is clicked', () => {
    useGraphStore.setState({
      currentError: 'Summary line\nStack trace line 1\nStack trace line 2',
    });
    render(<ErrorBanner />);
    expect(screen.queryByText(/Stack trace line 1/)).toBeNull();

    const toggle = screen.getByRole('button', { name: /show details/i });
    fireEvent.click(toggle);
    expect(screen.getByText(/Stack trace line 1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hide details/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /hide details/i }));
    expect(screen.queryByText(/Stack trace line 1/)).toBeNull();
  });

  it('dismiss button clears currentError', () => {
    useGraphStore.setState({ currentError: 'Summary line' });
    render(<ErrorBanner />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss error/i }));
    expect(useGraphStore.getState().currentError).toBeNull();
  });

  it('warning variant renders with amber accent', () => {
    useGraphStore.setState({ currentError: 'Heads up' });
    render(<ErrorBanner variant="warning" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-variant', 'warning');
    // jsdom normalises CSS-var inline styles; assert on the raw attribute to
    // confirm the amber token is referenced rather than relying on
    // toHaveStyle() parsing.
    const inline = alert.getAttribute('style') ?? '';
    expect(inline).toContain('var(--color-status-pending)');
  });

  // -------------------------------------------------------------------
  // Phase 4 Step 5 — category-aware banner
  // -------------------------------------------------------------------

  it('renders category-locked copy for ProcessCrashed', () => {
    useGraphStore.setState({
      subtaskErrorCategories: new Map([['sub-1', { kind: 'process-crashed' }]]),
    });
    render(<ErrorBanner />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-category-kind', 'process-crashed');
    expect(screen.getByText('Subprocess crashed')).toBeInTheDocument();
  });

  it('renders category-locked copy for TaskFailed', () => {
    useGraphStore.setState({
      subtaskErrorCategories: new Map([['sub-1', { kind: 'task-failed' }]]),
    });
    render(<ErrorBanner />);
    expect(screen.getByText('Task failed')).toBeInTheDocument();
  });

  it('renders category-locked copy for ParseFailed', () => {
    useGraphStore.setState({
      subtaskErrorCategories: new Map([['sub-1', { kind: 'parse-failed' }]]),
    });
    render(<ErrorBanner />);
    expect(screen.getByText('Invalid agent output')).toBeInTheDocument();
  });

  it('formats Timeout duration in whole minutes', () => {
    useGraphStore.setState({
      subtaskErrorCategories: new Map([
        ['sub-1', { kind: 'timeout', afterSecs: 600 }],
      ]),
    });
    render(<ErrorBanner />);
    expect(screen.getByText('Timed out after 10m')).toBeInTheDocument();
  });

  it('formats sub-minute Timeout as <1m', () => {
    useGraphStore.setState({
      subtaskErrorCategories: new Map([
        ['sub-1', { kind: 'timeout', afterSecs: 0 }],
      ]),
    });
    render(<ErrorBanner />);
    expect(screen.getByText('Timed out after <1m')).toBeInTheDocument();
  });

  it('renders category-locked copy for SpawnFailed', () => {
    useGraphStore.setState({
      subtaskErrorCategories: new Map([['sub-1', { kind: 'spawn-failed' }]]),
    });
    render(<ErrorBanner />);
    expect(screen.getByText("Agent couldn't start")).toBeInTheDocument();
  });

  it('collapses two same-kind failures into one banner', () => {
    useGraphStore.setState({
      subtaskErrorCategories: new Map([
        ['sub-1', { kind: 'process-crashed' }],
        ['sub-2', { kind: 'process-crashed' }],
      ]),
    });
    render(<ErrorBanner />);
    const summaries = screen.getAllByText('Subprocess crashed');
    expect(summaries).toHaveLength(1);
  });

  it('falls back to generic error summary when kinds disagree', () => {
    useGraphStore.setState({
      currentError: 'Something went wrong',
      subtaskErrorCategories: new Map([
        ['sub-1', { kind: 'process-crashed' }],
        ['sub-2', { kind: 'parse-failed' }],
      ]),
    });
    render(<ErrorBanner />);
    // Generic fallback — neither locked string appears as the summary.
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByText('Subprocess crashed')).toBeNull();
    expect(screen.queryByText('Invalid agent output')).toBeNull();
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-category-kind')).toBeNull();
  });

  it('promotes free-form currentError into the collapsible details of a category banner', () => {
    useGraphStore.setState({
      currentError: 'stderr: segfault at 0x0',
      subtaskErrorCategories: new Map([['sub-1', { kind: 'process-crashed' }]]),
    });
    render(<ErrorBanner />);
    // Headline = locked copy; free-form text hidden until expanded.
    expect(screen.getByText('Subprocess crashed')).toBeInTheDocument();
    expect(screen.queryByText(/segfault at 0x0/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show details/i }));
    expect(screen.getByText(/segfault at 0x0/)).toBeInTheDocument();
  });

  it('dismiss sets the errorCategoryBannerDismissed latch', () => {
    // jsdom + Framer Motion's AnimatePresence keeps the exiting node
    // in the DOM for the duration of the exit animation, so we assert
    // on the store flag rather than querying `alert`. The existing
    // `currentError` dismissal test uses the same contract pattern.
    useGraphStore.setState({
      subtaskErrorCategories: new Map([['sub-1', { kind: 'timeout', afterSecs: 120 }]]),
    });
    render(<ErrorBanner />);
    expect(useGraphStore.getState().errorCategoryBannerDismissed).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /dismiss error/i }));
    expect(useGraphStore.getState().errorCategoryBannerDismissed).toBe(true);
  });

  it('honors the dismissal latch so the category headline does not render', () => {
    useGraphStore.setState({
      subtaskErrorCategories: new Map([['sub-1', { kind: 'timeout', afterSecs: 120 }]]),
      errorCategoryBannerDismissed: true,
    });
    render(<ErrorBanner />);
    // Latched — no category-kind marker, no locked copy.
    expect(screen.queryByText(/Timed out/)).toBeNull();
  });

  it('re-arms the category banner when the latch is cleared', () => {
    // Simulates the `handleSubtaskStateChanged` re-arm path: a new
    // `Failed` transition with a not-yet-seen kind flips the latch
    // back to false and the banner returns. Two entries that share a
    // kind still collapse to a single category banner.
    useGraphStore.setState({
      subtaskErrorCategories: new Map([
        ['sub-1', { kind: 'timeout', afterSecs: 120 }],
        ['sub-2', { kind: 'timeout', afterSecs: 240 }],
      ]),
      errorCategoryBannerDismissed: false,
    });
    render(<ErrorBanner />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-category-kind', 'timeout');
    // Representative `afterSecs` on sub-1 (120s → 2m) drives the copy.
    expect(screen.getByText('Timed out after 2m')).toBeInTheDocument();
  });
});

describe('ErrorBanner — Phase 5 Step 2 stash & retry action', () => {
  it('hides the Stash & retry button when baseBranchDirty is null', () => {
    useGraphStore.setState({ currentError: 'Some other error' });
    render(<ErrorBanner />);
    expect(screen.queryByTestId('error-banner-stash-retry')).toBeNull();
  });

  it('shows the Stash & retry button when baseBranchDirty is set', () => {
    useGraphStore.setState({
      currentError: 'You have uncommitted changes in 1 file',
      baseBranchDirty: { files: ['seed.txt'] },
    });
    render(<ErrorBanner />);
    const btn = screen.getByTestId('error-banner-stash-retry');
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).toMatch(/stash & retry apply/i);
  });

  it('calls stashAndRetryApply on click', () => {
    const stashAndRetryApply = vi.fn(async () => undefined);
    useGraphStore.setState({
      currentError: 'You have uncommitted changes',
      baseBranchDirty: { files: ['seed.txt'] },
      stashAndRetryApply,
    });
    render(<ErrorBanner />);
    fireEvent.click(screen.getByTestId('error-banner-stash-retry'));
    expect(stashAndRetryApply).toHaveBeenCalled();
  });

  it('disables the button and renders "Stashing…" while stashInFlight is "stash-and-retry"', () => {
    useGraphStore.setState({
      currentError: 'You have uncommitted changes',
      baseBranchDirty: { files: ['seed.txt'] },
      stashInFlight: 'stash-and-retry',
    });
    render(<ErrorBanner />);
    const btn = screen.getByTestId('error-banner-stash-retry');
    expect(btn).toBeDisabled();
    expect(btn.textContent).toMatch(/stashing/i);
  });
});

describe('ErrorBanner — Phase 5 Step 3 merge conflict resolver action', () => {
  it('hides the Open resolver button when mergeConflict is null', () => {
    useGraphStore.setState({ currentError: 'unrelated error' });
    render(<ErrorBanner />);
    expect(screen.queryByTestId('error-banner-open-resolver')).toBeNull();
  });

  it('shows the Open resolver button when mergeConflict is set', () => {
    useGraphStore.setState({
      mergeConflict: { files: ['x.txt', 'y.rs'], retryAttempt: 0 },
    });
    render(<ErrorBanner />);
    const btn = screen.getByTestId('error-banner-open-resolver');
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).toMatch(/open resolver/i);
  });

  it('derives conflict summary copy when no other error signal dominates', () => {
    useGraphStore.setState({
      currentError: null,
      mergeConflict: { files: ['x.txt', 'y.rs'], retryAttempt: 0 },
    });
    render(<ErrorBanner />);
    expect(screen.getByTestId('error-banner-summary').textContent).toMatch(
      /merge conflict on 2 files/i,
    );
  });

  it('swaps copy to "Still conflicted (attempt N)" after a retry failure', () => {
    useGraphStore.setState({
      currentError: null,
      mergeConflict: { files: ['x.txt'], retryAttempt: 2 },
    });
    render(<ErrorBanner />);
    expect(screen.getByTestId('error-banner-summary').textContent).toMatch(
      /still conflicted on 1 file \(attempt 2\)/i,
    );
  });

  it('click fires setConflictResolverOpen(true)', () => {
    useGraphStore.setState({
      mergeConflict: { files: ['x.txt'], retryAttempt: 0 },
      conflictResolverOpen: false,
    });
    render(<ErrorBanner />);
    fireEvent.click(screen.getByTestId('error-banner-open-resolver'));
    expect(useGraphStore.getState().conflictResolverOpen).toBe(true);
  });
});
