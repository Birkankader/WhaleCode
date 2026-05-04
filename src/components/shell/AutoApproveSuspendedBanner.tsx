/**
 * Warning banner shown when the backend emits
 * `run:auto_approve_suspended` — the run hit its configured ceiling
 * and the approval path reverted to manual for the remainder of the
 * run. The backend latches this per-run, so the banner shows at most
 * once per run regardless of how many further passes fall back to
 * manual.
 *
 * Distinct from `ErrorBanner`: not an error, and it reads from a
 * different piece of store state (`autoApproveSuspended`) so the two
 * can coexist vertically if they both fire in the same frame.
 *
 * Phase 7 Step 6: shared chrome (motion enter/exit, accent bg,
 * dismiss × button) is delegated to the `Banner` primitive. This
 * wrapper picks copy + accent variant only.
 */

import { useGraphStore } from '../../state/graphStore';
import { Banner } from '../primitives/Banner';

const REASON_COPY: Record<string, string> = {
  subtask_limit:
    'Auto-approve suspended: this run hit the configured subtask ceiling. Remaining plan passes need manual approval.',
};

export function AutoApproveSuspendedBanner() {
  const suspended = useGraphStore((s) => s.autoApproveSuspended);
  const dismiss = useGraphStore((s) => s.dismissAutoApproveSuspended);

  const visible = suspended !== null;
  const message = suspended
    ? REASON_COPY[suspended.reason] ??
      'Auto-approve suspended: remaining plan passes need manual approval.'
    : '';

  return (
    <Banner
      variant="warning"
      visible={visible}
      testId="auto-approve-suspended-banner"
      role="status"
      ariaLive="polite"
      onDismiss={dismiss}
      dismissLabel="Dismiss auto-approve suspended notice"
    >
      <span className="text-body">{message}</span>
    </Banner>
  );
}
