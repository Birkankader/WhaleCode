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
});
