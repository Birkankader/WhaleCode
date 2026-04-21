import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Dropdown } from './Dropdown';

type Kind = 'claude' | 'gemini' | 'codex';

const OPTIONS = [
  { value: 'claude' as Kind, label: 'claude code' },
  { value: 'gemini' as Kind, label: 'gemini cli' },
  { value: 'codex' as Kind, label: 'codex cli' },
] as const;

function harness(onChange = vi.fn<(next: Kind) => void>(), initial: Kind = 'claude') {
  render(
    <Dropdown<Kind>
      value={initial}
      options={OPTIONS}
      onChange={onChange}
      ariaLabel="assigned worker"
      renderTrigger={({ value, toggle, triggerRef, open }) => (
        <button
          ref={triggerRef}
          type="button"
          aria-label="Change assigned worker"
          aria-expanded={open}
          onClick={toggle}
        >
          {value}
        </button>
      )}
    />,
  );
  return { onChange };
}

describe('Dropdown — open/close', () => {
  it('menu is closed by default', () => {
    harness();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('clicking the trigger opens the menu', () => {
    harness();
    fireEvent.click(screen.getByLabelText('Change assigned worker'));
    expect(screen.getByRole('listbox')).toBeDefined();
  });

  it('Escape closes the menu and returns focus to the trigger', () => {
    harness();
    const trigger = screen.getByLabelText('Change assigned worker');
    fireEvent.click(trigger);
    const menu = screen.getByRole('listbox');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('pointerdown outside the menu closes it', () => {
    harness();
    fireEvent.click(screen.getByLabelText('Change assigned worker'));
    expect(screen.getByRole('listbox')).toBeDefined();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('Dropdown — keyboard navigation', () => {
  it('ArrowDown moves highlight forward; Enter commits', () => {
    const onChange = vi.fn();
    harness(onChange, 'claude');
    fireEvent.click(screen.getByLabelText('Change assigned worker'));
    const menu = screen.getByRole('listbox');
    fireEvent.keyDown(menu, { key: 'ArrowDown' }); // claude → gemini
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('gemini');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('ArrowUp at top wraps to last option', () => {
    const onChange = vi.fn();
    harness(onChange, 'claude');
    fireEvent.click(screen.getByLabelText('Change assigned worker'));
    const menu = screen.getByRole('listbox');
    fireEvent.keyDown(menu, { key: 'ArrowUp' }); // claude → codex (wrap)
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('codex');
  });

  it('Home/End jump to first/last', () => {
    const onChange = vi.fn();
    harness(onChange, 'gemini');
    fireEvent.click(screen.getByLabelText('Change assigned worker'));
    const menu = screen.getByRole('listbox');
    fireEvent.keyDown(menu, { key: 'End' });
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('codex');
  });

  it('Space commits the highlighted option', () => {
    const onChange = vi.fn();
    harness(onChange, 'claude');
    fireEvent.click(screen.getByLabelText('Change assigned worker'));
    const menu = screen.getByRole('listbox');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: ' ' });
    expect(onChange).toHaveBeenCalledWith('gemini');
  });

  it('selecting the current value still closes (no-op onChange)', () => {
    const onChange = vi.fn();
    harness(onChange, 'claude');
    fireEvent.click(screen.getByLabelText('Change assigned worker'));
    const menu = screen.getByRole('listbox');
    // Highlight starts at current value → Enter commits same value.
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('Dropdown — mouse interaction', () => {
  it('clicking an option commits it', () => {
    const onChange = vi.fn();
    harness(onChange, 'claude');
    fireEvent.click(screen.getByLabelText('Change assigned worker'));
    fireEvent.click(screen.getByRole('option', { name: /codex cli/i }));
    expect(onChange).toHaveBeenCalledWith('codex');
  });

  it('hovering an option moves the highlight', () => {
    const onChange = vi.fn();
    harness(onChange, 'claude');
    fireEvent.click(screen.getByLabelText('Change assigned worker'));
    const codex = screen.getByRole('option', { name: /codex cli/i });
    fireEvent.mouseEnter(codex);
    const menu = screen.getByRole('listbox');
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('codex');
  });
});

describe('Dropdown — React Flow pointer-event safety', () => {
  it('menu wears nodrag and nopan classes', () => {
    harness();
    fireEvent.click(screen.getByLabelText('Change assigned worker'));
    const menu = screen.getByRole('listbox');
    expect(menu.className).toContain('nodrag');
    expect(menu.className).toContain('nopan');
  });
});
