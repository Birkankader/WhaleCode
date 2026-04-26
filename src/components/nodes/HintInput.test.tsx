/**
 * Phase 6 Step 4 — HintInput unit tests.
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

import { HintInput } from './HintInput';

beforeEach(() => {
  useGraphStore.setState({ runId: 'r-1', hintInFlight: new Set() });
});

afterEach(() => {
  useGraphStore.getState().reset();
});

describe('HintInput — render + submit', () => {
  it('renders inline input + send button', () => {
    render(<HintInput subtaskId="s-1" />);
    expect(screen.getByTestId('hint-input-s-1')).toBeInTheDocument();
    expect(screen.getByTestId('hint-input-field-s-1')).toBeInTheDocument();
    expect(screen.getByTestId('hint-input-send-s-1')).toBeInTheDocument();
  });

  it('placeholder makes restart-not-pause explicit', () => {
    render(<HintInput subtaskId="s-1" />);
    const field = screen.getByTestId('hint-input-field-s-1');
    expect(field.getAttribute('placeholder')).toMatch(/restart/i);
    expect(field.getAttribute('placeholder')).toMatch(/partial progress lost/i);
  });

  it('Send button disabled when hint is empty', () => {
    render(<HintInput subtaskId="s-1" />);
    expect(screen.getByTestId('hint-input-send-s-1')).toBeDisabled();
  });

  it('Send button enables once hint has non-whitespace text', () => {
    render(<HintInput subtaskId="s-1" />);
    const field = screen.getByTestId('hint-input-field-s-1');
    fireEvent.change(field, { target: { value: 'use approach B' } });
    expect(screen.getByTestId('hint-input-send-s-1')).not.toBeDisabled();
  });

  it('clicking Send fires hintSubtask with the trimmed text', async () => {
    const hintSubtask = vi.fn(async () => undefined);
    useGraphStore.setState({ hintSubtask });
    render(<HintInput subtaskId="s-1" />);
    const field = screen.getByTestId('hint-input-field-s-1');
    fireEvent.change(field, { target: { value: '  use approach B  ' } });
    fireEvent.click(screen.getByTestId('hint-input-send-s-1'));
    await waitFor(() => {
      expect(hintSubtask).toHaveBeenCalledWith('s-1', 'use approach B');
    });
  });

  it('Enter key submits', async () => {
    const hintSubtask = vi.fn(async () => undefined);
    useGraphStore.setState({ hintSubtask });
    render(<HintInput subtaskId="s-1" />);
    const field = screen.getByTestId('hint-input-field-s-1');
    fireEvent.change(field, { target: { value: 'go with B' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => {
      expect(hintSubtask).toHaveBeenCalledWith('s-1', 'go with B');
    });
  });

  it('Escape clears the field without submitting', () => {
    const hintSubtask = vi.fn(async () => undefined);
    useGraphStore.setState({ hintSubtask });
    render(<HintInput subtaskId="s-1" />);
    const field = screen.getByTestId('hint-input-field-s-1') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'something' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field.value).toBe('');
    expect(hintSubtask).not.toHaveBeenCalled();
  });

  it('clears the field after successful submit', async () => {
    const hintSubtask = vi.fn(async () => undefined);
    useGraphStore.setState({ hintSubtask });
    render(<HintInput subtaskId="s-1" />);
    const field = screen.getByTestId('hint-input-field-s-1') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'hint' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => {
      expect(hintSubtask).toHaveBeenCalled();
    });
    expect(field.value).toBe('');
  });
});

describe('HintInput — in-flight state', () => {
  it('disables input + button + shows status copy', () => {
    useGraphStore.setState({ hintInFlight: new Set(['s-1']) });
    render(<HintInput subtaskId="s-1" />);
    expect(screen.getByTestId('hint-input-field-s-1')).toBeDisabled();
    expect(screen.getByTestId('hint-input-send-s-1')).toBeDisabled();
    expect(screen.getByTestId('hint-input-status-s-1').textContent).toMatch(
      /restarting with your hint/i,
    );
  });

  it('hides status copy when not in flight', () => {
    render(<HintInput subtaskId="s-1" />);
    expect(screen.queryByTestId('hint-input-status-s-1')).toBeNull();
  });

  it('only the targeted subtask flips to in-flight', () => {
    useGraphStore.setState({ hintInFlight: new Set(['s-other']) });
    render(<HintInput subtaskId="s-1" />);
    expect(screen.getByTestId('hint-input-field-s-1')).not.toBeDisabled();
  });

  it('preserves typed text on submit failure (action throws)', async () => {
    const hintSubtask = vi.fn(async () => {
      throw 'concurrent hint';
    });
    useGraphStore.setState({ hintSubtask });
    render(<HintInput subtaskId="s-1" />);
    const field = screen.getByTestId('hint-input-field-s-1') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'retry me' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => {
      expect(hintSubtask).toHaveBeenCalled();
    });
    expect(field.value).toBe('retry me');
  });
});
