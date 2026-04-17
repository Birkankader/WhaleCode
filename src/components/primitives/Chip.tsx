import type { PropsWithChildren } from 'react';

type Variant = 'default' | 'agent';

export function Chip({
  children,
  variant = 'default',
  color,
}: PropsWithChildren<{ variant?: Variant; color?: string }>) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-hint"
      style={
        variant === 'agent' && color
          ? { borderColor: color, color }
          : { borderColor: 'var(--color-border-default)', color: 'var(--color-fg-secondary)' }
      }
    >
      {children}
    </span>
  );
}
