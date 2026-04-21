import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

import { useGraphStore } from '../../state/graphStore';

import { AutoApproveSuspendedBanner } from './AutoApproveSuspendedBanner';

beforeEach(() => {
  useGraphStore.getState().reset();
});

afterEach(() => {
  useGraphStore.getState().reset();
});

describe('AutoApproveSuspendedBanner', () => {
  it('renders nothing when autoApproveSuspended is null', () => {
    render(<AutoApproveSuspendedBanner />);
    expect(screen.queryByTestId('auto-approve-suspended-banner')).toBeNull();
  });

  it('renders the subtask_limit copy when set', () => {
    useGraphStore.setState({ autoApproveSuspended: { reason: 'subtask_limit' } });
    render(<AutoApproveSuspendedBanner />);
    const banner = screen.getByTestId('auto-approve-suspended-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/subtask ceiling/i);
    expect(banner).toHaveTextContent(/manual approval/i);
  });

  it('falls back to a generic message for unknown reasons', () => {
    useGraphStore.setState({ autoApproveSuspended: { reason: 'novel_reason' } });
    render(<AutoApproveSuspendedBanner />);
    expect(
      screen.getByTestId('auto-approve-suspended-banner'),
    ).toHaveTextContent(/remaining plan passes need manual approval/i);
  });

  it('dismiss clears the store state', () => {
    useGraphStore.setState({ autoApproveSuspended: { reason: 'subtask_limit' } });
    render(<AutoApproveSuspendedBanner />);
    fireEvent.click(screen.getByLabelText(/dismiss auto-approve suspended notice/i));
    expect(useGraphStore.getState().autoApproveSuspended).toBeNull();
  });
});
