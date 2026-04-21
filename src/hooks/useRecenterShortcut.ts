import { useEffect } from 'react';

/**
 * Binds Cmd/Ctrl + 0 to the recenter callback. The callback is kept in a
 * direct ref via the effect's closure, so consumers can pass a fresh
 * function on every render without churning listeners.
 */
export function useRecenterShortcut(onRecenter: () => void): void {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault();
        onRecenter();
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onRecenter]);
}
