import { useEffect, useRef, useState } from 'react';

/** Hook that tracks elapsed seconds while `isActive` is true. Resets on deactivation. */
export function useElapsedTime(isActive: boolean) {
  const startRef = useRef<number>(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isActive) {
      setElapsed(0);
      return;
    }
    startRef.current = Date.now();
    setElapsed(0);
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isActive]);

  return elapsed;
}

/** Format seconds into a human-readable string like "12s" or "1m 30s" */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}
