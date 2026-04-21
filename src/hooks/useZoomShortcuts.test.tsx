import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const zoomIn = vi.fn();
const zoomOut = vi.fn();
vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ zoomIn, zoomOut }),
}));

import { useZoomShortcuts } from './useZoomShortcuts';

function Probe() {
  useZoomShortcuts();
  return null;
}

function fireKey(key: string, { meta = false, ctrl = false } = {}) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, metaKey: meta, ctrlKey: ctrl, bubbles: true }),
    );
  });
}

describe('useZoomShortcuts', () => {
  it('zooms in on Cmd+= and Cmd++', () => {
    zoomIn.mockClear();
    render(<Probe />);
    fireKey('=', { meta: true });
    fireKey('+', { meta: true });
    expect(zoomIn).toHaveBeenCalledTimes(2);
  });

  it('zooms in on Ctrl+= (Linux/Windows)', () => {
    zoomIn.mockClear();
    render(<Probe />);
    fireKey('=', { ctrl: true });
    expect(zoomIn).toHaveBeenCalledTimes(1);
  });

  it('zooms out on Cmd+- and Cmd+_', () => {
    zoomOut.mockClear();
    render(<Probe />);
    fireKey('-', { meta: true });
    fireKey('_', { meta: true });
    expect(zoomOut).toHaveBeenCalledTimes(2);
  });

  it('ignores bare +/- without modifier (typing in an input must not zoom)', () => {
    zoomIn.mockClear();
    zoomOut.mockClear();
    render(<Probe />);
    fireKey('=');
    fireKey('+');
    fireKey('-');
    fireKey('_');
    expect(zoomIn).not.toHaveBeenCalled();
    expect(zoomOut).not.toHaveBeenCalled();
  });

  it('ignores Cmd+other keys (only +/- and = _ bound)', () => {
    zoomIn.mockClear();
    zoomOut.mockClear();
    render(<Probe />);
    fireKey('0', { meta: true });
    fireKey('a', { meta: true });
    expect(zoomIn).not.toHaveBeenCalled();
    expect(zoomOut).not.toHaveBeenCalled();
  });

  it('unbinds on unmount', () => {
    zoomIn.mockClear();
    const { unmount } = render(<Probe />);
    unmount();
    fireKey('=', { meta: true });
    expect(zoomIn).not.toHaveBeenCalled();
  });
});
