import { useEffect } from 'react';

type HotkeyHandler = (e: KeyboardEvent) => void;

interface HotkeyConfig {
  key: string;
  meta?: boolean;
  shift?: boolean;
  handler: HotkeyHandler;
  enabled?: boolean;
}

const IGNORED_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (IGNORED_TAGS.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useHotkeys(hotkeys: HotkeyConfig[]) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      for (const hk of hotkeys) {
        if (hk.enabled === false) continue;

        const wantMeta = hk.meta ?? false;
        const wantShift = hk.shift ?? false;

        if (e.key.toLowerCase() !== hk.key.toLowerCase()) continue;
        if (wantMeta !== e.metaKey) continue;
        if (wantShift !== e.shiftKey) continue;

        // Allow Escape to fire even in inputs (for closing modals/panels)
        if (hk.key !== 'Escape' && isEditableTarget(e.target)) continue;

        hk.handler(e);
        return;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkeys]);
}
