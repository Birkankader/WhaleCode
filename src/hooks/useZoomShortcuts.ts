import { useReactFlow } from '@xyflow/react';
import { useEffect } from 'react';

/**
 * Binds Cmd/Ctrl + "+" / "-" to the React Flow zoom-in / zoom-out handlers.
 * Pairs with `useRecenterShortcut` (Cmd+0 → fit view) — between them they
 * mirror the standard browser/editor zoom shortcut triplet.
 *
 * Must be called inside a `<ReactFlowProvider>` subtree; `useReactFlow`
 * otherwise throws. The 200 ms transition matches React Flow's own
 * `<Controls />` button animation so keyboard and button feel the same.
 */
export function useZoomShortcuts(): void {
  const { zoomIn, zoomOut } = useReactFlow();
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      // Shift+= produces "+" on most layouts, "=" unmodified. Accept both
      // so the binding fires regardless of which key the user lands on.
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        void zoomIn({ duration: 200 });
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        void zoomOut({ duration: 200 });
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [zoomIn, zoomOut]);
}
