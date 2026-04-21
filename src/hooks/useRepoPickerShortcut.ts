import { useEffect } from 'react';

/**
 * Binds Cmd/Ctrl + O to open the repo picker. Full menu integration
 * (menu bar, right-click) lands in Phase 6 polish — for now the
 * shortcut plus the clickable TopBar label are the only entry points.
 */
export function useRepoPickerShortcut(onOpen: () => void): void {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        onOpen();
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onOpen]);
}
