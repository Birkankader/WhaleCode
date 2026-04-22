import type { PropsWithChildren } from 'react';

/**
 * Small inline label used for metadata hints on nodes:
 * - "edited" → subtask modified from master's original plan
 * - "added" → user-authored subtask (not from master)
 *
 * Variants map to status/agent colors via CSS vars; no hard-coded colors.
 * Tooltip (via `title`) gives hover context since the badges are tight.
 */
type Variant = 'edited' | 'added' | 'neutral' | 'failed';

const VARIANT_STYLE: Record<Variant, { border: string; fg: string; bg: string }> = {
  edited: {
    border: 'var(--color-status-pending)',
    fg: 'var(--color-status-pending)',
    bg: 'transparent',
  },
  added: {
    border: 'var(--color-agent-master)',
    fg: 'var(--color-agent-master)',
    bg: 'transparent',
  },
  neutral: {
    border: 'var(--color-border-default)',
    fg: 'var(--color-fg-secondary)',
    bg: 'transparent',
  },
  // Phase 4 Step 5: error-category chip next to the `Failed` state
  // label on a WorkerNode. Uses the status-failed color so the chip
  // reads as diagnostic detail attached to the existing failure
  // signal rather than a separate affordance.
  failed: {
    border: 'var(--color-status-failed)',
    fg: 'var(--color-status-failed)',
    bg: 'transparent',
  },
};

export type BadgeProps = {
  variant?: Variant;
  tooltip?: string;
};

export function Badge({
  children,
  variant = 'neutral',
  tooltip,
}: PropsWithChildren<BadgeProps>) {
  const s = VARIANT_STYLE[variant];
  return (
    <span
      className="inline-flex items-center rounded-sm border px-1 text-hint leading-none"
      style={{ borderColor: s.border, color: s.fg, background: s.bg, padding: '1px 4px' }}
      title={tooltip}
      data-variant={variant}
    >
      {children}
    </span>
  );
}
