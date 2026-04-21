import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { InlineTextEdit } from './InlineTextEdit';

// Real timers here on purpose: @testing-library's `waitFor` polls on setTimeout,
// so faking timers freezes async resolution. The shake animation uses a real
// 320ms setTimeout to clear `shaking`, but no test asserts on it finishing —
// only that the shake was triggered (state observable via error/aria).

describe('InlineTextEdit — display mode', () => {
  it('renders the value as a click-to-edit button', () => {
    const onSave = vi.fn();
    render(<InlineTextEdit value="hello" onSave={onSave} ariaLabel="title" />);
    expect(screen.getByRole('button', { name: /Edit title/i })).toBeDefined();
    expect(screen.getByText('hello')).toBeDefined();
  });

  it('shows emptyPlaceholder as italic tertiary when value is empty', () => {
    render(
      <InlineTextEdit
        value=""
        onSave={vi.fn()}
        ariaLabel="why"
        emptyPlaceholder="Add context…"
      />,
    );
    const btn = screen.getByRole('button', { name: /Edit why/i });
    expect(btn.textContent).toContain('Add context');
    expect(btn.className).toContain('italic');
  });

  it('disabled mode blocks entering edit', () => {
    const onSave = vi.fn();
    render(
      <InlineTextEdit value="hello" onSave={onSave} ariaLabel="title" disabled />,
    );
    const btn = screen.getByRole('button', { name: /Edit title/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // Regression: inline inputs inside a React Flow node MUST wear `nodrag nopan`
  // (and `nowheel` for textareas) so pan-on-drag + wheel-pan don't steal the
  // pointer. Locked down at the primitive so every caller inherits it.
  it('attaches nodrag and nopan classes to the display-mode trigger', () => {
    render(<InlineTextEdit value="x" onSave={vi.fn()} ariaLabel="title" />);
    const btn = screen.getByRole('button', { name: /Edit title/i });
    expect(btn.className).toContain('nodrag');
    expect(btn.className).toContain('nopan');
  });
});

describe('InlineTextEdit — edit mode keyboard flow (single-line)', () => {
  it('click → input appears focused; typing updates draft', () => {
    const onSave = vi.fn();
    render(<InlineTextEdit value="hello" onSave={onSave} ariaLabel="title" />);
    fireEvent.click(screen.getByRole('button', { name: /Edit title/i }));
    const input = screen.getByLabelText('title') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'hello world' } });
    expect(input.value).toBe('hello world');
  });

  it('Enter saves and exits edit mode', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<InlineTextEdit value="hello" onSave={onSave} ariaLabel="title" />);
    fireEvent.click(screen.getByRole('button', { name: /Edit title/i }));
    const input = screen.getByLabelText('title');
    fireEvent.change(input, { target: { value: 'changed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('changed'));
  });

  it('Escape cancels and reverts the draft without calling onSave', () => {
    const onSave = vi.fn();
    render(<InlineTextEdit value="hello" onSave={onSave} ariaLabel="title" />);
    fireEvent.click(screen.getByRole('button', { name: /Edit title/i }));
    const input = screen.getByLabelText('title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'dirty' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onSave).not.toHaveBeenCalled();
    // Back in display mode with original value.
    expect(screen.getByText('hello')).toBeDefined();
  });

  it('blur saves the pending draft', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<InlineTextEdit value="hello" onSave={onSave} ariaLabel="title" />);
    fireEvent.click(screen.getByRole('button', { name: /Edit title/i }));
    const input = screen.getByLabelText('title');
    fireEvent.change(input, { target: { value: 'after blur' } });
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('after blur'));
  });

  it('identical save (unchanged value) exits edit mode without round-trip', () => {
    const onSave = vi.fn();
    render(<InlineTextEdit value="hello" onSave={onSave} ariaLabel="title" />);
    fireEvent.click(screen.getByRole('button', { name: /Edit title/i }));
    const input = screen.getByLabelText('title');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('hello')).toBeDefined();
  });
});

describe('InlineTextEdit — validation', () => {
  it('rejects empty title via validate(), shakes, keeps edit mode, does not call onSave', () => {
    const onSave = vi.fn();
    const validate = (next: string) =>
      next.trim().length > 0 ? null : 'Title cannot be empty';
    render(
      <InlineTextEdit
        value="hello"
        onSave={onSave}
        validate={validate}
        ariaLabel="title"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Edit title/i }));
    const input = screen.getByLabelText('title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    // Error message surfaces with role=alert.
    expect(screen.getByRole('alert').textContent).toBe('Title cannot be empty');
    // Still in edit mode — input still present.
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('async onSave rejection surfaces error + keeps edit open', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('backend: duplicate id'));
    render(<InlineTextEdit value="hello" onSave={onSave} ariaLabel="title" />);
    fireEvent.click(screen.getByRole('button', { name: /Edit title/i }));
    const input = screen.getByLabelText('title');
    fireEvent.change(input, { target: { value: 'changed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('backend: duplicate id'),
    );
  });
});

describe('InlineTextEdit — multiline (textarea) flow', () => {
  it('Enter inserts newline, Cmd+Enter saves', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineTextEdit value="a" onSave={onSave} ariaLabel="why" multiline />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Edit why/i }));
    const ta = screen.getByLabelText('why') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'line one' } });
    // Plain Enter should NOT save — textarea uses Cmd/Ctrl+Enter.
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('line one'));
  });

  it('attaches nowheel class to the textarea so internal scroll does not pan the canvas', () => {
    render(
      <InlineTextEdit value="a" onSave={vi.fn()} ariaLabel="why" multiline />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Edit why/i }));
    const ta = screen.getByLabelText('why');
    expect(ta.className).toContain('nowheel');
  });
});

describe('InlineTextEdit — character counter', () => {
  it('hidden below warn threshold', () => {
    render(
      <InlineTextEdit
        value=""
        onSave={vi.fn()}
        ariaLabel="title"
        softLimit={100}
        softLimitWarnAt={80}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Edit title/i }));
    expect(screen.queryByTestId('inline-edit-counter')).toBeNull();
  });

  it('appears at or above warn threshold; red at soft limit', () => {
    const text = 'x'.repeat(85);
    render(
      <InlineTextEdit
        value=""
        onSave={vi.fn()}
        ariaLabel="title"
        softLimit={100}
        softLimitWarnAt={80}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Edit title/i }));
    const input = screen.getByLabelText('title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: text } });
    const counter = screen.getByTestId('inline-edit-counter');
    expect(counter.textContent).toBe('85/100');
    // Push past soft limit — counter goes red.
    fireEvent.change(input, { target: { value: 'x'.repeat(100) } });
    expect(counter.style.color).toContain('failed');
  });
});

describe('InlineTextEdit — autoEnterEdit', () => {
  it('enters edit mode on mount when autoEnterEdit is true', () => {
    render(
      <InlineTextEdit
        value=""
        onSave={vi.fn()}
        ariaLabel="title"
        autoEnterEdit
      />,
    );
    const input = screen.getByLabelText('title');
    expect(document.activeElement).toBe(input);
  });
});
