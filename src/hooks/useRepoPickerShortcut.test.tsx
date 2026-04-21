import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useRepoPickerShortcut } from './useRepoPickerShortcut';

function Probe({ onOpen }: { onOpen: () => void }) {
  useRepoPickerShortcut(onOpen);
  return null;
}

function fireKey(key: string, { meta = false, ctrl = false } = {}) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, metaKey: meta, ctrlKey: ctrl, bubbles: true }),
    );
  });
}

describe('useRepoPickerShortcut', () => {
  it('invokes the callback on Cmd+O', () => {
    const spy = vi.fn();
    render(<Probe onOpen={spy} />);
    fireKey('o', { meta: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('also matches Cmd+Shift+O (uppercase O)', () => {
    const spy = vi.fn();
    render(<Probe onOpen={spy} />);
    fireKey('O', { meta: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('invokes the callback on Ctrl+O', () => {
    const spy = vi.fn();
    render(<Probe onOpen={spy} />);
    fireKey('o', { ctrl: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('ignores bare "o" without modifier', () => {
    const spy = vi.fn();
    render(<Probe onOpen={spy} />);
    fireKey('o');
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores Cmd+other keys', () => {
    const spy = vi.fn();
    render(<Probe onOpen={spy} />);
    fireKey('0', { meta: true });
    fireKey('K', { meta: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('unbinds on unmount', () => {
    const spy = vi.fn();
    const { unmount } = render(<Probe onOpen={spy} />);
    unmount();
    fireKey('o', { meta: true });
    expect(spy).not.toHaveBeenCalled();
  });
});
