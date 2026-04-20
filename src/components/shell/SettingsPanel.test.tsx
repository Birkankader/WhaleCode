import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../../lib/ipc')>('../../lib/ipc');
  return {
    ...actual,
    setSettings: vi.fn(),
  };
});

import { setSettings, type Settings } from '../../lib/ipc';
import { useRepoStore } from '../../state/repoStore';

import { SettingsPanel } from './SettingsPanel';

function seedSettings(overrides: Partial<Settings> = {}) {
  const base: Settings = {
    lastRepo: null,
    masterAgent: 'claude',
    autoApprove: false,
    maxSubtasksPerAutoApprovedRun: 20,
    autoApproveConsentGiven: false,
    ...overrides,
  };
  useRepoStore.setState({ settings: base });
  vi.mocked(setSettings).mockResolvedValue(base);
}

describe('SettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when settings are not loaded', () => {
    useRepoStore.setState({ settings: null });
    const { container } = render(<SettingsPanel onClose={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('opens the consent modal on first activation, not after confirm', async () => {
    seedSettings();
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);

    const toggle = screen.getByRole('switch', { name: /auto-approve/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    // Modal should appear, IPC should NOT have been called yet.
    expect(screen.getByRole('dialog', { name: /enable auto-approve\?/i })).toBeInTheDocument();
    expect(setSettings).not.toHaveBeenCalled();
  });

  it('persists autoApprove + consent flag on confirm', async () => {
    seedSettings();
    const merged: Settings = {
      lastRepo: null,
      masterAgent: 'claude',
      autoApprove: true,
      maxSubtasksPerAutoApprovedRun: 20,
      autoApproveConsentGiven: true,
    };
    vi.mocked(setSettings).mockResolvedValueOnce(merged);

    render(<SettingsPanel onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('switch', { name: /auto-approve/i }));
    fireEvent.click(screen.getByRole('button', { name: /enable auto-approve/i }));

    expect(setSettings).toHaveBeenCalledWith({
      autoApprove: true,
      autoApproveConsentGiven: true,
    });
  });

  it('cancelling the modal leaves settings untouched', () => {
    seedSettings();
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(screen.getByRole('switch', { name: /auto-approve/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(setSettings).not.toHaveBeenCalled();
    // Modal closes after cancel.
    expect(
      screen.queryByRole('dialog', { name: /enable auto-approve\?/i }),
    ).toBeNull();
  });

  it('skips the modal on subsequent activations once consent was given', () => {
    seedSettings({ autoApproveConsentGiven: true });
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(screen.getByRole('switch', { name: /auto-approve/i }));
    // No modal gate — IPC fires directly with `autoApprove: true` only.
    expect(
      screen.queryByRole('dialog', { name: /enable auto-approve\?/i }),
    ).toBeNull();
    expect(setSettings).toHaveBeenCalledWith({ autoApprove: true });
  });

  it('turning auto-approve off is direct and needs no consent', () => {
    seedSettings({ autoApprove: true, autoApproveConsentGiven: true });
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(screen.getByRole('switch', { name: /auto-approve/i }));
    expect(setSettings).toHaveBeenCalledWith({ autoApprove: false });
  });

  it('shows the max-subtasks input only when auto-approve is on', () => {
    seedSettings();
    const { rerender } = render(<SettingsPanel onClose={() => undefined} />);
    expect(screen.queryByLabelText(/max subtasks per run/i)).toBeNull();

    seedSettings({ autoApprove: true, autoApproveConsentGiven: true });
    rerender(<SettingsPanel onClose={() => undefined} />);
    expect(screen.getByLabelText(/max subtasks per run/i)).toBeInTheDocument();
  });

  it('persists a valid max-subtasks value on blur', () => {
    seedSettings({ autoApprove: true, autoApproveConsentGiven: true });
    render(<SettingsPanel onClose={() => undefined} />);

    const input = screen.getByLabelText(/max subtasks per run/i);
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.blur(input);

    expect(setSettings).toHaveBeenCalledWith({ maxSubtasksPerAutoApprovedRun: 42 });
  });

  it('rejects non-positive max-subtasks and surfaces an error', () => {
    seedSettings({
      autoApprove: true,
      autoApproveConsentGiven: true,
      maxSubtasksPerAutoApprovedRun: 20,
    });
    render(<SettingsPanel onClose={() => undefined} />);

    const input = screen.getByLabelText(/max subtasks per run/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);

    expect(setSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/positive integer/i);
    // Input reverts to the persisted value.
    expect(input.value).toBe('20');
  });

  it('persists a cleared editor field as null', () => {
    seedSettings({ editor: 'code' });
    render(<SettingsPanel onClose={() => undefined} />);

    const input = screen.getByLabelText(/editor/i);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(setSettings).toHaveBeenCalledWith({ editor: null });
  });

  it('persists a non-empty editor value', () => {
    seedSettings();
    render(<SettingsPanel onClose={() => undefined} />);

    const input = screen.getByLabelText(/editor/i);
    fireEvent.change(input, { target: { value: 'nvim' } });
    fireEvent.blur(input);

    expect(setSettings).toHaveBeenCalledWith({ editor: 'nvim' });
  });

  it('closes on Escape', () => {
    seedSettings();
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
