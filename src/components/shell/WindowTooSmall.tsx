import { useEffect, useState } from 'react';

/** Design-system minimum; below this the graph is unusable. */
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;

/**
 * Renders a fullscreen "too small" overlay when the window drops below the
 * design-system minimums. Returns the children untouched otherwise. Kept
 * outside the store so it works even before any task has been submitted.
 */
export function WindowTooSmall({ children }: { children: React.ReactNode }) {
  const [tooSmall, setTooSmall] = useState(() => belowMinimum());

  useEffect(() => {
    const onResize = () => setTooSmall(belowMinimum());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (tooSmall) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg-primary px-6 text-fg-primary">
        <div className="max-w-[320px] text-center">
          <p className="text-title font-medium">Window too small</p>
          <p className="mt-2 text-meta text-fg-tertiary">
            WhaleCode needs at least {MIN_WIDTH} × {MIN_HEIGHT} to render the graph. Resize the
            window to continue.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

function belowMinimum(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < MIN_WIDTH || window.innerHeight < MIN_HEIGHT;
}
