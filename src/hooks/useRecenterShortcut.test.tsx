import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useRecenterShortcut } from './useRecenterShortcut';

function Probe({ onRecenter }: { onRecenter: () => void }) {
  useRecenterShortcut(onRecenter);
  return null;
}

function fireKey(key: string, { meta = false, ctrl = false } = {}) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, metaKey: meta, ctrlKey: ctrl, bubbles: true }),
    );
  });
}

describe('useRecenterShortcut', () => {
  it('invokes the callback on Cmd+0', () => {
    const spy = vi.fn();
    render(<Probe onRecenter={spy} />);
    fireKey('0', { meta: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('invokes the callback on Ctrl+0', () => {
    const spy = vi.fn();
    render(<Probe onRecenter={spy} />);
    fireKey('0', { ctrl: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('ignores bare "0" without modifier', () => {
    const spy = vi.fn();
    render(<Probe onRecenter={spy} />);
    fireKey('0');
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores Cmd+other keys', () => {
    const spy = vi.fn();
    render(<Probe onRecenter={spy} />);
    fireKey('1', { meta: true });
    fireKey('K', { meta: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('unbinds on unmount', () => {
    const spy = vi.fn();
    const { unmount } = render(<Probe onRecenter={spy} />);
    unmount();
    fireKey('0', { meta: true });
    expect(spy).not.toHaveBeenCalled();
  });
});
