/**
 * Phase 7 Step 6 — unified banner primitive.
 *
 * `ErrorBanner`, `StashBanner`, and `AutoApproveSuspendedBanner`
 * historically duplicated the same outer chrome — top-of-viewport
 * absolute layout, framer-motion enter/exit, accent background +
 * border-bottom, dismiss × button. The Step 0 audit flagged them
 * as the cleanest banner-unification target. This primitive owns
 * that shared scaffolding; each wrapper passes a `variant` (drives
 * accent + icon), the visibility flag, an aria role/live tier, an
 * optional `onDismiss`, and arbitrary `children` for the inner
 * content + per-banner action buttons.
 *
 * No "kitchen-sink" props: the wrappers still own their own
 * variant text, action buttons, and any expandable detail bodies.
 * The primitive is the *frame*, not the *content*.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, X, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export type BannerVariant = 'error' | 'warning' | 'info';

const ACCENT: Record<BannerVariant, { fg: string; bg: string }> = {
  error: {
    fg: 'var(--color-status-failed)',
    bg: 'rgba(239, 68, 68, 0.1)',
  },
  warning: {
    fg: 'var(--color-status-pending)',
    bg: 'rgba(251, 191, 36, 0.1)',
  },
  info: {
    fg: 'var(--color-status-running)',
    bg: 'rgba(34, 211, 238, 0.1)',
  },
};

type Props = {
  /** Visual accent. Drives bg + border colour. */
  variant: BannerVariant;
  /** Renders the banner when `true`; framer-motion exit anim fires on flip
   *  to `false`. */
  visible: boolean;
  /** `data-testid` on the root motion.div. Each wrapper picks its own
   *  to preserve the existing test contracts. */
  testId: string;
  /** Optional `data-*` attributes for variant-specific test queries
   *  (e.g. `data-kind="conflict"` on StashBanner). Keys without the
   *  `data-` prefix; primitive prefixes automatically. */
  dataAttrs?: Record<string, string | undefined>;
  /** ARIA role. `'alert'` for errors (assertive), `'status'` for
   *  info / warning (polite). */
  role?: 'alert' | 'status';
  /** ARIA live region tier. */
  ariaLive?: 'polite' | 'assertive';
  /** ARIA label. Optional; aria-live + role usually carries the
   *  announcement. */
  ariaLabel?: string;
  /** Optional leading icon. Defaults to `AlertCircle` (matches the
   *  pre-unification look). */
  icon?: LucideIcon | null;
  /** Optional dismiss handler. When provided, primitive renders an
   *  × button at the top-right. Wrappers that handle dismissal
   *  inline (e.g. via a custom button placement) can omit. */
  onDismiss?: () => void;
  /** ARIA label for the dismiss button. Required when `onDismiss`
   *  is set so screen readers describe the action. */
  dismissLabel?: string;
  /** Inner content. Wrappers compose icon-adjacent text + chevron
   *  + expandable detail bodies here. The primitive renders children
   *  inside a flex-1 column so action buttons + dismiss align to the
   *  right. */
  children: ReactNode;
  /** Optional action buttons rendered between the content column and
   *  the dismiss × button (e.g. "Open resolver", "Pop stash"). The
   *  primitive renders them flex-row with `items-start` so each button
   *  top-aligns with the icon. */
  actions?: ReactNode;
};

export function Banner({
  variant,
  visible,
  testId,
  dataAttrs,
  role = 'status',
  ariaLive = 'polite',
  ariaLabel,
  icon: Icon = AlertCircle,
  onDismiss,
  dismissLabel,
  children,
  actions,
}: Props) {
  const accent = ACCENT[variant];
  const dataProps: Record<string, string> = {};
  for (const [key, value] of Object.entries(dataAttrs ?? {})) {
    if (value !== undefined) {
      dataProps[`data-${key}`] = value;
    }
  }
  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key={testId}
          initial={{ y: '-100%' }}
          animate={{ y: 0 }}
          exit={{ y: '-100%' }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          role={role}
          aria-live={ariaLive}
          aria-label={ariaLabel}
          data-testid={testId}
          data-variant={variant}
          {...dataProps}
          className="relative z-10 flex w-full items-start gap-2 px-4 py-2 text-fg-primary"
          style={{
            background: accent.bg,
            borderBottom: `1px solid ${accent.fg}`,
          }}
        >
          {Icon ? (
            <Icon
              size={16}
              style={{
                color: accent.fg,
                flexShrink: 0,
                marginTop: 4,
              }}
            />
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
          {actions ? (
            <div className="flex flex-shrink-0 items-start gap-2">{actions}</div>
          ) : null}
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={dismissLabel ?? 'Dismiss'}
              data-testid={`${testId}-dismiss`}
              className="inline-flex size-6 flex-shrink-0 items-center justify-center rounded-sm text-fg-secondary hover:bg-bg-subtle hover:text-fg-primary"
            >
              <X size={14} />
            </button>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
