import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AutoApproveConsentModal } from './AutoApproveConsentModal';

describe('AutoApproveConsentModal', () => {
  it('renders the heading and the two action buttons', () => {
    render(
      <AutoApproveConsentModal onConfirm={() => undefined} onCancel={() => undefined} />,
    );
    expect(
      screen.getByRole('dialog', { name: /enable auto-approve\?/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /enable auto-approve/i }),
    ).toBeInTheDocument();
  });

  it('invokes onConfirm when the primary button is clicked', () => {
    const onConfirm = vi.fn();
    render(
      <AutoApproveConsentModal onConfirm={onConfirm} onCancel={() => undefined} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /enable auto-approve/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('invokes onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(
      <AutoApproveConsentModal onConfirm={() => undefined} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('invokes onCancel on Escape', () => {
    const onCancel = vi.fn();
    render(
      <AutoApproveConsentModal onConfirm={() => undefined} onCancel={onCancel} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
